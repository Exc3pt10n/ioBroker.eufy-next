/*
 * ioBroker.eufy-next — Anker eufy devices in ioBroker, built on @mega-yfue/eufy-sdk.
 *
 * The object tree is generated from each device's own manifest (`dev.describe()`), so it mirrors exactly
 * what the SDK can read and write on that device — no per-model code lives in this adapter.
 */
import * as utils from '@iobroker/adapter-core';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
    AnyDeviceEvent,
    AvailabilityObservation,
    Device,
    DeviceState,
    EufyDevice,
    EufyMega,
    LoginResult,
} from '@mega-yfue/eufy-sdk' with { 'resolution-mode': 'import' };
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
} from './lib/mapping';
import {
    type Go2rtcOptions,
    type LiveConsumerLike,
    type TimerApi,
    nodeTimers,
    Go2rtcServer,
    LiveSession,
    detectHostname,
    playerUrls,
    pushUrl,
} from './lib/livestream';

// The SDK is ESM-only and loaded with a dynamic import(); this is the type of that module.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type Sdk = typeof import('@mega-yfue/eufy-sdk', { with: { 'resolution-mode': 'import' } });

/** setTimeout/setInterval cannot wait longer than this (2^31 - 1 ms). */
const MAX_TIMER_MS = 2_147_483_647;

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
    /** The cloud record (station serial etc.), kept for rebuilds. */
    rec: EufyDevice;
    /** property name → every state showing it (one property can back reads in several capabilities). */
    properties: Map<string, PropertyTarget[]>;
}

type WriteHandler = (value: ioBroker.StateValue) => Promise<void>;

