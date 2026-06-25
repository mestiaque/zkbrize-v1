const cron = require('node-cron');
const logger = require('./logger');
const { store, addSyncLog, upsertEmployee, markAttendancePushed } = require('./store');
const { fetchEmployees, pushAttendance } = require('./laravel/api');
const { syncEmployeesToTCP, tcpDevices } = require('./tcpip/connector');

let employeeSyncJob = null;
let attendanceFetchJob = null;
let io = null;

function setSocketIO(socketio) { io = socketio; }
function emit(event, data) { if (io) io.emit(event, data); }

async function runEmployeeSync() {
  if (!store.config.employeeSyncEnabled) {
    logger.info('Employee sync skipped: disabled');
    return;
  }
  if (!store.config.laravelApiUrl) {
    logger.warn('Employee sync skipped: ERP API URL not configured');
    return;
  }

  logger.info('Running scheduled employee sync...');
  emit('sync_started', { type: 'employee_sync' });

  const result = await fetchEmployees();
  if (!result.success) {
    emit('sync_done', { type: 'employee_sync', success: false, error: result.error });
    return;
  }

  // Save to bridge store
  (result.employees || []).forEach(emp => upsertEmployee(emp));

  // Also sync to any connected TCP devices
  for (const [deviceId, device] of Object.entries(tcpDevices)) {
    if (device.connected) {
      const syncResult = await syncEmployeesToTCP(deviceId, result.employees);
      logger.info(`Synced ${syncResult.synced} employees to ${deviceId}`);
    }
  }

  emit('sync_done', { type: 'employee_sync', success: true, count: result.employees.length });
  emit('state_update', { type: 'sync' });
}

async function runAttendanceFetch() {
  if (!store.config.attendanceSyncEnabled) {
    logger.info('Attendance sync skipped: disabled');
    return;
  }
  const pushUrl = store.config.syncAttendanceUrl || store.config.laravelApiUrl;
  if (!pushUrl) {
    logger.warn('Attendance push skipped: no URL configured (set Sync Attendance URL or ERP API Base URL)');
    return;
  }

  logger.info('Running scheduled attendance push to ERP...');
  emit('sync_started', { type: 'attendance_fetch' });

  // Push unpushed records already collected (from ADMS + TCP)
  const unpushed = store.attendanceLogs.filter(r => !r.pushedToERP);

  if (unpushed.length === 0) {
    logger.info('Attendance sync: no new records to push');
    emit('sync_done', { type: 'attendance_fetch', success: true, count: 0 });
    emit('state_update', { type: 'sync' });
    return;
  }

  const pushResult = await pushAttendance(unpushed);
  if (pushResult.success) {
    markAttendancePushed(unpushed.map(r => r.id));
    logger.info(`Pushed ${pushResult.count || unpushed.length} attendance records to ERP`);
    emit('sync_done', { type: 'attendance_fetch', success: true, count: unpushed.length });
  } else {
    logger.error('Attendance push failed: ' + pushResult.error);
    emit('sync_done', { type: 'attendance_fetch', success: false, error: pushResult.error });
  }

  emit('state_update', { type: 'sync' });
}

function startScheduler() {
  updateSchedule();
}

function updateSchedule() {
  const syncSchedule  = store.config.syncSchedule || '*/30 * * * *';
  const fetchSchedule = store.config.attendanceFetchSchedule || '*/15 * * * *';
  const empEnabled    = store.config.employeeSyncEnabled !== false;
  const attEnabled    = store.config.attendanceSyncEnabled !== false;

  // Employee sync job
  if (employeeSyncJob) { employeeSyncJob.stop(); employeeSyncJob = null; }
  if (empEnabled && cron.validate(syncSchedule)) {
    employeeSyncJob = cron.schedule(syncSchedule, runEmployeeSync);
    logger.info(`Employee sync scheduled: ${syncSchedule}`);
  } else {
    logger.info(`Employee sync: ${empEnabled ? 'invalid cron' : 'DISABLED'}`);
  }

  // Attendance fetch job
  if (attendanceFetchJob) { attendanceFetchJob.stop(); attendanceFetchJob = null; }
  if (attEnabled && cron.validate(fetchSchedule)) {
    attendanceFetchJob = cron.schedule(fetchSchedule, runAttendanceFetch);
    logger.info(`Attendance sync scheduled: ${fetchSchedule}`);
  } else {
    logger.info(`Attendance sync: ${attEnabled ? 'invalid cron' : 'DISABLED'}`);
  }
}

function stopScheduler() {
  if (employeeSyncJob) { employeeSyncJob.stop(); employeeSyncJob = null; }
  if (attendanceFetchJob) { attendanceFetchJob.stop(); attendanceFetchJob = null; }
  logger.info('Scheduler stopped');
}

function getSchedulerStatus() {
  return {
    employeeSyncEnabled:   store.config.employeeSyncEnabled !== false,
    attendanceSyncEnabled: store.config.attendanceSyncEnabled !== false,
    employeeSyncRunning:   !!employeeSyncJob,
    attendanceSyncRunning: !!attendanceFetchJob,
    syncSchedule:          store.config.syncSchedule,
    attendanceFetchSchedule: store.config.attendanceFetchSchedule,
  };
}

module.exports = { startScheduler, stopScheduler, updateSchedule, getSchedulerStatus, runEmployeeSync, runAttendanceFetch, setSocketIO };
