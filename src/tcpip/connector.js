const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { addDevice, updateDevice, addAttendanceLog, addSyncLog, store } = require('../store');

let io = null;
function setSocketIO(socketio) { io = socketio; }
function emit(event, data) { if (io) io.emit(event, data); }

// ── ZKTeco binary protocol (port 4370, TCP or UDP) ─────────────────
// Packet layout follows pyzk (github.com/fananimi/pyzk), the de-facto
// reference implementation that works across ZK6/ZK8 firmware.

const USHRT_MAX = 65535;
const CMD = {
  CONNECT: 1000, EXIT: 1001, ENABLEDEVICE: 1002, DISABLEDEVICE: 1003,
  REFRESHDATA: 1013, AUTH: 1102,
  PREPARE_DATA: 1500, DATA: 1501, FREE_DATA: 1502, DATA_WRRQ: 1503, DATA_RDY: 1504,
  USER_WRQ: 8, USERTEMP_RRQ: 9, ATTLOG_RRQ: 13, DELETE_USER: 18,
  GET_FREE_SIZES: 50, REG_EVENT: 500,
  ACK_OK: 2000, ACK_ERROR: 2001, ACK_DATA: 2002, ACK_UNAUTH: 2005,
};
const FCT_USER = 5;
const TCP_MAGIC = Buffer.from([0x50, 0x50, 0x82, 0x7d]);
const ADMIN_PRIVILEGE = 14;

const VERIFY_METHODS = { 0: 'password', 1: 'fingerprint', 2: 'card', 15: 'face' };

function checksum(buf) {
  let sum = 0;
  let i = 0;
  for (; i + 1 < buf.length; i += 2) {
    sum += buf.readUInt16LE(i);
    if (sum > USHRT_MAX) sum -= USHRT_MAX;
  }
  if (i < buf.length) sum += buf[buf.length - 1];
  while (sum > USHRT_MAX) sum -= USHRT_MAX;
  sum = ~sum;
  while (sum < 0) sum += USHRT_MAX;
  return sum;
}

function buildPacket(command, sessionId, replyId, data) {
  const payload = data || Buffer.alloc(0);
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt16LE(command, 0);
  buf.writeUInt16LE(0, 2);
  buf.writeUInt16LE(sessionId, 4);
  buf.writeUInt16LE(replyId, 6);
  payload.copy(buf, 8);
  // Checksum is taken before the reply id is advanced (same as the vendor SDK)
  buf.writeUInt16LE(checksum(buf), 2);
  buf.writeUInt16LE((replyId + 1) % USHRT_MAX, 6);
  return buf;
}

function tcpFrame(packet) {
  const top = Buffer.alloc(8);
  TCP_MAGIC.copy(top, 0);
  top.writeUInt32LE(packet.length, 4);
  return Buffer.concat([top, packet]);
}

// Comm key ("password" on device) encoding used by CMD_AUTH
function makeCommKey(key, sessionId, ticks = 50) {
  key = parseInt(key, 10) || 0;
  let k = 0;
  for (let i = 0; i < 32; i++) {
    k = (key & (1 << i)) ? ((k << 1) | 1) : (k << 1);
  }
  k = ((k >>> 0) + sessionId) >>> 0;
  const b = Buffer.alloc(4);
  b.writeUInt32LE(k, 0);
  const x = [b[0] ^ 0x5a, b[1] ^ 0x4b, b[2] ^ 0x53, b[3] ^ 0x4f]; // 'Z','K','S','O'
  const s = [x[2], x[3], x[0], x[1]];                             // swap 16-bit halves
  const t = ticks & 0xff;
  return Buffer.from([s[0] ^ t, s[1] ^ t, t, s[3] ^ t]);
}

function decodeTime(t) {
  const second = t % 60; t = Math.floor(t / 60);
  const minute = t % 60; t = Math.floor(t / 60);
  const hour = t % 24;   t = Math.floor(t / 24);
  const day = t % 31 + 1; t = Math.floor(t / 31);
  const month = t % 12 + 1; t = Math.floor(t / 12);
  const year = t + 2000;
  const p = n => String(n).padStart(2, '0');
  return `${year}-${p(month)}-${p(day)} ${p(hour)}:${p(minute)}:${p(second)}`;
}

