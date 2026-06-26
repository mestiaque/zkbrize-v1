# ZKTeco ↔ ERP Bridge

A Node.js application that bridges ZKTeco attendance devices with a ERP API.

## Features

- **ADMS Server** — newer ZKTeco devices push data in real-time
- **TCP/IP Connector** — connect older devices via pull mode
- **ERP Sync** — bidirectional: employees from ERP → devices, attendance from devices → ERP
- **Live Dashboard** — real-time UI with Socket.IO
- **Scheduler** — automated sync via cron

---

## Quick Start

### 1. Install
```bash
npm install
```

### 2. Configure
```bash
cp config/default.env .env
# Edit .env with your settings
```

### 3. Run
```bash
npm start
# Open http://localhost:3000
```

---

## .env Configuration

```env
PORT=3000               # Web UI & API port
ADMS_PORT=7788          # ZKTeco ADMS push port

LARAVEL_API_URL=https://yourapp.com/api
LARAVEL_API_TOKEN=your-sanctum-token

SYNC_SCHEDULE=*/30 * * * *           # Employee sync frequency
ATTENDANCE_FETCH_SCHEDULE=*/15 * * * * # TCP device pull frequency
```

---

## ERP API Endpoints Required

Add these to your ERP app:

```php
// routes/api.php
Route::middleware('auth:sanctum')->prefix('zk')->group(function () {
    Route::get('/ping',        [ZKController::class, 'ping']);
    Route::get('/employees',   [ZKController::class, 'employees']);
    Route::post('/attendance', [ZKController::class, 'storeAttendance']);
});
```

### ZKController.php

```php
<?php
namespace App\Http\Controllers;

use App\Models\Employee;
use App\Models\Attendance;
use Illuminate\Http\Request;

class ZKController extends Controller
{
    public function ping()
    {
        return response()->json(['message' => 'pong', 'status' => 'ok']);
    }

    public function employees()
    {
        $employees = Employee::select('id', 'employee_id', 'name')
            ->get()
            ->map(fn($e, $i) => [
                'id'          => $e->id,
                'uid'         => $i + 1,         // ZKTeco UID (1-65535)
                'employee_id' => $e->employee_id,
                'name'        => $e->name,
                'privilege'   => 0,               // 0=user, 14=admin
                'password'    => '',
            ]);

        return response()->json(['data' => $employees]);
    }

    public function storeAttendance(Request $request)
    {
        $records = $request->input('records', []);
        $saved = 0;

        foreach ($records as $record) {
            Attendance::updateOrCreate(
                [
                    'employee_id' => $record['employee_id'] ?? null,
                    'punch_time'  => $record['time'] ?? null,
                    'device_id'   => $record['device_id'] ?? null,
                ],
                [
                    'status'  => $record['status'] ?? '0',
                    'source'  => $record['source'] ?? 'zk',
                    'raw'     => json_encode($record),
                ]
            );
            $saved++;
        }

        return response()->json(['saved' => $saved, 'message' => 'OK']);
    }
}
```

---

## Device Setup

### ADMS (Newer Devices)
On the ZKTeco device:
1. Go to **Comm → ADMS**
2. Set server address: `http://<this-machine-ip>:7788`
3. Enable push, save

The device will start pushing attendance automatically.

### TCP/IP (Older Devices)
1. Open the bridge web UI → **Devices**
2. Click **Add TCP/IP Device**
3. Enter device IP (default port: 4370)
4. Click Connect

---

## Running as a Windows Service

Use [NSSM](https://nssm.cc/):
```cmd
nssm install ZKBridge "C:\Program Files\nodejs\node.exe" "C:\zk-bridge\src\server.js"
nssm set ZKBridge AppDirectory "C:\zk-bridge"
nssm start ZKBridge
```

---

## Project Structure

```
zk-bridge/
├── src/
│   ├── server.js          # Main entry point
│   ├── routes.js          # Express API routes
│   ├── store.js           # In-memory state
│   ├── logger.js          # Winston logger
│   ├── scheduler.js       # Cron jobs
│   ├── adms/
│   │   └── server.js      # ADMS HTTP push server
│   ├── tcpip/
│   │   └── connector.js   # TCP/IP device connector
│   └── laravel/
│       └── api.js         # ERP API client
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── config/
│   └── default.env
├── logs/                  # Auto-created
└── README.md
```

---

## Developer

**M. Estiaque Ahmed Khan**
Company: [Natore-IT](https://natoreit.com)
> Built and maintained by Natore-IT. All rights reserved © 2026.
