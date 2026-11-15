![Logo](admin/eufy-next.svg)

# ioBroker.eufy-next

ioBroker adapter for **Anker eufy** devices — cameras, doorbells, HomeBases, locks, entry/leak/smoke sensors,
keypads, robot vacuums, mowers and smart lights — built on the new
[`@mega-yfue/eufy-sdk`](https://github.com/mega-yfue/eufy-sdk), which speaks the current eufy **v6 cloud**
with realtime events over push, MQTT and P2P.

> Independent and unofficial. Not affiliated with, endorsed by, or sponsored by Anker Innovations or eufy.

## How it works

The adapter contains **no per-model code**. For every device it asks the SDK what that device exposes
(`dev.describe()`) and generates the object tree from that manifest:

| Manifest                                   | ioBroker                                                           |
| ------------------------------------------ | ------------------------------------------------------------------ |
| capability (`battery`, `camera`, `light`…) | channel `eufy-next.0.<SN>.<capability>`                            |
| read (`level`, `brightness`, `mode`…)      | state with type/role/unit/`states` derived from the value's `kind` |
| writable read / stateful action            | the same state becomes writable (`ack=false` → command)            |
| momentary action without arguments         | `button` state                                                     |
| action with one argument                   | write-only control state                                           |
| action with several arguments              | write-only `json` state (array or object by argument name)         |
| event (`motion`, `doorbellPress`…)         | `events.<name>.triggered` / `.lastTriggered` / `.payload`          |

So a device only gets the controls it really supports, and devices or capabilities added to the SDK appear
automatically after an SDK update.

### Object tree

```
eufy-next.0
├── info.connection / loginStatus / loginMessage / captchaImage / pushConnected / mqttConnected
├── auth.verifyCode / captchaAnswer / relogin
└── <SERIAL>
    ├── info.name / model / modelName / available / lastSeen / capabilities …
    ├── camera.enabled / nightVision / statusLed …
    ├── battery.level / charging …
    ├── arming.mode
    ├── events.motion.triggered / lastTriggered / payload
    ├── events.lastEvent
    ├── snapshot.url / dataUrl / updated / refreshStored / refreshLive   (cameras)
    ├── livestream.start / stop / url / rtsp / active             (cameras)
    ├── station.reboot / p2pConnected                             (HomeBase, standalone cameras)
    ├── ptz.presetGoto / presetSave / presetDelete                (pan & tilt cameras)
    └── doorbell.quickResponse / quickResponses                   (doorbells)
```

Values are updated live by the SDK's `propertyChanged` announcements. Writes are acknowledged when the
device reports the new value back.

### Snapshots

For cameras the latest event thumbnail (motion, person, doorbell …) is stored in the ioBroker file system as
`eufy-next.0/<SERIAL>/snapshot.jpg`; `snapshot.url` holds the path (`/files/eufy-next.0/<SERIAL>/snapshot.jpg`).
`snapshot.refreshLive` captures a fresh frame — this needs `ffmpeg` and wakes battery cameras, so use it sparingly.

### Livestream

Cameras that can stream get a `livestream` channel:

| State               | Role           | Meaning                                                          |
| ------------------- | -------------- | ---------------------------------------------------------------- |
| `livestream.start`  | `button.start` | Start streaming                                                  |
| `livestream.stop`   | `button.stop`  | Stop streaming                                                   |
| `livestream.url`    | `url`          | Player page `http://<host>:1984/stream.html?src=<SERIAL>` — only while streaming, otherwise empty |
| `livestream.rtsp`   | `url`          | `rtsp://<host>:8554/<SERIAL>` — only while streaming             |
| `livestream.active` | `indicator`    | Stream is running                                                |

The adapter bundles [go2rtc](https://github.com/AlexxIT/go2rtc) as player server and pushes the camera's video
(copied, never re-encoded) and sound (as AAC) into it with ffmpeg. go2rtc starts with the first stream. The player
page plays via MSE/HLS (with sound) or WebRTC.

- **Maximum duration** (default 120 s, tab *Livestream*): the stream ends on its own. Battery cameras drain while
  streaming, so keep it short; there is no automatic restart.
- **Hostname**: the address put into the URLs. Empty = the host's first network address; set it if the player is
  opened from another device and that address is wrong.
- **Ports**: player/API 1984, RTSP 8554, WebRTC 8555 (TCP/UDP). The player port has **no login** — keep it in
  your home network and never forward it to the internet. RTSP can be protected with user/password.
- While a stream runs, a still is stored as `snapshot.url` (option *Save a still from the running stream*).
- ffmpeg: the configured path, else `ffmpeg` on `PATH`, else the bundled `ffmpeg-static`.

### Station, PTZ presets, quick responses

- `station.reboot` restarts a HomeBase or a camera that is its own station (offline for a minute or two).
  `station.p2pConnected` shows whether a P2P session is open — sessions open on demand and close when idle, so
  `false` is the normal resting state, not a fault.
- `ptz.presetGoto` / `presetSave` / `presetDelete` take a preset id; `ptz.presets` lists stored presets where the
  camera can be asked for them.
- `doorbell.quickResponse` plays a quick response by voice id; `doorbell.quickResponsesRefresh` fills
  `doorbell.quickResponses` with the available ones where the doorbell supports reading them.

### Scripts: `listActions` / `callAction`

Every action a device offers — including those the SDK does not describe generically (e.g. `ptz.rotate`,
`ptz.preset.list`, `smartLight.setEffect`) — can be called from scripts:

```js
sendTo("eufy-next.0", "listActions", { sn: "T8410P..." }, (r) => log(JSON.stringify(r.result)));
sendTo("eufy-next.0", "callAction",
    { sn: "T8410P...", capability: "ptz", action: "rotate", args: ["left"] },
    (r) => log(r.error ?? JSON.stringify(r.result)));
// nested sub-APIs use a dot: action "preset.goto", args [2]
```

Only actions the device's manifest lists are accepted. Return values come back in `result` (Buffers as base64).

### Livestream over HTTPS

Tab *Livestream* → *Serve the player over HTTPS* with a certificate from the ioBroker system settings. Needed when
the player is embedded in a visualisation served over HTTPS (browsers block HTTP content there). The adapter then
also uses the player port + 1 on 127.0.0.1 internally.

## Requirements

- **Node.js ≥ 24.5.0** (required by the eufy-sdk; older versions log a warning and encrypted camera video may fail)
- js-controller ≥ 6.0.11, admin ≥ 7.4.10
- `ffmpeg` and `go2rtc` are bundled (ffmpeg-static, go2rtc-static); a system ffmpeg is used if present

## Configuration

1. Enter e-mail, password and the **country code** of your eufy account (e.g. `DE`).
   Recommended: create a second eufy account, share your devices with it in the eufy app and use that one here.
2. Start the instance. On the first login eufy sends a **verification code** (e-mail/SMS).
   Open the instance settings → tab **Login (2FA / captcha)**, enter the code and press *Submit code*
   (alternatively write the code to `eufy-next.0.auth.verifyCode`).
   **Do not save the settings while a login is pending** — that restarts the instance and invalidates the code.
3. If a captcha is requested, it is shown on the same tab (and in `info.captchaImage`); enter the characters there
   or write them to `auth.captchaAnswer`.

The session is stored in the instance data directory, so later restarts log in without 2FA.

| Option                 | Description                                                                 |
| ---------------------- | --------------------------------------------------------------------------- |
| Send 2FA code via      | E-mail (default) or SMS                                                     |
| Cloud poll interval    | How often cloud-only values are polled (realtime values arrive immediately) |
| Value cache TTL        | How old a cached value may be before the SDK refreshes it in the background |
| Reset event states     | `events.*.triggered` is reset to `false` after this many seconds            |
| Save camera thumbnail  | Store the latest event thumbnail as a file                                  |
| Snapshot as data URL   | Additionally put the snapshot into `snapshot.dataUrl` for vis image/HTML widgets |
| ffmpeg path            | Optional; default is `ffmpeg` on `PATH`, else the bundled one               |
| Ignore devices         | Serial numbers to skip                                                      |
| Client identity        | Leave empty; a stable random identity is generated per instance             |
| Verbose SDK logging    | Show SDK info/warnings in the ioBroker log (debug level always contains them) |

## Development

```bash
npm install
npm run build
npm test                  # unit + package tests
npm run test:integration  # js-controller integration (needs Node.js >= 24.5)
```

- `test/mapping.test.mjs` runs the manifest mapping over a synthetic device that has **every** capability the
  installed SDK knows, so a new SDK release is checked automatically.
- `test/integration.js` starts the adapter in a real js-controller. The second suite swaps the SDK for
  `test/fixtures/fake-sdk.mjs` (via a Node module hook): the cloud is fake, but the device objects are the SDK's
  real capability objects — covering 2FA login, object tree, live updates, events and commands.

## Deutsch – Kurzanleitung

1. E-Mail, Passwort und Ländercode (z. B. `DE`) eintragen. Am besten ein zweites eufy-Konto anlegen und die Geräte
   in der eufy-App damit teilen.
2. Instanz starten. eufy schickt beim ersten Login einen **Bestätigungscode**. In den Instanzeinstellungen im Tab
   **Anmeldung (2FA / Captcha)** eingeben und *Code senden* klicken (oder in `eufy-next.0.auth.verifyCode` schreiben).
   Während der Anmeldung die Einstellungen **nicht speichern**, sonst startet die Instanz neu.
3. Danach erscheinen alle Geräte unter `eufy-next.0.<Seriennummer>` mit genau den Datenpunkten, die das Gerät
   unterstützt. Ereignisse (Bewegung, Klingel, Person …) liegen unter `events`.
4. Livestream: `livestream.start` drücken, `livestream.url` enthält dann die Player-Seite (go2rtc, Port 1984). Der
   Stream endet nach der Höchstdauer (Standard 120 s), weil Akku-Kameras sonst leerlaufen. Den Player-Port nur im
   Heimnetz nutzen, nicht ins Internet freigeben.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### 0.3.0 (2026-11-15)

- `station.reboot` and `station.p2pConnected` for HomeBases and standalone cameras
- PTZ presets: `ptz.presetGoto` / `presetSave` / `presetDelete` (+ `ptz.presets` where readable)
- Doorbell quick responses: `doorbell.quickResponse` (+ list where readable)
- `sendTo` commands `listActions` and `callAction` for every action a device offers, including undescribed ones
- 2FA code via e-mail or SMS (setting)
- Snapshot additionally as data URL (`snapshot.dataUrl`)
- Livestream player optionally over HTTPS with an ioBroker certificate
- Fix: rebuilding a device's objects after it gained capabilities no longer removes `info.stationSn`

### 0.2.0 (2026-11-15)

- Camera livestream: `livestream.start/stop/url/rtsp/active` with a bundled go2rtc player (MSE/HLS/WebRTC, RTSP),
  video copied, sound as AAC, configurable maximum duration (default 120 s)
- Still from the running stream as snapshot
- Bundled ffmpeg (ffmpeg-static) as fallback when no ffmpeg is on the host

### 0.1.0 (2026-11-15)

- Initial release based on `@mega-yfue/eufy-sdk` 0.5
- Manifest-driven object tree for all device families, live property updates, events, snapshots
- Login with 2FA and captcha from the admin UI

## License

MIT License

Copyright (c) 2026 Exc3pt10n

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The underlying [eufy-sdk](https://github.com/mega-yfue/eufy-sdk) is licensed under Apache-2.0.