function readCString(buf, offset, length) {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf8').trim();
}

function writeFixed(buf, str, offset, length) {
  Buffer.from(String(str || ''), 'utf8').copy(buf, offset, 0, length);
}

function decodeUsers(data, packetSize) {
  const users = [];
  for (let i = 0; i + packetSize <= data.length; i += packetSize) {
    const b = data.subarray(i, i + packetSize);
    if (packetSize === 28) {
      users.push({
        uid: b.readUInt16LE(0),
        privilege: b[2],
        password: readCString(b, 3, 5),
        name: readCString(b, 8, 8),
        card: b.readUInt32LE(16),
        groupId: String(b[21]),
        userId: String(b.readUInt32LE(24)),
      });
    } else {
      users.push({
        uid: b.readUInt16LE(0),
        privilege: b[2],
        password: readCString(b, 3, 8),
        name: readCString(b, 11, 24),
        card: b.readUInt32LE(35),
        groupId: readCString(b, 40, 7),
        userId: readCString(b, 48, 24),
      });
    }
  }
  return users;
}

function encodeUser(u, packetSize) {
  const b = Buffer.alloc(packetSize);
  b.writeUInt16LE(u.uid, 0);
  b[2] = u.privilege;
  if (packetSize === 28) {
    writeFixed(b, u.password, 3, 5);
    writeFixed(b, u.name, 8, 8);
    b.writeUInt32LE((parseInt(u.card, 10) || 0) >>> 0, 16);
    b[21] = parseInt(u.groupId, 10) || 0;
    b.writeUInt32LE((parseInt(u.userId, 10) || 0) >>> 0, 24);
  } else {
    writeFixed(b, u.password, 3, 8);
    writeFixed(b, u.name, 11, 24);
    b.writeUInt32LE((parseInt(u.card, 10) || 0) >>> 0, 35);
    writeFixed(b, u.groupId, 40, 7);
    writeFixed(b, u.userId, 48, 24);
  }
  return b;
}

function decodeAttendance(data, recordSize, uidToUserId) {
  const records = [];
  for (let i = 0; i + recordSize <= data.length; i += recordSize) {
    const b = data.subarray(i, i + recordSize);
    if (recordSize === 8) {
      const uid = b.readUInt16LE(0);
      records.push({ uid, userId: uidToUserId.get(uid) || String(uid), verify: b[2], time: decodeTime(b.readUInt32LE(3)), punch: b[7] });
    } else if (recordSize === 16) {
      records.push({ uid: 0, userId: String(b.readUInt32LE(0)), time: decodeTime(b.readUInt32LE(4)), verify: b[8], punch: b[9] });
    } else {
      records.push({ uid: b.readUInt16LE(0), userId: readCString(b, 2, 24), verify: b[26], time: decodeTime(b.readUInt32LE(27)), punch: b[31] });
    }
  }
  return records;
}

class ZKDevice {
  constructor(config) {
    this.ip = config.ip;
    this.port = parseInt(config.port, 10) || 4370;
    this.timeout = parseInt(config.timeout, 10) || parseInt(process.env.ZK_TIMEOUT, 10) || 5000;
    this.password = config.password ? String(config.password).trim() : '';
    this.protocol = ['tcp', 'udp'].includes(config.protocol) ? config.protocol : 'auto';
    this.id = config.id || `${this.ip}:${this.port}`;
    this.name = config.name || `TCP Device (${this.ip})`;
    this.lastRecordTime = config.lastRecordTime || null;
    this.activeProtocol = null;
    this.userPacketSize = null;
    this._lock = Promise.resolve();
    this._resetState();
  }

  toJSON() {
    return {
      id: this.id, ip: this.ip, port: this.port, name: this.name, password: this.password,
      protocol: this.protocol, timeout: this.timeout, lastRecordTime: this.lastRecordTime,
    };
  }

