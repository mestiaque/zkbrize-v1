const http = require('http');
const logger = require('../logger');
const { addDevice, updateDevice, addAttendanceLog, store } = require('../store');
const { pushAttendanceSingle } = require('../laravel/api');

let io = null;
let admsServer = null;

function setSocketIO(socketio) { io = socketio; }
function emit(event, data) { if (io) io.emit(event, data); }

// ── ADMS Command Queue ─────────────────────────────────────────────
const deviceCommandQueue = {};   // sn -> [{ id, cmd }, ...]  (array, FIFO)
const cmdOwnership = {};         // cmdId -> { key, isLast } — tracks which promise owns which cmd
const pendingUserRequests = {};  // key -> { resolve, reject, timer }
const pendingOptionPush = new Set();
const deviceUserCache = {};      // sn -> { employees, receivedAt } — last push from device
let cmdSerial = 1;

function enqueue(sn, commands) {
  if (!deviceCommandQueue[sn]) deviceCommandQueue[sn] = [];
  deviceCommandQueue[sn].push(...commands);
}

function clearQueue(sn) {
  (deviceCommandQueue[sn] || []).forEach(c => delete cmdOwnership[c.id]);
  delete deviceCommandQueue[sn];
}

// Build UPDATE commands for employees.
// Always tries DATA UPDATE tablename=UserInfo first (preserves biometrics).
// If device returns -1004 (user doesn't exist yet), the devicecmd handler
// automatically falls back to DELETE+INSERT for that specific employee.
function buildUpsertCommands(empsToSync) {
  const commands = [];
  for (const e of empsToSync) {
    const pin  = String(e.employee_id || e.employeeId || e.uid || '');
    const name = (e.name || '').slice(0, 24).replace(/[&=\r\n\t]/g, ' ');
    const pri  = e.privilege || 0;
    const pass = e.password || '';
    // Use the exact field format the device itself sends in OPERLOG USER records.
    // Mismatched fields (TZ, Verify, Card) may cause the device to silently ignore name updates.
    commands.push({
      id: cmdSerial++,
      cmd: `DATA UPDATE tablename=UserInfo PIN=${pin}\tName=${name}\tPri=${pri}\tPasswd=${pass}\tCard=\tGrp=1\tTZ=0000000000000000\tVerify=-1\tViceCard=\tStartDatetime=0\tEndDatetime=0`,
      emp: e,
    });
  }
  return commands;
}

function requestUsersFromADMS(sn) {
  // Cache hit — return immediately, trigger background refresh
  const cache = deviceUserCache[sn];
  if (cache && cache.employees.length > 0) {
    const ageMin = (Date.now() - cache.receivedAt) / 60000;
    logger.info(`ADMS returning cached user list for SN=${sn} (${cache.employees.length} users, ${Math.round(ageMin)}min ago)`);
    pendingOptionPush.add(sn);
    return Promise.resolve({ employees: cache.employees, fromCache: true });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      delete pendingUserRequests[sn];
      pendingOptionPush.delete(sn);
      reject(new Error(
        'Device did not push user list in 30s. ' +
        'This firmware may not support user sync via ADMS. ' +
        'To fix: on device go to Menu → Comm → ADMS → and enable "Push User Data", then try again.'
      ));
    }, 30000);

    pendingUserRequests[sn] = { resolve, reject, timer };

    // Approach 1: UserInfoStamp=None in next option block (standard ADMS pull trigger)
    pendingOptionPush.add(sn);

    // Approach 2: DATA QUERY UserInfo command — some firmware versions respond to this
    // by POSTing their full user list to /iclock/cdata?table=UserInfo
    const qId = cmdSerial++;
    cmdOwnership[qId] = { key: sn, isLast: false, ignoreError: true };
    enqueue(sn, [{ id: qId, cmd: 'DATA QUERY UserInfo' }]);

    logger.info(`ADMS user list request for SN=${sn}: queued UserInfoStamp=None + DATA QUERY UserInfo`);
  });
}

// empList: explicit list override (used by push-to-devices for filtered unsynced employees)
function requestSetUserOnADMS(sn, emp, _isNew = false, empList = null) {
  return new Promise((resolve, reject) => {
    const empsToSync = empList || (emp ? [emp] : Object.values(store.employees));
    if (!empsToSync.length) { resolve([]); return; }

    const commands = buildUpsertCommands(empsToSync);

    const key = `set-${sn}`;
    const lastId = commands[commands.length - 1].id;
    commands.forEach(c => { cmdOwnership[c.id] = { key, isLast: c.id === lastId, ignoreError: c.ignoreError || false, emp: c.emp }; });

    const timer = setTimeout(() => {
      delete pendingUserRequests[key];
      commands.forEach(c => delete cmdOwnership[c.id]);
      reject(new Error('Timeout: device did not acknowledge user update.'));
    }, 20000 + empsToSync.length * 3000);

    pendingUserRequests[key] = { resolve, reject, timer, type: 'set', emps: empsToSync };
    enqueue(sn, commands);
    logger.info(`ADMS queued ${commands.length} commands for ${empsToSync.length} employee(s) SN=${sn}`);
  });
}

