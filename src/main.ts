/*
 * ioBroker.eufy-next — Anker eufy devices in ioBroker, built on @mega-yfue/eufy-sdk.
 *
 * The object tree is generated from each device's own manifest (`dev.describe()`), so it mirrors exactly
 * what the SDK can read and write on that device — no per-model code lives in this adapter.
 */
import * as utils from "@iobroker/adapter-core";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type {
    AnyDeviceEvent,
    AvailabilityObservation,
    Device,
    DeviceState,
    EufyDevice,
    EufyMega,
    LoginResult,
} from "@mega-yfue/eufy-sdk" with { "resolution-mode": "import" };
import {
    type CapabilityDescriptorLike,
    type DeviceManifestLike,
    type ReadDescriptorLike,
    type StateCommon,
    type ValueCodec,
    fromStateValue,
    humanize,
    parseJsonArgs,
    planAction,
    readCommon,
    sanitizeId,
    toStateValue,
} from "./lib/mapping";

type Sdk = typeof import("@mega-yfue/eufy-sdk", { with: { "resolution-mode": "import" } });

/** Where a property announced by the SDK lands in the object tree. */
interface PropertyTarget {
    id: string;
    codec: ValueCodec;
    type: ioBroker.CommonType;
    capAccessor: string;
    readAccessor: string;
}

/** Everything the adapter keeps per device. */
interface DeviceHandle {
    sn: string;
    /** Sanitised serial used as the object id. */
    oid: string;
    /** Held strongly: the SDK only announces property changes for Device objects someone still holds. */
    dev: Device;
    manifest: DeviceManifestLike;
    /** property name → every state showing it (one property can back reads in several capabilities). */
    properties: Map<string, PropertyTarget[]>;
}

type WriteHandler = (value: ioBroker.StateValue) => Promise<void>;

/** Events that come with a camera thumbnail worth keeping as the latest snapshot. */
const SNAPSHOT_EVENTS = new Set([
    "motion",
    "personDetected",
    "strangerDetected",
    "doorbellPress",
    "petDetection",
    "vehicleDetected",
    "packageDelivered",
    "packageTaken",
    "dogDetected",
]);

const RELOGIN_DEFAULT_MS = 5 * 60_000;