  _resetState() {
    this.sock = null;
    this.mode = null;
    this.sessionId = 0;
    this.replyId = USHRT_MAX - 1;
    this.queue = [];
    this.waiter = null;
    this.tcpBuf = Buffer.alloc(0);
  }

  // Serialize all work on one device — devices handle a single session at a time
  _exclusive(fn) {
    const run = this._lock.then(fn);
    this._lock = run.catch(() => {});
    return run;
  }

  // Open a session, run fn, always close. Each operation gets a fresh session,
  // so idle-connection drops on the device side never leave us in a stale state.
  session(fn) {
    return this._exclusive(async () => {
      await this._open();
      try {
        return await fn(this);
      } finally {
        await this._close();
      }
    });
  }

  async _open() {
    const modes = this.protocol === 'auto' ? ['tcp', 'udp'] : [this.protocol];
    let lastErr = null;
    for (const mode of modes) {
      try {
        await this._openMode(mode);
        this.activeProtocol = mode;
        return;
      } catch (err) {
        lastErr = err;
        this._destroy();
        if (err.authError) break; // wrong comm key — the other transport will not help
      }
    }
    throw lastErr;
  }

  async _openMode(mode) {
    this._resetState();
    if (mode === 'tcp') await this._openTcp();
    else await this._openUdp();
    this.mode = mode;

    let res = await this._command(CMD.CONNECT);
    this.sessionId = res.sessionId;
    if (res.cmd === CMD.ACK_UNAUTH) {
      if (!this.password) {
        throw Object.assign(new Error('Device requires a comm key (password)'), { authError: true });
      }
      res = await this._command(CMD.AUTH, makeCommKey(this.password, this.sessionId));
      if (res.cmd !== CMD.ACK_OK) {
        throw Object.assign(new Error('Comm key (password) rejected by device'), { authError: true });
      }
    } else if (res.cmd !== CMD.ACK_OK) {
      throw new Error(`Device refused connection (code ${res.cmd})`);
    }
  }

