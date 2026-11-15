// Unit tests for the pure parts of the livestream module (go2rtc config, URLs, ffmpeg arguments).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const L = require("../build/lib/livestream.js");

const opts = { binary: "go2rtc", ffmpeg: "/usr/bin/ffmpeg", apiPort: 1984, rtspPort: 8554, webrtcPort: 8555, hostname: "10.0.0.5" };

test("go2rtc config declares every stream (a push is only accepted for a configured stream)", () => {
    const c = L.go2rtcConfig(opts, ["CAM1", "CAM2"]);
    assert.deepEqual(c.streams, { CAM1: null, CAM2: null });
    assert.equal(c.api.listen, ":1984");
    assert.equal(c.rtsp.listen, ":8554");
    assert.equal(c.rtsp.username, undefined);
    assert.deepEqual(c.webrtc.candidates, ["10.0.0.5:8555", "stun:8555"]);
    assert.equal(c.ffmpeg.bin, "/usr/bin/ffmpeg");
});

test("RTSP credentials go into the config and the push URL, never into the player URL", () => {
    const o = { ...opts, rtspUsername: "u ser", rtspPassword: "p@ss" };
    assert.equal(L.go2rtcConfig(o, []).rtsp.username, "u ser");
    assert.equal(L.pushUrl(o, "CAM1"), "rtsp://u%20ser:p%40ss@127.0.0.1:8554/CAM1");
    assert.deepEqual(L.playerUrls(o, "CAM1"), {
        url: "http://10.0.0.5:1984/stream.html?src=CAM1",
        rtsp: "rtsp://10.0.0.5:8554/CAM1",
    });
});

test("ffmpeg copies video and encodes audio to AAC", () => {
    const v = L.ffmpegArgs("h264", undefined, "rtsp://x/CAM1");
    assert.deepEqual(v.slice(v.indexOf("-f"), v.indexOf("-f") + 4), ["-f", "h264", "-i", "pipe:0"]);
    assert.ok(!v.includes("pipe:3"));
    assert.ok(v.join(" ").includes("-map 0:v:0 -c:v copy"));
    assert.equal(v.at(-1), "rtsp://x/CAM1");

    const hevcAac = L.ffmpegArgs("h265", "aac-lc", "t").join(" ");
    assert.ok(hevcAac.includes("-f hevc -i pipe:0"));
    assert.ok(hevcAac.includes("-f aac -i pipe:3"));
    assert.ok(hevcAac.includes("-c:a aac"));

    const alaw = L.ffmpegArgs("h264", "g711a", "t").join(" ");
    assert.ok(alaw.includes("-f alaw -ar 16000 -ac 1 -i pipe:3"));
    assert.ok(alaw.includes("-c:a aac"));
});

test("LiveSession ends when no keyframe arrives and releases the camera", async () => {
    const { EventEmitter } = await import("node:events");
    const c = new EventEmitter();
    let stopped = false;
    c.stop = () => (stopped = true);
    let ended;
    new L.LiveSession(c, {
        stream: "CAM1",
        ffmpeg: "/nonexistent",
        target: "t",
        maxDurationMs: 0,
        firstFrameTimeoutMs: 50,
        log: { debug() {}, info() {}, warn() {} },
        onActive: () => assert.fail("must not become active"),
        onEnded: (r) => (ended = r),
    });
    c.emit("video", { keyframe: false, codec: "h264", data: Buffer.alloc(4) }); // not decodable: ignored
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ended, "no video keyframe from the camera");
    assert.equal(stopped, true);
});

test("LiveSession honours the battery budget only within its maximum duration", async () => {
    const { EventEmitter } = await import("node:events");
    const c = new EventEmitter();
    c.stop = () => undefined;
    const s = new L.LiveSession(c, {
        stream: "CAM1",
        ffmpeg: "/nonexistent",
        target: "t",
        maxDurationMs: 60_000,
        log: { debug() {}, info() {}, warn() {} },
        onActive() {},
        onEnded() {},
    });
    let extended;
    c.emit("budget", { graceMs: 5000, extend: (ms) => (extended = ms) });
    assert.ok(extended > 50_000 && extended <= 60_000, `extended by ${extended}`);
    s.stop();
});

test("LiveSession rejects an unsupported video codec", async () => {
    const { EventEmitter } = await import("node:events");
    const c = new EventEmitter();
    c.stop = () => undefined;
    let ended;
    new L.LiveSession(c, {
        stream: "CAM1",
        ffmpeg: "/nonexistent",
        target: "t",
        maxDurationMs: 0,
        log: { debug() {}, info() {}, warn() {} },
        onActive() {},
        onEnded: (r) => (ended = r),
    });
    c.emit("video", { keyframe: true, codec: "av1", data: Buffer.alloc(4) });
    assert.equal(ended, "unsupported video codec av1");
});

test("HTTPS: TLS on the player port, plain HTTP for the adapter on loopback next to it", () => {
    const o = { ...opts, https: { cert: "CERT", key: "KEY" } };
    const c = L.go2rtcConfig(o, ["CAM1"]);
    assert.deepEqual(c.api, { listen: "127.0.0.1:1985", tls_listen: ":1984", tls_cert: "CERT", tls_key: "KEY" });
    assert.equal(L.internalApiPort(o), 1985);
    assert.equal(L.internalApiPort(opts), 1984);
    assert.equal(L.playerUrls(o, "CAM1").url, "https://10.0.0.5:1984/stream.html?src=CAM1");
});
