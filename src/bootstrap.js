// First-run setup: creates .env, data/ and logs/ so a fresh install starts
// without any manual steps on Linux or Windows.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const DATA_DIR = path.join(ROOT, 'data');
const LOGS_DIR = path.join(ROOT, 'logs');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function setEnvValue(content, key, value) {
  const regex = new RegExp(`^${key}=.*$`, 'm');
  return regex.test(content) ? content.replace(regex, `${key}=${value}`) : `${content.trimEnd()}\n${key}=${value}\n`;
}

// Must run before dotenv is loaded
function prepareEnvironment() {
  ensureDir(DATA_DIR);
  ensureDir(LOGS_DIR);

  if (fs.existsSync(ENV_FILE)) return;

  let content = fs.existsSync(ENV_EXAMPLE) ? fs.readFileSync(ENV_EXAMPLE, 'utf8') : '';
  const masterPassword = crypto.randomBytes(6).toString('hex');
  content = setEnvValue(content, 'SESSION_SECRET', crypto.randomBytes(32).toString('hex'));
  content = setEnvValue(content, 'MASTER_PASSWORD', masterPassword);
  fs.writeFileSync(ENV_FILE, content);

  const user = (content.match(/^MASTER_USERNAME=(.*)$/m) || [])[1] || 'superadmin';
  console.log('\n  Created .env from .env.example');
  console.log(`  Login: ${user} / ${masterPassword}  (change MASTER_PASSWORD in .env)\n`);
}

// Write default content for any data file that does not exist yet
function ensureDataFiles(defaults) {
  ensureDir(DATA_DIR);
  for (const [file, value] of Object.entries(defaults)) {
    const target = path.join(DATA_DIR, file);
    if (!fs.existsSync(target)) fs.writeFileSync(target, JSON.stringify(value, null, 2));
  }
}

module.exports = { prepareEnvironment, ensureDataFiles, ENV_FILE };
