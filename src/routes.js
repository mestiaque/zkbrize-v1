const express = require('express');
const router = express.Router();
const os = require('os');
const { exec } = require('child_process');
const { store, getState, clearLogs, upsertEmployee, deleteEmployee, markAttendancePushed, markEmployeesSynced, savePermissions, DEFAULT_PERMISSIONS, saveConfigFile } = require('./store');
const { testConnection, fetchEmployees, pushAttendance } = require('./laravel/api');
const { connectTCPDevice, fetchAttendanceFromTCP, disconnectTCPDevice, syncEmployeesToTCP, getEmployeesFromDevice, setEmployeeOnDevice, deleteEmployeeFromDevice } = require('./tcpip/connector');
const { requestSetUserOnADMS, requestDeleteUserOnADMS, requestUsersFromADMS, pendingOptionPush, restartADMSServer, deviceUserCache } = require('./adms/server');
const { runEmployeeSync, runAttendanceFetch, updateSchedule, getSchedulerStatus } = require('./scheduler');
const logger = require('./logger');
const fs = require('fs');
const path = require('path');

// ── Permissions ────────────────────────────────────────────────────
router.get('/permissions', (req, res) => {
  res.json({ permissions: store.permissions, defaults: DEFAULT_PERMISSIONS });
});

router.post('/permissions', (req, res) => {
  const perms = req.body;
  if (!perms || typeof perms !== 'object') return res.status(400).json({ success: false, error: 'Invalid permissions' });
  savePermissions(perms);
  res.json({ success: true });
});

// ── State ──────────────────────────────────────────────────────────
router.get('/state', (req, res) => {
  res.json(getState());
});

// ── Config ─────────────────────────────────────────────────────────
router.get('/config', (req, res) => {
  const ifaces = os.networkInterfaces();
  let serverIp = '';
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        serverIp = iface.address;
        break;
      }
    }
    if (serverIp) break;
  }

  res.json({
    laravelApiUrl: store.config.laravelApiUrl,
    fetchEmployeeUrl: store.config.fetchEmployeeUrl,
    syncAttendanceUrl: store.config.syncAttendanceUrl,
    admsPort: store.config.admsPort,
    syncSchedule: store.config.syncSchedule,
    attendanceFetchSchedule: store.config.attendanceFetchSchedule,
    employeeSyncEnabled: store.config.employeeSyncEnabled !== false,
    attendanceSyncEnabled: store.config.attendanceSyncEnabled !== false,
    hasToken: !!store.config.laravelApiToken,
    serverIp,
    schedulerStatus: getSchedulerStatus(),
  });
});

