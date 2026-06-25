#!/bin/bash
if command -v pm2 &>/dev/null; then
  pm2 stop zk-bridge
  echo "ZK Bridge stopped."
fi
