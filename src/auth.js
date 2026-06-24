const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, '../data/users.json');
const ROLES_FILE = path.join(__dirname, '../data/roles.json');
const MASTER_USERNAME = process.env.MASTER_USERNAME || 'superadmin';
const MASTER_PASSWORD = process.env.MASTER_PASSWORD || '';

// ── Default roles ──────────────────────────────────────────────────

const FULL_PERMISSIONS = {
  nav: { dashboard: true, devices: true, employees: true, attendance: true, logs: true, settings: true, guide: true },
  employees: { btn_load_laravel: true, btn_load_machine: true, btn_set_device: true, btn_add_employee: true, export_csv: true, export_dat: true, card_export_guide: true, card_api_docs: true },
  devices: { card_add_tcp: true, card_adms_info: true, card_ping_test: true },
  attendance: { btn_fetch: true, btn_push_laravel: true },
};

const VIEWER_PERMISSIONS = {
  nav: { dashboard: true, devices: false, employees: true, attendance: true, logs: false, settings: false, guide: true },
  employees: { btn_load_laravel: false, btn_load_machine: false, btn_set_device: false, btn_add_employee: false, export_csv: false, export_dat: false, card_export_guide: false, card_api_docs: false },
  devices: { card_add_tcp: false, card_adms_info: false, card_ping_test: false },
  attendance: { btn_fetch: false, btn_push_laravel: false },
};

const DEFAULT_ROLES = [
  { id: 'superadmin', name: 'superadmin', locked: true,  permissions: JSON.parse(JSON.stringify(FULL_PERMISSIONS)) },
  { id: 'admin',      name: 'admin',      locked: false, permissions: JSON.parse(JSON.stringify(FULL_PERMISSIONS)) },
  { id: 'viewer',     name: 'viewer',     locked: false, permissions: JSON.parse(JSON.stringify(VIEWER_PERMISSIONS)) },
];

// ── Role store ─────────────────────────────────────────────────────

function loadRoles() {
  try {
    if (fs.existsSync(ROLES_FILE)) return JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_ROLES));
}

function saveRoles(roles) {
  const dir = path.dirname(ROLES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ROLES_FILE, JSON.stringify(roles, null, 2));
}

function createRole(name, permissions) {
  const roles = loadRoles();
  const slug = name.toLowerCase().replace(/\s+/g, '_');
  if (roles.find(r => r.id === slug)) return { success: false, error: 'Role already exists' };
  const role = { id: slug, name: slug, locked: false, permissions: permissions || {} };
  roles.push(role);
  saveRoles(roles);
  return { success: true, role };
}

function updateRole(id, fields) {
  const roles = loadRoles();
  const idx = roles.findIndex(r => r.id === id);
  if (idx === -1) return { success: false, error: 'Role not found' };
  if (roles[idx].locked) return { success: false, error: 'This role cannot be edited' };
  if (fields.permissions) roles[idx].permissions = { ...roles[idx].permissions, ...fields.permissions };
  if (fields.name) roles[idx].name = fields.name;
  saveRoles(roles);
  return { success: true, role: roles[idx] };
}

function deleteRole(id) {
  const roles = loadRoles();
  const idx = roles.findIndex(r => r.id === id);
  if (idx === -1) return { success: false, error: 'Role not found' };
  if (roles[idx].locked) return { success: false, error: 'Built-in role cannot be deleted' };
  roles.splice(idx, 1);
  saveRoles(roles);
  return { success: true };
}

// ── User store ─────────────────────────────────────────────────────

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {}
  return [];
}

function saveUsers(users) {
  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function findUser(username) {
  return loadUsers().find(u => u.username.toLowerCase() === username.toLowerCase());
}

function createUser(username, password, role = 'admin') {
  const users = loadUsers();
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return { success: false, error: 'Username already exists' };
  }
  const hash = bcrypt.hashSync(password, 10);
  const user = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    username, password: hash, role,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  saveUsers(users);
  return { success: true, user: safeUser(user) };
}

function updateUser(id, fields) {
  const users = loadUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return { success: false, error: 'User not found' };
  if (fields.password) fields.password = bcrypt.hashSync(fields.password, 10);
  users[idx] = { ...users[idx], ...fields };
  saveUsers(users);
  return { success: true, user: safeUser(users[idx]) };
}

function deleteUser(id) {
  const users = loadUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return { success: false, error: 'User not found' };
  users.splice(idx, 1);
  saveUsers(users);
  return { success: true };
}

function listUsers() { return loadUsers().map(safeUser); }
function safeUser(u) { return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt }; }

// ── Auth verify ────────────────────────────────────────────────────

async function verifyLogin(username, password) {
  if (MASTER_PASSWORD && username === MASTER_USERNAME && password === MASTER_PASSWORD) {
    return { id: 'master', username: MASTER_USERNAME, role: 'superadmin' };
  }
  const user = findUser(username);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return null;
  return safeUser(user);
}

// ── Middleware ─────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  const role = req.session?.user?.role;
  if (role === 'superadmin' || role === 'admin') return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Forbidden' });
  res.status(403).send('Forbidden');
}

function requireSuperAdmin(req, res, next) {
  if (req.session?.user?.role === 'superadmin') return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Forbidden' });
  res.status(403).send('Forbidden');
}

module.exports = {
  requireAuth, requireAdmin, requireSuperAdmin,
  verifyLogin,
  createUser, updateUser, deleteUser, listUsers, loadUsers,
  createRole, updateRole, deleteRole, loadRoles,
  MASTER_USERNAME,
};
