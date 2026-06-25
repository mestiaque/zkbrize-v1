// ZK Bridge Frontend
const socket = io();
let state = { devices: [], attendanceLogs: [], syncLog: [], stats: {}, config: {} };
let attendanceAll = [];

// ── Socket.IO ─────────────────────────────────────────────────────
socket.on('connect', () => {
  setSocketStatus(true);
  toast('Connected to bridge server', 'success');
});

socket.on('disconnect', () => {
  setSocketStatus(false);
});

socket.on('init', (data) => {
  state = data;
  renderAll();
});

socket.on('state_update', () => {
  fetchState();
});

socket.on('attendance', (record) => {
  attendanceAll.unshift(record);
  renderAttendanceTable();
  renderDashboardActivity();
  updateNavBadge('nav-attendance-count', attendanceAll.length);
  showLiveAttendancePulse(record);
});

socket.on('device_connected', ({ deviceId, type }) => {
  toast(`Device connected: ${deviceId} (${type.toUpperCase()})`, 'success');
  fetchState();
});

socket.on('sync_started', ({ type }) => {
  toast(`Sync started: ${type.replace('_', ' ')}`, 'info');
});

socket.on('sync_done', ({ type, success, count, error }) => {
  if (success) toast(`Sync done: ${count || 0} records`, 'success');
  else toast(`Sync failed: ${error}`, 'error');
  fetchState();
});

// ── State ─────────────────────────────────────────────────────────
async function fetchState() {
  const data = await api('/state');
  if (data) { state = data; renderAll(); }
}

function renderAll() {
  renderStats();
  renderDashboardDevices();
  renderDashboardActivity();
  renderDashboardSyncLog();
  renderDeviceList();
  renderAttendanceTable();
  renderSidebarStatus();
  updateNavBadge('nav-device-count', state.devices?.length || 0);
  updateNavBadge('nav-attendance-count', state.attendanceLogs?.length || 0);
  if (state.attendanceLogs) {
    attendanceAll = [...state.attendanceLogs];
  }
}

// ── Stats ─────────────────────────────────────────────────────────
function renderStats() {
  const s = state.stats || {};
  const devices = state.devices || [];
  setText('stat-total-devices', devices.length);
  setText('stat-connected', devices.filter(d => d.status === 'connected').length);
  setText('stat-attendance', s.totalAttendance || 0);
  setText('stat-last-sync', s.lastSync ? timeAgo(s.lastSync) : 'Never');
}

// ── Dashboard ─────────────────────────────────────────────────────
function renderDashboardDevices() {
  const el = document.getElementById('dashboard-devices');
  const devices = state.devices || [];
  if (!devices.length) { el.innerHTML = '<div class="empty-state">No devices connected yet</div>'; return; }
  el.innerHTML = devices.slice(0, 5).map(d => `
    <div class="device-item">
      <div class="device-icon">${d.type.toUpperCase()}</div>
      <div class="device-info">
        <div class="device-name">${d.name}</div>
        <div class="device-meta">${d.ip || '—'}  ·  ${d.sn || d.id}</div>
      </div>
      <span class="tag ${d.status==='connected'?'tag-green':d.status==='error'?'tag-red':''}">
        ${d.status}
      </span>
    </div>`).join('');
}

function renderDashboardActivity() {
  const el = document.getElementById('dashboard-activity');
  const logs = attendanceAll.length ? attendanceAll : (state.attendanceLogs || []);
  if (!logs.length) { el.innerHTML = '<div class="empty-state">No activity yet</div>'; return; }
  el.innerHTML = logs.slice(0, 8).map(r => `
    <div class="activity-item">
      <div class="activity-dot ${r.status==='1'?'out':''}"></div>
      <div class="activity-body">
        <div class="activity-title">Employee ${r.employeeId} — ${r.status==='1'?'Check Out':'Check In'}</div>
        <div class="activity-time">${r.time} · ${r.deviceId} · ${r.verify==='2'?'Face':r.verify==='3'?'Card':'Fingerprint'}</div>
      </div>
    </div>`).join('');
}

function renderDashboardSyncLog() {
  const el = document.getElementById('dashboard-synclog');
  const log = state.syncLog || [];
  if (!log.length) { el.innerHTML = '<div class="empty-state">No sync history</div>'; return; }
  el.innerHTML = log.slice(0, 10).map(e => `
    <div class="sync-item">
      <div class="sync-icon ${e.status}"></div>
      <span class="sync-time">${formatTime(e.timestamp)}</span>
      <span class="sync-msg">${e.message}</span>
      <span class="sync-badge">${e.type.replace(/_/g,' ')}</span>
    </div>`).join('');
}