router.post('/config', (req, res) => {
  const { laravelApiUrl, laravelApiToken, fetchEmployeeUrl, syncAttendanceUrl, syncSchedule, attendanceFetchSchedule, employeeSyncEnabled, attendanceSyncEnabled, admsPort } = req.body;
  if (laravelApiUrl !== undefined) store.config.laravelApiUrl = laravelApiUrl.trim();
  if (laravelApiToken !== undefined && laravelApiToken !== '••••••••') {
    store.config.laravelApiToken = laravelApiToken.trim();
  }
  if (fetchEmployeeUrl !== undefined) store.config.fetchEmployeeUrl = fetchEmployeeUrl.trim();
  if (syncAttendanceUrl !== undefined) store.config.syncAttendanceUrl = syncAttendanceUrl.trim();
  if (syncSchedule !== undefined) store.config.syncSchedule = syncSchedule;
  if (attendanceFetchSchedule !== undefined) store.config.attendanceFetchSchedule = attendanceFetchSchedule;
  if (employeeSyncEnabled !== undefined) store.config.employeeSyncEnabled = Boolean(employeeSyncEnabled);
  if (attendanceSyncEnabled !== undefined) store.config.attendanceSyncEnabled = Boolean(attendanceSyncEnabled);
  if (admsPort !== undefined) {
    const newPort = parseInt(admsPort);
    if (newPort && newPort !== store.config.admsPort) {
      store.config.admsPort = newPort;
      restartADMSServer(newPort).catch(e => logger.error('ADMS restart failed: ' + e.message));
    }
  }

  // Apply schedule changes live (no restart needed)
  const scheduleChanged = syncSchedule !== undefined || attendanceFetchSchedule !== undefined ||
                          employeeSyncEnabled !== undefined || attendanceSyncEnabled !== undefined;
  if (scheduleChanged) updateSchedule();

  try {
    const envPath = path.join(__dirname, '../.env');
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const setEnv = (key, value) => {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(envContent)) envContent = envContent.replace(regex, `${key}=${value}`);
      else envContent += `\n${key}=${value}`;
    };
    if (laravelApiUrl) setEnv('LARAVEL_API_URL', store.config.laravelApiUrl);
    if (laravelApiToken && laravelApiToken !== '••••••••') setEnv('LARAVEL_API_TOKEN', store.config.laravelApiToken);
    if (fetchEmployeeUrl !== undefined) setEnv('FETCH_EMPLOYEE_URL', store.config.fetchEmployeeUrl);
    if (syncAttendanceUrl !== undefined) setEnv('SYNC_ATTENDANCE_URL', store.config.syncAttendanceUrl);
    if (syncSchedule !== undefined) setEnv('SYNC_SCHEDULE', store.config.syncSchedule);
    if (attendanceFetchSchedule !== undefined) setEnv('ATTENDANCE_FETCH_SCHEDULE', store.config.attendanceFetchSchedule);
    if (employeeSyncEnabled !== undefined) setEnv('EMPLOYEE_SYNC_ENABLED', store.config.employeeSyncEnabled ? 'true' : 'false');
    if (attendanceSyncEnabled !== undefined) setEnv('ATTENDANCE_SYNC_ENABLED', store.config.attendanceSyncEnabled ? 'true' : 'false');
    if (admsPort !== undefined) setEnv('ADMS_PORT', store.config.admsPort);
    fs.writeFileSync(envPath, envContent);
  } catch (e) {
    logger.warn('Could not persist config to .env: ' + e.message);
  }

  // Always save schedule/toggle state to data/config.json (more reliable than .env)
  saveConfigFile();

  res.json({ success: true, message: 'Config updated', schedulerStatus: getSchedulerStatus() });
});

// ── ERP ────────────────────────────────────────────────────────
router.post('/laravel/test', async (req, res) => {
  const result = await testConnection();
  res.json(result);
});

// Fetch employees from API and return to UI (no device push)
router.get('/laravel/employees', async (req, res) => {
  const result = await fetchEmployees();
  res.json(result);
});

// Push employee list to a specific device
router.post('/laravel/set-employees', async (req, res) => {
  const { deviceId } = req.body;
  const empResult = await fetchEmployees();
  if (!empResult.success) return res.json({ success: false, error: empResult.error });

  const device = deviceId ? store.devices[deviceId] : null;
  const targets = device ? [device] : Object.values(store.devices).filter(d => d.status === 'connected');

  if (targets.length === 0) return res.json({ success: false, error: 'No connected devices found' });

  // Import fetched employees into bridge store so ADMS can pick them up
  for (const emp of empResult.employees) {
    const uid = parseInt(emp.uid || emp.id || emp.employee_id || emp.pin || 0);
    if (!uid) continue;
    upsertEmployee({
      uid,
      employee_id: String(emp.employee_id || emp.pin || emp.card_no || uid),
      name: emp.name || (emp.first_name ? emp.first_name + (emp.last_name ? ' ' + emp.last_name : '') : '') || '',
      password: emp.password || '',
      privilege: parseInt(emp.privilege || 0) || 0,
    });
  }

  const results = [];
  for (const d of targets) {
    if (d.type === 'tcp') {
      const r = await syncEmployeesToTCP(d.id, empResult.employees);
      results.push({ deviceId: d.id, ...r });
    } else if (d.type === 'adms') {
      // Queue DATA UPDATE command — device receives it on next heartbeat
      requestSetUserOnADMS(d.id, null)
        .then(() => logger.info(`ADMS ${d.id}: bulk employee sync OK`))
        .catch(e => logger.warn(`ADMS ${d.id}: bulk employee sync failed: ${e.message}`));
      results.push({ deviceId: d.id, success: true, queued: true, count: empResult.employees.length });
    }
  }
  res.json({ success: true, results, total: empResult.employees.length });
});

