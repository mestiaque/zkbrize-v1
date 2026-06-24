const net = require('net');
const logger = require('../logger');
const { addDevice, updateDevice, addAttendanceLog, addSyncLog, store } = require('../store');

let io = null;
function setSocketIO(socketio) { io = socketio; }
function emit(event, data) { if (io) io.emit(event, data); }

// ZKTeco binary protocol constants
const USHRT_MAX = 65535;
const ZK_CMD = {
  CONNECT: 1000, DISCONNECT: 1001, ACK_OK: 2000, ACK_UNAUTH: 2001,
  ACK_FAIL: 2002, PREPARE_DATA: 1500, DATA: 1501, FREE_DATA: 1502,
  GET_TIME: 201, SET_TIME: 202, ENABLE_DEVICE: 224, DISABLE_DEVICE: 223,
  VERSION: 1100, GET_ATTENDANCE: 13, CLEAR_ATTENDANCE: 14,
  GET_ALL_USER_INFO: 9, SET_USER_INFO: 8, DELETE_USER: 18,
};

function createHeader(command, checksum, sessionId, replyId, data) {
  const buf = Buffer.alloc(8 + (data ? data.length : 0));
  buf.writeUInt16LE(command, 0);
  buf.writeUInt16LE(checksum, 2);
  buf.writeUInt16LE(sessionId, 4);
  buf.writeUInt16LE(replyId, 6);
  if (data) data.copy(buf, 8);
  return buf;
}

function calcChecksum(buf) {
  let i = 0;
  let chk = 0;
  const l = buf.length;
  if (l % 2 === 1) { chk = buf[l - 1]; }
  for (; i < Math.floor(l / 2); i++) {
    chk = chk + buf.readUInt16LE(i * 2);
  }
  while (chk > USHRT_MAX) { chk = (chk & USHRT_MAX) + (chk >> 16); }
  chk = USHRT_MAX - chk;
  return chk;
}

class ZKDevice {
  constructor(config) {
    this.ip = config.ip;
    this.port = config.port || 4370;
    this.timeout = config.timeout || 5000;
    this.password = config.password || 0;
    this.id = config.id || `${config.ip}:${config.port || 4370}`;
    this.name = config.name || `TCP Device (${config.ip})`;

    this.socket = null;
    this.sessionId = 0;
    this.replyId = 0;
    this.connected = false;
    this._responseCallbacks = [];
    this._buffer = Buffer.alloc(0);
  }

