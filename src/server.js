require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const logger = require('./logger');
const { store, loadConfigFile } = require('./store');
const routes = require('./routes');
const authRoutes = require('./authRoutes');
const { requireAuth, requireSuperAdmin } = require('./auth');
const { startADMSServer, setSocketIO: admsSetIO } = require('./adms/server');
const { setSocketIO: tcpSetIO } = require('./tcpip/connector');
const { startScheduler, setSocketIO: schedSetIO } = require('./scheduler');

// Load config from env
store.config.laravelApiUrl = process.env.LARAVEL_API_URL || '';
store.config.laravelApiToken = process.env.LARAVEL_API_TOKEN || '';
store.config.fetchEmployeeUrl = process.env.FETCH_EMPLOYEE_URL || '';
store.config.syncAttendanceUrl = process.env.SYNC_ATTENDANCE_URL || '';
store.config.admsPort = parseInt(process.env.ADMS_PORT) || 5015;
store.config.syncSchedule = process.env.SYNC_SCHEDULE || '*/30 * * * *';
store.config.attendanceFetchSchedule = process.env.ATTENDANCE_FETCH_SCHEDULE || '*/15 * * * *';
store.config.employeeSyncEnabled     = process.env.EMPLOYEE_SYNC_ENABLED !== 'false';
store.config.attendanceSyncEnabled   = process.env.ATTENDANCE_SYNC_ENABLED !== 'false';
loadConfigFile();

const PORT = parseInt(process.env.PORT) || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || ('zk-bridge-' + Math.random().toString(36));

const app = express();
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
admsSetIO(io);
tcpSetIO(io);
schedSetIO(io);

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 },
}));

// ── Public routes (no auth required) ──────────────────────────────
// Serve logo and favicon before auth so login page can display them
const publicDir = path.join(__dirname, '../public');
app.get('/logo.png',    (req, res) => res.sendFile(path.join(publicDir, 'logo.png')));
app.get('/favicon.png', (req, res) => res.sendFile(path.join(publicDir, 'favicon.png')));
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(publicDir, 'favicon.png')));

app.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../public/login.html'));
});
app.use('/api/auth', authRoutes);

// ── Everything below requires login ───────────────────────────────
app.use(requireAuth);

app.use(express.static(path.join(__dirname, '../public')));
app.use('/api', routes);
app.get('/permissions', requireSuperAdmin, (req, res) => res.sendFile(path.join(__dirname, '../public/permissions.html')));
app.get('/users', requireSuperAdmin, (req, res) => res.sendFile(path.join(__dirname, '../public/users.html')));

// ── Socket.IO ──────────────────────────────────────────────────────
io.on('connection', (socket) => {
  logger.info(`UI connected: ${socket.id}`);
  const { getState } = require('./store');
  socket.emit('init', getState());
  socket.on('disconnect', () => logger.info(`UI disconnected: ${socket.id}`));
});

// ── Start services ─────────────────────────────────────────────────
startADMSServer(store.config.admsPort);
logger.info(`ADMS server started on port ${store.config.admsPort}`);
startScheduler();

const G = '\x1b[32m', R = '\x1b[0m';
function printBanner() {
  const lines = [
    '',
    ' __  __         _____   ____    _____   ___     _      ___    _   _   _____ ',
    '|  \\/  |       | ____| / ___|  |_   _| |_ _|   / \\    / _ \\  | | | | | ____|',
    '| |\\/| |       |  _|   \\___ \\    | |    | |   / _ \\  | | | | | | | | |  _|  ',
    '| |  | |   .   | |___   ___) |   | |    | |  / ___ \\ | |_| | | |_| | | |___ ',
    '|_|  |_|       |_____| |____/    |_|   |___| /_/ \\_\\  \\__\\_\\  \\___/  |_____|',
    '',
    '              ZKTeco ↔ ERP Bridge — by Natore-IT  |  http://localhost:' + PORT,
    '',
  ];
  lines.forEach(l => process.stdout.write(G + l + R + '\n'));
}

server.listen(PORT, '0.0.0.0', () => {
  logger.info(`ZK-ERP Bridge running at http://localhost:${PORT}`);
  logger.info(`ADMS listener on port ${store.config.admsPort}`);
  printBanner();
});

process.on('SIGUSR2', () => {
  logger.info('Banner requested via signal');
  printBanner();
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', { error: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', { reason: String(reason) });
});
