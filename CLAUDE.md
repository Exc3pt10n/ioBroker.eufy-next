# ioBroker.eufy-next

ioBroker-Adapter für Anker-eufy-Geräte auf Basis von `@mega-yfue/eufy-sdk` (ESM-only, Node ≥ 24.5).
Der Adapter ist TypeScript, kompiliert nach CommonJS (`build/`) und lädt das SDK per `await import(...)`.

## Architektur

- `src/main.ts`: Login (2FA/Captcha über `auth.*`-States und `sendTo` aus der Admin-UI), Session/Push-Store im
  Instanz-Datenverzeichnis, SDK-Events → States, Schreibbefehle → SDK.
- `src/lib/mapping.ts`: reine Abbildung des SDK-Manifests (`dev.describe()`) auf ioBroker-Objekte. **Kein
  gerätespezifischer Code** — neue Geräte/Capabilities sollen allein über das Manifest erscheinen.
- Eine Property kann mehrere Reads in verschiedenen Capabilities speisen (`battery` → `battery.level`,
  `lock.battery`); `propertyChanged` muss alle aktualisieren.
- SDK 0.5.x beschreibt einen Schreibbefehl als `stateful` (mit `reflects`) nur, wenn das Gerät den Wert meldet;
  sonst als `momentary` ohne `reflects` (Blind-Schreiben, z. B. `camera.setImageFlipped` an der T8142). Der
  Adapter legt dafür einen Nur-Schreib-Datenpunkt an — das ist so gewollt, nicht als Fehler „korrigieren“.
- `src/lib/livestream.ts`: go2rtc (go2rtc-static) als Player-Server, ffmpeg pusht `camera.live()` per RTSP hinein.
  go2rtc nimmt einen Push nur für Streams an, die beim Start konfiguriert waren (`register()` vorab, sonst Neustart).
  Video wird kopiert; Ton wird immer nach AAC kodiert, weil der RTSP-Muxer die AAC-Konfiguration schon im Header
  braucht, die ein ADTS-Rohstrom erst später liefert. ffmpeg-Rohstrom-Eingang nutzt Wanduhr-Zeitstempel und
  braucht deshalb Frames in Echtzeit (Tests spielen Dateien im 15-fps-Takt ab).
- Das SDK verweigert unverifizierte Schreibpfade mit einer Exception — das ist gewollt; der Adapter loggt eine
  Warnung und läuft weiter.

## Tests

- `npm test` = Unit (`test/mapping.test.mjs` über alle Capabilities des installierten SDK, `test/livestream.test.mjs`)
  + Paket-Test.
- `npm run test:integration`: echter js-controller; zweite Suite ersetzt das SDK per Module-Hook durch
  `test/fixtures/fake-sdk.mjs` (Fake-Cloud, echte SDK-Capability-Objekte; die Fake-Kamera spielt mit ffmpeg-static
  erzeugtes H.264/AAC als Livestream ab, go2rtc und ffmpeg laufen echt). Braucht Node 24.

## Versionierung

Jede Änderung, die gemergt werden soll, zieht die Adapter-Version **einmal pro Pull Request** hoch
(Semantic Versioning, solange < 1.0): neue Funktion → Minor, Fehlerbehebung → Patch.
Reine Änderungen an Entwicklungswerkzeugen ohne Auswirkung auf Nutzer (CI-Workflows, Tests,
Lint-Konfiguration, `CLAUDE.md`) brauchen keine neue Version.

Anzupassen sind jeweils `package.json`/`package-lock.json` (`version`), `io-package.json`
(`common.version` und neuer Eintrag oben in `common.news`) und der Changelog im `README.md`.

Der Changelog-Abschnitt im README heißt `### X.Y.Z (JJJJ-MM-TT)`; daraus entstehen die Release-Notes.
Der `common.news`-Eintrag der neuen Version braucht alle 11 Sprachen (en, de, ru, pt, nl, fr, it, es,
pl, uk, zh-cn), höchstens 20 Einträge behalten. Das prüft der `release-guard` im Pull Request.

## Automatische Tests und Releases (GitHub Actions)

`.github/workflows/test.yml` bindet den zentralen Workflow
`Exc3pt10n/ioBroker-workflows/.github/workflows/adapter.yml@v1` ein:

- **Pull Requests:** Typprüfung, Build, Unit- und Paket-Tests auf Node 24, Integrationstest, Installationstest
  wie `iobroker url` (baut über `prepare`), `npm audit --omit=dev --audit-level=high` und `release-guard`.
  Ändert ein PR ausgelieferte Dateien (`src/`, `admin/`, `io-package.json`, Laufzeit-Abhängigkeiten),
  braucht er einen Versionssprung.
- **Nach dem Merge auf `main`:** Sind alle Prüfungen grün und fehlt der Tag `vX.Y.Z`, setzt der Release-Job
  den annotierten Tag, legt ein GitHub-Release mit den Notes aus dem README und dem fertig gebauten `.tgz` an
  und spult den Branch `release` vor.
- **Wöchentlich und per `workflow_dispatch`:** Linux + Windows, Node 24/26. `workflow_dispatch` auf `main`
  holt außerdem ein abgebrochenes Release nach.
- **Pflicht-Check** für den Branch-Schutz von `main`: `adapter / ci-result`. Den Branch `release` nicht schützen.

Tags setzt **nur** der Release-Job. Auf Feature-Branches keine Tags pushen.

Fehler im zentralen Workflow selbst gehören in das Repo `Exc3pt10n/ioBroker-workflows`.

`"prepare": "npm run build"` muss bleiben: Bei der Installation aus GitHub baut npm nur darüber.
Deshalb `@iobroker/testing` bei 5.x lassen (6.x lehnt `prepare` im Paket-Test ab).
