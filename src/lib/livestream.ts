/**
 * Camera livestreams for players: go2rtc serves the stream (web player, MSE/HLS/WebRTC, RTSP) and ffmpeg pushes
 * the camera's elementary streams into it — on request only, and for a bounded time, because a battery camera
 * drains while it streams.
 *
 *   camera.live() ──video/audio frames──▶ ffmpeg (copy) ──RTSP push──▶ go2rtc ──▶ browser / vis / NVR
 *
 * go2rtc is started lazily on the first stream and kept running; it costs nothing while no stream is pushed.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import type { Writable } from 'node:stream';

export interface LiveLogger {
    debug: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
}

/** Timer functions; the adapter passes its own so js-controller clears them on unload. */
export interface TimerApi {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
}

/** Plain Node timers — for use outside an adapter (tests). */
export const nodeTimers: TimerApi = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: handle => clearTimeout(handle as NodeJS.Timeout),
};

export interface Go2rtcOptions {
    binary: string;
    ffmpeg: string;
    apiPort: number;
    rtspPort: number;
    webrtcPort: number;
    /** Host the player is reached under (also announced as WebRTC candidate). */
    hostname: string;
    rtspUsername?: string;
    rtspPassword?: string;
    /** Serve the player over HTTPS on `apiPort`; the adapter itself then talks to go2rtc on loopback. */
    https?: { cert: string; key: string };
    /**
     * Where to write the go2rtc configuration (mode 0600). It holds the RTSP password and the TLS key, which must
     * not appear on a command line visible to other local users. Without it the configuration is passed inline.
     */
    configFile?: string;
    timers?: TimerApi;
}

/** Port the adapter reaches go2rtc's API on: `apiPort`, or the loopback-only port next to it under HTTPS. */
export function internalApiPort(o: Go2rtcOptions): number {
    return o.https ? o.apiPort + 1 : o.apiPort;
}

/** The go2rtc configuration (passed as inline JSON via `-config`). */
export function go2rtcConfig(o: Go2rtcOptions, streams: readonly string[]): Record<string, unknown> {
    const rtsp: Record<string, unknown> = { listen: `:${o.rtspPort}` };
    if (o.rtspUsername) {
        rtsp.username = o.rtspUsername;
        rtsp.password = o.rtspPassword ?? '';
    }
    return {
        api: o.https
            ? {
                  listen: `127.0.0.1:${internalApiPort(o)}`,
                  tls_listen: `:${o.apiPort}`,
                  tls_cert: o.https.cert,
                  tls_key: o.https.key,
              }
            : { listen: `:${o.apiPort}` },
        rtsp,
        webrtc: { listen: `:${o.webrtcPort}`, candidates: [`${o.hostname}:${o.webrtcPort}`, `stun:${o.webrtcPort}`] },
        ffmpeg: { bin: o.ffmpeg },
        log: { level: 'warn' },
        // A stream with no source accepts an incoming RTSP push under its name.
        streams: Object.fromEntries(streams.map(s => [s, null])),
    };
}

/** Where ffmpeg pushes to — go2rtc's own RTSP server on loopback. */
export function pushUrl(o: Go2rtcOptions, stream: string): string {
    const auth = o.rtspUsername
        ? `${encodeURIComponent(o.rtspUsername)}:${encodeURIComponent(o.rtspPassword ?? '')}@`
        : '';
    return `rtsp://${auth}127.0.0.1:${o.rtspPort}/${encodeURIComponent(stream)}`;
}

/** The URLs a player uses. */
export function playerUrls(o: Go2rtcOptions, stream: string): { url: string; rtsp: string } {
    const src = encodeURIComponent(stream);
    return {
        url: `${o.https ? 'https' : 'http'}://${o.hostname}:${o.apiPort}/stream.html?src=${src}`,
        rtsp: `rtsp://${o.hostname}:${o.rtspPort}/${src}`,
    };
}

export type AudioInput = 'aac-lc' | 'g711a' | undefined;

/**
 * ffmpeg arguments: Annex-B video on stdin, optional audio on fd 3, pushed to go2rtc. Video is never re-encoded;
 * audio (AAC-LC or G.711 A-law) becomes AAC, which MSE/HLS players play.
 */
