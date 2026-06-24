const axios = require('axios');
const logger = require('../logger');
const { store, addSyncLog } = require('../store');

function makeHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (store.config.laravelApiToken) {
    headers['Authorization'] = `Bearer ${store.config.laravelApiToken}`;
  }
  return headers;
}

function resolveUrl(customUrl, fallbackPath) {
  if (customUrl && customUrl.trim()) return customUrl.trim();
  return (store.config.laravelApiUrl || '').replace(/\/$/, '') + fallbackPath;
}

async function testConnection() {
  try {
    const url = resolveUrl('', '/zk/ping');
    const res = await axios.get(url, { headers: makeHeaders(), timeout: 10000 });
    store.stats.laravelConnected = true;
    return { success: true, message: res.data?.message || 'Connected' };
  } catch (err) {
    store.stats.laravelConnected = false;
    const msg = err.response?.data?.message || err.message;
    return { success: false, message: msg };
  }
}

async function fetchEmployees() {
  try {
    const url = resolveUrl(store.config.fetchEmployeeUrl, '/zk/employees');
    logger.info(`Fetching employees from: ${url}`);
    const res = await axios.get(url, { headers: makeHeaders(), timeout: 15000 });
    const employees = res.data?.data || res.data || [];
    logger.info(`Fetched ${employees.length} employees from Laravel`);
    addSyncLog({
      type: 'employee_fetch',
      status: 'success',
      count: employees.length,
      message: `Fetched ${employees.length} employees`,
    });
    return { success: true, employees };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    logger.error('Failed to fetch employees: ' + msg);
    addSyncLog({ type: 'employee_fetch', status: 'error', message: msg });
    return { success: false, error: msg, employees: [] };
  }
}

async function pushAttendance(records) {
  if (!records || records.length === 0) return { success: true, count: 0 };
  try {
    const url = resolveUrl(store.config.syncAttendanceUrl, '/zk/attendance');
    logger.info(`Pushing ${records.length} records to: ${url}`);
    const res = await axios.post(url, { records }, { headers: makeHeaders(), timeout: 15000 });
    const count = res.data?.saved || res.data?.count || records.length;
    logger.info(`Pushed ${count} attendance records to Laravel`);
    addSyncLog({
      type: 'attendance_push',
      status: 'success',
      count,
      message: `Pushed ${count} attendance records`,
    });
    return { success: true, count };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    logger.error('Failed to push attendance: ' + msg);
    addSyncLog({ type: 'attendance_push', status: 'error', message: msg });
    return { success: false, error: msg };
  }
}

async function pushAttendanceSingle(record) {
  return pushAttendance([record]);
}

module.exports = { testConnection, fetchEmployees, pushAttendance, pushAttendanceSingle };