// ── Devices ───────────────────────────────────────────────────────
function renderDeviceList() {
  const el = document.getElementById('device-list');
  const devices = state.devices || [];
  if (!devices.length) { el.innerHTML = '<div class="empty-state">No devices configured</div>'; return; }
  el.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th>Type</th><th>Name</th><th>IP / SN</th><th>Status</th><th>Records</th><th>Last Seen</th><th>Actions</th>
      </tr></thead>
      <tbody>${devices.map(d => `
        <tr>
          <td><span class="tag ${d.type==='adms'?'tag-blue':'tag-amber'}">${d.type.toUpperCase()}</span></td>
          <td><strong>${d.name}</strong></td>
          <td style="font-family:monospace;font-size:12px">${d.ip||'—'} ${d.port?':'+d.port:''}<br><span style="color:var(--text-3)">${d.sn||d.id}</span></td>
          <td><span class="tag ${d.status==='connected'?'tag-green':d.status==='error'?'tag-red':''}">${d.status}</span></td>
          <td>${d.attendancePushed||0}</td>
          <td>${d.lastSeen ? timeAgo(d.lastSeen) : '—'}</td>
          <td>
            <div class="device-actions">
              ${d.type==='tcp'?`<button class="btn-sm" onclick="fetchFromDevice('${d.id}')">Fetch</button>`:''}
              <button class="btn-sm" onclick="syncEmpToDevice('${d.id}')">Sync Emp</button>
              ${d.type==='tcp'?`<button class="btn-sm" style="color:var(--red)" onclick="disconnectDevice('${d.id}')">Disconnect</button>`:''}
            </div>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

async function connectTCPDevice() {
  const ip = val('tcp-ip');
  const port = val('tcp-port') || 4370;
  const name = val('tcp-name') || '';
  const password = val('tcp-password') || '';
  if (!ip) { toast('Enter device IP address', 'error'); return; }

  toast('Connecting to device...', 'info');
  const res = await api('/devices/tcp/connect', { ip, port: parseInt(port), name, password });
  if (res?.success) toast(`Device connected: ${res.deviceId}`, 'success');
  else toast(`Connection failed: ${res?.error || 'Unknown error'}`, 'error');
  fetchState();
}

async function pingDevice() {
  const ip = val('ping-ip').trim();
  if (!ip) { toast('Enter an IP address', 'error'); return; }
  const btn = document.getElementById('ping-btn');
  const result = document.getElementById('ping-result');
  btn.disabled = true;
  btn.textContent = 'Pinging...';
  result.innerHTML = '<span style="color:var(--text-2)">Sending ping...</span>';
  const res = await api(`/devices/ping?ip=${encodeURIComponent(ip)}`, null, 'GET');
  btn.disabled = false;
  btn.textContent = 'Ping';
  if (!res) {
    result.innerHTML = '<div style="color:var(--red)">Request failed</div>';
    return;
  }
  if (res.reachable) {
    result.innerHTML = `<div class="badge-green">Reachable — ${ip} replied in <strong>${res.rtt} ms</strong></div>`;
    toast(`${ip} is reachable (${res.rtt} ms)`, 'success');
  } else {
    result.innerHTML = `<div style="color:var(--red);font-size:13px">Unreachable — ${ip} did not respond. Check IP and network.</div>`;
    toast(`${ip} unreachable`, 'error');
  }
}

async function disconnectDevice(deviceId) {
  await api('/devices/tcp/disconnect', { deviceId });
  toast('Device disconnected', 'info');
  fetchState();
}

async function fetchFromDevice(deviceId) {
  toast('Fetching attendance...', 'info');
  const res = await api(`/devices/${encodeURIComponent(deviceId)}/fetch-attendance`);
  if (res?.success) toast(`Fetched ${res.count} records`, 'success');
  else toast(`Fetch failed: ${res?.error}`, 'error');
  fetchState();
}

async function syncEmpToDevice(deviceId) {
  toast('Syncing employees...', 'info');
  const res = await api(`/devices/${encodeURIComponent(deviceId)}/sync-employees`);
  if (res?.success) toast(`Synced ${res.synced} employees`, 'success');
  else toast(`Sync failed: ${res?.error}`, 'error');
}

// ── Attendance ────────────────────────────────────────────────────
function renderAttendanceTable() {
  const tbody  = document.getElementById('attendance-tbody');
  const badge  = document.getElementById('att-count-badge');
  let records  = attendanceAll.length ? attendanceAll : (state.attendanceLogs || []);

  // Update device dropdown options
  const sel = document.getElementById('filter-device');
  const allDevices = [...new Set(records.map(r => r.deviceId))];
  const curDev = sel.value;
  sel.innerHTML = '<option value="">All Devices</option>' +
    allDevices.map(d => `<option value="${d}" ${d===curDev?'selected':''}>${d.slice(-8)}</option>`).join('');

  // Apply filters
  const empFilter    = (val('filter-empid') || '').toLowerCase();
  const dateFilter   = val('filter-date') || '';
  const deviceFilter = val('filter-device') || '';
  const statusFilter = val('filter-status') || '';
  const methodFilter = val('filter-method') || '';
  const sourceFilter = val('filter-source') || '';
  const pushedFilter = val('filter-pushed') || '';

  if (empFilter)    records = records.filter(r => String(r.employeeId||'').toLowerCase().includes(empFilter));
  if (dateFilter)   records = records.filter(r => (r.time||'').startsWith(dateFilter));
  if (deviceFilter) records = records.filter(r => r.deviceId === deviceFilter);
  if (statusFilter) records = records.filter(r => r.status === statusFilter);
  if (methodFilter) records = records.filter(r => (r.verifyMethod||'').toLowerCase() === methodFilter);
  if (sourceFilter) records = records.filter(r => (r.source||'') === sourceFilter);
  if (pushedFilter === 'pushed') records = records.filter(r => r.pushedToERP);
  if (pushedFilter === 'new')    records = records.filter(r => !r.pushedToERP);

  badge.textContent = `${records.length} records`;
  badge.style.display = '';

  if (!records.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No records match the filters</td></tr>';
    return;
  }

  tbody.innerHTML = records.slice(0, 300).map(r => {
    const isPushed = r.pushedToERP;
    const rowStyle = isPushed ? 'opacity:0.55' : '';
    const statusBadge = isPushed
      ? `<span class="tag tag-green" title="${r.pushedAt ? formatTime(r.pushedAt) : ''}">✓ Pushed</span>`
      : `<span class="tag" style="background:#fff3cd;color:#856404">New</span>`;
    return `
    <tr style="${rowStyle}">
      <td>${statusBadge}</td>
      <td><strong>${r.employeeId}</strong></td>
      <td style="font-size:12px">${r.time}</td>
      <td><span class="tag ${r.status==='1'?'tag-amber':'tag-green'}">${r.status==='1'?'Check Out':'Check In'}</span></td>
      <td>${verifyLabel(r.verify)}</td>
      <td style="font-size:11px;font-family:monospace">${(r.deviceId||'').slice(-8)}</td>
      <td><span class="tag ${r.source==='adms'?'tag-blue':'tag-amber'}">${r.source||'—'}</span></td>
      <td style="color:var(--text-3);font-size:11px">${r.pushedAt ? formatTime(r.pushedAt) : '—'}</td>
    </tr>`;
  }).join('');
}

function filterAttendance() { renderAttendanceTable(); }

function clearAttendanceFilters() {
  ['filter-empid','filter-date','filter-device','filter-status','filter-method','filter-source','filter-pushed']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  renderAttendanceTable();
}

async function fetchAttendance() {
  const btn = document.getElementById('btn-fetch-attendance');
  if (btn) { btn.disabled = true; btn.textContent = 'Fetching...'; }
  toast('Fetching from TCP devices...', 'info');
  await api('/laravel/fetch-attendance');
  setTimeout(() => { fetchState(); if (btn) { btn.disabled = false; btn.textContent = 'Fetch from Devices'; } }, 2000);
}

async function pushToERP() {
  const btn = document.getElementById('btn-push-laravel');
  if (btn) { btn.disabled = true; btn.textContent = 'Pushing...'; }
  toast('Pushing new records to ERP...', 'info');
  const res = await api('/laravel/push-attendance', { onlyNew: true });
  if (btn) { btn.disabled = false; btn.textContent = 'Push to ERP'; }
  if (res?.success) {
    if (res.count === 0) toast('All records already pushed to ERP', 'info');
    else toast(`Pushed ${res.count} new records (${res.alreadyPushed||0} already done)`, 'success');
    fetchState();
  } else {
    toast(`Push failed: ${res?.error}`, 'error');
  }
}

// ── Employees ─────────────────────────────────────────────────────
let fetchedEmployees = [];
let machineEmployees = [];
let machineEmployeeDeviceId = null;

async function fetchEmployeesFromApi() {
  const btn = document.getElementById('fetch-emp-btn');
  const wrap = document.getElementById('employee-table-wrap');
  const badge = document.getElementById('emp-count-badge');
  const setBtn = document.getElementById('set-emp-btn');

  btn.disabled = true;
  btn.textContent = 'Fetching...';
  wrap.innerHTML = '<div class="empty-state">Loading from API...</div>';

  const res = await api('/laravel/employees', null, 'GET');

  btn.disabled = false;
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zm-8 2V5h2v6h1.17L12 13.17 9.83 11H11zm-6 7h14v2H5z"/></svg> Fetch from API';

  if (!res?.success) {
    wrap.innerHTML = `<div style="color:var(--red);padding:12px">${res?.error || 'Failed to fetch employees. Check API URL in Settings.'}</div>`;
    toast('Failed to fetch employees', 'error');
    return;
  }

  fetchedEmployees = res.employees || [];
  if (!fetchedEmployees.length) {
    wrap.innerHTML = '<div class="empty-state">No employees returned from API</div>';
    toast('No employees found', 'info');
    return;
  }

  badge.textContent = `${fetchedEmployees.length} employees`;
  badge.style.display = '';
  setBtn.disabled = false;
  toast(`Fetched ${fetchedEmployees.length} employees`, 'success');

  wrap.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>
          <th>#</th><th>Employee ID</th><th>Name</th><th>UID</th><th>Role</th>
        </tr></thead>
        <tbody>
          ${fetchedEmployees.map((e, i) => `
            <tr>
              <td style="color:var(--text-3)">${i + 1}</td>
              <td><strong>${e.employee_id || e.id || '—'}</strong></td>
              <td>${e.name || '—'}</td>
              <td style="font-family:monospace">${e.uid || '—'}</td>
              <td><span class="tag ${e.privilege === 14 ? 'tag-amber' : ''}">${e.privilege === 14 ? 'Admin' : 'User'}</span></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

async function setEmployeesToDevice() {
  if (!fetchedEmployees.length) { toast('Fetch employees first', 'error'); return; }
  const statusEl = document.getElementById('employee-sync-status');
  const btn = document.getElementById('set-emp-btn');
  btn.disabled = true;
  btn.textContent = 'Pushing to device...';
  statusEl.innerHTML = '<div class="hint">Pushing employees to connected devices...</div>';

  const res = await api('/laravel/set-employees', {});
  btn.disabled = false;
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zM6 10h2v2H6zm0 4h8v2H6zm10 0h2v2h-2zm-6-4h8v2h-8z"/></svg> Set to Device';

  if (res?.success) {
    const lines = (res.results || []).map(r =>
      `<div style="font-size:13px;margin-top:4px">
        <strong>${r.deviceId}</strong>: ${r.success ? `<span style="color:var(--green)">✓ ${r.synced ?? ''} synced</span>` : `<span style="color:var(--red)">✗ ${r.error}</span>`}
      </div>`).join('');
    statusEl.innerHTML = `<div class="badge-green" style="margin-bottom:8px">${res.total} employees pushed</div>${lines}`;
    toast(`Employees set to device`, 'success');
  } else {
    statusEl.innerHTML = `<div style="color:var(--red)">${res?.error || 'Failed to set employees'}</div>`;
    toast(res?.error || 'Failed', 'error');
  }
}

async function syncEmployees() {
  await fetchEmployeesFromApi();
  if (fetchedEmployees.length) await setEmployeesToDevice();
}

// ── Bridge Employee Management ────────────────────────────────────
function showLoadFromMachineModal() {
  loadBridgeEmployees(true);
}

async function importFromERP() {
  const btn = document.getElementById('import-laravel-btn');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  const res = await api('/employees/import-from-laravel', {}, 'POST');
  btn.disabled = false;
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zm-8 2V5h2v6h1.17L12 13.17 9.83 11H11zm-6 7h14v2H5z"/></svg> Load from ERP';
  if (!res?.success) {
    toast(res?.error || 'Failed to load from ERP', 'error');
    return;
  }
  toast(`${res.imported} employees loaded from ERP and saved to bridge`, 'success');
  loadBridgeEmployees();
}

async function loadBridgeEmployees(fromDevice = false) {
  const wrap = document.getElementById('employee-table-wrap');
  wrap.innerHTML = '<div class="empty-state">Loading...</div>';

  let res;
  if (fromDevice) {
    toast('Requesting employee list from device…', 'info');
    res = await api('/employees/load-from-device', {}, 'POST');
  } else {
    res = await api('/employees', null, 'GET');
  }

  if (!res?.success) {
    wrap.innerHTML = `<div style="color:var(--red);padding:12px">${res?.error || 'Failed to load employees'}</div>`;
    return;
  }

  machineEmployees = res.employees || [];
  const hasData = machineEmployees.length > 0;

  const badge  = document.getElementById('emp-count-badge');
  const csvBtn = document.getElementById('export-csv-btn');
  const datBtn = document.getElementById('export-dat-btn');

  badge.textContent    = `${machineEmployees.length} employees`;
  badge.style.display  = hasData ? '' : 'none';
  csvBtn.style.display = hasData ? '' : 'none';
  datBtn.style.display = hasData ? '' : 'none';

  renderMachineEmployeeTable();

  if (fromDevice) {
    const src = res?.source === 'device' ? 'device' : 'bridge store';
    if (res?.warning) toast(`Loaded from ${src} (${res.warning})`, 'info');
    else toast(`${machineEmployees.length} employees loaded from ${src}`, 'success');
  }
}

function renderMachineEmployeeTable() {
  const wrap = document.getElementById('employee-table-wrap');
  if (!machineEmployees.length) {
    wrap.innerHTML = '<div class="empty-state">No employees yet. Click "+ Add Employee" to create one — it will sync to all connected devices.</div>';
    return;
  }
  wrap.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>
          <th>#</th><th>UID</th><th>Employee ID</th><th>Name</th><th>Role</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${machineEmployees.map((e, i) => `
            <tr>
              <td style="color:var(--text-3)">${i + 1}</td>
              <td style="font-family:monospace">${e.uid}</td>
              <td><strong>${e.employee_id || e.employeeId || '—'}</strong></td>
              <td>${e.name || '—'}</td>
              <td><span class="tag ${e.privilege === 14 ? 'tag-amber' : ''}">${e.privilege === 14 ? 'Admin' : 'User'}</span></td>
              <td>
                <div class="device-actions">
                  <button class="btn-sm" onclick="openEmployeeModal(${i})">Edit</button>
                  <button class="btn-sm" style="color:var(--red)" onclick="deleteBridgeEmployee(${e.uid})">Delete</button>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function openEmployeeModal(index) {
  const emp = index !== null ? machineEmployees[index] : null;
  document.getElementById('emp-modal-title').textContent = emp ? 'Edit Employee' : 'Add Employee';
  document.getElementById('emp-modal-uid-input').value = emp ? emp.uid : '';
  document.getElementById('emp-modal-uid-input').disabled = !!emp;
  document.getElementById('emp-modal-empid').value = emp ? (emp.employee_id || emp.employeeId || '') : '';
  document.getElementById('emp-modal-name').value = emp ? (emp.name || '') : '';
  document.getElementById('emp-modal-password').value = emp ? (emp.password || '') : '';
  document.getElementById('emp-modal-privilege').value = emp ? (emp.privilege || 0) : 0;
  document.getElementById('emp-modal-error').style.display = 'none';
  document.getElementById('modal-employee').style.display = 'flex';
}

async function saveEmployeeToMachine() {
  const uid = parseInt(document.getElementById('emp-modal-uid-input').value);
  const employee_id = document.getElementById('emp-modal-empid').value.trim();
  const name = document.getElementById('emp-modal-name').value.trim();
  const password = document.getElementById('emp-modal-password').value.trim();
  const privilege = parseInt(document.getElementById('emp-modal-privilege').value);
  const errEl = document.getElementById('emp-modal-error');

  if (!uid || uid < 1 || uid > 65535) { errEl.textContent = 'UID must be between 1 and 65535'; errEl.style.display = ''; return; }
  if (!name) { errEl.textContent = 'Name is required'; errEl.style.display = ''; return; }
  errEl.style.display = 'none';

  const res = await api('/employees', { uid, employee_id, name, password, privilege });

  if (res?.success) {
    const results   = res.syncResults || [];
    const synced    = results.filter(r => r.synced).length;
    const failed    = results.filter(r => !r.synced);
    const admsCount = res.admsQueued || 0;
    closeModal('modal-employee');
    loadBridgeEmployees();
    if (!results.length && !admsCount) {
      toast('Employee saved to bridge (no devices connected)', 'info');
    } else if (synced === results.length && admsCount > 0) {
      toast(`Employee saved — syncing to ADMS device in background`, 'success');
    } else if (synced > 0) {
      toast(`Employee saved & synced to ${synced} device(s)`, 'success');
    } else if (admsCount > 0) {
      toast(`Employee saved — syncing to ADMS device in background`, 'success');
    } else {
      toast('Employee saved to bridge only', 'info');
      failed.forEach(f => toast(`Device ${f.deviceId.slice(-6)}: ${f.error}`, 'error'));
    }
  } else {
    errEl.textContent = res?.error || 'Failed to save employee';
    errEl.style.display = '';
  }
}

async function deleteBridgeEmployee(uid) {
  if (!confirm(`Delete employee UID ${uid}? This will also remove from connected devices.`)) return;

  const res = await api(`/employees/${uid}`, null, 'DELETE');
  if (res?.success) {
    toast('Employee deleted', 'success');
    machineEmployees = machineEmployees.filter(e => e.uid !== uid);
    renderMachineEmployeeTable();
    document.getElementById('emp-count-badge').textContent = `${machineEmployees.length} employees`;
  } else {
    toast(res?.error || 'Failed to delete', 'error');
  }
}

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}

// ── Settings ──────────────────────────────────────────────────────
async function loadSettings() {
  const res = await api('/config', null, 'GET');
  if (res) {
    setVal('set-laravel-url', res.laravelApiUrl || '');
    setVal('set-laravel-token', res.hasToken ? '••••••••' : '');
    setVal('set-fetch-employee-url', res.fetchEmployeeUrl || '');
    setVal('set-sync-attendance-url', res.syncAttendanceUrl || '');
    setVal('set-sync-schedule', res.syncSchedule || '*/30 * * * *');
    setVal('set-fetch-schedule', res.attendanceFetchSchedule || '*/15 * * * *');
    const port = res.admsPort || 5015;
    const host = res.serverIp || window.location.hostname;
    setText('settings-adms-port', port);
    setText('adms-port-current', port);
    setText('settings-adms-url', `http://${host}:${port}`);
    setText('adms-port-display', port);
    setText('adms-address', host);
    setVal('set-adms-port', port);

    // Sync toggles
    const empEnabled = res.employeeSyncEnabled !== false;
    const attEnabled = res.attendanceSyncEnabled !== false;
    document.getElementById('toggle-employee-sync').checked  = empEnabled;
    document.getElementById('toggle-attendance-sync').checked = attEnabled;
    applySyncToggleUI('employee', empEnabled);
    applySyncToggleUI('attendance', attEnabled);
  }
}

function applySyncToggleUI(type, enabled) {
  if (type === 'employee') {
    document.getElementById('emp-sync-fields').style.opacity = enabled ? '1' : '0.4';
    document.getElementById('emp-sync-status-text').textContent = enabled
      ? 'Running — syncs employees from ERP to devices'
      : 'Disabled — schedule will not run';
    document.getElementById('emp-sync-status-text').style.color = enabled ? '' : 'var(--red)';
  } else {
    document.getElementById('att-sync-fields').style.opacity = enabled ? '1' : '0.4';
    document.getElementById('att-sync-status-text').textContent = enabled
      ? 'Running — pushes new attendance records to ERP'
      : 'Disabled — schedule will not run';
    document.getElementById('att-sync-status-text').style.color = enabled ? '' : 'var(--red)';
  }
}

async function toggleSync(type) {
  const empEnabled = document.getElementById('toggle-employee-sync').checked;
  const attEnabled = document.getElementById('toggle-attendance-sync').checked;
  applySyncToggleUI('employee', empEnabled);
  applySyncToggleUI('attendance', attEnabled);

  const body = type === 'employee'
    ? { employeeSyncEnabled: empEnabled }
    : { attendanceSyncEnabled: attEnabled };

  const res = await api('/config', body);
  if (res?.success) {
    const label = type === 'employee' ? 'Employee sync' : 'Attendance sync';
    const state = type === 'employee' ? empEnabled : attEnabled;
    toast(`${label} ${state ? 'enabled' : 'disabled'}`, state ? 'success' : 'info');
  }
}

async function restartServer() {
  if (!confirm('Restart the server? It will be back in ~2 seconds (requires PM2).')) return;
  try {
    await api('/server/restart', {});
    toast('Restarting server…', 'info');
    setTimeout(() => { window.location.reload(); }, 3000);
  } catch {
    toast('Restart signal sent', 'info');
    setTimeout(() => { window.location.reload(); }, 3000);
  }
}

async function saveAdmsPort() {
  const port = parseInt(val('set-adms-port'));
  if (!port || port < 1024 || port > 65535) {
    toast('Invalid port (must be 1024–65535)', 'error'); return;
  }
  const btn = document.querySelector('button[onclick="saveAdmsPort()"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }
  const res = await api('/config', { admsPort: port });
  if (btn) { btn.disabled = false; btn.textContent = 'Save & Apply'; }
  if (res?.success) {
    setText('settings-adms-port', port);
    setText('adms-port-current', port);
    setText('adms-port-display', port);
    const host = document.getElementById('adms-address')?.textContent || window.location.hostname;
    setText('settings-adms-url', `http://${host}:${port}`);
    toast(`ADMS port changed to ${port} — live, no restart needed`, 'success');
  } else {
    toast('Failed to change port', 'error');
  }
}

async function saveConfig() {
  const body = {
    laravelApiUrl: val('set-laravel-url'),
    laravelApiToken: val('set-laravel-token'),
    fetchEmployeeUrl: val('set-fetch-employee-url'),
    syncAttendanceUrl: val('set-sync-attendance-url'),
    syncSchedule: val('set-sync-schedule'),
    attendanceFetchSchedule: val('set-fetch-schedule'),
    employeeSyncEnabled: document.getElementById('toggle-employee-sync').checked,
    attendanceSyncEnabled: document.getElementById('toggle-attendance-sync').checked,
  };
  const res = await api('/config', body);
  if (res?.success) toast('Configuration saved', 'success');
  else toast('Failed to save config', 'error');
  fetchState();
}

async function testERP() {
  const el = document.getElementById('laravel-test-result');
  el.innerHTML = '<span style="color:var(--text-2)">Testing connection...</span>';
  const res = await api('/laravel/test', {});
  if (res?.success) {
    el.innerHTML = '<div class="badge-green">Connected successfully</div>';
    toast('ERP API connected!', 'success');
  } else {
    el.innerHTML = `<div style="color:var(--red);font-size:12px">Failed: ${res?.message || 'Unknown error'}</div>`;
    toast('ERP connection failed', 'error');
  }
}

function setSchedule(sync, fetch) {
  setVal('set-sync-schedule', sync);
  setVal('set-fetch-schedule', fetch);
}

// ── Logs ──────────────────────────────────────────────────────────
async function clearAllLogs() {
  if (!confirm('Clear all logs? This cannot be undone.')) return;
  const res = await api('/logs/clear', null, 'POST');
  if (res?.success) {
    toast('Logs cleared', 'success');
    document.getElementById('log-container').innerHTML = '<div class="empty-state">Logs cleared</div>';
    fetchState();
  } else {
    toast('Failed to clear logs', 'error');
  }
}

async function loadLogs() {
  const res = await api('/logs', null, 'GET');
  const el = document.getElementById('log-container');
  if (!res?.lines?.length) { el.innerHTML = '<div class="empty-state" style="color:#475569">No logs yet</div>'; return; }
  el.innerHTML = res.lines.map(line => {
    const cls = line.includes('ERROR') ? 'error' : line.includes('WARN') ? 'warn' : line.includes('INFO') ? 'info' : '';
    return `<div class="log-line ${cls}">${escHtml(line)}</div>`;
  }).join('');
}

// ── Global sync ───────────────────────────────────────────────────
async function triggerSync() {
  const btn = document.querySelector('[onclick="triggerSync()"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" style="animation:spin 1s linear infinite"><path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg> Syncing…'; }

  showSyncProgress('step1');
  const res = await api('/laravel/sync-all', {});

  if (btn) { btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg> Sync Now'; }

  hideSyncProgress();

  if (res?.success) {
    const parts = [];
    if (res.tcpFetched) parts.push(`TCP: ${res.tcpFetched} fetched`);
    parts.push(`ADMS: ${res.admsRecords} records`);
    if (res.pushed) parts.push(`Pushed: ${res.pushed} new`);
    if (res.alreadyPushed) parts.push(`Already done: ${res.alreadyPushed}`);
    toast(`Sync complete — ${parts.join(' · ')}`, 'success');
    fetchState();
    renderAttendanceTable();
  } else {
    toast('Sync failed', 'error');
  }
}

let syncProgressEl = null;
function showSyncProgress(step) {
  if (!syncProgressEl) {
    syncProgressEl = document.createElement('div');
    syncProgressEl.style.cssText = 'position:fixed;bottom:80px;right:24px;background:#1a1a2e;color:#fff;border-radius:12px;padding:14px 18px;font-size:13px;z-index:9999;min-width:240px;box-shadow:0 4px 20px rgba(0,0,0,.3)';
    document.body.appendChild(syncProgressEl);
  }
  syncProgressEl.innerHTML = `
    <div style="font-weight:600;margin-bottom:10px">🔄 Syncing…</div>
    <div style="display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="width:16px;height:16px;border-radius:50%;background:#6c63ff;display:flex;align-items:center;justify-content:center;font-size:10px">1</span>
        Fetching from TCP devices
      </div>
      <div style="display:flex;align-items:center;gap:8px;opacity:.5">
        <span style="width:16px;height:16px;border-radius:50%;background:#444;display:flex;align-items:center;justify-content:center;font-size:10px">2</span>
        Collecting ADMS data
      </div>
      <div style="display:flex;align-items:center;gap:8px;opacity:.5">
        <span style="width:16px;height:16px;border-radius:50%;background:#444;display:flex;align-items:center;justify-content:center;font-size:10px">3</span>
        Pushing to ERP
      </div>
    </div>`;
  syncProgressEl.style.display = '';
}
function hideSyncProgress() {
  if (syncProgressEl) syncProgressEl.style.display = 'none';
}

// ── Sidebar status ────────────────────────────────────────────────
function renderSidebarStatus() {
  const s = state.stats || {};
  setDot('status-laravel', s.laravelConnected ? 'online' : 'offline');
  setDot('status-adms', 'online'); // ADMS always running
}

// ── Page navigation ───────────────────────────────────────────────
function showPage(name, el) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  if (el) el.classList.add('active');
  else document.querySelector(`[data-page=${name}]`)?.classList.add('active');
  setText('page-title', name.charAt(0).toUpperCase() + name.slice(1));
  localStorage.setItem('activePage', name);

  if (name === 'logs') loadLogs();
  if (name === 'settings') loadSettings();
  if (name === 'employees') loadBridgeEmployees();
}

// ── Helpers ───────────────────────────────────────────────────────
async function api(path, body, method) {
  try {
    const m = method || (body !== null && body !== undefined ? 'POST' : 'GET');
    const opts = { method: m, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch('/api' + path, opts);
    return await res.json();
  } catch (e) { console.error(e); return null; }
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function showLiveAttendancePulse(record) {
  const msg = `${record.employeeId} — ${record.status==='1'?'Check Out':'Check In'} @ ${record.time}`;
  toast(msg, record.status==='1'?'info':'success');
}

function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
function val(id) { const el = document.getElementById(id); return el ? el.value : ''; }
function updateNavBadge(id, count) { const el = document.getElementById(id); if (el) { el.textContent = count; el.style.display = count > 0 ? '' : 'none'; } }
function setDot(id, cls) { const el = document.getElementById(id); if (el) { el.className = 'status-dot ' + cls; } }
function setSocketStatus(online) {
  const el = document.getElementById('socket-status');
  if (el) el.innerHTML = `<span class="status-dot ${online?'online':'offline'}"></span> ${online?'Live':'Disconnected'}`;
}
function verifyLabel(v) {
  const map = { '0': ['Password',''], '1': ['Fingerprint','tag-blue'], '2': ['Face','tag-green'], '3': ['Card','tag-amber'], '4': ['FP+Pass','tag-blue'], '15': ['Face+Pass','tag-green'] };
  const [label, cls] = map[String(v)] || ['Unknown',''];
  return `<span class="tag ${cls}">${label}</span>`;
}
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function timeAgo(iso) {
  const diff = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

// ── Init ──────────────────────────────────────────────────────────
// ── Permission map: permission key → CSS selector ─────────────────
const PERM_SELECTORS = {
  'nav.dashboard':          '[data-page="dashboard"]',
  'nav.devices':            '[data-page="devices"]',
  'nav.employees':          '[data-page="employees"]',
  'nav.attendance':         '[data-page="attendance"]',
  'nav.logs':               '[data-page="logs"]',
  'nav.settings':           '[data-page="settings"]',
  'nav.guide':              '[data-page="guide"]',
  'employees.btn_load_laravel': '#import-laravel-btn',
  'employees.btn_load_machine': '#load-machine-emp-btn',
  'employees.btn_set_device':   '#set-emp-btn',
  'employees.btn_add_employee': '#create-emp-btn',
  'employees.export_csv':       '#export-csv-btn',
  'employees.export_dat':       '#export-dat-btn',
  'employees.card_export_guide':'#card-export-guide',
  'employees.card_api_docs':    '#card-api-docs',
  'devices.card_add_tcp':       '#card-add-tcp',
  'devices.card_adms_info':     '#card-adms-info',
  'devices.card_ping_test':     '#card-ping-test',
  'attendance.btn_fetch':        '#btn-fetch-attendance',
  'attendance.btn_push_laravel': '#btn-push-laravel',
};

async function applyPermissions() {
  try {
    const res = await fetch('/api/permissions');
    const { permissions } = await res.json();
    for (const [permKey, selector] of Object.entries(PERM_SELECTORS)) {
      const [section, key] = permKey.split('.');
      const allowed = permissions?.[section]?.[key] !== false;
      document.querySelectorAll(selector).forEach(el => {
        el.style.display = allowed ? '' : 'none';
      });
    }
  } catch (e) { console.warn('Could not load permissions', e); }
}

async function loadCurrentUser() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) { window.location.href = '/login'; return; }
    const user = await res.json();
    const info = document.getElementById('sidebar-user-info');
    if (info) info.textContent = user.username + ' (' + user.role + ')';
    const usersLink = document.getElementById('nav-users-link');
    if (usersLink && (user.role === 'superadmin' || user.role === 'admin')) usersLink.style.display = 'flex';
  } catch {}
}

async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

document.addEventListener('DOMContentLoaded', () => {
  loadCurrentUser();
  applyPermissions();
  const savedPage = localStorage.getItem('activePage') || 'dashboard';
  showPage(savedPage);
  fetchState();
  loadSettings();
  setInterval(fetchState, 30000);
});