export function ffmpegArgs(videoCodec: 'h264' | 'h265', audio: AudioInput, target: string): string[] {
    const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-fflags',
        '+genpts+nobuffer',
        '-use_wallclock_as_timestamps',
        '1',
        '-f',
        videoCodec === 'h265' ? 'hevc' : 'h264',
        '-i',
        'pipe:0',
    ];
    if (audio === 'aac-lc') {
        args.push('-use_wallclock_as_timestamps', '1', '-f', 'aac', '-i', 'pipe:3');
    } else if (audio === 'g711a') {
        args.push('-use_wallclock_as_timestamps', '1', '-f', 'alaw', '-ar', '16000', '-ac', '1', '-i', 'pipe:3');
    }
    args.push('-map', '0:v:0', '-c:v', 'copy');
    if (audio) {
        // Re-encoded rather than copied: the RTSP muxer needs the AAC config when it writes its header, which a raw
        // ADTS input only reveals after the first packet. 16 kHz mono costs next to nothing to encode.
        args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '32k');
    }
    args.push('-f', 'rtsp', '-rtsp_transport', 'tcp', target);
    return args;
}

/** First non-internal IPv4 address of this host — the default hostname for player URLs. */
export function detectHostname(): string {
    for (const list of Object.values(networkInterfaces())) {
        for (const a of list ?? []) {
            if (a.family === 'IPv4' && !a.internal) {
                return a.address;
            }
        }
    }
    return '127.0.0.1';
}

/** The go2rtc child process. */
export class Go2rtcServer {
    private proc?: ChildProcess;
    private starting?: Promise<void>;
    /** Streams go2rtc accepts pushes for. go2rtc only takes a push for a stream that was configured at its start. */
    private readonly streams = new Set<string>();
    private configured = new Set<string>();

    public constructor(
        private readonly opts: Go2rtcOptions,
        private readonly log: LiveLogger,
    ) {}

    private get timers(): TimerApi {
        return this.opts.timers ?? nodeTimers;
    }

    public get running(): boolean {
        return !!this.proc && this.proc.exitCode === null;
    }

    /** Announce a stream before go2rtc starts, so a later start needs no restart. */
    public register(stream: string): void {
        this.streams.add(stream);
    }

    /** Make sure go2rtc runs and accepts a push for `stream`. */
    public async ensure(stream: string): Promise<void> {
        this.streams.add(stream);
        if (this.starting) {
            await this.starting;
        }
        if (this.running && this.configured.has(stream)) {
            return;
        }
        if (this.running) {
            this.log.info(`Restarting go2rtc to add stream ${stream}`);
            await this.stop();
        }
        this.starting ??= this.start().finally(() => (this.starting = undefined));
        await this.starting;
    }

    private async start(): Promise<void> {
        this.configured = new Set(this.streams);
        const json = JSON.stringify(go2rtcConfig(this.opts, [...this.configured]));
        let config = json;
        if (this.opts.configFile) {
            writeFileSync(this.opts.configFile, json, { mode: 0o600 });
            config = this.opts.configFile;
        }
        this.log.info(
            `Starting go2rtc (player port ${this.opts.apiPort}${this.opts.https ? ' HTTPS' : ''}, RTSP ${this.opts.rtspPort})`,
        );
        const proc = spawn(this.opts.binary, ['-config', config], { stdio: ['ignore', 'pipe', 'pipe'] });
        this.proc = proc;
        const onLine = (b: Buffer): void => {
            for (const line of b.toString().split('\n').filter(Boolean)) {
                this.log.debug(`[go2rtc] ${line}`);
            }
        };
        proc.stdout?.on('data', onLine);
        proc.stderr?.on('data', onLine);
        proc.on('exit', code => {
            if (this.proc === proc) {
                this.proc = undefined;
                this.log.warn(`go2rtc exited (code ${code ?? '?'})`);
            }
        });
        proc.on('error', e => this.log.warn(`go2rtc failed to start: ${e.message}`));
        const deadline = Date.now() + 10_000;
        for (;;) {
            if (proc.exitCode !== null || proc.killed) {
                throw new Error('go2rtc exited during start — is the port free?');
            }
            if (
                await this.api('/api').then(
                    () => true,
                    () => false,
                )
            ) {
                return;
            }
            if (Date.now() > deadline) {
                throw new Error('go2rtc did not answer within 10 s');
            }
            await new Promise<void>(r => this.timers.set(r, 200));
        }
    }

