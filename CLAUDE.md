# ioBroker.eufy-next — development notes

ioBroker adapter for Anker eufy devices based on `@mega-yfue/eufy-sdk` (ESM only, Node.js ≥ 24.5).
The adapter is TypeScript, compiled to CommonJS (`build/`), and loads the SDK with `await import(...)`.

## Architecture

- `src/main.ts`: login (2FA/captcha via `auth.*` states and `sendTo` from the admin UI), session/push store in the
  instance data directory, SDK events → states, state writes → SDK.
- `src/lib/mapping.ts`: pure mapping of the SDK manifest (`dev.describe()`) to ioBroker objects. **No per-model
  code** — new devices/capabilities must appear through the manifest alone.
- One property can back reads in several capabilities (`battery` → `battery.level`, `lock.battery`);
  `propertyChanged` must update all of them.
- SDK 0.5.x describes a write as `stateful` (with `reflects`) only when the device reports the value; otherwise as
  `momentary` without `reflects` (blind write, e.g. `camera.setImageFlipped` on a T8142). The adapter creates a
  command state for it — this is intended, do not "fix" it.
- `src/lib/livestream.ts`: go2rtc (go2rtc-static) as player server, ffmpeg pushes `camera.live()` into it via RTSP.
  go2rtc only accepts a push for streams configured at its start (`register()` beforehand, otherwise a restart).
  Video is copied; audio is always encoded to AAC because the RTSP muxer needs the AAC config in its header, which a
  raw ADTS stream only reveals later. The raw ffmpeg input uses wall-clock timestamps and therefore needs frames in
  real time (tests play files at 15 fps). The go2rtc configuration (RTSP password, TLS key) goes into a 0600 file in
  the instance data directory, never onto the command line.
- The SDK refuses unverified write paths with an exception — intended; the adapter logs a warning and carries on.
- Roles follow the ioBroker role list (stateroles.md): no bare `level.mode`/`value.mode`; `value.*` only for
  read-only numbers, `level.*`/`switch` readable and writable. `test/mapping.test.mjs` enforces this for every state
  the SDK can produce.
- Log messages are English. Admin texts live in `admin/i18n/<lang>/translations.json` (11 languages).
- Background promises go through `this.bg(...)` (logs a rejection); timers use the adapter's `this.setTimeout`.

## Tests

- `npm test` = unit tests (`test/mapping.test.mjs` over all capabilities of the installed SDK,
  `test/livestream.test.mjs`) + package test.
- `npm run test:integration`: real js-controller; the second suite replaces the SDK via a module hook with
  `test/fixtures/fake-sdk.mjs` (fake cloud, real SDK capability objects; the fake camera plays H.264/AAC created with
  ffmpeg-static as a livestream, go2rtc and ffmpeg run for real). Needs Node.js 24.

## Versioning

Every change to be merged bumps the adapter version **once per pull request** (semantic versioning while < 1.0):
new feature → minor, bug fix → patch, incompatible change → minor marked **Breaking** in the changelog.
Pure changes to development tooling without effect on users (CI workflows, tests, lint configuration, `CLAUDE.md`)
need no new version.

Update each time:

- `package.json` and `package-lock.json` (`version`, in the lockfile at the top and under `packages[""]`)
- `io-package.json`: `common.version` and a new entry at the top of `common.news` in all 11 languages
  (en, de, ru, pt, nl, fr, it, es, pl, uk, zh-cn); keep **at most 7 entries** and only versions that exist on npm
- `README.md`: section `### X.Y.Z (YYYY-MM-DD)` at the top of the changelog, entries **in English** as
  `- (Exc3pt10n) …`. The README must be English only (ioBroker repository checker); the German description is
  `docs/de/README.md` and is updated with new features. Older changelog entries may move to `CHANGELOG_OLD.md`.

### Release

Releases come from the central workflow in
[Exc3pt10n/ioBroker-workflows](https://github.com/Exc3pt10n/ioBroker-workflows), included in
`.github/workflows/test-and-release.yml` via `@v1` (file name as the ioBroker repository checker expects and as
npm trusted publishing is configured). After a merge to `main` all checks run; only if they are green and the version
from `package.json` has no tag yet, the release job creates:

- the annotated tag `vX.Y.Z`,
- a GitHub release with the notes from the README changelog and the built `iobroker.eufy-next-X.Y.Z.tgz`,
- then `npm-publish.yml` publishes exactly that `.tgz` to npm (trusted publishing, no token).

Never create or push tags, releases or npm versions yourself — especially not for a version bump on a feature
branch. A merge without a version bump (e.g. tooling only) creates no release.

The `release-guard` checks these rules: if a pull request changes shipped files (`files`/`main` from
`package.json`, `io-package.json`, `src/`) or runtime dependencies (also only in the lockfile, e.g. through
`npm audit fix`), the version must be bumped and recorded completely.

## Distribution via npm

The adapter is distributed via npm (parameter `npm-package: true` of the central workflow); it is not (yet) in the
ioBroker repository — the owner decides that.

- There is **no** `prepare` script: users get the built package, the build only runs in CI.
- `common.nogit` is set in `io-package.json` (the build is not in the repository).
- `@iobroker/testing` stays current (6.x), `admin` as global dependency at least 7.6.20.
- Everything the build needs is in `devDependencies`.
- Installation: `iobroker url iobroker.eufy-next` or Admin → custom URL → tab npm. For testers without an npm
  version: the `.tgz` of the GitHub release. Installing from `tarball/main` no longer works.

Before a pull request, look at the findings of the ioBroker repository checker:

```bash
npx @iobroker/repochecker https://github.com/Exc3pt10n/ioBroker.eufy-next <branch>
```

## Automated tests (GitHub Actions)

`.github/workflows/test-and-release.yml` follows the ioBroker standard: `check-and-lint`
(`ioBroker/testing-action-check@v2`: type check, lint, package tests), `adapter` (central workflow: build, tests,
integration and installation test, audit, release-guard, release), `adapter-tests` (`ioBroker/testing-action-adapter@v1`,
Node 24/26 on Linux, Windows and macOS) and `deploy` (npm publish after a release). Node 22 is not tested: the SDK
requires Node.js ≥ 24.5.

Required checks in the branch protection of `main`: `adapter / ci-result` and `check-and-lint`.

Bugs in the central workflow belong in the `Exc3pt10n/ioBroker-workflows` repository.

## Before pushing

```bash
npm run lint && npm run check && npm test && npm run build
npm run test:integration   # for changes to src/main.ts, the livestream or the mapping
```

Run the `release-guard` locally (with a clone of ioBroker-workflows next to this repository):

```bash
node ../ioBroker-workflows/scripts/check-release.mjs pr --base origin/main --npm-package true
```
