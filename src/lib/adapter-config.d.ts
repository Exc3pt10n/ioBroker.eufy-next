// Augments the ioBroker adapter config with this adapter's native settings (see admin/jsonConfig.json).
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            email: string;
            password: string;
            countryCode: string;
            openudid: string;
            pollIntervalMin: number;
            cacheTtlSec: number;
            eventResetSec: number;
            saveSnapshots: boolean;
            ffmpegPath: string;
            excludeDevices: string;
            sdkDebug: boolean;
            liveEnabled: boolean;
            liveHostname: string;
            liveApiPort: number;
            liveRtspPort: number;
            liveWebrtcPort: number;
            liveMaxDurationSec: number;
            liveRtspUsername: string;
            liveRtspPassword: string;
            liveSnapshot: boolean;
            liveHttps: boolean;
            liveCertPublic: string;
            liveCertPrivate: string;
            verifyMethod: 'email' | 'sms';
            snapshotDataUrl: boolean;
        }
    }
}

export {};
