const express = require('express');
const router = express.Router();
const {
  verifyLogin, createUser, updateUser, deleteUser, listUsers,
  createRole, updateRole, deleteRole, loadRoles,
  requireAdmin, requireSuperAdmin, MASTER_USERNAME,
} = require('./auth');

// ── Auth ───────────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, error: 'Username and password required' });
  const user = await verifyLogin(username, password);
  if (!user) return res.json({ success: false, error: 'Invalid username or password' });
  req.session.user = user;
  res.json({ success: true, user: { username: user.username, role: user.role } });
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

router.get('/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json(req.session.user);
});

// ── Users (admin + superadmin) ─────────────────────────────────────

router.get('/users', requireAdmin, (req, res) => {
  res.json({ users: listUsers(), masterUser: MASTER_USERNAME });
});

router.post('/users/create', requireAdmin, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.json({ success: false, error: 'Username and password required' });
  if (role === 'superadmin' && req.session.user.role !== 'superadmin')
    return res.json({ success: false, error: 'Only superadmin can assign superadmin role' });
  res.json(createUser(username, password, role));
});

router.post('/users/update', requireAdmin, (req, res) => {
  const { id, role, password } = req.body;
  if (!id) return res.json({ success: false, error: 'ID required' });
  if (role === 'superadmin' && req.session.user.role !== 'superadmin')
    return res.json({ success: false, error: 'Only superadmin can assign superadmin role' });
  res.json(updateUser(id, { role, ...(password ? { password } : {}) }));
});

router.post('/users/delete', requireAdmin, (req, res) => {
  const { id } = req.body;
  if (!id) return res.json({ success: false, error: 'ID required' });
  res.json(deleteUser(id));
});

// ── Roles (admin + superadmin) ─────────────────────────────────────

router.get('/roles', requireAdmin, (req, res) => {
  res.json({ roles: loadRoles() });
});

router.post('/roles/create', requireAdmin, (req, res) => {
  const { name, permissions } = req.body;
  if (!name) return res.json({ success: false, error: 'Role name required' });
  res.json(createRole(name, permissions));
});

router.post('/roles/update', requireAdmin, (req, res) => {
  const { id, name, permissions } = req.body;
  if (!id) return res.json({ success: false, error: 'Role ID required' });
  res.json(updateRole(id, { name, permissions }));
});

router.post('/roles/delete', requireAdmin, (req, res) => {
  const { id } = req.body;
  if (!id) return res.json({ success: false, error: 'Role ID required' });
  res.json(deleteRole(id));
});

module.exports = router;
