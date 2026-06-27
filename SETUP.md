# ZK Bridge — Setup Guide

**Developer:** M. Estiaque Ahmed Khan | **Company:** Natore-IT

---

## প্রয়োজনীয় Software ইনস্টল

### Node.js (v18 বা তার উপরে)

**Linux (Ubuntu/Debian):**
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # চেক করুন
```

**Windows:**
- https://nodejs.org থেকে LTS version ডাউনলোড করুন
- ইনস্টল করার পর Command Prompt-এ চেক করুন:
```cmd
node -v
npm -v
```

---

### PM2 (Background Process Manager)

```bash
npm install -g pm2
pm2 -v   # চেক করুন
```

> Windows-এ Administrator হিসেবে Command Prompt/PowerShell-এ চালান।

---

## Project Setup

```bash
# Project folder-এ যান
cd /path/to/zk-bridge

# Dependencies ইনস্টল করুন
npm install
```

---

## Background-এ Run করা

### Linux

```bash
# PM2 দিয়ে start করুন
pm2 start src/server.js --name zk-bridge

# Status দেখুন
pm2 status

# Live logs দেখুন
pm2 logs zk-bridge

# Restart করুন
pm2 restart zk-bridge

# Stop করুন
pm2 stop zk-bridge
```

### Windows

```cmd
# PM2 দিয়ে start করুন
pm2 start src/server.js --name zk-bridge

# Status দেখুন
pm2 status

# Live logs দেখুন
pm2 logs zk-bridge
```

---

## PC চালু হলে Auto-Start

### Linux (systemd)

```bash
# PM2 startup script তৈরি করুন
pm2 startup

# উপরের command output-এ একটা sudo command দেবে, সেটা copy করে run করুন
# উদাহরণ:
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u your-username --hp /home/your-username

# বর্তমান process list save করুন
pm2 save
```

এখন থেকে PC reboot হলেও zk-bridge স্বয়ংক্রিয়ভাবে চালু হবে।

**চেক করতে:**
```bash
pm2 list
```

---

### Windows (Auto-start)

```cmd
# PowerShell (Administrator) দিয়ে চালান:
pm2 startup

# দেওয়া command run করুন, তারপর:
pm2 save

# pm2-startup package দিয়ে Windows Service হিসেবে রেজিস্টার করুন:
npm install -g pm2-windows-startup
pm2-startup install
```

অথবা **Task Scheduler** দিয়ে:
1. `Win + R` → `taskschd.msc`
2. "Create Basic Task" → Trigger: "When the computer starts"
3. Action: `pm2 resurrect`

---

## Port চালু আছে কিনা চেক করুন

### ব্যবহৃত Ports
| Port | কাজ |
|------|-----|
| `3000` | Web UI (Browser) |
| `5015` | ADMS Protocol (ZKTeco device connect) |

### Linux-এ চেক করুন
```bash
# কোন port listen করছে দেখুন
sudo ss -tlnp | grep -E '3000|5015'

# অথবা
sudo netstat -tlnp | grep -E '3000|5015'

# নির্দিষ্ট port-এ কিছু আছে কিনা
sudo lsof -i :3000
sudo lsof -i :5015
```

### Windows-এ চেক করুন
```cmd
netstat -ano | findstr :3000
netstat -ano | findstr :5015
```

### Firewall-এ Port খুলুন

**Linux (UFW):**
```bash
sudo ufw allow 3000
sudo ufw allow 5015
sudo ufw status
```

**Linux (firewalld):**
```bash
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --permanent --add-port=5015/tcp
sudo firewall-cmd --reload
```

**Windows (PowerShell — Administrator):**
```powershell
netsh advfirewall firewall add rule name="ZK Bridge Web" dir=in action=allow protocol=TCP localport=3000
netsh advfirewall firewall add rule name="ZK Bridge ADMS" dir=in action=allow protocol=TCP localport=5015
```

---

## Same Network-এ Machine চালু আছে কিনা Terminal দিয়ে চেক করুন

### একটা নির্দিষ্ট Machine Ping করুন

**Linux & Windows উভয়ে:**
```bash
ping 192.168.1.100
```

**নির্দিষ্ট Port চালু আছে কিনা (TCP Ping):**

Linux:
```bash
# ZKTeco machine-এর port 4370 চালু আছে কিনা
nc -zv 192.168.1.100 4370

