const http = require('http');
const logger = require('../logger');
const { addDevice, updateDevice, addAttendanceLog, store } = require('../store');
const { pushAttendanceSingle } = require('../laravel/api');

let io = null;
let admsServer = null;

function setSocketIO(socketio) { io = socketio; }
function emit(event, data) { if (io) io.emit(event, data); }

// ── ADMS Command Queue ─────────────────────────────────────────────
const deviceCommandQueue = {};   // sn -> { id, cmd }
const pendingUserRequests = {};  // sn -> { resolve, reject, timer }
const pendingOptionPush = new Set(); // SNs that need a full option block on next getrequest
let cmdSerial = 1;

function requestUsersFromADMS(sn) {
  // Respond to the device's next getrequest with the full option block including UserInfoStamp=None.
  // Device processes the options and POSTs its user list to /iclock/cdata?table=UserInfo.
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      delete pendingUserRequests[sn];
      pendingOptionPush.delete(sn);
      const existing = Object.values(store.employees);
      if (existing.length) resolve(existing);
      else reject(new Error('Device did not send user data within 30s. Try clicking "Load from Machine" again.'));
    }, 30000);

    pendingUserRequests[sn] = { resolve, reject, timer };
    pendingOptionPush.add(sn); // flag: next getrequest gets full option block
    delete deviceCommandQueue[sn]; // clear any pending command
    logger.info(`ADMS flagged option-push for SN=${sn} — next getrequest will include UserInfoStamp=None`);
  });
}

function buildUserInfoCmd(employees) {
  // DATA UPDATE tablename=UserInfo with inline tab-separated rows — no GET needed
  let cmd = 'DATA UPDATE tablename=UserInfo\r\nPIN\tName\tPri\tPasswd\tCard\tGrpTmp\tTimeZone\tVerify\tViceCard\r\n';
  for (const e of employees) {
    const pin  = String(e.employee_id || e.employeeId || e.uid || '');
    const name = (e.name || '').slice(0, 24).replace(/\t/g, ' ');
    const pri  = e.privilege || 0;
    const pass = e.password || '';
    cmd += `${pin}\t${name}\t${pri}\t${pass}\t0\t1\t0000111100000000\t0\t0\r\n`;
  }
  return cmd;
}

function requestSetUserOnADMS(sn, emp) {
  return new Promise((resolve, reject) => {
    // Include ALL bridge employees so device user list stays in sync
    const allEmps = Object.values(store.employees);
    const cmd = buildUserInfoCmd(allEmps.length ? allEmps : [emp]);

    const timer = setTimeout(() => {
      delete pendingUserRequests[`set-${sn}`];
      delete deviceCommandQueue[sn];
      reject(new Error('Timeout: device did not acknowledge user update.'));
    }, 20000);

    pendingUserRequests[`set-${sn}`] = { resolve, reject, timer, type: 'set' };
    deviceCommandQueue[sn] = { id: cmdSerial++, cmd };
    logger.info(`ADMS queued DATA UPDATE UserInfo for SN=${sn} (${allEmps.length} employees)`);
  });
}

function requestDeleteUserOnADMS(sn, uid) {
  return new Promise((resolve, reject) => {
    // After bridge delete, push full remaining employee list to device
    const allEmps = Object.values(store.employees);
    const cmd = allEmps.length
      ? buildUserInfoCmd(allEmps)
      : `DATA DELETE tablename=UserInfo PIN=${uid}`;

    const timer = setTimeout(() => {
      delete pendingUserRequests[`del-${sn}`];
      delete deviceCommandQueue[sn];
      reject(new Error('Timeout: device did not acknowledge user delete.'));
    }, 20000);

    pendingUserRequests[`del-${sn}`] = { resolve, reject, timer, type: 'delete' };
    deviceCommandQueue[sn] = { id: cmdSerial++, cmd };
    logger.info(`ADMS queued delete/update UserInfo for SN=${sn} UID=${uid}`);
  });
}

function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ` +
         `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

// Parse &-separated key=value pairs from a single line
function parseKV(str) {
  const out = {};
  (str || '').split('&').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const k = decodeURIComponent(pair.slice(0, idx).trim());
      const v = decodeURIComponent(pair.slice(idx + 1).trim());
      out[k] = v;
    }
  });
  return out;
}