  _send(command, data) {
    return new Promise((resolve, reject) => {
      const payload = data || Buffer.alloc(0);
      const buf = createHeader(command, 0, this.sessionId, this.replyId, payload);
      const chk = calcChecksum(buf);
      buf.writeUInt16LE(chk, 2);

      const timer = setTimeout(() => {
        this._responseCallbacks = this._responseCallbacks.filter(cb => cb !== handler);
        reject(new Error(`Timeout waiting for response to cmd ${command}`));
      }, this.timeout);

      const handler = (response) => {
        clearTimeout(timer);
        resolve(response);
      };
      this._responseCallbacks.push(handler);
      this.socket.write(buf);
    });
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (this._buffer.length >= 8) {
      const len = 8; // base header; real data follows
      const packet = this._buffer.slice(0, len);
      this._buffer = this._buffer.slice(len);

      const cmd = packet.readUInt16LE(0);
      const sessionId = packet.readUInt16LE(4);
      if (this.sessionId === 0 && cmd === ZK_CMD.ACK_OK) {
        this.sessionId = sessionId;
      }

      const cb = this._responseCallbacks.shift();
      if (cb) cb({ cmd, sessionId, data: this._buffer });
    }
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      this.socket.setTimeout(this.timeout);

      this.socket.on('data', (chunk) => this._onData(chunk));
      this.socket.on('error', (err) => {
        this.connected = false;
        updateDevice(this.id, { status: 'error', error: err.message });
        reject(err);
      });
      this.socket.on('timeout', () => {
        this.connected = false;
        this.socket.destroy();
        reject(new Error('Connection timeout'));
      });
      this.socket.on('close', () => {
        this.connected = false;
        updateDevice(this.id, { status: 'disconnected' });
        emit('state_update', { type: 'device_update' });
      });

      this.socket.connect(this.port, this.ip, async () => {
        try {
          const res = await this._send(ZK_CMD.CONNECT);
          if (res.cmd === ZK_CMD.ACK_OK) {
            this.connected = true;
            this.replyId = 1;
            resolve(true);
          } else {
            reject(new Error('Device rejected connection'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  async disconnect() {
    if (this.socket) {
      try { await this._send(ZK_CMD.DISCONNECT); } catch {}
      this.socket.destroy();
    }
    this.connected = false;
  }

  async getAttendance() {
    // Request attendance data
    const res = await this._send(ZK_CMD.GET_ATTENDANCE);
    if (res.cmd !== ZK_CMD.ACK_OK) throw new Error('Failed to request attendance');

    // Data follows in chunks
    const records = [];
    // In real ZK protocol data comes via PREPARE_DATA + DATA packets
    // Here we parse the buffer that arrived with the response
    const data = res.data || Buffer.alloc(0);
    const recordSize = 40;
    for (let i = 0; i + recordSize <= data.length; i += recordSize) {
      try {
        const uid = data.readUInt16LE(i);
        const employeeId = data.slice(i + 2, i + 10).toString('utf8').replace(/\0/g, '').trim();
        const status = data.readUInt8(i + 10);
        const second = data.readUInt8(i + 11);
        const minute = data.readUInt8(i + 12);
        const hour = data.readUInt8(i + 13);
        const day = data.readUInt8(i + 14);
        const month = data.readUInt8(i + 15);
        const year = data.readUInt16LE(i + 16) + 2000;
        const time = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')} ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:${String(second).padStart(2,'0')}`;
        records.push({ uid, employeeId, status, time });
      } catch {}
    }
    return records;
  }

  async getUsers() {
    const res = await this._send(ZK_CMD.GET_ALL_USER_INFO);
    if (res.cmd !== ZK_CMD.ACK_OK) throw new Error('Failed to get users');

    const users = [];
    const data = res.data || Buffer.alloc(0);
    const userSize = 72;
    for (let i = 0; i + userSize <= data.length; i += userSize) {
      try {
        const uid = data.readUInt16LE(i);
        const privilege = data.readUInt8(i + 2);
        const password = data.slice(i + 3, i + 11).toString('utf8').replace(/\0/g, '');
        const name = data.slice(i + 11, i + 35).toString('utf8').replace(/\0/g, '').trim();
        const employeeId = data.slice(i + 35, i + 43).toString('utf8').replace(/\0/g, '').trim();
        users.push({ uid, privilege, password, name, employeeId });
      } catch {}
    }
    return users;
  }

  async setUser(uid, employeeId, name, password = '', privilege = 0) {
    const buf = Buffer.alloc(72);
    buf.writeUInt16LE(uid, 0);
    buf.writeUInt8(privilege, 2);
    buf.write(password.padEnd(8, '\0'), 3, 'utf8');
    buf.write(name.padEnd(24, '\0'), 11, 'utf8');
    buf.write(employeeId.padEnd(8, '\0'), 35, 'utf8');
    const res = await this._send(ZK_CMD.SET_USER_INFO, buf);
    return res.cmd === ZK_CMD.ACK_OK;
  }

  async deleteUser(uid) {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(uid, 0);
    const res = await this._send(ZK_CMD.DELETE_USER, buf);
    return res.cmd === ZK_CMD.ACK_OK;
  }
}

// Active TCP device connections
const tcpDevices = {};

async function connectTCPDevice(config) {
  const deviceId = config.id || `${config.ip}:${config.port || 4370}`;

  if (tcpDevices[deviceId]) {
    try { await tcpDevices[deviceId].disconnect(); } catch {}
  }

  const device = new ZKDevice(config);
  try {
    await device.connect();
    tcpDevices[deviceId] = device;

    addDevice({
      id: deviceId,
      sn: deviceId,
      type: 'tcp',
      name: config.name || `TCP Device (${config.ip})`,
      ip: config.ip,
      port: config.port || 4370,
      model: 'ZKTeco (TCP/IP)',
    });

    logger.info(`TCP device connected: ${deviceId}`);
    emit('device_connected', { deviceId, type: 'tcp' });
    emit('state_update', { type: 'device_update' });

    return { success: true, deviceId };
  } catch (err) {
    logger.error(`Failed to connect TCP device ${deviceId}: ${err.message}`);
    addDevice({
      id: deviceId,
      sn: deviceId,
      type: 'tcp',
      name: config.name || `TCP Device (${config.ip})`,
      ip: config.ip,
      port: config.port || 4370,
      model: 'ZKTeco (TCP/IP)',
      status: 'error',
      error: err.message,
    });
    emit('state_update', { type: 'device_update' });
    return { success: false, error: err.message };
  }
}

async function fetchAttendanceFromTCP(deviceId) {
  const device = tcpDevices[deviceId];
  if (!device || !device.connected) {
    return { success: false, error: 'Device not connected' };
  }

  try {
    const records = await device.getAttendance();
    logger.info(`Fetched ${records.length} attendance records from TCP device ${deviceId}`);

    for (const rec of records) {
      const record = {
        deviceId,
        employeeId: rec.employeeId,
        time: rec.time,
        status: String(rec.status),
        source: 'tcp',
      };
      addAttendanceLog(record);
      emit('attendance', record);
    }

    addSyncLog({
      type: 'tcp_attendance_fetch',
      status: 'success',
      deviceId,
      count: records.length,
      message: `Fetched ${records.length} records from ${deviceId}`,
    });

    emit('state_update', { type: 'attendance', count: records.length });
    return { success: true, count: records.length, records };
  } catch (err) {
    logger.error(`Failed to fetch attendance from ${deviceId}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function syncEmployeesToTCP(deviceId, employees) {
  const device = tcpDevices[deviceId];
  if (!device || !device.connected) {
    return { success: false, error: 'Device not connected' };
  }

  let synced = 0;
  for (const emp of employees) {
    try {
      await device.setUser(
        emp.uid || emp.id,
        String(emp.employee_id || emp.id),
        emp.name || '',
        emp.password || '',
        emp.privilege || 0
      );
      synced++;
    } catch (err) {
      logger.warn(`Failed to sync employee ${emp.id} to device: ${err.message}`);
    }
  }

  updateDevice(deviceId, { employeesSynced: synced });
  addSyncLog({
    type: 'employee_sync_tcp',
    status: 'success',
    deviceId,
    count: synced,
    message: `Synced ${synced}/${employees.length} employees to ${deviceId}`,
  });

  return { success: true, synced, total: employees.length };
}

async function getEmployeesFromDevice(deviceId) {
  const device = tcpDevices[deviceId];
  if (!device || !device.connected) return { success: false, error: 'Device not connected' };
  try {
    const users = await device.getUsers();
    return { success: true, employees: users };
  } catch (err) {
    logger.error(`Failed to get employees from ${deviceId}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function getEmployeesFromIP(ip, port = 4370) {
  const temp = new ZKDevice({ ip, port, timeout: 8000, id: `temp-${ip}` });
  try {
    await temp.connect();
    const users = await temp.getUsers();
    await temp.disconnect();
    return { success: true, employees: users };
  } catch (err) {
    try { await temp.disconnect(); } catch {}
    logger.error(`Failed to get employees from ${ip}:${port} — ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function setEmployeeOnDevice(deviceId, emp) {
  const device = tcpDevices[deviceId];
  if (!device || !device.connected) return { success: false, error: 'Device not connected' };
  try {
    const ok = await device.setUser(
      emp.uid,
      String(emp.employee_id || emp.employeeId || ''),
      emp.name || '',
      emp.password || '',
      emp.privilege || 0
    );
    if (ok) addSyncLog({ type: 'employee_set', status: 'success', deviceId, message: `Set employee UID=${emp.uid} on ${deviceId}` });
    return { success: ok };
  } catch (err) {
    logger.error(`Failed to set employee on ${deviceId}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function setEmployeeViaIP(ip, port = 4370, emp) {
  const temp = new ZKDevice({ ip, port, timeout: 8000, id: `temp-${ip}` });
  try {
    await temp.connect();
    const ok = await temp.setUser(
      emp.uid,
      String(emp.employee_id || emp.employeeId || ''),
      emp.name || '',
      emp.password || '',
      emp.privilege || 0
    );
    await temp.disconnect();
    return { success: ok };
  } catch (err) {
    try { await temp.disconnect(); } catch {}
    logger.error(`Failed to set employee on ${ip}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function deleteEmployeeFromDevice(deviceId, uid) {
  const device = tcpDevices[deviceId];
  if (!device || !device.connected) return { success: false, error: 'Device not connected' };
  try {
    const ok = await device.deleteUser(Number(uid));
    if (ok) addSyncLog({ type: 'employee_delete', status: 'success', deviceId, message: `Deleted employee UID=${uid} from ${deviceId}` });
    return { success: ok };
  } catch (err) {
    logger.error(`Failed to delete employee UID=${uid} from ${deviceId}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function deleteEmployeeViaIP(ip, port = 4370, uid) {
  const temp = new ZKDevice({ ip, port, timeout: 8000, id: `temp-${ip}` });
  try {
    await temp.connect();
    const ok = await temp.deleteUser(Number(uid));
    await temp.disconnect();
    return { success: ok };
  } catch (err) {
    try { await temp.disconnect(); } catch {}
    logger.error(`Failed to delete employee UID=${uid} from ${ip}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function disconnectTCPDevice(deviceId) {
  if (tcpDevices[deviceId]) {
    await tcpDevices[deviceId].disconnect();
    delete tcpDevices[deviceId];
    updateDevice(deviceId, { status: 'disconnected' });
    emit('state_update', { type: 'device_update' });
  }
}

module.exports = {
  connectTCPDevice,
  fetchAttendanceFromTCP,
  syncEmployeesToTCP,
  getEmployeesFromDevice,
  getEmployeesFromIP,
  setEmployeeOnDevice,
  setEmployeeViaIP,
  deleteEmployeeFromDevice,
  deleteEmployeeViaIP,
  disconnectTCPDevice,
  setSocketIO,
  tcpDevices,
};
