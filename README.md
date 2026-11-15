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
    └── snapshot.url / updated / refreshStored / refreshLive      (cameras)
```

Values are updated live by the SDK's `propertyChanged` announcements. Writes are acknowledged when the
device reports the new value back.

### Snapshots

For cameras the latest event thumbnail (motion, person, doorbell …) is stored in the ioBroker file system as
`eufy-next.0/<SERIAL>/snapshot.jpg`; `snapshot.url` holds the path (`/files/eufy-next.0/<SERIAL>/snapshot.jpg`).
`snapshot.refreshLive` captures a fresh frame — this needs `ffmpeg` and wakes battery cameras, so use it sparingly.

## Requirements

- **Node.js ≥ 24.5.0** (required by the eufy-sdk; older versions log a warning and encrypted camera video may fail)
- js-controller ≥ 6.0.11, admin ≥ 7.4.10
- optional: `ffmpeg` for live snapshots

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
| Cloud poll interval    | How often cloud-only values are polled (realtime values arrive immediately) |
| Value cache TTL        | How old a cached value may be before the SDK refreshes it in the background |
| Reset event states     | `events.*.triggered` is reset to `false` after this many seconds            |
| Save camera thumbnail  | Store the latest event thumbnail as a file                                  |
| ffmpeg path            | Only needed for `snapshot.refreshLive`                                      |
| Ignore devices         | Serial numbers to skip                                                      |
| Client identity        | Leave empty; a stable random identity is generated per instance             |
| Verbose SDK logging    | Show SDK info/warnings in the ioBroker log (debug level always contains them) |

## Development

```bash
npm install
npm run build
npm test          # unit + package + integration (needs Node.js >= 24.5)
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

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

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
