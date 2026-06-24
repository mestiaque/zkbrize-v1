module.exports = {
  apps: [{
    name: 'zk-bridge',
    script: 'src/server.js',
    watch: false,
    autorestart: true,
    restart_delay: 1000,
    env: { NODE_ENV: 'production' },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