  _openTcp() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.ip, port: this.port });
      this.sock = sock;
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`TCP connect timeout (${this.ip}:${this.port})`));
      }, this.timeout);
      sock.once('connect', () => {
        clearTimeout(timer);
        sock.setNoDelay(true);
        resolve();
      });
      sock.once('error', err => { clearTimeout(timer); reject(err); });
      sock.on('error', err => { if (this.sock === sock) this._fail(err); });
      sock.on('close', () => { if (this.sock === sock) this._fail(new Error('Connection closed by device')); });
      sock.on('data', chunk => { if (this.sock === sock) this._onTcpData(chunk); });
    });
  }

  _openUdp() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      this.sock = sock;
      sock.once('error', reject);
      sock.on('error', err => { if (this.sock === sock) this._fail(err); });
      sock.on('message', msg => { if (this.sock === sock) this._onPacket(msg); });
      sock.bind(0, () => {
        sock.removeListener('error', reject);
        resolve();
      });
    });
  }

  _destroy() {
    const sock = this.sock;
    this._resetState();
    if (!sock) return;
    try {
      if (typeof sock.destroy === 'function') sock.destroy();
      else sock.close();
    } catch {}
  }

  async _close() {
    if (this.sock) {
      try { await this._command(CMD.EXIT, null, 2000); } catch {}
    }
    this._destroy();
  }

  _fail(err) {
    if (this.waiter) this.waiter.reject(err);
  }

  _onTcpData(chunk) {
    this.tcpBuf = Buffer.concat([this.tcpBuf, chunk]);
    while (this.tcpBuf.length >= 8) {
      if (this.tcpBuf.compare(TCP_MAGIC, 0, 4, 0, 4) !== 0) {
        // Out of sync — skip to the next frame marker
        const next = this.tcpBuf.indexOf(TCP_MAGIC, 1);
        this.tcpBuf = next === -1 ? Buffer.alloc(0) : this.tcpBuf.subarray(next);
        continue;
      }
      const len = this.tcpBuf.readUInt32LE(4);
      if (this.tcpBuf.length < 8 + len) break;
      const packet = this.tcpBuf.subarray(8, 8 + len);
      this.tcpBuf = this.tcpBuf.subarray(8 + len);
      this._onPacket(packet);
    }
  }

  _onPacket(buf) {
    if (buf.length < 8) return;
    const pkt = {
      cmd: buf.readUInt16LE(0),
      sessionId: buf.readUInt16LE(4),
      replyId: buf.readUInt16LE(6),
      data: Buffer.from(buf.subarray(8)),
    };
    if (pkt.cmd === CMD.REG_EVENT) return; // unsolicited realtime event — not used
    if (this.waiter) this.waiter.resolve(pkt);
    else this.queue.push(pkt);
  }

  _nextPacket(timeout) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (!this.sock) return Promise.reject(new Error('Not connected'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`Timeout waiting for device response (${this.ip}:${this.port})`));
      }, timeout || this.timeout);
      this.waiter = {
        resolve: pkt => { clearTimeout(timer); this.waiter = null; resolve(pkt); },
        reject: err => { clearTimeout(timer); this.waiter = null; reject(err); },
      };
    });
  }

  async _command(command, data, timeout) {
    if (!this.sock) throw new Error('Not connected');
    this.queue = [];
    const packet = buildPacket(command, this.sessionId, this.replyId, data);
    if (this.mode === 'tcp') this.sock.write(tcpFrame(packet));
    else this.sock.send(packet, this.port, this.ip);
    const res = await this._nextPacket(timeout);
    this.replyId = res.replyId;
    return res;
  }

  async _expectOk(command, data, what) {
    const res = await this._command(command, data);
    if (res.cmd !== CMD.ACK_OK) throw new Error(`${what} failed (device code ${res.cmd})`);
    return res;
  }

  async readSizes() {
    const res = await this._command(CMD.GET_FREE_SIZES);
    if (res.cmd !== CMD.ACK_OK || res.data.length < 80) return null;
    const f = i => res.data.readInt32LE(i * 4);
    return { users: f(4), fingers: f(6), records: f(8), usersCap: f(15), recordsCap: f(16) };
  }

  async _freeData() {
    try { await this._command(CMD.FREE_DATA); } catch {}
  }

  // Large tables (users, attendance) are transferred via the buffered-read handshake
  async _readWithBuffer(command, fct = 0, ext = 0) {
    const maxChunk = this.mode === 'tcp' ? 0xffc0 : 16 * 1024;
    const req = Buffer.alloc(11);
    req.writeInt8(1, 0);
    req.writeInt16LE(command, 1);
    req.writeInt32LE(fct, 3);
    req.writeInt32LE(ext, 7);

    const res = await this._command(CMD.DATA_WRRQ, req);
    try {
      if (res.cmd === CMD.DATA) return res.data;
      if (res.cmd !== CMD.ACK_OK && res.cmd !== CMD.PREPARE_DATA) {
        throw new Error(`Device rejected data request (code ${res.cmd})`);
      }
      const size = res.data.readUInt32LE(1);
      const parts = [];
      for (let start = 0; start < size; start += maxChunk) {
        parts.push(await this._readChunk(start, Math.min(maxChunk, size - start)));
      }
      return Buffer.concat(parts);
    } finally {
      await this._freeData();
    }
  }

  async _readChunk(start, size) {
    const waitMs = Math.max(this.timeout, 10000);
    for (let attempt = 0; attempt < 3; attempt++) {
      const req = Buffer.alloc(8);
      req.writeInt32LE(start, 0);
      req.writeInt32LE(size, 4);
      const res = await this._command(CMD.DATA_RDY, req, waitMs);

      if (res.cmd === CMD.DATA) return res.data;
      if (res.cmd !== CMD.PREPARE_DATA) continue;

      const expected = res.data.readUInt32LE(0);
      const parts = [];
      let received = 0;
      let acked = false;
      while (received < expected) {
        const pkt = await this._nextPacket(waitMs);
        if (pkt.cmd === CMD.DATA) {
          parts.push(pkt.data);
          received += pkt.data.length;
        } else {
          acked = pkt.cmd === CMD.ACK_OK;
          break;
        }
      }
      if (received < expected) continue;
      if (!acked) {
        try { await this._nextPacket(2000); } catch {} // trailing ACK_OK
      }
      return Buffer.concat(parts).subarray(0, expected);
    }
    throw new Error(`Failed to read data chunk at offset ${start}`);
  }

  async getUsers() {
    const sizes = await this.readSizes();
    if (sizes && sizes.users === 0) return [];
    const raw = await this._readWithBuffer(CMD.USERTEMP_RRQ, FCT_USER);
    if (raw.length <= 4) return [];
    const total = raw.readUInt32LE(0);
    let size = sizes && sizes.users ? total / sizes.users : 0;
    if (size !== 28 && size !== 72) size = total % 72 === 0 ? 72 : total % 28 === 0 ? 28 : 72;
    this.userPacketSize = size;
    return decodeUsers(raw.subarray(4, 4 + total), size);
  }

  async getAttendance() {
    const sizes = await this.readSizes();
    if (sizes && sizes.records === 0) return [];
    const raw = await this._readWithBuffer(CMD.ATTLOG_RRQ);
    if (raw.length < 4) return [];
    const total = raw.readUInt32LE(0);
    let size = sizes && sizes.records ? Math.floor(total / sizes.records) : 0;
    if (![8, 16, 40].includes(size)) size = total % 40 === 0 ? 40 : total % 16 === 0 ? 16 : 8;

    // Old 8-byte records only carry the internal uid — map it to the user id (PIN)
    const uidToUserId = new Map();
    if (size === 8) {
      for (const u of await this.getUsers()) uidToUserId.set(u.uid, u.userId);
    }
    return decodeAttendance(raw.subarray(4, 4 + total), size, uidToUserId);
  }

  async setUser(user) {
    const size = this.userPacketSize || 72;
    await this._expectOk(CMD.USER_WRQ, encodeUser(user, size), `Set user ${user.userId}`);
  }

  async deleteUser(uid) {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(uid, 0);
    await this._expectOk(CMD.DELETE_USER, buf, `Delete user uid=${uid}`);
  }

  async refreshData() {
    try { await this._command(CMD.REFRESHDATA); } catch {}
  }

  // Upsert bridge/ERP employees. Matches existing device users by user id (PIN)
  // so re-syncing updates in place instead of creating duplicates.
  async syncUsers(employees) {
    const existing = await this.getUsers();
    const byUserId = new Map(existing.map(u => [u.userId, u]));
    const usedUids = new Map(existing.map(u => [u.uid, u.userId]));
    let nextUid = Math.max(0, ...existing.map(u => u.uid)) + 1;

    const pickUid = (wanted, userId) => {
      if (wanted >= 1 && wanted <= USHRT_MAX && (!usedUids.has(wanted) || usedUids.get(wanted) === userId)) return wanted;
      while (usedUids.has(nextUid)) nextUid++;
      if (nextUid > USHRT_MAX) throw new Error('Device user table is full');
      return nextUid;
    };

    const result = { synced: 0, failed: 0, errors: [] };
    for (const emp of employees) {
      const norm = normalizeEmployee(emp);
      if (!norm.userId) { result.failed++; continue; }
      try {
        const current = byUserId.get(norm.userId);
        const uid = current ? current.uid : pickUid(norm.uid, norm.userId);
        await this.setUser({
          uid,
          userId: norm.userId,
          name: norm.name,
          password: norm.password,
          privilege: norm.privilege,
          card: norm.card || (current ? current.card : 0),
          groupId: current ? current.groupId : '',
        });
        usedUids.set(uid, norm.userId);
        byUserId.set(norm.userId, { uid, userId: norm.userId });
        result.synced++;
      } catch (err) {
        result.failed++;
        result.errors.push(`${norm.userId}: ${err.message}`);
      }
    }
    if (result.synced) await this.refreshData();
    return result;
  }

  async removeUser(userId) {
    const users = await this.getUsers();
    const target = users.find(u => u.userId === String(userId));
    if (!target) return false;
    await this.deleteUser(target.uid);
    await this.refreshData();
    return true;
  }
}