router.post('/laravel/sync-employees', async (req, res) => {
  const result = await runEmployeeSync();
  res.json({ success: true, message: 'Employee sync triggered' });
});

router.post('/laravel/fetch-attendance', async (req, res) => {
  await runAttendanceFetch();
  res.json({ success: true, message: 'Attendance fetch triggered' });
});

router.post('/laravel/push-attendance', async (req, res) => {
  const allRecords = store.attendanceLogs;
  const unpushed = allRecords.filter(r => !r.pushedToERP);
  const records = req.body.onlyNew !== false ? unpushed : allRecords;
  if (!records.length) return res.json({ success: true, count: 0, message: 'All records already pushed' });
  const result = await pushAttendance(records);
  if (result.success) markAttendancePushed(records.map(r => r.id));
  res.json({ ...result, total: allRecords.length, pushed: records.length, alreadyPushed: allRecords.length - unpushed.length });
});

// Full sync: TCP fetch → push all to ERP
router.post('/laravel/sync-all', async (req, res) => {
  const steps = [];

  // Step 1: fetch from TCP devices
  const tcpDevices = Object.values(store.devices).filter(d => d.type === 'tcp' && d.status === 'connected');
  let tcpFetched = 0;
  for (const d of tcpDevices) {
    try {
      const r = await fetchAttendanceFromTCP(d.id);
      tcpFetched += r.count || 0;
      steps.push({ step: 'tcp_fetch', device: d.id, success: r.success, count: r.count || 0, error: r.error });
    } catch (e) {
      steps.push({ step: 'tcp_fetch', device: d.id, success: false, error: e.message });
    }
  }

  // ADMS data is already in store (pushed in real-time)
  const admsRecords = store.attendanceLogs.filter(r => r.source === 'adms').length;

  // Step 2: push all unpushed records to ERP
  const unpushed = store.attendanceLogs.filter(r => !r.pushedToERP);
  let pushResult = { success: true, count: 0 };
  if (unpushed.length) {
    pushResult = await pushAttendance(unpushed);
    if (pushResult.success) markAttendancePushed(unpushed.map(r => r.id));
  }
  steps.push({ step: 'laravel_push', success: pushResult.success, count: pushResult.count || 0, error: pushResult.error });

  res.json({
    success: true,
    tcpFetched,
    admsRecords,
    pushed: pushResult.count || 0,
    alreadyPushed: store.attendanceLogs.length - unpushed.length,
    total: store.attendanceLogs.length,
    steps,
  });
});

// ── Ping Test ──────────────────────────────────────────────────────
router.get('/devices/ping', (req, res) => {
  const ip = req.query.ip;
  if (!ip || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    return res.status(400).json({ success: false, error: 'Invalid IP address' });
  }
  const start = Date.now();
  exec(`ping -c 1 -W 3 ${ip}`, { timeout: 5000 }, (error, stdout) => {
    const elapsed = Date.now() - start;
    if (error) {
      logger.info(`Ping failed for ${ip}: ${error.message}`);
      return res.json({ success: true, reachable: false, ip, error: 'Host unreachable' });
    }
    const match = stdout.match(/time[=<]([\d.]+)\s*ms/);
    const rtt = match ? parseFloat(match[1]) : elapsed;
    res.json({ success: true, reachable: true, ip, rtt });
  });
});

// ── Devices ────────────────────────────────────────────────────────
router.get('/devices', (req, res) => {
  res.json({ devices: Object.values(store.devices) });
});

router.post('/devices/tcp/connect', async (req, res) => {
  const { ip, port, name, password } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP address required' });

  const result = await connectTCPDevice({ ip, port: port || 4370, name, password });
  res.json(result);
});

router.post('/devices/tcp/disconnect', async (req, res) => {
  const { deviceId } = req.body;
  await disconnectTCPDevice(deviceId);
  res.json({ success: true });
});

