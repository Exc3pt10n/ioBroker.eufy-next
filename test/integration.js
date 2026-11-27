"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { tests } = require("@iobroker/testing");

// Starts the adapter in a real js-controller test environment. Without credentials it must stay alive,
// create its instance objects and report that it needs credentials — no crash, no network.
tests.integration(path.join(__dirname, ".."), {
    allowedExitCodes: [11],
    defineAdditionalTests({ suite }) {
        suite("Start without credentials", (getHarness) => {
            it("reports missing credentials and stays disconnected", async function () {
                this.timeout(60_000);
                const harness = getHarness();
                await harness.startAdapterAndWait();
                await new Promise((r) => setTimeout(r, 3000));
                const status = await harness.states.getStateAsync("eufy-next.0.info.loginStatus");
                const conn = await harness.states.getStateAsync("eufy-next.0.info.connection");
                if (!status || status.val !== "no_credentials") {
                    throw new Error(`unexpected loginStatus: ${JSON.stringify(status)}`);
                }
                if (!conn || conn.val !== false) {
                    throw new Error(`unexpected connection: ${JSON.stringify(conn)}`);
                }
                const obj = await harness.objects.getObjectAsync("eufy-next.0.auth.verifyCode");
                if (!obj || !obj.common.write) {
                    throw new Error("auth.verifyCode missing");
                }
            });
        });

        // End-to-end against fake-sdk.mjs: fake cloud, REAL SDK capability objects.
        suite("Devices (fake cloud, real SDK capability objects)", (getHarness) => {
            const fs = require("node:fs");
            const os = require("node:os");
            const logFile = path.join(os.tmpdir(), `eufy-next-fake-${process.pid}.log`);
            const sent = () =>
                fs.existsSync(logFile)
                    ? fs.readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
                    : [];
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const P = "eufy-next.0.T8420FAKE0001";
            const LIVE_PORT = 18984;

            async function waitFor(fn, what, timeout = 15_000) {
                const end = Date.now() + timeout;
                for (;;) {
                    const v = await fn();
                    if (v) return v;
                    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
                    await sleep(250);
                }
            }

            it("logs in with 2FA, builds the device tree, handles events and commands", async function () {
                this.timeout(180_000);
                const harness = getHarness();
                fs.rmSync(logFile, { force: true });
                // fresh login: drop a session persisted by an earlier run
                fs.rmSync(path.join(harness["testDir"], "iobroker-data", "eufy-next.0"), { recursive: true, force: true });
                await harness.changeAdapterConfig("eufy-next", {
                    native: {
                        email: "test@example.invalid",
                        password: "secret",
                        countryCode: "de",
                        eventResetSec: 0,
                        liveHostname: "127.0.0.1",
                        liveApiPort: LIVE_PORT,
                        liveRtspPort: LIVE_PORT + 1,
                        liveWebrtcPort: LIVE_PORT + 2,
                        // long enough for a slow start at 3 fps plus the checks below (Windows needed ~4 s to start)
                        liveMaxDurationSec: 15,
                    },
                });
                // an object an older version generated for a write the device has no evidence for
                await harness.objects.setObjectAsync(`${P}.light.setObsolete`, {
                    type: "state",
                    common: { name: "obsolete", type: "boolean", role: "switch", read: false, write: true },
                    native: {},
                });
                // test media for the fake camera: H.264 with AUD separators + 16 kHz mono AAC (ADTS)
                const { execFileSync } = require("node:child_process");
                const ffmpeg = require("ffmpeg-static");
                const h264 = path.join(os.tmpdir(), "eufy-next-test.h264");
                const aac = path.join(os.tmpdir(), "eufy-next-test.aac");
                execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15",
                    "-t", "4", "-c:v", "libx264", "-g", "3", "-pix_fmt", "yuv420p", "-x264-params", "aud=1", "-f", "h264", h264]);
                execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000",
                    "-t", "4", "-ac", "1", "-c:a", "aac", "-f", "adts", aac]);
                await harness.startAdapter({
                    // --import takes a URL: a bare absolute path fails on Windows ("Received protocol 'd:'").
                    NODE_OPTIONS: `--import=${pathToFileURL(path.join(__dirname, "fixtures", "sdk-hook.mjs")).href}`,
                    FAKE_SDK_LOG: logFile,
                    FAKE_SDK_H264: h264,
                    FAKE_SDK_AAC: aac,
                    // like a battery camera: few frames per second, so ffmpeg needs a while before go2rtc has data
                    FAKE_SDK_FPS: "3",
                });
                const st = (id) => harness.states.getStateAsync(id);

                await waitFor(async () => (await st("eufy-next.0.info.loginStatus"))?.val === "2fa", "2fa status");
                if (!sent().some((e) => e.type === "construct" && e.countryCode === "DE" && e.openudid)) {
                    throw new Error("client not constructed with normalised country code + identity");
                }

                await harness.states.setStateAsync("eufy-next.0.auth.verifyCode", { val: "123456", ack: false });
                await waitFor(async () => (await st("eufy-next.0.info.connection"))?.val === true, "connection");

                // device + info
                const devObj = await harness.objects.getObjectAsync(P);
                if (!devObj || devObj.type !== "device" || devObj.common.name !== "Fake Garage") {
                    throw new Error(`device object: ${JSON.stringify(devObj)}`);
                }
                if ((await st(`${P}.info.modelName`))?.val !== "Floodlight Cam") throw new Error("info.modelName");

                if (await harness.objects.getObjectAsync(`${P}.light.setObsolete`)) throw new Error("stale object kept");

                // reads with initial values, generated from the manifest
                const isOn = await harness.objects.getObjectAsync(`${P}.light.isOn`);
                if (!isOn || isOn.common.type !== "boolean" || !isOn.common.write || isOn.common.role !== "switch") {
                    throw new Error(`light.isOn: ${JSON.stringify(isOn && isOn.common)}`);
                }
                if ((await st(`${P}.light.brightness`))?.val !== 40) throw new Error("brightness initial");
                const lockBtn = await harness.objects.getObjectAsync(`${P}.lock.lock`);
                if (!lockBtn || lockBtn.common.role !== "button") throw new Error("lock.lock button");

                // propertyChanged("battery") must reach BOTH reads backed by that property
                await waitFor(async () => (await st(`${P}.battery.level`))?.val === 55, "battery.level = 55");
                await waitFor(async () => (await st(`${P}.lock.battery`))?.val === 55, "lock.battery = 55");

                // events
                await waitFor(async () => (await st(`${P}.events.motion.triggered`))?.val === true, "motion event");
                const payload = JSON.parse(String((await st(`${P}.events.motion.payload`)).val));
                if (payload.thumbnailUrl !== "https://example.invalid/t.jpg") throw new Error("motion payload");
                // the adapter writes events.lastEvent after events.<name>.triggered: wait for it instead of reading once
                // (a fast runner read the old value in between)
                await waitFor(async () => (await st(`${P}.events.lastEvent`))?.val === "motion", "lastEvent = motion");

                // Commands go through the real SDK setters/actions. The SDK refuses writes whose wire format is not
                // verified for this (synthetic) device — light.set, lock.lock and arming.setMode here, which need a
                // real account identity — and the adapter must log
                // that and carry on; the verified ones reach the command sink.
                await harness.states.setStateAsync(`${P}.light.isOn`, { val: true, ack: false });
                await harness.states.setStateAsync(`${P}.lock.lock`, { val: true, ack: false });
                await harness.states.setStateAsync(`${P}.light.brightness`, { val: 70, ack: false });
                await harness.states.setStateAsync(`${P}.arming.mode`, { val: 0, ack: false });
                const commands = () => sent().filter((e) => e.type === "command" || e.type === "setProperty");
                await waitFor(() => commands().length >= 1, "brightness command");
                console.log("commands:", JSON.stringify(commands()));
                // still alive and connected after the refused writes
                await sleep(1000);
                if ((await st("eufy-next.0.info.connection"))?.val !== true) throw new Error("lost connection");

                // snapshot from the motion event (fake stored thumbnail), also as data URL
                await waitFor(async () => (await st(`${P}.snapshot.url`))?.val, "snapshot.url");
                await waitFor(async () => String((await st(`${P}.snapshot.dataUrl`))?.val ?? "").startsWith("data:image/jpeg;base64,/9j/"), "snapshot.dataUrl");

                // 2FA code requested by e-mail (default)
                if (!sent().some((e) => e.type === "login" && e.messageType === 2)) throw new Error("login without messageType 2");

                // station: P2P session state + reboot (the fake camera is its own station)
                await waitFor(async () => (await st(`${P}.station.p2pConnected`))?.val === true, "station.p2pConnected");
                await harness.states.setStateAsync(`${P}.station.reboot`, { val: true, ack: false });
                await waitFor(() => sent().some((e) => e.type === "reboot" && e.sn === "T8420FAKE0001"), "reboot call");

                // PTZ presets through the SDK's real preset sub-API (6032 = goto preset)
                const before = sent().length;
                await harness.states.setStateAsync(`${P}.ptz.presetGoto`, { val: 2, ack: false });
                await waitFor(() => sent().slice(before).some((e) => e.type === "command" && e.cmd.param === 6032 && e.cmd.data.value === 2), "preset goto command");
                if (await harness.objects.getObjectAsync(`${P}.ptz.presets`)) throw new Error("ptz.presets without a list() API");
                if (!(await harness.objects.getObjectAsync(`${P}.doorbell.quickResponse`))) throw new Error("doorbell.quickResponse missing");

                // sendTo: listActions + callAction (nested sub-API path), and refusal of a non-action
                const sendTo = (command, message) =>
                    new Promise((resolve) => harness.sendTo("eufy-next.0", command, message, resolve));
                const list = await sendTo("listActions", { sn: "T8420FAKE0001" });
                if (!list.result?.ptz?.described?.some((a) => a.name === "setRotationSpeed")) throw new Error(`listActions: ${JSON.stringify(list)}`);
                const ptzActions = [...list.result.ptz.described.map((a) => a.name), ...list.result.ptz.undescribed];
                if (!ptzActions.includes("preset")) throw new Error("listActions: preset missing");
                const n = sent().length;
                const res = await sendTo("callAction", { sn: "T8420FAKE0001", capability: "ptz", action: "preset.save", args: [3] });
                if (res.error) throw new Error(`callAction: ${res.error}`);
                await waitFor(() => sent().slice(n).some((e) => e.type === "command"), "preset save command");
                const bad = await sendTo("callAction", { sn: "T8420FAKE0001", capability: "ptz", action: "constructor" });
                if (!bad.error) throw new Error("callAction accepted a non-action");

                // Livestream: real go2rtc + ffmpeg, fed by the fake camera's H.264/AAC frames.
                const start = await harness.objects.getObjectAsync(`${P}.livestream.start`);
                if (!start || start.common.role !== "button.start") throw new Error("livestream.start missing");
                if ((await st(`${P}.livestream.active`))?.val !== false) throw new Error("livestream active before start");
                await harness.states.setStateAsync(`${P}.livestream.start`, { val: true, ack: false });
                await waitFor(async () => (await st(`${P}.livestream.active`))?.val === true, "livestream active", 30_000);
                const url = (await st(`${P}.livestream.url`)).val;
                if (url !== `http://127.0.0.1:${LIVE_PORT}/stream.html?src=T8420FAKE0001`) throw new Error(`url ${url}`);
                if ((await st(`${P}.livestream.rtsp`)).val !== `rtsp://127.0.0.1:${LIVE_PORT + 1}/T8420FAKE0001`) throw new Error("rtsp url");

                // active=true must mean the player can play: go2rtc already has the camera's stream at this moment
                // (a player opened earlier showed "streams: unknown error" on low-frame-rate cameras)
                const now = await fetch(`http://127.0.0.1:${LIVE_PORT}/api/streams`).then((x) => x.json());
                if (!now?.T8420FAKE0001?.producers?.some((p) => (p.medias || []).length)) {
                    throw new Error(`active=true but go2rtc has no producer yet: ${JSON.stringify(now)}`);
                }
                if ((await st(`${P}.livestream.error`))?.val !== "") throw new Error("livestream.error not empty after a good start");
                const streams = await waitFor(async () => {
                    const r = await fetch(`http://127.0.0.1:${LIVE_PORT}/api/streams`).then((x) => x.json(), () => undefined);
                    const medias = r?.T8420FAKE0001?.producers?.flatMap((p) => p.medias || []) || [];
                    return medias.some((m) => m.includes("H264")) && medias.some((m) => m.includes("MPEG4-GENERIC")) ? medias : undefined;
                }, "go2rtc producer with H264 + AAC");
                console.log("go2rtc medias:", JSON.stringify(streams));
                // a keyframe per second at 3 fps (GOP 3); the timeout reports a failure instead of hanging until mocha gives up
                const frame = Buffer.from(
                    await (
                        await fetch(`http://127.0.0.1:${LIVE_PORT}/api/frame.jpeg?src=T8420FAKE0001`, { signal: AbortSignal.timeout(15_000) })
                    ).arrayBuffer(),
                );
                if (frame[0] !== 0xff || frame[1] !== 0xd8 || frame.length < 1000) throw new Error(`frame.jpeg: ${frame.length} bytes`);

                await harness.states.setStateAsync(`${P}.livestream.stop`, { val: true, ack: false });
                await waitFor(async () => (await st(`${P}.livestream.active`))?.val === false, "livestream stopped");
                if ((await st(`${P}.livestream.url`)).val !== "") throw new Error("url not cleared after stop");
                await waitFor(() => sent().some((e) => e.type === "liveStop"), "camera consumer released");

                // maximum duration (15 s in this test) ends a stream on its own
                const t0 = Date.now();
                await harness.states.setStateAsync(`${P}.livestream.start`, { val: true, ack: false });
                await waitFor(async () => (await st(`${P}.livestream.active`))?.val === true, "second livestream", 30_000);
                await waitFor(async () => (await st(`${P}.livestream.active`))?.val === false, "stop at maximum duration", 30_000);
                const took = Date.now() - t0;
                if (took < 14_000) throw new Error(`stopped too early (${took} ms)`);
                if (sent().filter((e) => e.type === "liveStop").length !== 2) throw new Error("second consumer not released");
            });
        });
    },
});