    /** Call go2rtc's API on loopback. */
    public async api(path: string, method = 'GET'): Promise<Response> {
        const res = await fetch(`http://127.0.0.1:${internalApiPort(this.opts)}${path}`, {
            method,
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
            throw new Error(`go2rtc ${method} ${path}: HTTP ${res.status}`);
        }
        return res;
    }

    /** A JPEG of the stream's current picture (go2rtc decodes it with ffmpeg). */
    public async frame(stream: string): Promise<Buffer> {
        const res = await this.api(`/api/frame.jpeg?src=${encodeURIComponent(stream)}`);
        return Buffer.from(await res.arrayBuffer());
    }

    public async stop(): Promise<void> {
        const proc = this.proc;
        this.proc = undefined;
        if (!proc || proc.exitCode !== null) {
            return;
        }
        await new Promise<void>(resolve => {
            const t = this.timers.set(() => {
                proc.kill('SIGKILL');
                resolve();
            }, 3000);
            proc.once('exit', () => {
                this.timers.clear(t);
                resolve();
            });
            proc.kill('SIGTERM');
        });
    }
}

/** The listener overloads of the SDK's `LiveStreamConsumer.on`, as one function type. */
type LiveOn = ((event: 'video', l: (f: { keyframe: boolean; codec: string; data: Buffer }) => void) => unknown) &
    ((event: 'audio', l: (f: { codec: string; data: Buffer }) => void) => unknown) &
    ((event: 'stop' | 'unacknowledged', l: () => void) => unknown) &
    ((event: 'error', l: (e: Error) => void) => unknown) &
    ((event: 'budget', l: (n: { graceMs: number; extend: (ms?: number) => void }) => void) => unknown);

/** Structural subset of the SDK's `LiveStreamConsumer`. */
export interface LiveConsumerLike {
    stop: () => void;
    pause?: () => void;
    resume?: () => void;
    on: LiveOn;
}

export interface LiveSessionOptions {
    stream: string;
    ffmpeg: string;
    target: string;
    /** Stop after this many ms (0 = never). */
    maxDurationMs: number;
    /** How long to collect frames to learn whether audio comes along before ffmpeg starts. */
    audioProbeMs?: number;
    /** Give up when no video keyframe arrives within this time. */
    firstFrameTimeoutMs?: number;
    log: LiveLogger;
    timers?: TimerApi;
    /** Called once, when the push into go2rtc is running. */
    onActive: () => void;
    /** Called once, whenever and however the session ends. */
    onEnded: (reason: string) => void;
}

/**
 * One camera stream: waits for the first keyframe, learns the audio codec, starts ffmpeg and feeds it until it
 * is stopped, the maximum duration passes, or anything in the chain ends.
 */
export class LiveSession {
    private ffmpeg?: ChildProcess;
    private videoIn?: Writable;
    private audioIn?: Writable;
    private ended = false;
    private started = false;
    private videoCodec?: 'h264' | 'h265';
    private audioCodec: AudioInput;
    private pending: { kind: 'v' | 'a'; data: Buffer }[] = [];
    private timerHandles: unknown[] = [];
    private readonly timers: TimerApi;
    private deadline = 0;

    public constructor(
        private readonly consumer: LiveConsumerLike,
        private readonly o: LiveSessionOptions,
    ) {
        this.timers = o.timers ?? nodeTimers;
        this.deadline = o.maxDurationMs > 0 ? Date.now() + o.maxDurationMs : 0;
        consumer.on('video', f => this.onVideo(f));
        consumer.on('audio', f => this.onAudio(f));
        consumer.on('stop', () => this.end('camera stopped the stream'));
        consumer.on('unacknowledged', () => this.end('camera did not acknowledge the stream start'));
        consumer.on('error', e => this.end(`stream error: ${e.message}`));
        consumer.on('budget', n => {
            // Battery budget: keep going only while our own maximum allows it.
            const left = this.deadline ? this.deadline - Date.now() : Infinity;
            if (left > n.graceMs) {
                n.extend(Number.isFinite(left) ? left : undefined);
            }
        });
        this.timerHandles.push(
            this.timers.set(() => {
                if (!this.started) {
                    this.end('no video keyframe from the camera');
                }
            }, o.firstFrameTimeoutMs ?? 20_000),
        );
        if (this.deadline) {
            this.timerHandles.push(this.timers.set(() => this.end('maximum duration reached'), o.maxDurationMs));
        }
    }

