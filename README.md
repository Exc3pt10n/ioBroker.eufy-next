![Logo](admin/eufy-next.svg)

# ioBroker.eufy-next

ioBroker adapter for **Anker eufy** devices — cameras, doorbells, HomeBases, locks, entry/leak/smoke sensors,
keypads, robot vacuums, mowers and smart lights — built on the new
[`@mega-yfue/eufy-sdk`](https://github.com/mega-yfue/eufy-sdk), which speaks the current eufy **v6 cloud**
with realtime events over push, MQTT and P2P.

Manufacturer: [eufy (Anker Innovations)](https://www.eufy.com/). German description: [docs/de/README.md](docs/de/README.md).

> Independent and unofficial. Not affiliated with, endorsed by, or sponsored by Anker Innovations or eufy.

## Availability

The adapter is published on npm as `iobroker.eufy-next`. It is not (yet) part of the official ioBroker repository.

## How it works

The adapter contains **no per-model code**. For every device it asks the SDK what that device exposes
(`dev.describe()`) and generates the object tree from that manifest:

| Manifest                                   | ioBroker                                                           |
| ------------------------------------------ | ------------------------------------------------------------------ |
| capability (`battery`, `camera`, `light`…) | channel `eufy-next.0.<SN>.<capability>`                            |
| read (`level`, `brightness`, `mode`…)      | state with type/role/unit/`states` derived from the value's `kind` |
| writable read / stateful action            | the same state becomes writable (`ack=false` → command)            |
| momentary action without arguments         | `button` state                                                     |
| action with one argument                   | control state (keeps the last value sent)                          |
| action with several arguments              | `json` command state (array or object by argument name)            |
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
    ├── livestream.start / stop / url / rtsp / active / error     (cameras)
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
| `livestream.active` | `indicator`    | Stream is playable: `true` only once the player server has the camera's data |
| `livestream.error`  | `text`         | Why the last start failed (e.g. no video from the camera); empty after a good start |

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
- ffmpeg: the configured path, else the bundled `ffmpeg-static`.

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
- js-controller ≥ 6.0.11, admin ≥ 7.6.20
- For snapshots from a running camera and for the livestream the adapter needs `ffmpeg` (remuxes the camera's video
  and encodes its sound) and [go2rtc](https://github.com/AlexxIT/go2rtc) (player server). Both are installed as npm
  dependencies (`ffmpeg-static`, `go2rtc-static`, which download the binary for your platform during installation).
  A different ffmpeg can be set in the options.

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
| ffmpeg path            | Optional; default is the bundled ffmpeg                                     |
| Ignore devices         | Serial numbers to skip                                                      |
| Client identity        | Leave empty; a stable random identity is generated per instance             |
| Verbose SDK logging    | Show SDK info/warnings in the ioBroker log (debug level always contains them) |

Developer information: [DEVELOPMENT.md](DEVELOPMENT.md).

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### 0.5.0 (2026-11-27)

- (Exc3pt10n) Livestream: `livestream.active` and `livestream.url` are only set once go2rtc really has the camera's
  stream; before, a player opened right away could show "streams: unknown error" on battery cameras with a low frame
  rate
- (Exc3pt10n) Livestream starts faster (shorter ffmpeg stream analysis)
- (Exc3pt10n) New state `livestream.error` with the reason of a failed start

### 0.4.1 (2026-11-26)

- (Exc3pt10n) Fixes for the ioBroker repository checker: no global timers or custom sleep, no use of
  `process.env`, no installation commands in the README, `.commitinfo` ignored
- (Exc3pt10n) ffmpeg: the configured path, else the bundled one (a system ffmpeg is no longer searched on `PATH`)

### 0.4.0 (2026-11-26)

- (Exc3pt10n) **Breaking:** the adapter is now distributed via npm. Installations from GitHub (`tarball/release`)
  no longer update — reinstall it from npm; settings and objects are kept
- (Exc3pt10n) Admin UI available in 11 languages
- (Exc3pt10n) State roles follow the ioBroker role list (no `level.mode`/`value.mode`; command states are readable)
- (Exc3pt10n) Objects with custom settings (history, InfluxDB, SQL …) are no longer deleted when a device stops
  providing them
- (Exc3pt10n) Configured intervals are validated in code; background errors are logged instead of being unhandled
- (Exc3pt10n) The go2rtc configuration (RTSP password, TLS key) is written to a protected file instead of the
  command line
- (Exc3pt10n) Doorbell press events use the role `sensor`

### 0.3.0 (2026-11-15)

- (Exc3pt10n) `station.reboot` and `station.p2pConnected` for HomeBases and standalone cameras
- (Exc3pt10n) PTZ presets: `ptz.presetGoto` / `presetSave` / `presetDelete` (+ `ptz.presets` where readable)
- (Exc3pt10n) Doorbell quick responses: `doorbell.quickResponse` (+ list where readable)
- (Exc3pt10n) `sendTo` commands `listActions` and `callAction` for every action a device offers
- (Exc3pt10n) 2FA code via e-mail or SMS (setting)
- (Exc3pt10n) Snapshot additionally as data URL (`snapshot.dataUrl`)
- (Exc3pt10n) Livestream player optionally over HTTPS with an ioBroker certificate
- (Exc3pt10n) Fix: rebuilding a device's objects after it gained capabilities no longer removes `info.stationSn`

### 0.2.0 (2026-11-15)

- (Exc3pt10n) Camera livestream: `livestream.start/stop/url/rtsp/active` with a bundled go2rtc player
  (MSE/HLS/WebRTC, RTSP), video copied, sound as AAC, configurable maximum duration (default 120 s)
- (Exc3pt10n) Still from the running stream as snapshot
- (Exc3pt10n) Bundled ffmpeg (ffmpeg-static) as fallback when no ffmpeg is on the host

### 0.1.0 (2026-11-15)

- (Exc3pt10n) Initial release based on `@mega-yfue/eufy-sdk` 0.5
- (Exc3pt10n) Manifest-driven object tree for all device families, live property updates, events, snapshots
- (Exc3pt10n) Login with 2FA and captcha from the admin UI

## License

MIT License, see [LICENSE](LICENSE).

Copyright (c) 2026 Exc3pt10n <kontakt@jansesoft.de>

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
