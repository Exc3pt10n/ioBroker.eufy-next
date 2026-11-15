/**
 * A stand-in for @mega-yfue/eufy-sdk with no network. The cloud is faked, but the device objects are the
 * REAL bound capability objects of the installed SDK (buildActions + describeCapabilities), so the adapter's
 * manifest walk, getters, setters and actions run against genuine SDK code. Commands the SDK would send are
 * appended to $FAKE_SDK_LOG for the test to inspect.
 */
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import * as real from "@mega-yfue/eufy-sdk";

const LOG = process.env.FAKE_SDK_LOG;
const record = (entry) => LOG && appendFileSync(LOG, `${JSON.stringify(entry)}\n`);

export const LoginStatus = real.LoginStatus;

export class FileSessionStore {
    constructor(path) {
        this.path = path;
    }
    load() {
        try {
            return JSON.parse(readFileSync(this.path, "utf-8"));
        } catch {
            return null;
        }
    }
    save(s) {
        writeFileSync(this.path, JSON.stringify(s));
    }
    clear() {}
}
export class FileFcmStore extends FileSessionStore {}

const SN = "T8420FAKE0001";
const CAPS = ["light", "battery", "lock", "arming", "camera"];

/** Annex-B H.264 file → access units (the test encodes it with AUD NAL units as separators). */
function accessUnits(buf) {
    const out = [];
    let last = 0;
    for (let i = 4; i < buf.length - 4; i++) {
        if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1 && (buf[i + 4] & 0x1f) === 9) {
            out.push(buf.subarray(last, i));
            last = i;
        }
    }
    out.push(buf.subarray(last));
    return out.filter((u) => u.length);
}
function isIdr(u) {
    for (let i = 0; i < u.length - 4; i++) if (u[i] === 0 && u[i + 1] === 0 && u[i + 2] === 1 && (u[i + 3] & 0x1f) === 5) return true;
    return false;
}
function adtsFrames(buf) {
    const out = [];
    for (let i = 0; i + 7 < buf.length; ) {
        const len = ((buf[i + 3] & 3) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5);
        out.push(buf.subarray(i, i + len));
        i += len;
    }
    return out;
}

/** A live consumer that plays the test's H.264 + AAC files in real time, looping. */
class FakeLive extends EventEmitter {
    constructor() {
        super();
        const v = process.env.FAKE_SDK_H264 && existsSync(process.env.FAKE_SDK_H264) ? accessUnits(readFileSync(process.env.FAKE_SDK_H264)) : [];
        const a = process.env.FAKE_SDK_AAC && existsSync(process.env.FAKE_SDK_AAC) ? adtsFrames(readFileSync(process.env.FAKE_SDK_AAC)) : [];
        let vi = 0;
        let ai = 0;
        this.timers = [
            v.length && setInterval(() => {
                const u = v[vi++ % v.length];
                this.emit("video", { keyframe: isIdr(u), codec: "h264", width: 320, height: 240, data: u });
            }, 1000 / 15),
            a.length && setInterval(() => this.emit("audio", { codec: "aac-lc", data: a[ai++ % a.length] }), 64),
        ].filter(Boolean);
        record({ type: "liveStart" });
    }
    pause() {}
    resume() {}
    stop() {
        if (!this.timers.length) return;
        this.timers.forEach(clearInterval);
        this.timers = [];
        record({ type: "liveStop" });
    }
}

function makeDevice(client) {
    const modules = CAPS.map((c) => real.CAPABILITY_MODULES[c] ?? Object.values(real.CAPABILITY_MODULES).find((m) => m.capability === c));
    const params = new Set(modules.flatMap((m) => m.properties.flatMap((p) => [p.paramType, ...(p.readAliases?.map((a) => a.paramType) ?? [])])));
    const values = new Map([
        ["light", false],
        ["brightness", 40],
        ["battery", 87],
        ["armingMode", 1],
        ["locked", true],
    ]);
    const ctx = { channel: 0, codec: "camera", paramIds: params, capabilities: new Set(CAPS), model: "T8420" };
    const sink = {
        dispatch: async (cmd) => {
            record({ type: "command", cmd });
        },
    };
    const media = {
        live: async () => new FakeLive(),
        snapshotLive: async () => Buffer.from("not a jpeg"),
    };
    const bound = real.buildActions(CAPS, {
        ctx,
        sink,
        media,
        read: (name) => (values.has(name) ? { value: values.get(name) } : undefined),
    });
    // The stored push thumbnail lives in the client's image cache, which this fake does not have.
    Object.defineProperty(bound.camera, "snapshotStored", { value: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    const dev = {
        sn: SN,
        describe: () => ({
            sn: SN,
            name: "Fake Garage",
            model: "T8420",
            modelName: "Floodlight Cam",
            codec: "camera",
            source: "registry",
            bound: true,
            capabilities: CAPS,
            details: real.describeCapabilities(bound),
        }),
        // test helper: change a value as if the device reported it
        _report(property, value) {
            values.set(property, value);
            client.emit("propertyChanged", { deviceSn: SN, property, value });
        },
    };
    for (const [k, v] of Object.entries(bound)) dev[k] = () => v;
    return dev;
}

export class EufyMega extends EventEmitter {
    constructor(opts) {
        super();
        this.opts = opts;
        record({ type: "construct", countryCode: opts.countryCode, openudid: !!opts.openudid });
    }
    async login() {
        if (this.opts.store.load()) return { status: "ok", session: {} };
        return { status: "2fa", method: "email" };
    }
    async solveCaptcha() {
        return { status: "2fa", method: "email" };
    }
    async submitVerifyCode(code) {
        record({ type: "verifyCode", code });
        if (code !== "123456") return { status: "2fa", method: "email" };
        this.opts.store.save({ ok: true });
        return { status: "ok", session: {} };
    }
    async getDevices() {
        return [{ sn: SN, name: "Fake Garage", model: "T8420", category: "eufy_security", stationSn: SN }];
    }
    async getDevice(sn) {
        if (sn !== SN) throw new Error("unknown");
        this.dev ??= makeDevice(this);
        setTimeout(() => {
            this.dev._report("battery", 55);
            const motion = { deviceSn: SN, eventType: 3101, thumbnailUrl: "https://example.invalid/t.jpg" };
            this.emit("motion", motion);
            this.emit("event", { ...motion, eventName: "motion" });
        }, 1500);
        return this.dev;
    }
    deviceState(sn) {
        return { sn, stationSn: sn, lastSeenMs: 1_700_000_000_000 };
    }
    async setProperty(sn, name, value) {
        record({ type: "setProperty", sn, name, value });
    }
    async disconnect() {}
    clearSession() {}
}
