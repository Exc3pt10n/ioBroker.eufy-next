# Development

Notes for contributors. User documentation: [README.md](README.md) (English) and [docs/de/README.md](docs/de/README.md)
(German).

## Setup and checks

```bash
npm install
npm run build
npm run lint && npm run check
npm test                   # unit + package tests
npm run test:integration   # adapter in a real js-controller test instance (Node.js >= 24.5)
```

## Architecture

- `src/main.ts` — login (2FA/captcha via `auth.*` states and `sendTo` from the admin UI), session/push store in the
  instance data directory, SDK events → states, state writes → SDK.
- `src/lib/mapping.ts` — pure mapping of the SDK device manifest (`dev.describe()`) to ioBroker objects. No per-model
  code: devices and capabilities added to the SDK appear through the manifest alone.
- `src/lib/livestream.ts` — go2rtc as player server; ffmpeg pushes the frames of `camera.live()` into it via RTSP.

## Tests

- `test/mapping.test.mjs` runs the mapping over a synthetic device that has **every** capability the installed SDK
  knows (including the role/attribute rules of the ioBroker role list), so a new SDK release is checked automatically.
- `test/livestream.test.mjs` covers the go2rtc configuration, URLs, ffmpeg arguments and the session lifecycle.
- `test/integration.js` starts the adapter in a real js-controller. The second suite swaps the SDK for
  `test/fixtures/fake-sdk.mjs` (via a Node module hook): the cloud is fake, but the device objects are the SDK's real
  capability objects — covering 2FA login, object tree, live updates, events, commands and the livestream with real
  go2rtc and ffmpeg.

## Releases

See [CLAUDE.md](CLAUDE.md) (versioning, release workflow, npm distribution).
