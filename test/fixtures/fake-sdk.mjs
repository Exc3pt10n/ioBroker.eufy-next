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
const CAPS = ["light", "battery", "lock", "arming"];

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
    const bound = real.buildActions(CAPS, { ctx, sink, read: (name) => (values.has(name) ? { value: values.get(name) } : undefined) });
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