function requestDeleteUserOnADMS(sn, uid) {
  return new Promise((resolve, reject) => {
    const id  = cmdSerial++;
    const cmd = `DATA DELETE UserInfo PIN=${uid}`;
    const key = `del-${sn}`;

    cmdOwnership[id] = { key, isLast: true };

    const timer = setTimeout(() => {
      delete pendingUserRequests[key];
      delete cmdOwnership[id];
      reject(new Error('Timeout: device did not acknowledge user delete.'));
    }, 20000);

    pendingUserRequests[key] = { resolve, reject, timer, type: 'delete' };
    enqueue(sn, [{ id, cmd }]);
    logger.info(`ADMS queued DATA DELETE UserInfo for SN=${sn} UID=${uid}`);
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

          // Device fetching users from server — resolve any pending load-from-device promise
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
          // Cache the device's user list for Load from Machine
          deviceUserCache[sn] = { employees: parsed, receivedAt: Date.now() };
          // Mark them as synced (they exist on the device)
          const { markEmployeesSynced } = require('../store');
          markEmployeesSynced(parsed.map(e => String(e.uid)));
          emit('state_update', { type: 'employees' });

          // Resolve any pending requestUsersFromADMS promise
          const pending = pendingUserRequests[sn];
          if (pending) {
            clearTimeout(pending.timer);
            delete pendingUserRequests[sn];
            pending.resolve({ employees: parsed, fromCache: false });
          }

          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('OK');
          return;
        }

        // ── OPERLOG may contain USER records (device response to DATA QUERY UserInfo) ──
        // This firmware (MB10-VL Ver2.0.14) sends user data inside OPERLOG rather than
        // table=UserInfo when responding to DATA QUERY UserInfo.
        if (table === 'OPERLOG' || table === 'operlog') {
          const userLines = recordLines.filter(l => /^USER[\t ]/.test(l) && l.includes('PIN='));
          if (userLines.length > 0) {
            logger.info(`ADMS ${sn} OPERLOG has ${userLines.length} USER records (DATA QUERY response)`);

            if (!deviceUserCache[sn] || !deviceUserCache[sn].collecting) {
              deviceUserCache[sn] = { employees: [], receivedAt: Date.now(), collecting: true };
            }
            const cache = deviceUserCache[sn];

            for (const line of userLines) {
              const parts = line.split('\t');
              const kv = {};
              for (const p of parts.slice(1)) {
                const idx = p.indexOf('=');
                if (idx >= 0) kv[p.slice(0, idx)] = p.slice(idx + 1).trim();
              }
              // Fallback: space-separated format (some firmware variants)
              if (!kv.PIN) {
                const m = line.match(/PIN=(\S+)/);
                if (m) kv.PIN = m[1];
                const nm = line.match(/Name=(.+?)\s+(?:Pri|Passwd|Card|Grp|TZ|Verify)=/);
                if (nm) kv.Name = nm[1].trim();
                const pm = line.match(/Pri=(\d+)/);
                if (pm) kv.Pri = pm[1];
                const pw = line.match(/Passwd=(\S*)/);
                if (pw) kv.Passwd = pw[1];
              }
              const pin = kv.PIN || '';
              if (!pin || pin === 'PIN') continue;
              cache.employees.push({
                uid: parseInt(pin) || 0,
                employee_id: pin,
                name: kv.Name || '',
                privilege: parseInt(kv.Pri || '0') || 0,
                password: kv.Passwd || '',
              });
            }

            logger.info(`ADMS ${sn} total users collected so far: ${cache.employees.length}`);

            // Debounce: if no more USER records arrive in 3s, consider collection complete
            if (cache.resolveTimer) clearTimeout(cache.resolveTimer);
            cache.resolveTimer = setTimeout(() => {
              cache.collecting = false;
              delete cache.resolveTimer;
              cache.receivedAt = Date.now();

              const valid = cache.employees.filter(e => e.uid > 0);
              logger.info(`ADMS ${sn} user collection complete: ${valid.length} users from OPERLOG`);

              // Resolve the pending load-from-device promise.
              // Intentionally NOT calling upsertEmployee here — the route does that
              // explicitly so it can control overwrite behaviour and avoid stale re-imports.
              const pending = pendingUserRequests[sn];
              if (pending) {
                clearTimeout(pending.timer);
                delete pendingUserRequests[sn];
                pending.resolve({ employees: valid, fromCache: false });
              }
            }, 3000);
          }
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

        // If a "load from device" was requested, send option block with UserInfoStamp=0.
        // Some firmware responds to 0 but ignores "None"; others need None.
        // DATA QUERY UserInfo command (queued separately) is a second-attempt trigger.
        if (pendingOptionPush.has(sn)) {
          pendingOptionPush.delete(sn);
          logger.info(`ADMS sending option block with UserInfoStamp=0 to SN=${sn} (load-from-device trigger)`);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(
            `GET OPTION FROM: ${sn}\r\n` +
            `ATTLOGStamp=None\r\n` +
            `OPERLOGStamp=9999\r\n` +
            `ATTPHOTOStamp=None\r\n` +
            `UserInfoStamp=0\r\n` +
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

        // Dequeue and send the next pending command for this device
        if (deviceCommandQueue[sn] && deviceCommandQueue[sn].length > 0) {
          const { id, cmd } = deviceCommandQueue[sn].shift();
          if (deviceCommandQueue[sn].length === 0) delete deviceCommandQueue[sn];
          const remaining = deviceCommandQueue[sn]?.length || 0;
          logger.info(`ADMS sending command to SN=${sn} [${remaining} remaining]: C:${id}:${cmd.slice(0,80)}`);
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
        // Device sends the command ID back as "ID" field
        const cmdId = parseInt(ack.ID ?? ack.CmdID ?? '-1');
        logger.info(`ADMS devicecmd ACK SN=${sn2} Return=${returnCode} ID=${cmdId} CMD=${ack.CMD || ''}`);

        if (returnCode === 0) {
          // Resolve by command ID if ownership is tracked
          if (cmdOwnership[cmdId]) {
            const { key, isLast } = cmdOwnership[cmdId];
            delete cmdOwnership[cmdId];
            if (isLast) {
              const p = pendingUserRequests[key];
              if (p) { clearTimeout(p.timer); p.resolve(p.emps || []); delete pendingUserRequests[key]; }
            } else {
              logger.info(`ADMS cmd ${cmdId} ACK Return=0 (not last — waiting for device data push)`);
            }
          } else {
            // Fallback: resolve any set/del promise for this SN
            const setP = pendingUserRequests[`set-${sn2}`];
            const delP = pendingUserRequests[`del-${sn2}`];
            if (setP && !deviceCommandQueue[sn2]?.length) {
              clearTimeout(setP.timer); setP.resolve(true); delete pendingUserRequests[`set-${sn2}`];
            }
            if (delP) { clearTimeout(delP.timer); delP.resolve(true); delete pendingUserRequests[`del-${sn2}`]; }
          }
        } else if (returnCode < 0) {
          const ownership = cmdOwnership[cmdId];
          if (ownership?.ignoreError) {
            logger.info(`ADMS cmd ${cmdId} failed with ${returnCode} (ignored — continuing queue)`);
            delete cmdOwnership[cmdId];
          } else if (returnCode === -1004 && ownership?.emp) {
            // UPDATE tablename=UserInfo failed — user doesn't exist on device yet.
            // Fall back to DELETE+INSERT so the employee is created without losing
            // any other employees' biometrics.
            const e = ownership.emp;
            const pin  = String(e.employee_id || e.employeeId || e.uid || '');
            const name = (e.name || '').slice(0, 24).replace(/[&=\r\n\t]/g, ' ');
            const pri  = e.privilege || 0;
            const pass = e.password || '';
            const delId = cmdSerial++;
            const insId = cmdSerial++;
            const key = ownership.key;
            cmdOwnership[delId] = { key, isLast: false, ignoreError: true };
            cmdOwnership[insId] = { key, isLast: true };
            enqueue(sn2, [
              { id: delId, cmd: `DATA DELETE UserInfo PIN=${pin}` },
              { id: insId, cmd: `DATA UPDATE UserInfo PIN=${pin}\tName=${name}\tPri=${pri}\tPasswd=${pass}\tCard=0\tGrp=1\tTZ=0000111100000000\tVerify=0\tViceCard=0` },
            ]);
            delete cmdOwnership[cmdId];
            logger.info(`ADMS cmd ${cmdId} UPDATE -1004 — falling back to DELETE+INSERT for PIN=${pin}`);
          } else {
            const key = ownership?.key;
            const candidates = key
              ? [pendingUserRequests[key]]
              : [pendingUserRequests[`set-${sn2}`], pendingUserRequests[`del-${sn2}`], pendingUserRequests[sn2]];
            for (const p of candidates) {
              if (!p) continue;
              clearTimeout(p.timer);
              p.reject(new Error(`Device returned error ${returnCode} for command ${cmdId}`));
            }
            if (key) delete pendingUserRequests[key];
            if (cmdId >= 0) delete cmdOwnership[cmdId];
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

module.exports = { startADMSServer, restartADMSServer, setSocketIO, requestUsersFromADMS, requestSetUserOnADMS, requestDeleteUserOnADMS, pendingOptionPush, deviceUserCache };