router.post('/devices/:deviceId/fetch-attendance', async (req, res) => {
  const { deviceId } = req.params;
  const device = store.devices[deviceId];
  if (!device) return res.status(404).json({ error: 'Device not found' });

  if (device.type === 'tcp') {
    const result = await fetchAttendanceFromTCP(deviceId);
    return res.json(result);
  }
  res.json({ success: false, error: 'ADMS devices push automatically' });
});

// ── Push bridge employees to all ADMS/TCP devices ──────────────
// Only pushes employees not yet synced to device (syncedToDevice !== true)
router.post('/employees/push-to-devices', async (req, res) => {
  const allEmps  = Object.values(store.employees);
  const unsynced = allEmps.filter(e => !e.syncedToDevice);

  if (!allEmps.length) return res.json({ success: false, error: 'No employees in bridge store. Add employees first.' });

  const connected = Object.values(store.devices).filter(d => d.status === 'connected');
  if (!connected.length) return res.json({ success: false, error: 'No connected devices found.' });

  if (!unsynced.length) {
    return res.json({ success: true, total: 0, skipped: allEmps.length, message: 'All employees already synced to device.' });
  }

  const results = [];
  for (const d of connected) {
    if (d.type === 'adms') {
      // Pass only unsynced employees, treat as new (isNew=true → DELETE+INSERT)
      requestSetUserOnADMS(d.id, null, true, unsynced)
        .then(synced => {
          const uids = (synced || unsynced).map(e => String(e.uid));
          markEmployeesSynced(uids);
          logger.info(`ADMS ${d.id}: ${uids.length} employees synced`);
        })
        .catch(e => logger.warn(`ADMS ${d.id}: push-to-devices failed: ${e.message}`));
      results.push({ deviceId: d.id, type: 'adms', queued: true, count: unsynced.length });
    } else if (d.type === 'tcp') {
      try {
        const r = await syncEmployeesToTCP(d.id, unsynced);
        if (r.success) markEmployeesSynced(unsynced.map(e => String(e.uid)));
        results.push({ deviceId: d.id, type: 'tcp', ...r });
      } catch (e) {
        results.push({ deviceId: d.id, type: 'tcp', success: false, error: e.message });
      }
    }
  }
  res.json({ success: true, total: unsynced.length, skipped: allEmps.length - unsynced.length, results });
});

// ── ERP → Bridge import ────────────────────────────────────────
// Fetch employees from ERP and save them all to bridge store
router.post('/employees/import-from-laravel', async (req, res) => {
  const result = await fetchEmployees();
  if (!result.success) return res.json({ success: false, error: result.error });

  let imported = 0;
  for (const emp of result.employees) {
    const uid = parseInt(emp.uid || emp.id || emp.employee_id || emp.pin || 0);
    if (!uid) continue;
    upsertEmployee({
      uid,
      employee_id: String(emp.employee_id || emp.pin || emp.card_no || uid),
      name: emp.name || emp.first_name && (emp.first_name + (emp.last_name ? ' ' + emp.last_name : '')) || '',
      password: emp.password || '',
      privilege: parseInt(emp.privilege || emp.role || 0) || 0,
    });
    imported++;
  }

  res.json({ success: true, imported, total: result.employees.length });
});