function parseUid(value) {
  const raw = String(value || '');
  return parseInt(raw, 10) || parseInt(raw.replace(/\D/g, ''), 10) || 0;
}

function normalizeEmployee(emp) {
  const userId = String(emp.employee_id || emp.employeeId || emp.pin || emp.uid || emp.id || '').trim();
  const name = emp.name || (emp.first_name ? emp.first_name + (emp.last_name ? ' ' + emp.last_name : '') : '') || '';
  const privilege = parseInt(emp.privilege ?? emp.role ?? 0, 10) || 0;
  return {
    uid: parseUid(emp.uid || emp.id || userId),
    userId,
    name,
    password: emp.password ? String(emp.password) : '',
    privilege: privilege === ADMIN_PRIVILEGE || privilege === 3 ? ADMIN_PRIVILEGE : 0,
    card: emp.card_no || emp.card || 0,
  };
}

function toBridgeEmployee(u) {
  return {
    uid: parseUid(u.userId) || u.uid,
    employee_id: u.userId,
    name: u.name,
    privilege: u.privilege === ADMIN_PRIVILEGE ? ADMIN_PRIVILEGE : 0,
    password: u.password || '',
    card_no: u.card ? String(u.card) : '',
    deviceUid: u.uid,
  };
}

// ── Device registry (persisted so devices survive restarts) ────────
const DEVICES_FILE = path.join(__dirname, '../../data/tcp_devices.json');
const HEALTH_CHECK_MS = 2 * 60 * 1000;
const tcpDevices = {};
let healthTimer = null;