class EufyNext extends utils.Adapter {
    private sdk?: Sdk;
    private eufy?: EufyMega;
    private readonly devices = new Map<string, DeviceHandle>();
    private readonly writeHandlers = new Map<string, WriteHandler>();
    private readonly createdObjects = new Set<string>();
    private readonly eventResetTimers = new Map<string, ioBroker.Timeout>();
    private reloginTimer?: ioBroker.Timeout;
    private excluded = new Set<string>();
    private loginInFlight = false;
    private devicesLoaded = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: "eufy-next" });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("message", this.onMessage.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    // ----------------------------------------------------------------------------------------------------
    // Lifecycle
    // ----------------------------------------------------------------------------------------------------

    private async onReady(): Promise<void> {
        await this.setStateAsync("info.connection", false, true);
        await this.subscribeStatesAsync("*");

        const [major, minor] = process.versions.node.split(".").map(Number);
        if (major < 24 || (major === 24 && minor < 5)) {
            this.log.warn(
                `eufy-sdk requires Node.js >= 24.5.0 (running ${process.versions.node}). ` +
                    "Login and events usually work, but encrypted camera video may fail. Please upgrade Node.js.",
            );
        }

        if (!this.config.email || !this.config.password) {
            await this.setLoginStatus("no_credentials", "Please enter e-mail and password in the instance settings.");
            this.log.error("No eufy credentials configured — please open the instance settings.");
            return;
        }

        this.excluded = new Set(
            (this.config.excludeDevices || "")
                .split(/[,;\s]+/)
                .map((s) => s.trim())
                .filter(Boolean),
        );

        try {
            this.sdk = await import("@mega-yfue/eufy-sdk");
        } catch (e) {
            this.log.error(`Cannot load @mega-yfue/eufy-sdk: ${errText(e)}`);
            return;
        }

        this.eufy = this.createClient(this.sdk);
        this.wireClientEvents(this.eufy);
        await this.startLogin();
    }

    private async onUnload(callback: () => void): Promise<void> {
        try {
            if (this.reloginTimer) {
                this.clearTimeout(this.reloginTimer);
            }
            for (const t of this.eventResetTimers.values()) {
                this.clearTimeout(t);
            }
            this.eventResetTimers.clear();
            if (this.eufy) {
                await Promise.race([this.eufy.disconnect(), new Promise((r) => setTimeout(r, 4000))]);
            }
            this.devices.clear();
            await this.setStateAsync("info.connection", false, true);
        } catch {
            // ignore — shutting down
        } finally {
            callback();
        }
    }

    // ----------------------------------------------------------------------------------------------------
    // Client + login
    // ----------------------------------------------------------------------------------------------------

    private dataDir(): string {
        const dir = utils.getAbsoluteInstanceDataDir(this);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        return dir;
    }

    /**
     * A stable identity for this instance. The SDK otherwise derives one from the credentials, which would make
     * this adapter look like the SAME phone as any other eufy-sdk client on the account and the two would keep
     * evicting each other's session.
     */
    private openudid(): string {
        if (this.config.openudid?.trim()) {
            return this.config.openudid.trim();
        }
        const file = path.join(this.dataDir(), "identity.json");
        try {
            const stored = JSON.parse(readFileSync(file, "utf-8")) as { openudid?: string };
            if (stored.openudid) {
                return stored.openudid;
            }
        } catch {
            // first start
        }
        const openudid = randomUUID().replace(/-/g, "");
        writeFileSync(file, JSON.stringify({ openudid }), { mode: 0o600 });
        return openudid;
    }

    private createClient(sdk: Sdk): EufyMega {
        const dir = this.dataDir();
        const log = this.log;
        const verbose = !!this.config.sdkDebug;
        const ffmpegPath = this.config.ffmpegPath?.trim();
        return new sdk.EufyMega({
            email: this.config.email.trim(),
            password: this.config.password,
            countryCode: (this.config.countryCode || "DE").trim().toUpperCase(),
            openudid: this.openudid(),
            store: new sdk.FileSessionStore(path.join(dir, "session.json")),
            pushStore: new sdk.FileFcmStore(path.join(dir, "push.json")),
            pollMs: Math.max(1, Number(this.config.pollIntervalMin) || 10) * 60_000,
            cacheTtlMs: Math.max(5, Number(this.config.cacheTtlSec) || 15) * 1000,
            ...(ffmpegPath ? { ffmpegPath } : {}),
            logger: {
                debug: (m: string, ...a: unknown[]) => log.debug(`[sdk] ${fmt(m, a)}`),
                info: (m: string, ...a: unknown[]) => (verbose ? log.info : log.debug)(`[sdk] ${fmt(m, a)}`),
                warn: (m: string, ...a: unknown[]) => (verbose ? log.warn : log.debug)(`[sdk] ${fmt(m, a)}`),
                error: (m: string, ...a: unknown[]) => log.warn(`[sdk] ${fmt(m, a)}`),
            },
        });
    }

    private async startLogin(): Promise<void> {
        if (!this.eufy || this.loginInFlight) {
            return;
        }
        this.loginInFlight = true;
        try {
            await this.setLoginStatus("logging_in", "Logging in to the eufy cloud…");
            await this.handleLoginResult(await this.eufy.login());
        } catch (e) {
            await this.onLoginError(e);
        } finally {
            this.loginInFlight = false;
        }
    }

    private async handleLoginResult(r: LoginResult): Promise<void> {
        switch (r.status) {
            case "ok":
                await this.setStateAsync("info.captchaImage", "", true);
                await this.setLoginStatus("ok", "Logged in");
                this.log.info("Logged in to the eufy cloud");
                await this.loadDevices();
                return;
            case "captcha":
                await this.setStateAsync("info.captchaImage", r.image, true);
                await this.setLoginStatus(
                    "captcha",
                    r.retry ? "Wrong captcha answer — please try again." : "Captcha required.",
                );
                this.log.warn(
                    `eufy requests a captcha${r.retry ? " (previous answer was wrong)" : ""}. Open the instance ` +
                        `settings ("Login" tab) or view state ${this.namespace}.info.captchaImage, then write the ` +
                        `characters to ${this.namespace}.auth.captchaAnswer.`,
                );
                return;
            case "2fa":
                await this.setLoginStatus("2fa", `Verification code sent (${r.method}).`);
                this.log.warn(
                    `eufy sent a verification code (${r.method}). Enter it in the instance settings ("Login" tab) ` +
                        `or write it to ${this.namespace}.auth.verifyCode. Do not restart the adapter meanwhile.`,
                );
                return;
        }
    }

    private async onLoginError(e: unknown): Promise<void> {
        const retryAfter = (e as { retryAfterMs?: number })?.retryAfterMs;
        const wait = Math.max(retryAfter ?? 0, RELOGIN_DEFAULT_MS);
        await this.setLoginStatus("error", errText(e));
        await this.setStateAsync("info.connection", false, true);
        this.log.error(`eufy login failed: ${errText(e)} — retrying in ${Math.round(wait / 60_000)} min`);
        this.scheduleRelogin(wait);
    }

    private scheduleRelogin(ms: number): void {
        if (this.reloginTimer) {
            this.clearTimeout(this.reloginTimer);
        }
        this.reloginTimer = this.setTimeout(() => {
            this.reloginTimer = undefined;
            void this.startLogin();
        }, ms);
    }

    private async submitVerifyCode(code: string): Promise<string> {
        if (!this.eufy) {
            throw new Error("adapter not ready");
        }
        const r = await this.eufy.submitVerifyCode(code.trim());
        await this.handleLoginResult(r);
        return r.status;
    }

    private async solveCaptcha(answer: string): Promise<string> {
        if (!this.eufy) {
            throw new Error("adapter not ready");
        }
        const r = await this.eufy.solveCaptcha(answer.trim());
        await this.handleLoginResult(r);
        return r.status;
    }

    /** Forget the stored session and log in from scratch (may trigger 2FA). */
    private async relogin(): Promise<void> {
        if (!this.eufy) {
            return;
        }
        this.devicesLoaded = false;
        await this.setStateAsync("info.connection", false, true);
        try {
            await this.eufy.disconnect();
        } catch {
            // ignore
        }
        this.eufy.clearSession();
        await this.startLogin();
    }

    private async setLoginStatus(status: string, message: string): Promise<void> {
        await this.setStateAsync("info.loginStatus", status, true);
        await this.setStateAsync("info.loginMessage", message, true);
    }

    // ----------------------------------------------------------------------------------------------------
    // SDK events
    // ----------------------------------------------------------------------------------------------------

    private wireClientEvents(eufy: EufyMega): void {
        eufy.on("error", (err: Error) => {
            // The push-check step after the token registration is best-effort in the SDK; the cloud
            // commonly answers -1 there while push delivery works. Not worth a warning on every start.
            if (err.message.includes("/app/review/app_push_check")) {
                this.log.debug(`eufy: ${err.message} (best-effort push check, ignored)`);
                return;
            }
            this.log.warn(`eufy: ${err.message}`);
        });

        eufy.on("sessionExpired", (err) => {
            this.devicesLoaded = false;
            void this.setStateAsync("info.connection", false, true);
            const wait = Math.max(err.retryAfterMs || 0, 60_000);
            this.log.warn(
                `eufy session expired${err.contended ? " (another client is using the same identity)" : ""} — ` +
                    `logging in again in ${Math.round(wait / 1000)} s`,
            );
            void this.setLoginStatus("error", err.message);
            this.scheduleRelogin(wait);
        });

        eufy.on("connect", () => void this.setStateAsync("info.mqttConnected", true, true));
        eufy.on("disconnect", () => void this.setStateAsync("info.mqttConnected", false, true));
        eufy.on("pushConnect", () => void this.setStateAsync("info.pushConnected", true, true));
        eufy.on("pushDisconnect", () => void this.setStateAsync("info.pushConnected", false, true));

        eufy.on("propertyChanged", (e) => {
            if (e.deviceSn) {
                void this.onPropertyChanged(e.deviceSn, e.property, e.value);
            }
        });

        eufy.on("event", (e: AnyDeviceEvent) => {
            if (e.eventName !== "propertyChanged") {
                void this.onDeviceEvent(e);
            }
        });

        eufy.on("deviceState", (s: DeviceState) => {
            const h = this.devices.get(s.sn);
            if (h && s.lastSeenMs) {
                void this.setStateAsync(`${h.oid}.info.lastSeen`, s.lastSeenMs, true);
            }
        });

        eufy.on("availability", (o: AvailabilityObservation) => {
            const h = this.devices.get(o.entity.sn);
            if (h) {
                void this.setStateAsync(`${h.oid}.info.available`, o.availability === "available", true);
            }
        });

        eufy.on("deviceAdded", (d: EufyDevice) => {
            this.log.info(`New eufy device on the account: ${d.name ?? d.model} (${d.sn})`);
            if (this.devicesLoaded) {
                void this.syncDevice(d).catch((e) => this.log.warn(`Cannot add ${d.sn}: ${errText(e)}`));
            }
        });

        eufy.on("deviceRemoved", (d: EufyDevice) => {
            const h = this.devices.get(d.sn);
            this.log.info(`eufy device removed from the account: ${d.name ?? d.model} (${d.sn})`);
            if (h) {
                this.devices.delete(d.sn);
                void this.setStateAsync(`${h.oid}.info.available`, false, true);
            }
        });

        eufy.on("deviceCapabilities", (info) => {
            const h = this.devices.get(info.deviceSn);
            if (h) {
                this.log.info(`${info.deviceSn} gained capabilities: ${info.gained.join(", ")}`);
                void this.buildDeviceTree(h).catch((e) => this.log.warn(`Rebuild ${h.sn} failed: ${errText(e)}`));
            }
        });
    }

    private async onPropertyChanged(sn: string, property: string, value: unknown): Promise<void> {
        const h = this.devices.get(sn);
        const targets = h?.properties.get(property);
        if (!h || !targets) {
            return;
        }
        for (const t of targets) {
            // `value` is absent for payload-shaped properties: "this moved, re-read it" — the getter has the lifted value.
            const v = value !== undefined ? value : this.readGetter(h, t.capAccessor, t.readAccessor);
            await this.setStateAsync(t.id, toStateValue(v, t.codec, t.type), true);
        }
    }

    private async onDeviceEvent(e: AnyDeviceEvent): Promise<void> {
        const sn = e.deviceSn ?? e.stationSn;
        const h = sn ? this.devices.get(sn) : undefined;
        if (!h) {
            this.log.debug(`event ${e.eventName} for unknown device ${sn ?? "-"}`);
            return;
        }
        const base = `${h.oid}.events.${sanitizeId(e.eventName)}`;
        await this.ensureEventObjects(base, e.eventName);
        const now = Date.now();
        await this.setStateAsync(`${base}.payload`, JSON.stringify(e), true);
        await this.setStateAsync(`${base}.lastTriggered`, now, true);
        await this.setStateAsync(`${base}.triggered`, true, true);
        await this.setStateAsync(`${h.oid}.events.lastEvent`, e.eventName, true);

        const resetSec = Number(this.config.eventResetSec) || 0;
        if (resetSec > 0) {
            const old = this.eventResetTimers.get(base);
            if (old) {
                this.clearTimeout(old);
            }
            const timer = this.setTimeout(() => {
                this.eventResetTimers.delete(base);
                void this.setStateAsync(`${base}.triggered`, false, true);
            }, resetSec * 1000);
            if (timer) {
                this.eventResetTimers.set(base, timer);
            }
        }

        if (e.eventName === "armingModeChanged") {
            // Carries no mode — re-read every property of the device so the new guard mode shows up.
            this.refreshAll(h);
        }

        if (this.config.saveSnapshots && SNAPSHOT_EVENTS.has(e.eventName) && e.deviceSn) {
            // The stored thumbnail is retained from the same push; give it a moment to land.
            this.setTimeout(() => void this.storeSnapshot(h, false, "event"), 3000);
        }
    }

    // ----------------------------------------------------------------------------------------------------
    // Devices → object tree
    // ----------------------------------------------------------------------------------------------------

    private async loadDevices(): Promise<void> {
        if (!this.eufy) {
            return;
        }
        let list: EufyDevice[];
        try {
            list = await this.eufy.getDevices();
        } catch (e) {
            await this.onLoginError(e);
            return;
        }
        this.log.info(`Found ${list.length} eufy device(s)`);
        for (const d of list) {
            if (this.excluded.has(d.sn)) {
                this.log.info(`Skipping excluded device ${d.name ?? d.model} (${d.sn})`);
                continue;
            }
            try {
                await this.syncDevice(d);
            } catch (e) {
                this.log.warn(`Cannot set up device ${d.name ?? d.model} (${d.sn}): ${errText(e)}`);
            }
        }
        this.devicesLoaded = true;
        await this.setStateAsync("info.connection", true, true);
    }

    private async syncDevice(d: EufyDevice): Promise<void> {
        if (!this.eufy || this.excluded.has(d.sn)) {
            return;
        }
        const dev = await this.eufy.getDevice(d.sn);
        const h: DeviceHandle = {
            sn: d.sn,
            oid: sanitizeId(d.sn),
            dev,
            manifest: dev.describe() as unknown as DeviceManifestLike,
            properties: new Map(),
        };
        this.devices.set(d.sn, h);
        await this.buildDeviceTree(h, d);
        this.log.info(
            `Device ${h.manifest.name} (${h.manifest.modelName}${h.manifest.model ? `, ${h.manifest.model}` : ""}) ` +
                `ready — capabilities: ${h.manifest.capabilities.join(", ") || "none"}`,
        );
    }

    private async buildDeviceTree(h: DeviceHandle, rec?: EufyDevice): Promise<void> {
        h.manifest = h.dev.describe() as unknown as DeviceManifestLike;
        const m = h.manifest;
        const oid = h.oid;

        await this.extendObjectAsync(oid, {
            type: "device",
            common: {
                name: m.name || m.modelName || h.sn,
                statusStates: { onlineId: `${this.namespace}.${oid}.info.available` },
            } as ioBroker.DeviceCommon,
            native: { sn: h.sn, model: m.model, codec: m.codec },
        });

        await this.ensureChannel(`${oid}.info`, "Device information");
        const info: [string, StateCommon, ioBroker.StateValue][] = [
            ["name", stateDef("Name", "string", "info.name"), m.name],
            ["serialNumber", stateDef("Serial number", "string", "info.serial"), h.sn],
            ["model", stateDef("Model", "string", "info.hardware"), m.model ?? ""],
            ["modelName", stateDef("Model name", "string", "info.hardware"), m.modelName],
            ["codec", stateDef("Device family", "string", "text"), m.codec],
            ["capabilities", stateDef("Capabilities", "string", "json"), JSON.stringify(m.capabilities)],
            ["available", stateDef("Available", "boolean", "indicator.reachable"), true],
            ["lastSeen", stateDef("Last seen", "number", "value.time"), null],
        ];
        if (rec?.stationSn && rec.stationSn !== h.sn) {
            info.push(["stationSn", stateDef("Station serial", "string", "text"), rec.stationSn]);
        }
        for (const [name, common, value] of info) {
            await this.ensureState(`${oid}.info.${name}`, common);
            if (value !== null && !(name === "available" && rec === undefined)) {
                await this.setStateAsync(`${oid}.info.${name}`, value, true);
            }
        }
        try {
            const st = this.eufy?.deviceState(h.sn);
            if (st?.lastSeenMs) {
                await this.setStateAsync(`${oid}.info.lastSeen`, st.lastSeenMs, true);
            }
        } catch {
            // not every serial has state yet
        }

        for (const cap of m.details) {
            await this.buildCapability(h, cap);
        }

        await this.ensureChannel(`${oid}.events`, "Events");
        await this.ensureState(`${oid}.events.lastEvent`, stateDef("Last event", "string", "text"));
        for (const ev of new Set(m.details.flatMap((c) => c.events))) {
            if (ev !== "propertyChanged") {
                await this.ensureEventObjects(`${oid}.events.${sanitizeId(ev)}`, ev);
            }
        }

        await this.buildSnapshotObjects(h);
        await this.removeStaleObjects(h);
    }

    private async buildCapability(h: DeviceHandle, cap: CapabilityDescriptorLike): Promise<void> {
        if (!cap.accessor || (!cap.reads.length && !cap.actions.length)) {
            return;
        }
        const capAccessor = cap.accessor;
        const base = `${h.oid}.${sanitizeId(capAccessor)}`;
        await this.ensureChannel(base, humanize(cap.capability));

        const plans = cap.actions.map((a) => planAction(cap, a));
        const boundReads = new Map(
            plans.flatMap((p) => (p.kind === "bindRead" ? [[p.readAccessor, p.action.name] as const] : [])),
        );

        for (const r of cap.reads) {
            const { common, codec } = readCommon(r);
            const actionName = boundReads.get(r.accessor);
            if (actionName) {
                common.write = true;
                if (common.role === "indicator") {
                    common.role = "switch";
                } else if (common.role.startsWith("value")) {
                    common.role = common.role === "value" ? "level" : common.role.replace(/^value/, "level");
                }
            }
            const id = `${base}.${sanitizeId(r.accessor)}`;
            await this.ensureState(id, common, { property: r.property, kind: r.kind });
            const target: PropertyTarget = { id, codec, type: common.type, capAccessor, readAccessor: r.accessor };
            const targets = (h.properties.get(r.property) ?? []).filter((t) => t.id !== id);
            h.properties.set(r.property, [...targets, target]);

            if (common.write) {
                this.writeHandlers.set(`${this.namespace}.${id}`, async (val) => {
                    const v = fromStateValue(val, codec, common.type);
                    await this.writeRead(h, cap, r, v, actionName);
                });
            }

            const value = this.readGetter(h, capAccessor, r.accessor);
            if (value !== undefined) {
                await this.setStateAsync(id, toStateValue(value, codec, common.type), true);
            }
        }

        for (const p of plans) {
            if (p.kind === "skip" || p.kind === "bindRead") {
                continue;
            }
            const id = `${base}.${sanitizeId(p.action.name)}`;
            await this.ensureState(id, p.common, { action: p.action.name, args: p.action.args });
            const name = p.action.name;
            const args = p.action.args ?? [];
            const fullId = `${this.namespace}.${id}`;
            if (p.kind === "button") {
                this.writeHandlers.set(fullId, async () => this.callAction(h, capAccessor, name, []));
            } else if (p.kind === "single") {
                const type = p.common.type;
                this.writeHandlers.set(fullId, async (val) =>
                    this.callAction(h, capAccessor, name, [fromStateValue(val, "raw", type)]),
                );
            } else {
                this.writeHandlers.set(fullId, async (val) =>
                    this.callAction(h, capAccessor, name, parseJsonArgs(val, args)),
                );
            }
        }
    }

    /**
     * Delete objects of a device that this version no longer generates (e.g. a control an older version created
     * for a write the device has no evidence for). Event objects are kept: they are created lazily and an event
     * the manifest does not list can still have fired.
     */
    private async removeStaleObjects(h: DeviceHandle): Promise<void> {
        if (!h.manifest.bound || !h.manifest.details.length) {
            return; // an unbound/empty manifest says "ask again later", not "this device has nothing"
        }
        const prefix = `${this.namespace}.${h.oid}.`;
        let objs: Record<string, ioBroker.Object>;
        try {
            objs = await this.getForeignObjectsAsync(`${prefix}*`);
        } catch {
            return;
        }
        const stale = Object.keys(objs)
            .map((id) => id.slice(this.namespace.length + 1))
            .filter((id) => !this.createdObjects.has(id) && !id.startsWith(`${h.oid}.events.`))
            .sort((a, b) => b.length - a.length); // states before their channels
        for (const id of stale) {
            this.log.debug(`Removing obsolete object ${id}`);
            this.writeHandlers.delete(`${this.namespace}.${id}`);
            await this.delObjectAsync(id);
        }
        if (stale.length) {
            this.log.info(`${h.manifest.name}: removed ${stale.length} obsolete object(s)`);
        }
    }

    private async ensureEventObjects(base: string, eventName: string): Promise<void> {
        if (this.createdObjects.has(base)) {
            return;
        }
        await this.ensureChannel(base, humanize(eventName));
        await this.ensureState(`${base}.triggered`, stateDef("Triggered", "boolean", eventRole(eventName)));
        await this.ensureState(`${base}.lastTriggered`, stateDef("Last triggered", "number", "value.time"));
        await this.ensureState(`${base}.payload`, stateDef("Event payload", "string", "json"));
        this.createdObjects.add(base);
    }

    private async buildSnapshotObjects(h: DeviceHandle): Promise<void> {
        const camera = this.capObject(h, "camera");
        if (!camera || typeof camera.snapshotStored !== "function") {
            return;
        }
        const base = `${h.oid}.snapshot`;
        await this.ensureChannel(base, "Snapshot");
        await this.ensureState(`${base}.url`, stateDef("Snapshot URL (ioBroker files)", "string", "url"));
        await this.ensureState(`${base}.updated`, stateDef("Snapshot updated", "number", "value.time"));
        await this.ensureState(`${base}.refreshStored`, {
            ...stateDef("Load latest event thumbnail", "boolean", "button"),
            read: false,
            write: true,
        });
        this.writeHandlers.set(`${this.namespace}.${base}.refreshStored`, () => this.storeSnapshot(h, false));
        if (typeof camera.snapshotLive === "function") {
            await this.ensureState(`${base}.refreshLive`, {
                ...stateDef("Capture live snapshot (needs ffmpeg, wakes battery cameras)", "boolean", "button"),
                read: false,
                write: true,
            });
            this.writeHandlers.set(`${this.namespace}.${base}.refreshLive`, () => this.storeSnapshot(h, true));
        }
    }

    /** Devices already told (once per run) that their pushes carry no thumbnail. */
    private readonly thumbnailHinted = new Set<string>();

    /**
     * @param origin `event`: after a detection push; `button`: the user asked for it — failures are reported louder.
     */
    private async storeSnapshot(h: DeviceHandle, live: boolean, origin: "event" | "button" = "button"): Promise<void> {
        const camera = this.capObject(h, "camera");
        const fn = camera?.[live ? "snapshotLive" : "snapshotStored"];
        if (typeof fn !== "function") {
            return;
        }
        let img: unknown;
        try {
            img = await (fn as () => Promise<unknown>).call(camera);
        } catch (e) {
            const why = errText(e);
            if (live) {
                this.log.warn(`Live snapshot for ${h.manifest.name} failed: ${why}`);
            } else if (origin === "button") {
                this.log.info(`No event thumbnail stored for ${h.manifest.name} yet: ${why}`);
            } else if (!this.thumbnailHinted.has(h.sn)) {
                this.thumbnailHinted.add(h.sn);
                this.log.info(
                    `${h.manifest.name}: the event carried no thumbnail, so no snapshot was saved. In the eufy app, ` +
                        `set the camera's notification style to one that includes a thumbnail (not "text only"). (${why})`,
                );
            } else {
                this.log.debug(`No stored snapshot for ${h.sn}: ${why}`);
            }
            return;
        }
        if (!Buffer.isBuffer(img) || !img.length) {
            return;
        }
        await this.ensureFilesMeta();
        const file = `${h.oid}/snapshot.jpg`;
        await this.writeFileAsync(this.namespace, file, img);
        await this.setStateAsync(`${h.oid}.snapshot.url`, `/files/${this.namespace}/${file}`, true);
        await this.setStateAsync(`${h.oid}.snapshot.updated`, Date.now(), true);
    }

    private filesMetaReady = false;
    private async ensureFilesMeta(): Promise<void> {
        if (this.filesMetaReady) {
            return;
        }
        await this.setForeignObjectNotExistsAsync(this.namespace, {
            type: "meta",
            common: { name: "eufy snapshots", type: "meta.user" },
            native: {},
        });
        this.filesMetaReady = true;
    }

    // ----------------------------------------------------------------------------------------------------
    // Reads and writes through the SDK
    // ----------------------------------------------------------------------------------------------------

    /** `dev[accessor]()` — the capability object, re-fetched each time because a re-bind replaces it. */
    private capObject(h: DeviceHandle, accessor: string): Record<string, unknown> | undefined {
        const fn = (h.dev as unknown as Record<string, unknown>)[accessor];
        if (typeof fn !== "function") {
            return undefined;
        }
        try {
            return (fn as () => Record<string, unknown> | undefined).call(h.dev) ?? undefined;
        } catch {
            return undefined;
        }
    }

    private readGetter(h: DeviceHandle, capAccessor: string, readAccessor: string): unknown {
        try {
            return this.capObject(h, capAccessor)?.[readAccessor];
        } catch (e) {
            this.log.debug(`read ${h.sn} ${capAccessor}.${readAccessor} failed: ${errText(e)}`);
            return undefined;
        }
    }

    private refreshAll(h: DeviceHandle): void {
        for (const t of [...h.properties.values()].flat()) {
            const v = this.readGetter(h, t.capAccessor, t.readAccessor);
            if (v !== undefined) {
                void this.setStateAsync(t.id, toStateValue(v, t.codec, t.type), true);
            }
        }
    }

    private async callAction(h: DeviceHandle, capAccessor: string, name: string, args: unknown[]): Promise<void> {
        const obj = this.capObject(h, capAccessor);
        const fn = obj?.[name];
        if (typeof fn !== "function") {
            throw new Error(`${capAccessor}.${name} is not available on ${h.sn}`);
        }
        this.log.debug(`${h.sn}: ${capAccessor}.${name}(${args.map((a) => JSON.stringify(a)).join(", ")})`);
        await (fn as (...a: unknown[]) => unknown).apply(obj, args);
    }

    /** Write a read value: the stateful action bound to it, else its setter, else the flat property writer. */
    private async writeRead(
        h: DeviceHandle,
        cap: CapabilityDescriptorLike,
        r: ReadDescriptorLike,
        value: unknown,
        actionName?: string,
    ): Promise<void> {
        const capAccessor = cap.accessor!;
        if (actionName) {
            return this.callAction(h, capAccessor, actionName, [value]);
        }
        const setter = `set${r.accessor.charAt(0).toUpperCase()}${r.accessor.slice(1)}`;
        if (typeof this.capObject(h, capAccessor)?.[setter] === "function") {
            return this.callAction(h, capAccessor, setter, [value]);
        }
        if (!this.eufy) {
            throw new Error("not connected");
        }
        if (typeof value !== "boolean" && typeof value !== "number" && typeof value !== "string") {
            throw new Error(`unsupported value for ${r.property}: ${JSON.stringify(value)}`);
        }
        await this.eufy.setProperty(h.sn, r.property, value);
    }

    // ----------------------------------------------------------------------------------------------------
    // ioBroker inputs
    // ----------------------------------------------------------------------------------------------------

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack) {
            return;
        }
        const local = id.slice(this.namespace.length + 1);
        try {
            switch (local) {
                case "auth.verifyCode":
                    if (state.val) {
                        await this.submitVerifyCode(String(state.val));
                        await this.setStateAsync(local, "", true);
                    }
                    return;
                case "auth.captchaAnswer":
                    if (state.val) {
                        await this.solveCaptcha(String(state.val));
                        await this.setStateAsync(local, "", true);
                    }
                    return;
                case "auth.relogin":
                    await this.relogin();
                    return;
            }

            const handler = this.writeHandlers.get(id);
            if (!handler) {
                return;
            }
            if (!this.devicesLoaded) {
                this.log.warn(`Cannot write ${local}: not connected to eufy`);
                return;
            }
            await handler(state.val);
            const obj = await this.getObjectAsync(local);
            if (obj?.common && (obj.common as ioBroker.StateCommon).role === "button") {
                await this.setStateAsync(local, false, true);
            } else if (!(obj?.common as ioBroker.StateCommon | undefined)?.read) {
                // write-only control: acknowledge what was sent
                await this.setStateAsync(local, state.val, true);
            }
            // readable states are acknowledged by the device echo (propertyChanged)
        } catch (e) {
            this.log.warn(`Writing ${local} = ${JSON.stringify(state.val)} failed: ${errText(e)}`);
        }
    }

    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (!obj?.command) {
            return;
        }
        const msg = (obj.message ?? {}) as Record<string, unknown>;
        const reply = (res: unknown): void => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, res, obj.callback);
            }
        };
        try {
            switch (obj.command) {
                case "verifyCode": {
                    const code = String(msg.code ?? "").trim();
                    if (!code) {
                        return reply({ error: "Please enter the verification code first." });
                    }
                    const status = await this.submitVerifyCode(code);
                    return reply(
                        status === "ok"
                            ? { result: "Logged in successfully." }
                            : { error: `Login not finished yet: ${status}` },
                    );
                }
                case "captcha": {
                    const answer = String(msg.answer ?? "").trim();
                    if (!answer) {
                        return reply({ error: "Please enter the captcha characters first." });
                    }
                    const status = await this.solveCaptcha(answer);
                    return reply(
                        status === "ok"
                            ? { result: "Logged in successfully." }
                            : { error: `Login not finished yet: ${status}` },
                    );
                }
                case "relogin":
                    await this.relogin();
                    return reply({ result: "Login restarted — check the login status." });
                case "loginStatus": {
                    const status = await this.getStateAsync("info.loginStatus");
                    const message = await this.getStateAsync("info.loginMessage");
                    // textSendTo renders the reply as plain text.
                    return reply(`${String(status?.val ?? "unknown")}: ${String(message?.val ?? "")}`);
                }
                case "captchaImage": {
                    // imageSendTo in jsonConfig renders the reply directly as <img src>.
                    const img = await this.getStateAsync("info.captchaImage");
                    return reply(String(img?.val ?? ""));
                }
                default:
                    return reply({ error: `Unknown command ${obj.command}` });
            }
        } catch (e) {
            reply({ error: errText(e) });
        }
    }

    // ----------------------------------------------------------------------------------------------------
    // Object helpers
    // ----------------------------------------------------------------------------------------------------

    private async ensureChannel(id: string, name: string): Promise<void> {
        if (this.createdObjects.has(id)) {
            return;
        }
        await this.extendObjectAsync(id, { type: "channel", common: { name }, native: {} });
        this.createdObjects.add(id);
    }

    private async ensureState(id: string, common: StateCommon, native: Record<string, unknown> = {}): Promise<void> {
        const clean = Object.fromEntries(Object.entries(common).filter(([, v]) => v !== undefined));
        await this.extendObjectAsync(id, {
            type: "state",
            common: clean as unknown as ioBroker.StateCommon,
            native: JSON.parse(JSON.stringify(native)) as Record<string, unknown>,
        });
        this.createdObjects.add(id);
    }
}

function stateDef(name: string, type: ioBroker.CommonType, role: string): StateCommon {
    return { name, type, role, read: true, write: false };
}

function eventRole(eventName: string): string {
    if (eventName === "motion") {
        return "sensor.motion";
    }
    if (eventName === "doorbellPress") {
        return "sensor.switch";
    }
    if (eventName === "alarm") {
        return "sensor.alarm";
    }
    return "indicator";
}

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function fmt(m: string, a: unknown[]): string {
    if (!a.length) {
        return m;
    }
    return `${m} ${a
        .map((x) => {
            if (x instanceof Error) {
                return x.message;
            }
            if (typeof x === "object") {
                try {
                    return JSON.stringify(x);
                } catch {
                    return String(x);
                }
            }
            return String(x);
        })
        .join(" ")}`;
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new EufyNext(options);
} else {
    (() => new EufyNext())();
}