/** Events that come with a camera thumbnail worth keeping as the latest snapshot. */
const SNAPSHOT_EVENTS = new Set([
    'motion',
    'personDetected',
    'strangerDetected',
    'doorbellPress',
    'petDetection',
    'vehicleDetected',
    'packageDelivered',
    'packageTaken',
    'dogDetected',
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
    private go2rtc?: Go2rtcServer;
    private go2rtcOpts?: Go2rtcOptions;
    private readonly liveSessions = new Map<string, LiveSession>();
    private ffmpegBin?: string;
    private unloading = false;
    /** Certificate + key for the HTTPS player, loaded once at start. */
    private liveCerts?: { cert: string; key: string };

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'eufy-next' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ----------------------------------------------------------------------------------------------------
    // Lifecycle
    // ----------------------------------------------------------------------------------------------------

    private async onReady(): Promise<void> {
        await this.setStateAsync('info.connection', false, true);
        await this.subscribeStatesAsync('*');

        const [major, minor] = process.versions.node.split('.').map(Number);
        if (major < 24 || (major === 24 && minor < 5)) {
            this.log.warn(
                `eufy-sdk requires Node.js >= 24.5.0 (running ${process.versions.node}). ` +
                    'Login and events usually work, but encrypted camera video may fail. Please upgrade Node.js.',
            );
        }

        if (!this.config.email || !this.config.password) {
            await this.setLoginStatus('no_credentials', 'Please enter e-mail and password in the instance settings.');
            this.log.error('No eufy credentials configured — please open the instance settings.');
            return;
        }

        this.excluded = new Set(
            (this.config.excludeDevices || '')
                .split(/[,;\s]+/)
                .map(s => s.trim())
                .filter(Boolean),
        );

        try {
            this.sdk = await import('@mega-yfue/eufy-sdk');
        } catch (e) {
            this.log.error(`Cannot load @mega-yfue/eufy-sdk: ${errText(e)}`);
            return;
        }

        if (this.config.liveEnabled !== false && this.config.liveHttps) {
            await this.loadLiveCertificates();
        }

        this.eufy = this.createClient(this.sdk);
        this.wireClientEvents(this.eufy);
        await this.startLogin();
    }

    private async onUnload(callback: () => void): Promise<void> {
        this.unloading = true;
        try {
            if (this.reloginTimer) {
                this.clearTimeout(this.reloginTimer);
            }
            for (const t of this.eventResetTimers.values()) {
                this.clearTimeout(t);
            }
            this.eventResetTimers.clear();
            for (const s of this.liveSessions.values()) {
                s.stop('adapter stopping');
            }
            this.liveSessions.clear();
            await this.go2rtc?.stop();
            if (this.eufy) {
                // the adapter's own timers are refused while unloading
                await Promise.race([this.eufy.disconnect(), sleep(4000)]);
            }
            this.devices.clear();
            await this.setStateAsync('info.connection', false, true);
        } catch {
            // ignore — shutting down
        } finally {
            callback();
        }
    }

    /** The adapter's own timers for the livestream module: js-controller clears them when the instance stops. */
    private adapterTimers(): TimerApi {
        // While unloading, the adapter refuses new timers, but stopping ffmpeg/go2rtc still needs its kill timeout.
        return {
            set: (fn, ms) => (this.unloading ? nodeTimers.set(fn, ms) : this.setTimeout(fn, ms)),
            clear: handle =>
                this.unloading ? nodeTimers.clear(handle) : this.clearTimeout(handle as ioBroker.Timeout),
        };
    }

    /** Run a promise in the background; a rejection is logged instead of becoming an unhandled rejection. */
    private bg(p: Promise<unknown>): void {
        p.catch(e => this.log.warn(`Background task failed: ${errText(e)}`));
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
        const file = path.join(this.dataDir(), 'identity.json');
        try {
            const stored = JSON.parse(readFileSync(file, 'utf-8')) as { openudid?: string };
            if (stored.openudid) {
                return stored.openudid;
            }
        } catch {
            // first start
        }
        const openudid = randomUUID().replace(/-/g, '');
        writeFileSync(file, JSON.stringify({ openudid }), { mode: 0o600 });
        return openudid;
    }

    private createClient(sdk: Sdk): EufyMega {
        const dir = this.dataDir();
        const log = this.log;
        const verbose = !!this.config.sdkDebug;
        const ffmpegPath = this.ffmpeg();
        return new sdk.EufyMega({
            email: this.config.email.trim(),
            password: this.config.password,
            countryCode: (this.config.countryCode || 'DE').trim().toUpperCase(),
            openudid: this.openudid(),
            store: new sdk.FileSessionStore(path.join(dir, 'session.json')),
            pushStore: new sdk.FileFcmStore(path.join(dir, 'push.json')),
            pollMs: clampNumber(this.config.pollIntervalMin, 1, 1440, 10) * 60_000,
            cacheTtlMs: clampNumber(this.config.cacheTtlSec, 5, 3600, 15) * 1000,
            ...(ffmpegPath ? { ffmpegPath } : {}),
            logger: {
                debug: (m: string, ...a: unknown[]) => log.debug(`[sdk] ${fmt(m, a)}`),
                info: (m: string, ...a: unknown[]) => (verbose ? log.info : log.debug)(`[sdk] ${fmt(m, a)}`),
                warn: (m: string, ...a: unknown[]) => (verbose ? log.warn : log.debug)(`[sdk] ${fmt(m, a)}`),
                error: (m: string, ...a: unknown[]) => log.warn(`[sdk] ${fmt(m, a)}`),
            },
        });
    }

    /** The ioBroker certificates chosen for the HTTPS player (system.certificates). */
    private async loadLiveCertificates(): Promise<void> {
        try {
            const res = (await this.getCertificatesAsync(
                this.config.liveCertPublic || undefined,
                this.config.liveCertPrivate || undefined,
            )) as unknown as [{ cert?: string; key?: string }?];
            const certs = res?.[0];
            if (certs?.cert && certs.key) {
                this.liveCerts = { cert: certs.cert, key: certs.key };
                return;
            }
            this.log.warn('Livestream HTTPS: no certificate/key found — the player falls back to HTTP');
        } catch (e) {
            this.log.warn(`Livestream HTTPS: cannot read certificates (${errText(e)}) — the player falls back to HTTP`);
        }
    }

    /**
     * ffmpeg to run: the configured path, else the bundled ffmpeg-static, else plain `ffmpeg` (resolved from PATH
     * by the operating system when it is started).
     */
    private ffmpeg(): string {
        if (this.ffmpegBin === undefined) {
            this.ffmpegBin = this.config.ffmpegPath?.trim() || bundledFfmpeg() || 'ffmpeg';
            this.log.debug(`ffmpeg: ${this.ffmpegBin}`);
        }
        return this.ffmpegBin;
    }

    /** Where eufy sends the 2FA code: 2 = e-mail (default), 1 = SMS. */
    private messageType(): number {
        return this.config.verifyMethod === 'sms' ? 1 : 2;
    }

    private async startLogin(): Promise<void> {
        if (!this.eufy || this.loginInFlight) {
            return;
        }
        this.loginInFlight = true;
        try {
            await this.setLoginStatus('logging_in', 'Logging in to the eufy cloud…');
            await this.handleLoginResult(await this.eufy.login({ messageType: this.messageType() }));
        } catch (e) {
            await this.onLoginError(e);
        } finally {
            this.loginInFlight = false;
        }
    }

    private async handleLoginResult(r: LoginResult): Promise<void> {
        switch (r.status) {
            case 'ok':
                await this.setStateAsync('info.captchaImage', '', true);
                await this.setLoginStatus('ok', 'Logged in');
                this.log.info('Logged in to the eufy cloud');
                await this.loadDevices();
                return;
            case 'captcha':
                await this.setStateAsync('info.captchaImage', r.image, true);
                await this.setLoginStatus(
                    'captcha',
                    r.retry ? 'Wrong captcha answer — please try again.' : 'Captcha required.',
                );
                this.log.warn(
                    `eufy requests a captcha${r.retry ? ' (previous answer was wrong)' : ''}. Open the instance ` +
                        `settings ("Login" tab) or view state ${this.namespace}.info.captchaImage, then write the ` +
                        `characters to ${this.namespace}.auth.captchaAnswer.`,
                );
                return;
            case '2fa':
                await this.setLoginStatus('2fa', `Verification code sent (${r.method}).`);
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
        await this.setLoginStatus('error', errText(e));
        await this.setStateAsync('info.connection', false, true);
        this.log.error(`eufy login failed: ${errText(e)} — retrying in ${Math.round(wait / 60_000)} min`);
        this.scheduleRelogin(wait);
    }

    private scheduleRelogin(ms: number): void {
        if (this.reloginTimer) {
            this.clearTimeout(this.reloginTimer);
        }
        this.reloginTimer = this.setTimeout(() => {
            this.reloginTimer = undefined;
            this.bg(this.startLogin());
        }, ms);
    }

    private async submitVerifyCode(code: string): Promise<string> {
        if (!this.eufy) {
            throw new Error('adapter not ready');
        }
        const r = await this.eufy.submitVerifyCode(code.trim());
        await this.handleLoginResult(r);
        return r.status;
    }

    private async solveCaptcha(answer: string): Promise<string> {
        if (!this.eufy) {
            throw new Error('adapter not ready');
        }
        const r = await this.eufy.solveCaptcha(answer.trim(), { messageType: this.messageType() });
        await this.handleLoginResult(r);
        return r.status;
    }

    /** Forget the stored session and log in from scratch (may trigger 2FA). */
    private async relogin(): Promise<void> {
        if (!this.eufy) {
            return;
        }
        this.devicesLoaded = false;
        await this.setStateAsync('info.connection', false, true);
        try {
            await this.eufy.disconnect();
        } catch {
            // ignore
        }
        this.eufy.clearSession();
        await this.startLogin();
    }

    private async setLoginStatus(status: string, message: string): Promise<void> {
        await this.setStateAsync('info.loginStatus', status, true);
        await this.setStateAsync('info.loginMessage', message, true);
    }

    // ----------------------------------------------------------------------------------------------------
    // SDK events
    // ----------------------------------------------------------------------------------------------------

    private wireClientEvents(eufy: EufyMega): void {
        eufy.on('error', (err: Error) => {
            // The push-check step after the token registration is best-effort in the SDK; the cloud
            // commonly answers -1 there while push delivery works. Not worth a warning on every start.
            if (err.message.includes('/app/review/app_push_check')) {
                this.log.debug(`eufy: ${err.message} (best-effort push check, ignored)`);
                return;
            }
            this.log.warn(`eufy: ${err.message}`);
        });

        eufy.on('sessionExpired', err => {
            this.devicesLoaded = false;
            this.bg(this.setStateAsync('info.connection', false, true));
            const wait = Math.max(err.retryAfterMs || 0, 60_000);
            this.log.warn(
                `eufy session expired${err.contended ? ' (another client is using the same identity)' : ''} — ` +
                    `logging in again in ${Math.round(wait / 1000)} s`,
            );
            this.bg(this.setLoginStatus('error', err.message));
            this.scheduleRelogin(wait);
        });

        eufy.on('connect', () => this.bg(this.setStateAsync('info.mqttConnected', true, true)));
        eufy.on('disconnect', () => this.bg(this.setStateAsync('info.mqttConnected', false, true)));
        eufy.on('pushConnect', () => this.bg(this.setStateAsync('info.pushConnected', true, true)));
        eufy.on('pushDisconnect', () => this.bg(this.setStateAsync('info.pushConnected', false, true)));
        eufy.on('p2pConnect', (stationSn: string) => this.bg(this.setP2p(stationSn, true)));
        eufy.on('p2pClose', (stationSn: string) => this.bg(this.setP2p(stationSn, false)));

        eufy.on('propertyChanged', e => {
            if (e.deviceSn) {
                this.bg(this.onPropertyChanged(e.deviceSn, e.property, e.value));
            }
        });

        eufy.on('event', (e: AnyDeviceEvent) => {
            if (e.eventName !== 'propertyChanged') {
                this.bg(this.onDeviceEvent(e));
            }
        });

        eufy.on('deviceState', (s: DeviceState) => {
            const h = this.devices.get(s.sn);
            if (h && s.lastSeenMs) {
                this.bg(this.setStateAsync(`${h.oid}.info.lastSeen`, s.lastSeenMs, true));
            }
        });

        eufy.on('availability', (o: AvailabilityObservation) => {
            const h = this.devices.get(o.entity.sn);
            if (h) {
                this.bg(this.setStateAsync(`${h.oid}.info.available`, o.availability === 'available', true));
            }
        });

        eufy.on('deviceAdded', (d: EufyDevice) => {
            this.log.info(`New eufy device on the account: ${d.name ?? d.model} (${d.sn})`);
            if (this.devicesLoaded) {
                void this.syncDevice(d).catch(e => this.log.warn(`Cannot add ${d.sn}: ${errText(e)}`));
            }
        });

        eufy.on('deviceRemoved', (d: EufyDevice) => {
            const h = this.devices.get(d.sn);
            this.log.info(`eufy device removed from the account: ${d.name ?? d.model} (${d.sn})`);
            if (h) {
                this.devices.delete(d.sn);
                this.bg(this.setStateAsync(`${h.oid}.info.available`, false, true));
            }
        });

        eufy.on('deviceCapabilities', info => {
            const h = this.devices.get(info.deviceSn);
            if (h) {
                this.log.info(`${info.deviceSn} gained capabilities: ${info.gained.join(', ')}`);
                void this.buildDeviceTree(h).catch(e => this.log.warn(`Rebuild ${h.sn} failed: ${errText(e)}`));
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
            this.log.debug(`event ${e.eventName} for unknown device ${sn ?? '-'}`);
            return;
        }
        const base = `${h.oid}.events.${sanitizeId(e.eventName)}`;
        await this.ensureEventObjects(base, e.eventName);
        const now = Date.now();
        await this.setStateAsync(`${base}.payload`, JSON.stringify(e), true);
        await this.setStateAsync(`${base}.lastTriggered`, now, true);
        await this.setStateAsync(`${base}.triggered`, true, true);
        await this.setStateAsync(`${h.oid}.events.lastEvent`, e.eventName, true);

        const resetSec = clampNumber(this.config.eventResetSec, 0, 3600, 30);
        if (resetSec > 0) {
            const old = this.eventResetTimers.get(base);
            if (old) {
                this.clearTimeout(old);
            }
            const timer = this.setTimeout(() => {
                this.eventResetTimers.delete(base);
                this.bg(this.setStateAsync(`${base}.triggered`, false, true));
            }, resetSec * 1000);
            if (timer) {
                this.eventResetTimers.set(base, timer);
            }
        }

        if (e.eventName === 'armingModeChanged') {
            // Carries no mode — re-read every property of the device so the new guard mode shows up.
            this.refreshAll(h);
        }

        if (this.config.saveSnapshots && SNAPSHOT_EVENTS.has(e.eventName) && e.deviceSn) {
            // The stored thumbnail is retained from the same push; give it a moment to land.
            this.setTimeout(() => this.bg(this.storeSnapshot(h, false, 'event')), 3000);
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
        await this.setStateAsync('info.connection', true, true);
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
            manifest: dev.describe(),
            rec: d,
            properties: new Map(),
        };
        this.devices.set(d.sn, h);
        await this.buildDeviceTree(h, true);
        this.log.info(
            `Device ${h.manifest.name} (${h.manifest.modelName}${h.manifest.model ? `, ${h.manifest.model}` : ''}) ` +
                `ready — capabilities: ${h.manifest.capabilities.join(', ') || 'none'}`,
        );
    }

    private async buildDeviceTree(h: DeviceHandle, initial = false): Promise<void> {
        const rec = h.rec;
        h.manifest = h.dev.describe();
        const m = h.manifest;
        const oid = h.oid;

        await this.extendObjectAsync(oid, {
            type: 'device',
            common: {
                name: m.name || m.modelName || h.sn,
                statusStates: { onlineId: `${this.namespace}.${oid}.info.available` },
            } as ioBroker.DeviceCommon,
            native: { sn: h.sn, model: m.model, codec: m.codec },
        });

        await this.ensureChannel(`${oid}.info`, 'Device information');
        const info: [string, StateCommon, ioBroker.StateValue][] = [
            ['name', stateDef('Name', 'string', 'info.name'), m.name],
            ['serialNumber', stateDef('Serial number', 'string', 'info.serial'), h.sn],
            ['model', stateDef('Model', 'string', 'info.hardware'), m.model ?? ''],
            ['modelName', stateDef('Model name', 'string', 'info.hardware'), m.modelName],
            ['codec', stateDef('Device family', 'string', 'text'), m.codec],
            ['capabilities', stateDef('Capabilities', 'string', 'json'), JSON.stringify(m.capabilities)],
            ['available', stateDef('Available', 'boolean', 'indicator.reachable'), true],
            ['lastSeen', stateDef('Last seen', 'number', 'value.time'), null],
        ];
        if (rec?.stationSn && rec.stationSn !== h.sn) {
            info.push(['stationSn', stateDef('Station serial', 'string', 'text'), rec.stationSn]);
        }
        for (const [name, common, value] of info) {
            await this.ensureState(`${oid}.info.${name}`, common);
            if (value !== null && !(name === 'available' && !initial)) {
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

        await this.ensureChannel(`${oid}.events`, 'Events');
        await this.ensureState(`${oid}.events.lastEvent`, stateDef('Last event', 'string', 'text'));
        for (const ev of new Set(m.details.flatMap(c => c.events))) {
            if (ev !== 'propertyChanged') {
                await this.ensureEventObjects(`${oid}.events.${sanitizeId(ev)}`, ev);
            }
        }

        await this.buildSnapshotObjects(h);
        await this.buildLivestreamObjects(h);
        await this.buildStationObjects(h);
        await this.buildPtzPresetObjects(h);
        await this.buildQuickResponseObjects(h);
        await this.removeStaleObjects(h);
    }

    private async buildCapability(h: DeviceHandle, cap: CapabilityDescriptorLike): Promise<void> {
        if (!cap.accessor || (!cap.reads.length && !cap.actions.length)) {
            return;
        }
        const capAccessor = cap.accessor;
        const base = `${h.oid}.${sanitizeId(capAccessor)}`;
        await this.ensureChannel(base, humanize(cap.capability));

        const plans = cap.actions.map(a => planAction(cap, a));
        const boundReads = new Map(
            plans.flatMap(p => (p.kind === 'bindRead' ? [[p.readAccessor, p.action.name] as const] : [])),
        );

        for (const r of cap.reads) {
            const actionName = boundReads.get(r.accessor);
            // a read driven by a stateful action is writable: derive its role as such
            const { common, codec } = readCommon(actionName ? { ...r, writable: true } : r);
            const id = `${base}.${sanitizeId(r.accessor)}`;
            await this.ensureState(id, common, { property: r.property, kind: r.kind });
            const target: PropertyTarget = { id, codec, type: common.type, capAccessor, readAccessor: r.accessor };
            const targets = (h.properties.get(r.property) ?? []).filter(t => t.id !== id);
            h.properties.set(r.property, [...targets, target]);

            if (common.write) {
                this.writeHandlers.set(`${this.namespace}.${id}`, async val => {
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
            if (p.kind === 'skip' || p.kind === 'bindRead') {
                continue;
            }
            const id = `${base}.${sanitizeId(p.action.name)}`;
            await this.ensureState(id, p.common, { action: p.action.name, args: p.action.args });
            const name = p.action.name;
            const args = p.action.args ?? [];
            const fullId = `${this.namespace}.${id}`;
            if (p.kind === 'button') {
                this.writeHandlers.set(fullId, async () => this.callAction(h, capAccessor, name, []));
            } else if (p.kind === 'single') {
                const type = p.common.type;
                this.writeHandlers.set(fullId, async val =>
                    this.callAction(h, capAccessor, name, [fromStateValue(val, 'raw', type)]),
                );
            } else {
                this.writeHandlers.set(fullId, async val =>
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
            .map(id => id.slice(this.namespace.length + 1))
            .filter(id => !this.createdObjects.has(id) && !id.startsWith(`${h.oid}.events.`))
            .sort((a, b) => b.length - a.length); // states before their channels
        let removed = 0;
        for (const id of stale) {
            this.writeHandlers.delete(`${this.namespace}.${id}`);
            const custom = (objs[`${this.namespace}.${id}`]?.common as { custom?: Record<string, unknown> } | undefined)
                ?.custom;
            if (custom && Object.keys(custom).length) {
                // History/InfluxDB/SQL settings would be lost for good — keep the object, tell the user
                this.log.warn(
                    `Object ${id} is no longer provided by the device but has custom settings (${Object.keys(custom).join(', ')}) — kept. Delete it manually if it is not needed.`,
                );
                continue;
            }
            this.log.debug(`Removing obsolete object ${id}`);
            await this.delObjectAsync(id);
            removed++;
        }
        if (removed) {
            this.log.info(`${h.manifest.name}: removed ${removed} obsolete object(s)`);
        }
    }

    private async ensureEventObjects(base: string, eventName: string): Promise<void> {
        if (this.createdObjects.has(base)) {
            return;
        }
        await this.ensureChannel(base, humanize(eventName));
        await this.ensureState(`${base}.triggered`, stateDef('Triggered', 'boolean', eventRole(eventName)));
        await this.ensureState(`${base}.lastTriggered`, stateDef('Last triggered', 'number', 'value.time'));
        await this.ensureState(`${base}.payload`, stateDef('Event payload', 'string', 'json'));
        this.createdObjects.add(base);
    }

    private async buildSnapshotObjects(h: DeviceHandle): Promise<void> {
        const camera = this.capObject(h, 'camera');
        if (!camera || typeof camera.snapshotStored !== 'function') {
            return;
        }
        const base = `${h.oid}.snapshot`;
        await this.ensureChannel(base, 'Snapshot');
        await this.ensureState(`${base}.url`, stateDef('Snapshot URL (ioBroker files)', 'string', 'url'));
        await this.ensureState(`${base}.updated`, stateDef('Snapshot updated', 'number', 'value.time'));
        if (this.config.snapshotDataUrl !== false) {
            await this.ensureState(
                `${base}.dataUrl`,
                stateDef('Snapshot as data URL (for <img src>)', 'string', 'url'),
            );
        }
        await this.ensureState(`${base}.refreshStored`, {
            ...stateDef('Load latest event thumbnail', 'boolean', 'button'),
            read: false,
            write: true,
        });
        this.writeHandlers.set(`${this.namespace}.${base}.refreshStored`, () => this.storeSnapshot(h, false));
        if (typeof camera.snapshotLive === 'function') {
            await this.ensureState(`${base}.refreshLive`, {
                ...stateDef('Capture live snapshot (needs ffmpeg, wakes battery cameras)', 'boolean', 'button'),
                read: false,
                write: true,
            });
            this.writeHandlers.set(`${this.namespace}.${base}.refreshLive`, () => this.storeSnapshot(h, true));
        }
    }

    /** Devices already told (once per run) that their pushes carry no thumbnail. */
    private readonly thumbnailHinted = new Set<string>();

    /**
     * @param h the device
     * @param live capture a fresh frame instead of the stored event thumbnail
     * @param origin `event`: after a detection push; `button`: the user asked for it — failures are reported louder.
     */
    private async storeSnapshot(h: DeviceHandle, live: boolean, origin: 'event' | 'button' = 'button'): Promise<void> {
        const camera = this.capObject(h, 'camera');
        const fn = camera?.[live ? 'snapshotLive' : 'snapshotStored'];
        if (typeof fn !== 'function') {
            return;
        }
        let img: unknown;
        try {
            img = await (fn as () => Promise<unknown>).call(camera);
        } catch (e) {
            const why = errText(e);
            if (live) {
                this.log.warn(`Live snapshot for ${h.manifest.name} failed: ${why}`);
            } else if (origin === 'button') {
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
        await this.saveSnapshot(h, img);
    }

    private async saveSnapshot(h: DeviceHandle, img: Buffer): Promise<void> {
        await this.ensureFilesMeta();
        const file = `${h.oid}/snapshot.jpg`;
        await this.writeFileAsync(this.namespace, file, img);
        await this.setStateAsync(`${h.oid}.snapshot.url`, `/files/${this.namespace}/${file}`, true);
        await this.setStateAsync(`${h.oid}.snapshot.updated`, Date.now(), true);
        if (this.config.snapshotDataUrl !== false) {
            await this.setStateAsync(
                `${h.oid}.snapshot.dataUrl`,
                `data:image/jpeg;base64,${img.toString('base64')}`,
                true,
            );
        }
    }

    // ----------------------------------------------------------------------------------------------------
    // Station: reboot + P2P session, PTZ presets, doorbell quick responses
    // ----------------------------------------------------------------------------------------------------

    /** A device that is its own station: a HomeBase, or a camera without one. */
    private isOwnStation(h: DeviceHandle): boolean {
        return !h.rec.stationSn || h.rec.stationSn === h.sn;
    }

    private async buildStationObjects(h: DeviceHandle): Promise<void> {
        if (!this.isOwnStation(h)) {
            return;
        }
        const base = `${h.oid}.station`;
        await this.ensureChannel(base, 'Station');
        await this.ensureState(
            `${base}.p2pConnected`,
            stateDef(
                'P2P session open (opened on demand, closed when idle — not a fault)',
                'boolean',
                'indicator.connected',
            ),
        );
        // The SDK restarts HomeBases and cameras that are their own station (verified on hardware).
        if (h.manifest.codec === 'station' || h.manifest.codec === 'camera') {
            await this.ensureState(`${base}.reboot`, {
                ...stateDef('Reboot (offline for a minute or two)', 'boolean', 'button'),
                read: false,
                write: true,
            });
            this.writeHandlers.set(`${this.namespace}.${base}.reboot`, async () => {
                this.log.info(`${h.manifest.name}: rebooting`);
                await this.eufy?.reboot(h.sn);
            });
        }
    }

    private async setP2p(stationSn: string, open: boolean): Promise<void> {
        const h = this.devices.get(stationSn);
        if (h && this.createdObjects.has(`${h.oid}.station.p2pConnected`)) {
            await this.setStateAsync(`${h.oid}.station.p2pConnected`, open, true);
        }
    }

    /** `dev.ptz().preset()` — the preset sub-API, when this camera has one. */
    private ptzPresets(h: DeviceHandle): Record<string, unknown> | undefined {
        const ptz = this.capObject(h, 'ptz');
        const fn = ptz?.preset;
        if (typeof fn !== 'function') {
            return undefined;
        }
        try {
            return (fn as () => Record<string, unknown>).call(ptz);
        } catch {
            return undefined;
        }
    }

    private async buildPtzPresetObjects(h: DeviceHandle): Promise<void> {
        const presets = this.ptzPresets(h);
        if (!presets) {
            return;
        }
        const base = `${h.oid}.ptz`;
        await this.ensureChannel(base, 'Ptz');
        const verbs: [string, string, string][] = [
            ['goto', 'presetGoto', 'Move to preset (id)'],
            ['save', 'presetSave', 'Save current position as preset (id)'],
            ['delete', 'presetDelete', 'Delete preset (id)'],
        ];
        for (const [verb, id, name] of verbs) {
            if (typeof presets[verb] !== 'function') {
                continue;
            }
            await this.ensureState(
                `${base}.${id}`,
                { ...stateDef(name, 'number', 'level'), write: true },
                { command: true },
            );
            this.writeHandlers.set(`${this.namespace}.${base}.${id}`, async val => {
                await this.callPath(h, 'ptz', `preset.${verb}`, [Number(val)]);
                if (verb !== 'goto') {
                    await this.refreshPresetList(h);
                }
            });
        }
        if (typeof presets.list === 'function') {
            await this.ensureState(`${base}.presets`, stateDef('Stored presets', 'string', 'json'));
            await this.ensureState(`${base}.presetsRefresh`, {
                ...stateDef('Read stored presets from the camera', 'boolean', 'button'),
                read: false,
                write: true,
            });
            this.writeHandlers.set(`${this.namespace}.${base}.presetsRefresh`, () => this.refreshPresetList(h));
        }
    }

    private async refreshPresetList(h: DeviceHandle): Promise<void> {
        if (!this.createdObjects.has(`${h.oid}.ptz.presets`)) {
            return;
        }
        const list = await this.callPath(h, 'ptz', 'preset.list', []);
        await this.setStateAsync(`${h.oid}.ptz.presets`, JSON.stringify(list ?? []), true);
    }

    private async buildQuickResponseObjects(h: DeviceHandle): Promise<void> {
        const doorbell = this.capObject(h, 'doorbell');
        if (!doorbell || typeof doorbell.playQuickResponse !== 'function') {
            return;
        }
        const base = `${h.oid}.doorbell`;
        await this.ensureChannel(base, 'Doorbell');
        await this.ensureState(
            `${base}.quickResponse`,
            {
                ...stateDef('Play quick response (voice id)', 'number', 'level'),
                write: true,
            },
            { command: true },
        );
        this.writeHandlers.set(`${this.namespace}.${base}.quickResponse`, async val => {
            await this.callPath(h, 'doorbell', 'playQuickResponse', [Number(val)]);
        });
        if (typeof doorbell.quickResponses === 'function') {
            await this.ensureState(`${base}.quickResponses`, stateDef('Available quick responses', 'string', 'json'));
            await this.ensureState(`${base}.quickResponsesRefresh`, {
                ...stateDef('Read quick responses from the doorbell', 'boolean', 'button'),
                read: false,
                write: true,
            });
            this.writeHandlers.set(`${this.namespace}.${base}.quickResponsesRefresh`, async () => {
                const list = await this.callPath(h, 'doorbell', 'quickResponses', []);
                await this.setStateAsync(`${base}.quickResponses`, JSON.stringify(list ?? []), true);
            });
        }
    }

    /**
     * Call `dev.<capability>().<a>.<b>(...args)`: every segment but the last is a sub-API reached by calling it
     * without arguments (`preset.goto` → `ptz().preset().goto(id)`).
     */
    private async callPath(h: DeviceHandle, capability: string, action: string, args: unknown[]): Promise<unknown> {
        let target: unknown = this.capObject(h, capability);
        const segments = action.split('.');
        for (const seg of segments.slice(0, -1)) {
            const sub = (target as Record<string, unknown> | undefined)?.[seg];
            if (typeof sub !== 'function') {
                throw new Error(`${capability}.${action} is not available on ${h.sn}`);
            }
            target = await (sub as () => unknown).call(target);
        }
        const last = segments[segments.length - 1];
        const fn = (target as Record<string, unknown> | undefined)?.[last];
        if (typeof fn !== 'function') {
            throw new Error(`${capability}.${action} is not available on ${h.sn}`);
        }
        this.log.debug(`${h.sn}: ${capability}.${action}(${args.map(a => JSON.stringify(a)).join(', ')})`);
        return await (fn as (...a: unknown[]) => unknown).apply(target, args);
    }

    // ----------------------------------------------------------------------------------------------------
    // Livestream (go2rtc)
    // ----------------------------------------------------------------------------------------------------

    private liveOptions(): Go2rtcOptions | undefined {
        if (this.go2rtcOpts) {
            return this.go2rtcOpts;
        }
        let binary: string | null = null;
        try {
            binary = bundledGo2rtc();
        } catch {
            binary = null;
        }
        const ffmpeg = this.ffmpeg();
        if (!binary || !ffmpeg) {
            return undefined;
        }
        const port = (v: unknown, d: number): number => {
            const n = Number(v);
            return Number.isInteger(n) && n > 0 && n < 65536 ? n : d;
        };
        this.go2rtcOpts = {
            binary,
            ffmpeg,
            apiPort: port(this.config.liveApiPort, 1984),
            rtspPort: port(this.config.liveRtspPort, 8554),
            webrtcPort: port(this.config.liveWebrtcPort, 8555),
            hostname: this.config.liveHostname?.trim() || detectHostname(),
            rtspUsername: this.config.liveRtspUsername?.trim() || undefined,
            rtspPassword: this.config.liveRtspPassword || undefined,
            https: this.liveCerts,
            configFile: path.join(this.dataDir(), 'go2rtc.json'),
            timers: this.adapterTimers(),
        };
        return this.go2rtcOpts;
    }

    private async buildLivestreamObjects(h: DeviceHandle): Promise<void> {
        const camera = this.capObject(h, 'camera');
        if (this.config.liveEnabled === false || !camera || typeof camera.live !== 'function') {
            return;
        }
        const base = `${h.oid}.livestream`;
        await this.ensureChannel(base, 'Livestream');
        await this.ensureState(`${base}.start`, {
            ...stateDef('Start livestream', 'boolean', 'button.start'),
            read: false,
            write: true,
        });
        await this.ensureState(`${base}.stop`, {
            ...stateDef('Stop livestream', 'boolean', 'button.stop'),
            read: false,
            write: true,
        });
        await this.ensureState(`${base}.url`, stateDef('Player URL (only while streaming)', 'string', 'url'));
        await this.ensureState(`${base}.rtsp`, stateDef('RTSP URL (only while streaming)', 'string', 'url'));
        await this.ensureState(`${base}.active`, stateDef('Streaming (player has data)', 'boolean', 'indicator'));
        await this.ensureState(
            `${base}.error`,
            stateDef('Why the last start failed (empty when fine)', 'string', 'text'),
        );
        this.writeHandlers.set(`${this.namespace}.${base}.start`, () => this.startLive(h));
        this.writeHandlers.set(`${this.namespace}.${base}.stop`, () => {
            this.liveSessions.get(h.sn)?.stop('stopped');
            return Promise.resolve();
        });
        if (!this.liveSessions.has(h.sn)) {
            await this.setLiveStates(h, undefined);
        }
        this.go2rtcServer()?.register(h.oid);
    }

    private go2rtcServer(): Go2rtcServer | undefined {
        if (!this.go2rtc) {
            const opts = this.liveOptions();
            if (!opts) {
                return undefined;
            }
            this.go2rtc = new Go2rtcServer(opts, {
                debug: m => this.log.debug(m),
                info: m => this.log.info(m),
                warn: m => this.log.warn(m),
            });
        }
        return this.go2rtc;
    }

    private async setLiveStates(h: DeviceHandle, urls: { url: string; rtsp: string } | undefined): Promise<void> {
        const base = `${h.oid}.livestream`;
        await this.setStateAsync(`${base}.url`, urls?.url ?? '', true);
        await this.setStateAsync(`${base}.rtsp`, urls?.rtsp ?? '', true);
        await this.setStateAsync(`${base}.active`, !!urls, true);
    }

    private async setLiveError(h: DeviceHandle, message: string): Promise<void> {
        // setStateChanged: clearing an already empty error must not produce an update a visualisation could
        // take for a new failure
        await this.setStateChangedAsync(`${h.oid}.livestream.error`, message, true);
    }

    private async startLive(h: DeviceHandle): Promise<void> {
        try {
            await this.startLiveSession(h);
        } catch (e) {
            await this.setLiveError(h, errText(e));
            throw e;
        }
    }

    private async startLiveSession(h: DeviceHandle): Promise<void> {
        if (this.liveSessions.has(h.sn)) {
            this.log.info(`${h.manifest.name}: livestream already running`);
            return;
        }
        const server = this.go2rtcServer();
        const opts = this.go2rtcOpts;
        if (!server || !opts) {
            throw new Error('livestream needs ffmpeg and go2rtc, but at least one is not available on this host');
        }
        const camera = this.capObject(h, 'camera');
        const live = camera?.live;
        if (typeof live !== 'function') {
            throw new Error('this camera offers no livestream');
        }
        const stream = h.oid;
        await this.setLiveError(h, '');
        await server.ensure(stream);
        this.log.info(`${h.manifest.name}: starting livestream`);
        let consumer: LiveConsumerLike;
        try {
            consumer = await (live as () => Promise<LiveConsumerLike>).call(camera);
        } catch (e) {
            await this.setLiveStates(h, undefined);
            throw new Error(`camera did not start streaming: ${errText(e)}`);
        }
        const maxSec = clampNumber(this.config.liveMaxDurationSec, 0, 86_400, 120);
        let snapshotTimer: ioBroker.Timeout | undefined;
        let playable = false;
        const session = new LiveSession(consumer, {
            stream,
            ffmpeg: opts.ffmpeg,
            target: pushUrl(opts, stream),
            maxDurationMs: Math.min(maxSec * 1000, MAX_TIMER_MS),
            audio: this.config.liveAudio !== false,
            log: { debug: m => this.log.debug(m), info: m => this.log.info(m), warn: m => this.log.warn(m) },
            timers: this.adapterTimers(),
            // only report the stream once go2rtc really has it, so a player opened on `active` never finds it empty
            ready: () => server.hasProducer(stream),
            onActive: () => {
                playable = true;
                const urls = playerUrls(opts, stream);
                this.log.info(`${h.manifest.name}: livestream running — ${urls.url}`);
                this.bg(this.setLiveStates(h, urls));
                if (this.config.liveSnapshot !== false) {
                    // A still from the running stream: a fresh tile picture without waking the camera again.
                    snapshotTimer = this.setTimeout(() => {
                        void server
                            .frame(stream)
                            .then(jpg => (jpg.length ? this.saveSnapshot(h, jpg) : undefined))
                            .catch(e => this.log.debug(`No frame from go2rtc for ${h.sn}: ${errText(e)}`));
                    }, 4000);
                }
            },
            onEnded: reason => {
                if (snapshotTimer) {
                    this.clearTimeout(snapshotTimer);
                }
                if (this.liveSessions.get(h.sn) === session) {
                    this.liveSessions.delete(h.sn);
                }
                this.bg(this.setLiveStates(h, undefined));
                if (playable || reason === 'stopped' || reason === 'adapter stopping') {
                    this.log.info(`${h.manifest.name}: livestream ended (${reason})`);
                } else {
                    // never became playable: a failed start — tell the user (and visualisations) why
                    this.log.warn(`${h.manifest.name}: livestream could not be started (${reason})`);
                    this.bg(this.setLiveError(h, reason));
                }
            },
        });
        this.liveSessions.set(h.sn, session);
    }

    private filesMetaReady = false;
    private async ensureFilesMeta(): Promise<void> {
        if (this.filesMetaReady) {
            return;
        }
        await this.setForeignObjectNotExistsAsync(this.namespace, {
            type: 'meta',
            common: { name: 'eufy snapshots', type: 'meta.user' },
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
        if (typeof fn !== 'function') {
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
                this.bg(this.setStateAsync(t.id, toStateValue(v, t.codec, t.type), true));
            }
        }
    }

    private async callAction(h: DeviceHandle, capAccessor: string, name: string, args: unknown[]): Promise<void> {
        const obj = this.capObject(h, capAccessor);
        const fn = obj?.[name];
        if (typeof fn !== 'function') {
            throw new Error(`${capAccessor}.${name} is not available on ${h.sn}`);
        }
        this.log.debug(`${h.sn}: ${capAccessor}.${name}(${args.map(a => JSON.stringify(a)).join(', ')})`);
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
        if (typeof this.capObject(h, capAccessor)?.[setter] === 'function') {
            return this.callAction(h, capAccessor, setter, [value]);
        }
        if (!this.eufy) {
            throw new Error('not connected');
        }
        if (typeof value !== 'boolean' && typeof value !== 'number' && typeof value !== 'string') {
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
                case 'auth.verifyCode':
                    if (state.val) {
                        await this.submitVerifyCode(String(state.val));
                        await this.setStateAsync(local, '', true);
                    }
                    return;
                case 'auth.captchaAnswer':
                    if (state.val) {
                        await this.solveCaptcha(String(state.val));
                        await this.setStateAsync(local, '', true);
                    }
                    return;
                case 'auth.relogin':
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
            if (local.endsWith('.livestream.start') || local.endsWith('.livestream.stop')) {
                // visualisations open and close streams on their own: say who did it
                this.log.info(`${local} requested by ${state.from || 'unknown'}`);
            }
            await handler(state.val);
            const obj = await this.getObjectAsync(local);
            const common = obj?.common as ioBroker.StateCommon | undefined;
            const native = (obj?.native ?? {}) as { action?: string; command?: boolean };
            if (common?.role?.startsWith('button')) {
                await this.setStateAsync(local, false, true);
            } else if (native.action || native.command || !common?.read) {
                // command state: acknowledge what was sent (the state keeps the last command)
                await this.setStateAsync(local, state.val, true);
            }
            // readable device values are acknowledged by the device echo (propertyChanged)
        } catch (e) {
            this.log.warn(`Writing ${local} = ${JSON.stringify(state.val)} failed: ${errText(e)}`);
        }
    }

    private deviceFor(sn: unknown): DeviceHandle {
        const h = typeof sn === 'string' ? this.devices.get(sn) : undefined;
        if (!h) {
            throw new Error(`unknown device ${String(sn)}`);
        }
        return h;
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
                case 'verifyCode': {
                    const code = str(msg.code).trim();
                    if (!code) {
                        return reply({ error: 'Please enter the verification code first.' });
                    }
                    const status = await this.submitVerifyCode(code);
                    return reply(
                        status === 'ok'
                            ? { result: 'Logged in successfully.' }
                            : { error: `Login not finished yet: ${status}` },
                    );
                }
                case 'captcha': {
                    const answer = str(msg.answer).trim();
                    if (!answer) {
                        return reply({ error: 'Please enter the captcha characters first.' });
                    }
                    const status = await this.solveCaptcha(answer);
                    return reply(
                        status === 'ok'
                            ? { result: 'Logged in successfully.' }
                            : { error: `Login not finished yet: ${status}` },
                    );
                }
                case 'relogin':
                    await this.relogin();
                    return reply({ result: 'Login restarted — check the login status.' });
                case 'loginStatus': {
                    const status = await this.getStateAsync('info.loginStatus');
                    const message = await this.getStateAsync('info.loginMessage');
                    // textSendTo renders the reply as plain text.
                    return reply(`${String(status?.val ?? 'unknown')}: ${String(message?.val ?? '')}`);
                }
                case 'captchaImage': {
                    // imageSendTo in jsonConfig renders the reply directly as <img src>.
                    const img = await this.getStateAsync('info.captchaImage');
                    return reply(String(img?.val ?? ''));
                }
                case 'listActions': {
                    // What callAction can reach on a device: described and undescribed actions per capability.
                    const h = this.deviceFor(msg.sn);
                    return reply({
                        result: Object.fromEntries(
                            h.manifest.details
                                .filter(c => c.accessor && (c.actions.length || c.undescribedActions.length))
                                .map(c => [
                                    c.accessor,
                                    {
                                        described: c.actions.map(a => ({ name: a.name, form: a.form, args: a.args })),
                                        undescribed: c.undescribedActions,
                                    },
                                ]),
                        ),
                    });
                }
                case 'callAction': {
                    // Any action of a capability, including those the SDK does not describe (ptz.rotate,
                    // ptz.preset.list, doorbell.quickResponses, smartLight.setEffect …). Args are positional.
                    const h = this.deviceFor(msg.sn);
                    const capability = str(msg.capability);
                    const action = str(msg.action);
                    const allowed = h.manifest.details.find(c => c.accessor === capability);
                    const root = action.split('.')[0];
                    if (
                        !allowed ||
                        ![...allowed.actions.map(a => a.name), ...allowed.undescribedActions].includes(root)
                    ) {
                        return reply({ error: `${capability}.${root} is not an action of ${h.sn} (see listActions)` });
                    }
                    const args = Array.isArray(msg.args)
                        ? (msg.args as unknown[])
                        : msg.args === undefined
                          ? []
                          : [msg.args];
                    const result = await this.callPath(h, capability, action, args);
                    return reply({ result: toJsonSafe(result) });
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
        await this.extendObjectAsync(id, { type: 'channel', common: { name }, native: {} });
        this.createdObjects.add(id);
    }

    private async ensureState(id: string, common: StateCommon, native: Record<string, unknown> = {}): Promise<void> {
        const clean = Object.fromEntries(Object.entries(common).filter(([, v]) => v !== undefined));
        await this.extendObjectAsync(id, {
            type: 'state',
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
    if (eventName === 'motion') {
        return 'sensor.motion';
    }
    if (eventName === 'doorbellPress') {
        return 'sensor';
    }
    if (eventName === 'alarm') {
        return 'sensor.alarm';
    }
    return 'indicator';
}

/** Make an SDK return value fit a sendTo reply: Buffers become base64, functions are dropped. */
function toJsonSafe(v: unknown): unknown {
    if (v === undefined || v === null) {
        return null;
    }
    return JSON.parse(
        JSON.stringify(v, (_k, x: unknown) => {
            if (typeof x === 'function') {
                return undefined;
            }
            if (typeof x === 'bigint') {
                return Number(x);
            }
            if (
                x &&
                typeof x === 'object' &&
                (x as { type?: string }).type === 'Buffer' &&
                Array.isArray((x as { data?: unknown }).data)
            ) {
                return Buffer.from((x as { data: number[] }).data).toString('base64');
            }
            return x;
        }),
    ) as unknown;
}

/** A message field as trimmed-later string; anything that is not a primitive counts as empty. */
function str(v: unknown): string {
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
}

/** Path of the ffmpeg binary installed by `ffmpeg-static`, or null on a platform it has no binary for. */
function bundledFfmpeg(): string | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const p: unknown = require('ffmpeg-static');
        return typeof p === 'string' ? p : null;
    } catch {
        return null;
    }
}

/** Path of the go2rtc binary installed by `go2rtc-static`, or null on a platform it has no binary for. */
function bundledGo2rtc(): string | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const p: unknown = require('go2rtc-static');
        return typeof p === 'string' ? p : null;
    } catch {
        return null;
    }
}

/** Clamp a configured number into [min, max]; anything unparsable becomes `fallback`. */
export function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
    const n = Number(v);
    if (!Number.isFinite(n)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, n));
}

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function fmt(m: string, a: unknown[]): string {
    if (!a.length) {
        return m;
    }
    const part = (x: unknown): string => {
        if (x instanceof Error) {
            return x.message;
        }
        if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean' || typeof x === 'bigint') {
            return String(x);
        }
        if (x === undefined || x === null || typeof x === 'symbol' || typeof x === 'function') {
            return String(x);
        }
        try {
            return JSON.stringify(x);
        } catch {
            return Object.prototype.toString.call(x);
        }
    };
    return `${m} ${a.map(part).join(' ')}`;
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new EufyNext(options);
} else {
    (() => new EufyNext())();
}