# অথবা
timeout 3 bash -c 'cat < /dev/null > /dev/tcp/192.168.1.100/4370' && echo "Open" || echo "Closed"
```

Windows:
```cmd
# PowerShell
Test-NetConnection -ComputerName 192.168.1.100 -Port 4370
```

---

### Network-এ সব Active Machine খুঁজে বের করুন

**Linux — nmap দিয়ে (সবচেয়ে ভালো):**
```bash
# ইনস্টল না থাকলে
sudo apt install nmap -y

# পুরো subnet scan করুন (আপনার subnet অনুযায়ী বদলান)
sudo nmap -sn 192.168.1.0/24

# শুধু ZKTeco-র common port (4370) চালু এমন machine খুঁজুন
sudo nmap -p 4370 192.168.1.0/24 --open
```

**Linux — arp-scan দিয়ে (দ্রুত):**
```bash
sudo apt install arp-scan -y
sudo arp-scan --localnet
```

**Linux — ping sweep (nmap ছাড়া):**
```bash
for i in $(seq 1 254); do
  ping -c 1 -W 1 192.168.1.$i &>/dev/null && echo "192.168.1.$i is UP" &
done
wait
```

**Windows — PowerShell:**
```powershell
1..254 | ForEach-Object {
  $ip = "192.168.1.$_"
  if (Test-Connection -ComputerName $ip -Count 1 -Quiet -ErrorAction SilentlyContinue) {
    Write-Host "$ip is UP"
  }
}
```

**Windows — arp table দেখুন (connected device):**
```cmd
arp -a
```

---

## Environment Variables (Optional)

Project folder-এ `.env` file তৈরি করুন:

```env
PORT=3000
ADMS_PORT=5015
SESSION_SECRET=your-secret-key-here
MASTER_USERNAME=superadmin
MASTER_PASSWORD=your-password-here
```

---

## Server Restart করুন

```bash
# Restart (config/code change-এর পর)
pm2 restart zk-bridge

# Stop করুন
pm2 stop zk-bridge

# Start করুন (stop-এর পর)
pm2 start zk-bridge

# Force kill করে fresh start
pm2 delete zk-bridge
pm2 start src/server.js --name zk-bridge
pm2 save

# Restart করে live log দেখুন
pm2 restart zk-bridge && pm2 logs zk-bridge
```

**Windows-এ একই command কাজ করে।**

---

## Git Pull (data/ skip করে)

`data/` folder-এ employees, config, permissions সব থাকে — pull-এ overwrite হলে সব মুছে যাবে।

### Linux

```bash
git stash && git pull origin master && git checkout stash@{0} -- data/ && git stash drop
```

একলাইনে কী হচ্ছে:
1. `git stash` — data/ সহ সব local change সরিয়ে রাখে
2. `git pull origin master` — latest code নামায়
3. `git checkout stash@{0} -- data/` — stash থেকে শুধু data/ ফিরিয়ে আনে
4. `git stash drop` — stash মুছে দেয়

### Windows (Command Prompt / PowerShell)

```cmd
git stash && git pull origin master && git checkout stash@{0} -- data/ && git stash drop
```

Windows-এও একই command কাজ করে।

### Pull-এর পর সবসময় করুন

```bash
# নতুন dependency থাকতে পারে
npm install

# Server restart করুন
pm2 restart zk-bridge
```

---

## Quick Start Summary

```bash
# ১. Install
npm install
npm install -g pm2

# ২. Start
pm2 start src/server.js --name zk-bridge

# ৩. Auto-start on boot
pm2 startup   # দেওয়া command run করুন
pm2 save

# ৪. Browser-এ খুলুন
# http://localhost:3000
# অথবা same network থেকে: http://192.168.x.x:3000

# ৫. Server restart করুন
pm2 restart zk-bridge

# ৬. Code update (data/ নষ্ট না করে)
git stash && git pull origin master && git checkout stash@{0} -- data/ && git stash drop
npm install
pm2 restart zk-bridge
```

---

*Developed by Natore-IT — https://natoreit.com*