    public get active(): boolean {
        return this.started && !this.ended;
    }

    private onVideo(f: { keyframe: boolean; codec: string; data: Buffer }): void {
        if (this.ended) {
            return;
        }
        if (!this.videoCodec) {
            if (!f.keyframe) {
                return; // begin at a decodable frame
            }
            if (f.codec !== 'h264' && f.codec !== 'h265') {
                this.end(`unsupported video codec ${f.codec}`);
                return;
            }
            this.videoCodec = f.codec;
            this.timerHandles.push(this.timers.set(() => this.startFfmpeg(), this.o.audioProbeMs ?? 1500));
        }
        this.write('v', f.data);
    }

    private onAudio(f: { codec: string; data: Buffer }): void {
        if (this.ended || !this.videoCodec) {
            return;
        }
        if (!this.ffmpeg && this.audioCodec === undefined && (f.codec === 'aac-lc' || f.codec === 'g711a')) {
            this.audioCodec = f.codec;
        }
        if (f.codec === this.audioCodec) {
            this.write('a', f.data);
        }
    }

    private write(kind: 'v' | 'a', data: Buffer): void {
        if (!this.ffmpeg) {
            this.pending.push({ kind, data });
            return;
        }
        const sink = kind === 'v' ? this.videoIn : this.audioIn;
        if (sink && !sink.destroyed && !sink.write(data) && kind === 'v') {
            // ffmpeg is behind: let the SDK queue (and resync at the next IDR) instead of buffering here.
            this.consumer.pause?.();
            sink.once('drain', () => this.consumer.resume?.());
        }
    }

    private startFfmpeg(): void {
        if (this.ended || this.ffmpeg || !this.videoCodec) {
            return;
        }
        const args = ffmpegArgs(this.videoCodec, this.audioCodec, this.o.target);
        this.o.log.debug(`[${this.o.stream}] ffmpeg ${args.join(' ').replace(/\/\/[^@/]*@/, '//***@')}`);
        const proc = spawn(this.o.ffmpeg, args, {
            stdio: ['pipe', 'ignore', 'pipe', ...(this.audioCodec ? (['pipe'] as const) : [])],
        });
        this.ffmpeg = proc;
        this.videoIn = proc.stdin ?? undefined;
        this.audioIn = this.audioCodec ? (proc.stdio[3] as Writable) : undefined;
        for (const s of [this.videoIn, this.audioIn]) {
            s?.on('error', () => undefined); // EPIPE when ffmpeg ends first; the exit handler reports it
        }
        let stderr = '';
        proc.stderr?.on('data', (b: Buffer) => (stderr = (stderr + b.toString()).slice(-500)));
        proc.on('error', e => this.end(`ffmpeg failed to start: ${e.message}`));
        proc.on('exit', code => this.end(`ffmpeg exited (code ${code ?? '?'})${stderr ? `: ${stderr.trim()}` : ''}`));

        const pending = this.pending;
        this.pending = [];
        for (const p of pending) {
            this.write(p.kind, p.data);
        }
        this.started = true;
        this.o.onActive();
    }

    /** Stop the stream (idempotent). */
    public stop(reason = 'stopped'): void {
        this.end(reason);
    }

    private end(reason: string): void {
        if (this.ended) {
            return;
        }
        this.ended = true;
        for (const t of this.timerHandles) {
            this.timers.clear(t);
        }
        this.pending = [];
        try {
            this.consumer.stop();
        } catch {
            // already gone
        }
        const proc = this.ffmpeg;
        if (proc && proc.exitCode === null) {
            this.videoIn?.end();
            this.audioIn?.end();
            const kill = this.timers.set(() => proc.kill('SIGKILL'), 3000);
            proc.once('exit', () => this.timers.clear(kill));
            proc.kill('SIGTERM');
        }
        this.o.onEnded(reason);
    }
}