// ADMS POST body: header key=value lines, then tab-separated record lines
// Some devices also send records in a URL-encoded "Content" field
function parseADMSPost(body) {
  const headers = {};
  const recordLines = [];

  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.includes('\t')) {
      recordLines.push(t);
    } else {
      Object.assign(headers, parseKV(t));
    }
  }

  // MB10-VL and some newer devices put records in "Content" param (URL-encoded)
  if (recordLines.length === 0 && headers.Content) {
    const decoded = decodeURIComponent(headers.Content.replace(/\+/g, ' '));
    for (const line of decoded.split(/\r?\n/)) {
      const t = line.trim();
      if (t && t.includes('\t')) recordLines.push(t);
    }
  }

  return { headers, recordLines };
}

function startADMSServer(port) {
  admsServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      const urlPath = req.url.split('?')[0];
      const method = req.method;

      // Log everything so we can see exactly what the device sends
      logger.info(`ADMS RAW ${method} ${req.url} | headers.sn=${req.headers['sn'] || '-'} | body: ${body.slice(0, 400)}`);

      // ── Initial handshake: GET /iclock/cdata ──────────────────
      if (urlPath === '/iclock/cdata' && method === 'GET') {
        const qs = Object.fromEntries(new URL('http://x' + req.url).searchParams);
        const sn = qs.SN || req.headers['sn'] || 'UNKNOWN';

        // ── User data download request (from DATA SYNCHRONIZE command) ──
        // Device calls GET /iclock/cdata?table=user to fetch users from server.
        // This GET itself proves DATA SYNCHRONIZE succeeded — resolve pending set/del promises here.
        if (qs.table && qs.table.toLowerCase().includes('user')) {
          logger.info(`ADMS user data request from SN=${sn} table=${qs.table}`);
          const employees = Object.values(store.employees);
          let userBody = 'OK\r\n';
          if (employees.length) {
            userBody += 'PIN\tName\tPri\tPasswd\tCard\tGrpTmp\tTimeZone\tVerify\tViceCard\r\n';
            for (const e of employees) {
              const pin  = String(e.employee_id || e.employeeId || e.uid || '');
              const name = (e.name || '').slice(0, 24);
              const pri  = e.privilege || 0;
              const pass = e.password || '';
              userBody += `${pin}\t${name}\t${pri}\t${pass}\t0\t1\t0000111100000000\t0\t0\r\n`;
            }
          }
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(userBody);

          // Device fetching from us = sync command succeeded — resolve any pending promise
          const setP = pendingUserRequests[`set-${sn}`];
          const delP = pendingUserRequests[`del-${sn}`];
          if (setP) { clearTimeout(setP.timer); setP.resolve(true); delete pendingUserRequests[`set-${sn}`]; }
          if (delP) { clearTimeout(delP.timer); delP.resolve(true); delete pendingUserRequests[`del-${sn}`]; }
          return;
        }

        logger.info(`ADMS handshake from SN=${sn} ip=${req.socket.remoteAddress}`);

        if (!store.devices[sn]) {
          addDevice({
            id: sn, sn, type: 'adms',
            name: `ADMS Device (${sn.slice(-6)})`,
            ip: req.socket.remoteAddress,
            model: qs.DeviceName || 'ZKTeco',
            firmware: qs.FWVersion || '',
          });
          emit('device_connected', { deviceId: sn, type: 'adms' });
        } else {
          updateDevice(sn, { status: 'connected', ip: req.socket.remoteAddress, lastSeen: new Date().toISOString() });
        }
        emit('state_update', { type: 'device_update' });

        // Respond with server options — \r\n required by ADMS spec
        // UserInfoStamp=None triggers device to push its full user list on connect
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(
          `GET OPTION FROM: ${sn}\r\n` +
          `ATTLOGStamp=None\r\n` +
          `OPERLOGStamp=9999\r\n` +
          `ATTPHOTOStamp=None\r\n` +
          `UserInfoStamp=None\r\n` +
          `ErrorDelay=30\r\n` +
          `Delay=10\r\n` +
          `TransTimes=00:00;14:05\r\n` +
          `TransInterval=1\r\n` +
          `TransFlag=TransData AttLog OpLog AttPhoto UserInfo\r\n` +
          `TimeZone=6\r\n` +
          `Realtime=1\r\n` +
          `Encrypt=None\r\n` +
          `ServerVer=2.4.1\r\n` +
          `TableNameStamp=None\r\n` +
          `DateTime=${nowStr()}\r\n`
        );
        return;
      }

      // ── Data push: POST /iclock/cdata ─────────────────────────
      // Body: header lines (SN=X&table=ATTLOG&Stamp=Y) then tab-separated records
      if (urlPath === '/iclock/cdata' && method === 'POST') {
        const { headers: hdrs, recordLines } = parseADMSPost(body);
        // SN can come from: body headers, URL query string, or HTTP header
        const qs = Object.fromEntries(new URL('http://x' + req.url).searchParams);
        const sn = hdrs.SN || qs.SN || req.headers['sn'] || req.headers['SN'] || 'UNKNOWN';
        const table = hdrs.table || qs.table || '';

        logger.info(`ADMS POST SN=${sn} table=${table} recordLines=${recordLines.length}`);
        updateDevice(sn, { status: 'connected', lastSeen: new Date().toISOString() });

        // ── User data pushed by device (triggered by UserInfoStamp=None) ──
        const tl = table.toLowerCase();
        if (tl === 'user' || tl === 'userinfo' || tl === 'user_info') {
          logger.info(`ADMS ${sn} pushed user data: ${recordLines.length} record lines`);

          const { upsertEmployee } = require('../store');
          const parsed = [];

          for (const line of recordLines) {
            const p = line.split('\t');
            const pin = p[0]?.trim() || '';
            if (!pin || /^PIN$/i.test(pin)) continue; // skip header row
            const emp = {
              uid: parseInt(pin) || 0,
              employee_id: pin,
              name: p[1]?.trim() || '',
              privilege: parseInt(p[2]) || 0,
              password: p[3]?.trim() || '',
            };
            if (emp.uid) {
              upsertEmployee(emp);
              parsed.push(emp);
            }
          }

          logger.info(`ADMS ${sn} saved ${parsed.length} employees from device push`);
          emit('state_update', { type: 'employees' });

          // Also resolve any pending requestUsersFromADMS promise
          const pending = pendingUserRequests[sn];
          if (pending) {
            clearTimeout(pending.timer);
            delete pendingUserRequests[sn];
            pending.resolve(parsed);
          }

          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('OK');
          return;
        }

        // ── Command ACK (device confirms SET/DELETE completed) ────────
        if (table === 'CMD_ACK' || table === 'cmd_ack' || table === '') {
          const setKey = `set-${sn}`;
          const delKey = `del-${sn}`;
          if (pendingUserRequests[setKey]) {
            clearTimeout(pendingUserRequests[setKey].timer);
            pendingUserRequests[setKey].resolve(true);
            delete pendingUserRequests[setKey];
          } else if (pendingUserRequests[delKey]) {
            clearTimeout(pendingUserRequests[delKey].timer);
            pendingUserRequests[delKey].resolve(true);
            delete pendingUserRequests[delKey];
          }
        }

        // Accept ATTLOG or empty table (some devices omit it)
        if (table === 'ATTLOG' || table === '') {
          let pushed = 0;
          for (const line of recordLines) {
            const parts = line.split('\t');
            // Format: PIN \t Time \t Status \t Verify \t WorkCode \t Reserved
            if (parts.length >= 2 && parts[0].trim()) {
              const verifyCode = parts[3]?.trim() || '1';
              const verifyMap = { '0':'password', '1':'fingerprint', '2':'face', '3':'card', '4':'fingerprint', '15':'face' };
              const record = {
                deviceId: sn,
                employeeId: parts[0].trim(),
                time: parts[1].trim(),
                status: parts[2]?.trim() || '0',
                verify: verifyCode,
                verifyMethod: verifyMap[verifyCode] || 'fingerprint',
                workCode: parts[4]?.trim() || '',
                source: 'adms',
                receivedAt: new Date().toISOString(),
              };
              addAttendanceLog(record);
              emit('attendance', record);
              if (store.config.laravelApiUrl) {
                pushAttendanceSingle(record).catch(() => {});
              }
              pushed++;
            }
          }
          if (pushed > 0) {
            logger.info(`ADMS ${sn} saved ${pushed} attendance records`);
          } else if (recordLines.length === 0) {
            logger.info(`ADMS ${sn} POST received but no record lines found — check RAW log above`);
          }
          emit('state_update', { type: 'attendance', count: pushed });
        }

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`OK: ${table}`);
        return;
      }

      // ── Heartbeat: GET /iclock/getrequest ─────────────────────
      if (urlPath === '/iclock/getrequest') {
        const qs = Object.fromEntries(new URL('http://x' + req.url).searchParams);
        const sn = qs.SN || req.headers['sn'] || 'UNKNOWN';

        if (!store.devices[sn]) {
          const ip = req.socket.remoteAddress;
          let model = 'ZKTeco (ADMS)';
          if (qs.INFO) { const p = qs.INFO.split(','); if (p[0]) model = p[0]; }
          logger.info(`ADMS device re-registered from heartbeat: SN=${sn} ip=${ip}`);
          addDevice({ id: sn, sn, type: 'adms', name: `ADMS Device (${sn.slice(-6)})`, ip, model });
          emit('device_connected', { deviceId: sn, type: 'adms' });
        } else {
          updateDevice(sn, { status: 'connected', lastSeen: new Date().toISOString() });
        }

        emit('state_update', { type: 'device_update' });

        // If a "load from device" was requested, send the full option block.
        // UserInfoStamp=None tells the device to push ALL its registered users.
        if (pendingOptionPush.has(sn)) {
          pendingOptionPush.delete(sn);
          logger.info(`ADMS sending option block with UserInfoStamp=None to SN=${sn} (load-from-device trigger)`);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(
            `GET OPTION FROM: ${sn}\r\n` +
            `ATTLOGStamp=None\r\n` +
            `OPERLOGStamp=9999\r\n` +
            `ATTPHOTOStamp=None\r\n` +
            `UserInfoStamp=None\r\n` +
            `ErrorDelay=30\r\n` +
            `Delay=10\r\n` +
            `TransTimes=00:00;14:05\r\n` +
            `TransInterval=1\r\n` +
            `TransFlag=TransData AttLog OpLog AttPhoto UserInfo\r\n` +
            `TimeZone=6\r\n` +
            `Realtime=1\r\n` +
            `Encrypt=None\r\n` +
            `ServerVer=2.4.1\r\n` +
            `TableNameStamp=None\r\n` +
            `DateTime=${nowStr()}\r\n`
          );
          return;
        }

        // If there's a pending command for this device, send it now
        if (deviceCommandQueue[sn]) {
          const { id, cmd } = deviceCommandQueue[sn];
          delete deviceCommandQueue[sn];
          logger.info(`ADMS sending command to SN=${sn}: C:${id}:${cmd}`);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(`C:${id}:${cmd}`);
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
      }

      // ── Device acknowledges a server command ──────────────────
      if (urlPath === '/iclock/devicecmd') {
        const qs2 = Object.fromEntries(new URL('http://x' + req.url).searchParams);
        const sn2 = qs2.SN || req.headers['sn'] || 'UNKNOWN';
        const ack = parseKV(body);
        const returnCode = parseInt(ack.Return ?? '0');
        logger.info(`ADMS devicecmd ACK SN=${sn2} Return=${returnCode} CMD=${ack.CMD || ''}`);

        if (returnCode === 0) {
          // Command succeeded — resolve set/delete pending promises
          const setP = pendingUserRequests[`set-${sn2}`];
          const delP = pendingUserRequests[`del-${sn2}`];
          if (setP) { clearTimeout(setP.timer); setP.resolve(true); delete pendingUserRequests[`set-${sn2}`]; }
          if (delP) { clearTimeout(delP.timer); delP.resolve(true); delete pendingUserRequests[`del-${sn2}`]; }
        } else if (returnCode < 0) {
          // Device rejected the command — fail pending promise immediately
          const pending = pendingUserRequests[sn2];
          const setP   = pendingUserRequests[`set-${sn2}`];
          const delP   = pendingUserRequests[`del-${sn2}`];
          const p = pending || setP || delP;
          if (p) {
            clearTimeout(p.timer);
            if (pending) delete pendingUserRequests[sn2];
            if (setP)    delete pendingUserRequests[`set-${sn2}`];
            if (delP)    delete pendingUserRequests[`del-${sn2}`];
            p.reject(new Error(`Device returned error ${returnCode} — check Logs page for details`));
          }
        }

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    });
  });

  admsServer.listen(port, '0.0.0.0', () => {
    logger.info(`ADMS server listening on port ${port}`);
  });
  admsServer.on('error', err => {
    logger.error(`ADMS server error: ${err.message}`);
  });

  return admsServer;
}

function restartADMSServer(newPort) {
  return new Promise((resolve, reject) => {
    if (admsServer && admsServer.listening) {
      admsServer.close((err) => {
        if (err) { logger.error('Error closing ADMS server: ' + err.message); }
        admsServer = null;
        startADMSServer(newPort);
        logger.info(`ADMS server restarted on port ${newPort}`);
        resolve(newPort);
      });
    } else {
      startADMSServer(newPort);
      logger.info(`ADMS server started on port ${newPort}`);
      resolve(newPort);
    }
  });
}

module.exports = { startADMSServer, restartADMSServer, setSocketIO, requestUsersFromADMS, requestSetUserOnADMS, requestDeleteUserOnADMS, pendingOptionPush };
