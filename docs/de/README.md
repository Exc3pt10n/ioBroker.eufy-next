# ioBroker.eufy-next – Deutsche Beschreibung

Adapter für **Anker eufy**-Geräte (Kameras, Türklingeln, HomeBases, Schlösser, Sensoren, Keypads, Saugroboter,
Mähroboter, Lampen) auf Basis des [`@mega-yfue/eufy-sdk`](https://github.com/mega-yfue/eufy-sdk) und der aktuellen
eufy-v6-Cloud. Hersteller: [eufy (Anker Innovations)](https://www.eufy.com/). Die vollständige Beschreibung steht in
der englischen [README](../../README.md).

> Unabhängiges, inoffizielles Projekt – nicht mit Anker Innovations oder eufy verbunden.

## Installation

Der Adapter wird über npm als `iobroker.eufy-next` verteilt (noch nicht im offiziellen ioBroker-Repository):

- Admin → Adapter → *Installieren aus eigener URL* → Reiter **npm** → `iobroker.eufy-next`, oder
- auf der Kommandozeile: `iobroker url iobroker.eufy-next`

Wer bisher aus GitHub installiert hat, installiert einmal neu aus npm; Einstellungen und Objekte bleiben erhalten.

## Einrichtung

1. E-Mail, Passwort und Ländercode (z. B. `DE`) des eufy-Kontos eintragen. Am besten ein zweites eufy-Konto anlegen,
   die Geräte in der eufy-App damit teilen und dieses Konto verwenden – dann meldet der Adapter das Handy nie ab.
2. Instanz starten. eufy schickt beim ersten Login einen **Bestätigungscode** (E-Mail oder SMS, einstellbar). Im Tab
   **Anmeldung (2FA / Captcha)** der Instanzeinstellungen eingeben und *Code senden* klicken (oder in
   `eufy-next.0.auth.verifyCode` schreiben). Während der Anmeldung die Einstellungen **nicht speichern**, sonst startet
   die Instanz neu und der Code verfällt.
3. Wird ein Captcha verlangt, erscheint es im selben Tab (und in `info.captchaImage`).

Die Sitzung wird im Datenverzeichnis der Instanz gespeichert; spätere Neustarts kommen ohne 2FA aus.

## Datenpunkte

Alle Geräte erscheinen unter `eufy-next.0.<Seriennummer>` mit genau den Datenpunkten, die das SDK für dieses Gerät
anbietet (z. B. `camera.nightVision`, `battery.level`, `arming.mode`, `light.brightness`):

- **Werte** werden live aktualisiert; schreibbare Werte lösen beim Setzen (ohne `ack`) einen Befehl aus.
- **Ereignisse** (Bewegung, Person, Klingel, Alarm …) unter `events.<name>.triggered`, `lastTriggered`, `payload`.
- **Snapshots** von Kameras: `snapshot.url` (Datei), `snapshot.dataUrl` (für `<img src>`), aktualisiert bei Ereignissen
  mit Vorschaubild. Dafür in der eufy-App eine Benachrichtigungsart *mit Vorschaubild* wählen.
- **Livestream:** `livestream.start` drücken, `livestream.url` enthält dann die Player-Seite (go2rtc, Port 1984).
  Der Stream endet nach der Höchstdauer (Standard 120 s), weil Akku-Kameras beim Streamen leerlaufen. Den Player-Port
  nur im Heimnetz nutzen und nicht ins Internet weiterleiten.
- **Station:** `station.reboot` startet eine HomeBase oder eine Kamera ohne HomeBase neu; `station.p2pConnected` zeigt
  eine offene P2P-Sitzung (`false` ist der normale Ruhezustand).
- **PTZ-Presets** (`ptz.presetGoto` …), **Schnellantworten** der Türklingel (`doorbell.quickResponse`) sowie
  `sendTo` mit `listActions` / `callAction` für Skripte.