function saveDevices() {
  try {
    const dir = path.dirname(DEVICES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(Object.values(tcpDevices).map(d => d.toJSON()), null, 2));
  } catch (e) {
    logger.error('Failed to save tcp_devices.json: ' + e.message);
  }
}

function loadDevices() {
  try {
    if (fs.existsSync(DEVICES_FILE)) return JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8')) || [];
  } catch (e) {
    logger.error('Failed to read tcp_devices.json: ' + e.message);
  }
  return [];
}

function registerInStore(dev, extra = {}) {
  addDevice({
    id: dev.id,
    sn: dev.id,
    type: 'tcp',
    name: dev.name,
    ip: dev.ip,
    port: dev.port,
    model: 'ZKTeco (TCP/IP)',
    ...extra,
  });
}

function setStatus(dev, status, extra = {}) {
  const prev = store.devices[dev.id];
  if (!prev) registerInStore(dev);
  updateDevice(dev.id, { status, protocol: dev.activeProtocol, error: status === 'error' ? extra.error : null, ...extra });
  if (!prev || prev.status !== status) emit('state_update', { type: 'device_update' });
}

// Run fn inside a device session and keep the UI status in step with the result
async function withDevice(deviceId, fn) {
  const dev = tcpDevices[deviceId];
  if (!dev) throw new Error('Device not found');
  try {
    const result = await dev.session(fn);
    setStatus(dev, 'connected');
    return result;
  } catch (err) {
    setStatus(dev, 'error', { error: err.message });
    throw err;
  }
}

async function probeDevice(dev) {
  try {
    const sizes = await withDevice(dev.id, d => d.readSizes());
    if (sizes) updateDevice(dev.id, { deviceUsers: sizes.users, deviceRecords: sizes.records });
    return true;
  } catch (err) {
    logger.warn(`TCP device ${dev.id} unreachable: ${err.message}`);
    return false;
  }
}

function startHealthCheck() {
  if (healthTimer) return;
  healthTimer = setInterval(() => {
    for (const dev of Object.values(tcpDevices)) probeDevice(dev);
  }, HEALTH_CHECK_MS);
  healthTimer.unref();
}

