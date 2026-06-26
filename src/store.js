const fs   = require('fs');
const path = require('path');

const EMP_FILE    = path.join(__dirname, '../data/employees.json');
const PERM_FILE   = path.join(__dirname, '../data/permissions.json');
const CONFIG_FILE = path.join(__dirname, '../data/config.json');

const DEFAULT_PERMISSIONS = {
  nav: {
    dashboard: true, devices: true, employees: true,
    attendance: true, logs: true, settings: true, guide: true,
  },
  employees: {
    btn_load_laravel: true, btn_load_machine: true,
    btn_set_device: true, btn_add_employee: true,
    btn_edit_employee: true, btn_delete_employee: true,
    export_csv: true, export_dat: true,
    card_export_guide: true, card_api_docs: true,
  },
  devices: {
    card_add_tcp: true, card_adms_info: true, card_ping_test: true,
  },
  attendance: {
    btn_fetch: true, btn_push_laravel: true,
  },
};

function loadPermissionsFile() {
  try {
    if (fs.existsSync(PERM_FILE)) return JSON.parse(fs.readFileSync(PERM_FILE, 'utf8'));
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
}

function savePermissionsFile(perms) {
  try {
    const dir = path.dirname(PERM_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PERM_FILE, JSON.stringify(perms, null, 2));
  } catch (e) { console.error('Failed to save permissions.json:', e.message); }
}

function loadConfigFile() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      Object.assign(store.config, saved);
    }
  } catch (e) { console.error('Failed to load config.json:', e.message); }
}

function saveConfigFile() {
  try {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const toSave = {
      syncSchedule: store.config.syncSchedule,
      attendanceFetchSchedule: store.config.attendanceFetchSchedule,
      employeeSyncEnabled: store.config.employeeSyncEnabled,
      attendanceSyncEnabled: store.config.attendanceSyncEnabled,
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(toSave, null, 2));
  } catch (e) { console.error('Failed to save config.json:', e.message); }
}

function loadEmployeeFile() {
  try {
    if (fs.existsSync(EMP_FILE)) return JSON.parse(fs.readFileSync(EMP_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveEmployeeFile(employees) {
  try {
    const dir = path.dirname(EMP_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(EMP_FILE, JSON.stringify(employees, null, 2));
  } catch (e) {
    console.error('Failed to save employees.json:', e.message);
  }
}

// In-memory state store
const store = {
  devices: {},       // deviceId -> device info + status
  attendanceLogs: [], // recent attendance records
  syncLog: [],       // sync history
  employees: loadEmployeeFile(), // uid -> employee (persisted)
  permissions: loadPermissionsFile(), // ui permissions (persisted)
  stats: {
    totalAttendance: 0,
    lastSync: null,
    laravelConnected: false,
    admsDevicesConnected: 0,
    tcpDevicesConnected: 0,
  },
  config: {
    laravelApiUrl: '',
    laravelApiToken: '',
    fetchEmployeeUrl: '',
    syncAttendanceUrl: '',
    admsPort: 5015,
    syncSchedule: '*/30 * * * *',
    attendanceFetchSchedule: '*/15 * * * *',
  }
};

// Max recent logs to keep in memory
const MAX_LOGS = 500;
const MAX_SYNC_LOG = 100;

function addDevice(device) {
  store.devices[device.id] = {
    ...device,
    connectedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    status: 'connected',
    attendancePushed: 0,
    employeesSynced: 0,
  };
  updateStats();
}

function updateDevice(deviceId, updates) {
  if (store.devices[deviceId]) {
    store.devices[deviceId] = {
      ...store.devices[deviceId],
      ...updates,
      lastSeen: new Date().toISOString(),
    };
    updateStats();
  }
}

function removeDevice(deviceId) {
  if (store.devices[deviceId]) {
    store.devices[deviceId].status = 'disconnected';
    store.devices[deviceId].disconnectedAt = new Date().toISOString();
    updateStats();
  }
}

function addAttendanceLog(record) {
  store.attendanceLogs.unshift({
    ...record,
    receivedAt: new Date().toISOString(),
    id: Date.now() + Math.random(),
    pushedToERP: false,
    pushedAt: null,
  });
  if (store.attendanceLogs.length > MAX_LOGS) {
    store.attendanceLogs = store.attendanceLogs.slice(0, MAX_LOGS);
  }
  store.stats.totalAttendance++;
  if (store.devices[record.deviceId]) {
    store.devices[record.deviceId].attendancePushed =
      (store.devices[record.deviceId].attendancePushed || 0) + 1;
  }
}

function addSyncLog(entry) {
  store.syncLog.unshift({
    ...entry,
    timestamp: new Date().toISOString(),
    id: Date.now(),
  });
  if (store.syncLog.length > MAX_SYNC_LOG) {
    store.syncLog = store.syncLog.slice(0, MAX_SYNC_LOG);
  }
  store.stats.lastSync = new Date().toISOString();
}

function upsertEmployee(emp) {
  const key = String(emp.uid);
  const existing = store.employees[key];
  store.employees[key] = {
    ...emp,
    // Preserve sync status across edits — only new employees start as unsynced
    syncedToDevice: existing?.syncedToDevice ?? false,
    syncedAt:       existing?.syncedAt       ?? null,
    createdAt:      existing?.createdAt      ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveEmployeeFile(store.employees);
}

function markEmployeesSynced(uids) {
  const now = new Date().toISOString();
  let changed = false;
  uids.forEach(uid => {
    const key = String(uid);
    if (store.employees[key]) {
      store.employees[key].syncedToDevice = true;
      store.employees[key].syncedAt = now;
      changed = true;
    }
  });
  if (changed) saveEmployeeFile(store.employees);
}

function deleteEmployee(uid) {
  delete store.employees[String(uid)];
  saveEmployeeFile(store.employees);
}

function markAttendancePushed(ids) {
  const idSet = new Set(ids.map(String));
  const now = new Date().toISOString();
  store.attendanceLogs.forEach(r => {
    if (idSet.has(String(r.id))) {
      r.pushedToERP = true;
      r.pushedAt = now;
    }
  });
}

function savePermissions(perms) {
  store.permissions = perms;
  savePermissionsFile(perms);
}

function clearLogs() {
  store.attendanceLogs = [];
  store.syncLog = [];
  store.stats.totalAttendance = 0;
  store.stats.lastSync = null;
}

function updateStats() {
  const devices = Object.values(store.devices);
  store.stats.admsDevicesConnected = devices.filter(
    d => d.type === 'adms' && d.status === 'connected'
  ).length;
  store.stats.tcpDevicesConnected = devices.filter(
    d => d.type === 'tcp' && d.status === 'connected'
  ).length;
}

function getState() {
  return {
    devices: Object.values(store.devices),
    attendanceLogs: store.attendanceLogs.slice(0, 50),
    syncLog: store.syncLog.slice(0, 20),
    stats: store.stats,
    config: {
      laravelApiUrl: store.config.laravelApiUrl,
      admsPort: store.config.admsPort,
      syncSchedule: store.config.syncSchedule,
      hasToken: !!store.config.laravelApiToken,
    },
  };
}

module.exports = {
  store,
  addDevice,
  updateDevice,
  removeDevice,
  addAttendanceLog,
  addSyncLog,
  upsertEmployee,
  deleteEmployee,
  markAttendancePushed,
  markEmployeesSynced,
  clearLogs,
  getState,
  savePermissions,
  DEFAULT_PERMISSIONS,
  loadConfigFile,
  saveConfigFile,
};
