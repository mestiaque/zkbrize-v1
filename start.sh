#!/bin/bash

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Check node_modules
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

# Start or restart with PM2
if command -v pm2 &>/dev/null; then
  if pm2 list | grep -q "zk-bridge"; then
    pm2 restart zk-bridge
  else
    pm2 start ecosystem.config.js
  fi
else
  # Fallback: run directly in background
  nohup node src/server.js > logs/server.log 2>&1 &
  echo "Server started (no PM2)"
fi

# Wait for server to be ready
echo "Waiting for server..."
for i in {1..15}; do
  if curl -s http://localhost:3000 > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Open browser
if command -v xdg-open &>/dev/null; then
  xdg-open http://localhost:3000
elif command -v gnome-open &>/dev/null; then
  gnome-open http://localhost:3000
fi