// Restore saved devices on startup
function initTCPDevices() {
  const saved = loadDevices();
  for (const cfg of saved) {
    const dev = new ZKDevice(cfg);
    tcpDevices[dev.id] = dev;
    registerInStore(dev);
    updateDevice(dev.id, { status: 'connecting' });
    probeDevice(dev).then(ok => {
      if (ok) logger.info(`TCP device restored: ${dev.id} (${dev.activeProtocol})`);
    });
  }
  if (saved.length) logger.info(`Restoring ${saved.length} saved TCP device(s)`);
  startHealthCheck();
}

async function connectTCPDevice(config) {
  const dev = new ZKDevice(config);
  try {
    const sizes = await dev.session(d => d.readSizes());
    const previous = tcpDevices[dev.id];
    if (previous && !config.lastRecordTime) dev.lastRecordTime = previous.lastRecordTime;
    tcpDevices[dev.id] = dev;
    saveDevices();
    registerInStore(dev, {
      protocol: dev.activeProtocol,
      deviceUsers: sizes ? sizes.users : undefined,
      deviceRecords: sizes ? sizes.records : undefined,
    });
    startHealthCheck();

    logger.info(`TCP device connected: ${dev.id} via ${dev.activeProtocol.toUpperCase()}` +
      (sizes ? ` (${sizes.users} users, ${sizes.records} records)` : ''));
    emit('device_connected', { deviceId: dev.id, type: 'tcp' });
    emit('state_update', { type: 'device_update' });
    return { success: true, deviceId: dev.id, protocol: dev.activeProtocol, users: sizes?.users, records: sizes?.records };
  } catch (err) {
    logger.error(`Failed to connect TCP device ${dev.id}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function fetchAttendanceFromTCP(deviceId, fromDate = null, toDate = null, options = {}) {
  const dev = tcpDevices[deviceId];
  if (!dev) return { success: false, error: 'Device not found' };

  try {
    const records = await withDevice(deviceId, d => d.getAttendance());
    logger.info(`Fetched ${records.length} attendance records from TCP device ${deviceId}`);

    const from = fromDate ? `${fromDate} 00:00:00` : null;
    const to   = toDate   ? `${toDate} 23:59:59`   : null;
    const since = options.onlyNew ? dev.lastRecordTime : null;
    const known = new Set(store.attendanceLogs.filter(r => r.deviceId === deviceId).map(r => `${r.employeeId}|${r.time}`));

    let newest = dev.lastRecordTime;
    const fresh = [];
    for (const rec of records) {
      if (!rec.userId) continue;
      if (!newest || rec.time > newest) newest = rec.time;
      if (from && rec.time < from) continue;
      if (to && rec.time > to) continue;
      if (since && rec.time <= since) continue;
      if (known.has(`${rec.userId}|${rec.time}`)) continue;
      known.add(`${rec.userId}|${rec.time}`);
      fresh.push(rec);
    }
    fresh.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

    let saved = 0;
    for (const rec of fresh) {
      const record = {
        deviceId,
        employeeId: rec.userId,
        time: rec.time,
        status: String(rec.punch),
        verify: String(rec.verify),
        verifyMethod: VERIFY_METHODS[rec.verify] || 'fingerprint',
        workCode: '',
        source: 'tcp',
      };
      if (addAttendanceLog(record) === false) continue;
      saved++;
      if (fresh.length <= 100) emit('attendance', record);
    }

    if (newest !== dev.lastRecordTime) {
      dev.lastRecordTime = newest;
      saveDevices();
    }

    addSyncLog({
      type: 'tcp_attendance_fetch',
      status: 'success',
      deviceId,
      count: saved,
      message: `Fetched ${saved} new records from ${deviceId} (device has ${records.length})`,
    });

    emit('state_update', { type: 'attendance', count: saved });
    return { success: true, count: saved, total: records.length };
  } catch (err) {
    logger.error(`Failed to fetch attendance from ${deviceId}: ${err.message}`);
    addSyncLog({ type: 'tcp_attendance_fetch', status: 'error', deviceId, message: err.message });
    return { success: false, error: err.message };
  }
}

// Scheduled pull: only records newer than the last one seen on each device
async function pullAttendanceFromAllTCP() {
  let fetched = 0;
  for (const id of Object.keys(tcpDevices)) {
    const r = await fetchAttendanceFromTCP(id, null, null, { onlyNew: true });
    if (r.success) fetched += r.count;
  }
  return fetched;
}

async function syncEmployeesToTCP(deviceId, employees) {
  if (!tcpDevices[deviceId]) return { success: false, error: 'Device not found' };
  try {
    const r = await withDevice(deviceId, d => d.syncUsers(employees));
    r.errors.forEach(e => logger.warn(`TCP ${deviceId}: failed to sync employee ${e}`));

    updateDevice(deviceId, { employeesSynced: r.synced });
    addSyncLog({
      type: 'employee_sync_tcp',
      status: r.failed ? 'partial' : 'success',
      deviceId,
      count: r.synced,
      message: `Synced ${r.synced}/${employees.length} employees to ${deviceId}`,
    });
    return { success: r.failed === 0, synced: r.synced, failed: r.failed, total: employees.length, error: r.errors[0] };
  } catch (err) {
    logger.error(`Failed to sync employees to ${deviceId}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function getEmployeesFromDevice(deviceId) {
  if (!tcpDevices[deviceId]) return { success: false, error: 'Device not found' };
  try {
    const users = await withDevice(deviceId, d => d.getUsers());
    return { success: true, employees: users.map(toBridgeEmployee) };
  } catch (err) {
    logger.error(`Failed to get employees from ${deviceId}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function setEmployeeOnDevice(deviceId, emp) {
  const r = await syncEmployeesToTCP(deviceId, [emp]);
  if (r.success) addSyncLog({ type: 'employee_set', status: 'success', deviceId, message: `Set employee UID=${emp.uid} on ${deviceId}` });
  return { success: r.success, error: r.error };
}

async function deleteEmployeeFromDevice(deviceId, uid, employeeId) {
  if (!tcpDevices[deviceId]) return { success: false, error: 'Device not found' };
  const userId = String(employeeId || uid);
  try {
    const removed = await withDevice(deviceId, d => d.removeUser(userId));
    if (removed) addSyncLog({ type: 'employee_delete', status: 'success', deviceId, message: `Deleted employee ${userId} from ${deviceId}` });
    return { success: true, removed };
  } catch (err) {
    logger.error(`Failed to delete employee ${userId} from ${deviceId}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// One-off helpers for a device that is not registered
async function withTemporaryDevice(ip, port, fn) {
  const dev = new ZKDevice({ ip, port, timeout: 8000, id: `temp-${ip}` });
  return dev.session(fn);
}

async function getEmployeesFromIP(ip, port = 4370) {
  try {
    const users = await withTemporaryDevice(ip, port, d => d.getUsers());
    return { success: true, employees: users.map(toBridgeEmployee) };
  } catch (err) {
    logger.error(`Failed to get employees from ${ip}:${port} — ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function setEmployeeViaIP(ip, port = 4370, emp) {
  try {
    const r = await withTemporaryDevice(ip, port, d => d.syncUsers([emp]));
    return { success: r.synced === 1, error: r.errors[0] };
  } catch (err) {
    logger.error(`Failed to set employee on ${ip}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function deleteEmployeeViaIP(ip, port = 4370, uid, employeeId) {
  try {
    const removed = await withTemporaryDevice(ip, port, d => d.removeUser(String(employeeId || uid)));
    return { success: true, removed };
  } catch (err) {
    logger.error(`Failed to delete employee ${employeeId || uid} from ${ip}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function disconnectTCPDevice(deviceId) {
  if (tcpDevices[deviceId]) {
    delete tcpDevices[deviceId];
    saveDevices();
  }
  if (store.devices[deviceId] && store.devices[deviceId].type === 'tcp') {
    updateDevice(deviceId, { status: 'disconnected' });
    delete store.devices[deviceId];
    emit('state_update', { type: 'device_update' });
  }
}

module.exports = {
  ZKDevice,
  initTCPDevices,
  connectTCPDevice,
  fetchAttendanceFromTCP,
  pullAttendanceFromAllTCP,
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