// ── Export employees ───────────────────────────────────────────────
// CSV format — importable by ZKBio Security / ZKTime.Net software
router.get('/employees/export.csv', (req, res) => {
  const employees = Object.values(store.employees);
  const lines = ['Employee No,First Name,Last Name,Department,Card No,Password,Privilege'];
  for (const e of employees) {
    const nameParts = (e.name || '').split(' ');
    const firstName = nameParts[0] || '';
    const lastName  = nameParts.slice(1).join(' ') || '';
    const pin       = e.employee_id || e.uid || '';
    const card      = e.card_no || '';
    const pass      = e.password || '';
    const priv      = e.privilege || 0;
    lines.push(`"${pin}","${firstName}","${lastName}","Default","${card}","${pass}",${priv}`);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="employees.csv"');
  res.end('﻿' + lines.join('\r\n')); // BOM for Excel UTF-8 compatibility
});

// DAT format — ZKTeco USB drive import (user.dat)
router.get('/employees/export.dat', (req, res) => {
  const employees = Object.values(store.employees);
  const lines = ['PIN\tName\tPri\tPasswd\tCard\tGrpTmp\tTimeZone\tVerify\tViceCard'];
  for (const e of employees) {
    const pin  = String(e.employee_id || e.uid || '');
    const name = (e.name || '').replace(/\t/g, ' ');
    const pri  = e.privilege || 0;
    const pass = e.password || '';
    lines.push(`${pin}\t${name}\t${pri}\t${pass}\t0\t1\t0000111100000000\t0\t0`);
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="user.dat"');
  res.end(lines.join('\r\n'));
});

// ── Bridge Employee Store (persisted, device-agnostic) ─────────────
// List all bridge-managed employees
router.get('/employees', (req, res) => {
  res.json({ success: true, employees: Object.values(store.employees), total: Object.keys(store.employees).length });
});

// Load employees from device (or bridge store if device doesn't push)
router.post('/employees/load-from-device', async (req, res) => {
  const admsDevices = Object.values(store.devices).filter(d => d.type === 'adms' && d.status === 'connected');
  if (!admsDevices.length) {
    const synced = Object.values(store.employees).filter(e => e.syncedToDevice);
    return res.json({ success: true, employees: synced, source: 'bridge', total: synced.length, warning: 'No ADMS device connected — showing bridge-synced employees' });
  }

  const sn = admsDevices[0].id;

  try {
    const result = await requestUsersFromADMS(sn);
    const employees = Array.isArray(result) ? result : (result.employees || []);
    const fromCache = result.fromCache || false;
    res.json({ success: true, employees, source: 'device', total: employees.length, fromCache });
  } catch (e) {
    // Device firmware doesn't push — return employees confirmed synced to this device
    const synced = Object.values(store.employees).filter(e => e.syncedToDevice);
    logger.warn(`Load from device failed (${e.message}), returning ${synced.length} bridge-synced employees`);
    res.json({
      success: true,
      employees: synced,
      source: 'bridge',
      total: synced.length,
      warning: `Device did not push user list. Showing ${synced.length} employee(s) confirmed synced to device.`,
    });
  }
});

// Create or update a bridge employee, then try to push to device
router.post('/employees', async (req, res) => {
  const emp = req.body;
  if (!emp.uid || !emp.name) return res.status(400).json({ success: false, error: 'uid and name required' });

  const isNew = !store.employees[String(emp.uid)]; // true = first time this UID is added
  upsertEmployee(emp);

  const connectedDevices = Object.values(store.devices).filter(d => d.status === 'connected');

  // For TCP devices, wait for result (fast). For ADMS, fire-and-forget (takes up to 20s).
  const syncResults = [];
  const admsDevices = connectedDevices.filter(d => d.type === 'adms');
  const tcpDevices  = connectedDevices.filter(d => d.type === 'tcp');

  for (const device of tcpDevices) {
    try {
      const r = await setEmployeeOnDevice(device.id, emp);
      syncResults.push({ deviceId: device.id, synced: r.success, error: r.error });
    } catch (e) {
      syncResults.push({ deviceId: device.id, synced: false, error: e.message });
    }
  }

  // Respond immediately — don't block on ADMS round-trip
  res.json({ success: true, syncResults, admsQueued: admsDevices.length });

  // Sync ADMS devices in background
  for (const device of admsDevices) {
    requestSetUserOnADMS(device.id, emp, isNew)
      .then(() => {
        markEmployeesSynced([String(emp.uid)]);
        logger.info(`ADMS ${device.id}: employee ${emp.uid} synced OK`);
      })
      .catch(e => logger.warn(`ADMS ${device.id}: employee sync failed: ${e.message}`));
  }
});

// Delete a bridge employee, then try to remove from device
router.delete('/employees/:uid', async (req, res) => {
  const { uid } = req.params;
  deleteEmployee(uid);

  const connectedDevices = Object.values(store.devices).filter(d => d.status === 'connected');
  const admsDevices = connectedDevices.filter(d => d.type === 'adms');
  const tcpDevices  = connectedDevices.filter(d => d.type === 'tcp');

  const syncResults = [];
  for (const device of tcpDevices) {
    try {
      const r = await deleteEmployeeFromDevice(device.id, uid);
      syncResults.push({ deviceId: device.id, synced: r.success });
    } catch (e) {
      syncResults.push({ deviceId: device.id, synced: false, error: e.message });
    }
  }

  // Respond immediately
  res.json({ success: true, syncResults, admsQueued: admsDevices.length });

  // Sync ADMS in background
  for (const device of admsDevices) {
    requestDeleteUserOnADMS(device.id, uid)
      .then(() => logger.info(`ADMS ${device.id}: employee ${uid} deleted OK`))
      .catch(e => logger.warn(`ADMS ${device.id}: employee delete sync failed: ${e.message}`));
  }
});

router.post('/devices/:deviceId/sync-employees', async (req, res) => {
  const { deviceId } = req.params;
  const device = store.devices[deviceId];
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const empResult = await fetchEmployees();
  if (!empResult.success) return res.json({ success: false, error: empResult.error });

  if (device.type === 'tcp') {
    const result = await syncEmployeesToTCP(deviceId, empResult.employees);
    return res.json(result);
  }

  if (device.type === 'adms') {
    // Import fetched employees into bridge store first
    for (const emp of empResult.employees) {
      const uid = parseInt(emp.uid || emp.id || emp.employee_id || emp.pin || 0);
      if (!uid) continue;
      upsertEmployee({
        uid,
        employee_id: String(emp.employee_id || emp.pin || emp.card_no || uid),
        name: emp.name || (emp.first_name ? emp.first_name + (emp.last_name ? ' ' + emp.last_name : '') : '') || '',
        password: emp.password || '',
        privilege: parseInt(emp.privilege || 0) || 0,
      });
    }
    // Queue the sync — device picks it up on next heartbeat (within ~30s)
    requestSetUserOnADMS(deviceId, null)
      .then(() => logger.info(`ADMS ${deviceId}: sync-employees OK`))
      .catch(e => logger.warn(`ADMS ${deviceId}: sync-employees failed: ${e.message}`));
    return res.json({ success: true, queued: true, count: empResult.employees.length, message: 'Sync queued — device will update on next heartbeat' });
  }

  res.json({ success: false, error: 'Unknown device type' });
});

// ── Attendance Logs ────────────────────────────────────────────────
router.get('/attendance', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const deviceId = req.query.deviceId;
  let logs = store.attendanceLogs;
  if (deviceId) logs = logs.filter(l => l.deviceId === deviceId);
  res.json({ records: logs.slice(0, limit), total: logs.length });
});

// ── Sync Log ───────────────────────────────────────────────────────
router.get('/sync-log', (req, res) => {
  res.json({ log: store.syncLog });
});

// ── Server restart ─────────────────────────────────────────────────
router.post('/server/restart', (req, res) => {
  res.json({ success: true, message: 'Restarting...' });
  setTimeout(() => process.exit(0), 300); // PM2 will auto-restart
});

// ── Clear Logs ─────────────────────────────────────────────────────
router.post('/logs/clear', (req, res) => {
  clearLogs();
  // Also truncate the log file
  try {
    const logPath = path.join(__dirname, '../logs/combined.log');
    if (fs.existsSync(logPath)) fs.writeFileSync(logPath, '');
  } catch (e) {
    logger.warn('Could not clear log file: ' + e.message);
  }
  res.json({ success: true, message: 'Logs cleared' });
});

// ── Logs (file) ────────────────────────────────────────────────────
router.get('/logs', (req, res) => {
  const logPath = path.join(__dirname, '../logs/combined.log');
  try {
    if (!fs.existsSync(logPath)) return res.json({ lines: [] });
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.trim().split('\n').slice(-100).reverse();
    res.json({ lines });
  } catch {
    res.json({ lines: [] });
  }
});

module.exports = router;
