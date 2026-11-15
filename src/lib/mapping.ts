/**
 * Pure translation of the eufy-sdk device manifest (`dev.describe()`) into ioBroker object definitions.
 *
 * The SDK publishes what each read MEANS (`kind`, `unit`, `values`/`labels`) and what each action accepts
 * (`args`). This module is the one small table from that vocabulary to ioBroker's (`type`, `role`, `unit`,
 * `states`), so a capability added to the SDK shows up in ioBroker without a change here.
 *
 * The interfaces below are structural copies of the manifest shapes the SDK exports, kept local so this file
 * has no runtime dependency on the (ESM-only) SDK and can be unit-tested on its own.
 */

/** Structural copy of the SDK's `ReadDescriptor`. */
export interface ReadDescriptorLike {
    accessor: string;
    property: string;
    type: "bool" | "number" | "string" | "enum" | string;
    kind?: string;
    unit?: string;
    values?: readonly (string | number)[];
    labels?: Readonly<Record<string, string>>;
    writable: boolean;
    description?: string;
}

/** Structural copy of the SDK's `ActionArgSpec`. */
export interface ActionArgLike {
    name: string;
    kind: string;
    optional?: boolean;
    min?: number;
    max?: number;
    step?: number;
    values?: readonly (string | number)[];
    labels?: Readonly<Record<string, string>>;
    description?: string;
}

/** Structural copy of the SDK's `ActionDescriptor`. */
export interface ActionDescriptorLike {
    name: string;
    form: "momentary" | "stateful";
    reflects?: string;
    args?: readonly ActionArgLike[];
    description?: string;
}

/** Structural copy of the SDK's `CapabilityDescriptor`. */
export interface CapabilityDescriptorLike {
    capability: string;
    accessor?: string;
    reads: readonly ReadDescriptorLike[];
    actions: readonly ActionDescriptorLike[];
    undescribedActions: readonly string[];
    events: readonly string[];
}

/** Structural copy of the SDK's `DeviceManifest`. */
export interface DeviceManifestLike {
    sn: string;
    name: string;
    model?: string;
    modelName: string;
    codec: string;
    source: string;
    bound: boolean;
    capabilities: readonly string[];
    details: readonly CapabilityDescriptorLike[];
}

/** The ioBroker `common` fields this module decides. */
export interface StateCommon {
    name: string;
    type: ioBroker.CommonType;
    role: string;
    read: boolean;
    write: boolean;
    unit?: string;
    min?: number;
    max?: number;
    step?: number;
    states?: Record<string, string>;
    desc?: string;
}

/** How a state's value travels between ioBroker and the SDK. */
export type ValueCodec = "raw" | "timestamp" | "json";

/** Replace characters ioBroker forbids in object ids. */
export function sanitizeId(id: string): string {
    return id.replace(/[\][*,;'"`<>\\?\s.]/g, "_");
}

/** "batteryTemperature" → "Battery temperature". */
export function humanize(name: string): string {
    const spaced = name
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .toLowerCase()
        .trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Units the SDK reports per kind, used when a descriptor carries a kind but no unit. */
const KIND_UNITS: Record<string, string> = {
    percent: "%",
    celsius: "°C",
    dbm: "dBm",
    seconds: "s",
    minutes: "min",
    hours: "h",
    millimetres: "mm",
    megabytes: "MB",
    degrees: "°",
};

function enumStates(
    values: readonly (string | number)[] | undefined,
    labels: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
    if (labels && Object.keys(labels).length) {
        return { ...labels };
    }
    if (values?.length) {
        return Object.fromEntries(values.map((v) => [String(v), String(v)]));
    }
    return undefined;
}

function allNumeric(values: readonly (string | number)[] | undefined): boolean {
    return !!values?.length && values.every((v) => typeof v === "number" || /^-?\d+(\.\d+)?$/.test(String(v)));
}

/** Pick the ioBroker storage type for a kind/type pair. */
function storageType(
    type: string,
    kind: string | undefined,
    values: readonly (string | number)[] | undefined,
): ioBroker.CommonType {
    if (kind === "boolean" || type === "bool") {
        return "boolean";
    }
    if (kind === "text" || kind === "identifier") {
        return type === "number" ? "number" : "string";
    }
    if (type === "number" || kind === "timestamp" || (kind && kind in KIND_UNITS) || kind === "scalar" || kind === "bitfield") {
        return "number";
    }
    if (type === "enum" || kind === "enum") {
        return allNumeric(values) || values === undefined ? "number" : "string";
    }
    if (type === "string") {
        return "string";
    }
    return "mixed";
}

/** Read-only booleans: pick a sensor role from the name where it is unambiguous. */
function booleanSensorRole(name: string): string {
    if (name.includes("leak")) {
        return "sensor.alarm.flood";
    }
    if (name.includes("smoke")) {
        return "sensor.alarm.fire";
    }
    if (/(^|\s)co(detected|\s|$)/.test(name)) {
        return "sensor.alarm";
    }
    if (name.includes("motion")) {
        return "sensor.motion";
    }
    if (name.includes("open")) {
        return "sensor.door";
    }
    return "indicator";
}

/** Choose a role from what the value means, whether it is writable, and its property name. */
function roleFor(kind: string | undefined, type: ioBroker.CommonType, writable: boolean, property: string): string {
    const p = property.toLowerCase();
    switch (kind) {
        case "boolean":
            return writable ? "switch" : booleanSensorRole(p);
        case "percent":
            if (p.includes("battery")) {
                return writable ? "level" : "value.battery";
            }
            if (p.includes("bright")) {
                return writable ? "level.dimmer" : "value.brightness";
            }
            if (p.includes("volume")) {
                return writable ? "level.volume" : "value.volume";
            }
            return writable ? "level" : "value";
        case "celsius":
            return writable ? "level.temperature" : "value.temperature";
        case "timestamp":
            return "value.time";
        case "enum":
            return writable ? "level.mode" : "value.mode";
        case "text":
            return "text";
        case "identifier":
            return type === "number" ? "value" : "text";
        case undefined:
            break;
        default:
            if (type === "number") {
                return writable ? "level" : "value";
            }
    }
    if (type === "boolean") {
        return writable ? "switch" : "indicator";
    }
    if (type === "number") {
        return writable ? "level" : "value";
    }
    if (type === "string") {
        return "text";
    }
    return "state";
}

/** Map one manifest read to a state definition. */
export function readCommon(r: ReadDescriptorLike): { common: StateCommon; codec: ValueCodec } {
    const type = storageType(r.type, r.kind, r.values);
    const unit = r.kind === "timestamp" ? undefined : (r.unit ?? (r.kind ? KIND_UNITS[r.kind] : undefined));
    const common: StateCommon = {
        name: humanize(r.accessor),
        type,
        role: roleFor(r.kind, type, r.writable, `${r.accessor} ${r.property}`),
        read: true,
        write: r.writable,
    };
    if (unit) {
        common.unit = unit;
    }
    if (r.kind === "percent") {
        common.min = 0;
        common.max = 100;
    }
    const states = r.kind === "boolean" || type === "boolean" ? undefined : enumStates(r.values, r.labels);
    if (states && (r.kind === "enum" || r.type === "enum" || r.labels)) {
        common.states = states;
    }
    if (r.description) {
        common.desc = r.description;
    }
    return { common, codec: r.kind === "timestamp" ? "timestamp" : type === "mixed" ? "json" : "raw" };
}

/** Map one action argument to a state definition (write-only control). */
export function argCommon(name: string, a: ActionArgLike): StateCommon {
    const type = storageType(a.kind === "boolean" ? "bool" : a.values && !allNumeric(a.values) ? "string" : "number", a.kind, a.values);
    const common: StateCommon = {
        name: humanize(name),
        type: a.kind === "text" || a.kind === "identifier" ? "string" : type,
        role: roleFor(a.kind, type, true, name),
        read: false,
        write: true,
    };
    const unit = a.kind ? KIND_UNITS[a.kind] : undefined;
    if (unit) {
        common.unit = unit;
    }
    if (a.min !== undefined) {
        common.min = a.min;
    }
    if (a.max !== undefined) {
        common.max = a.max;
    }
    if (a.step !== undefined) {
        common.step = a.step;
    }
    const states = enumStates(a.values, a.labels);
    if (states && common.type !== "boolean") {
        common.states = states;
    }
    if (a.description) {
        common.desc = a.description;
    }
    return common;
}

/** What the adapter does with one described action. */
export type ActionPlan =
    /** Bind the action as the writer of an existing read state (stateful, one argument). */
    | { kind: "bindRead"; action: ActionDescriptorLike; readAccessor: string }
    /** A button: write `true` to call the action without arguments. */
    | { kind: "button"; action: ActionDescriptorLike; common: StateCommon }
    /** A single-argument control state. */
    | { kind: "single"; action: ActionDescriptorLike; common: StateCommon }
    /** A JSON control state for actions taking several arguments. */
    | { kind: "json"; action: ActionDescriptorLike; common: StateCommon }
    /** Not auto-offerable (arguments not stated by the SDK). */
    | { kind: "skip"; action: ActionDescriptorLike };

/** Decide how each action of a capability is surfaced. */
export function planAction(cap: CapabilityDescriptorLike, a: ActionDescriptorLike): ActionPlan {
    if (!a.args) {
        return { kind: "skip", action: a };
    }
    const required = a.args.filter((x) => !x.optional);
    if (a.form === "stateful" && a.reflects && a.args.length === 1 && cap.reads.some((r) => r.accessor === a.reflects)) {
        return { kind: "bindRead", action: a, readAccessor: a.reflects };
    }
    if (required.length === 0) {
        return {
            kind: "button",
            action: a,
            common: {
                name: humanize(a.name),
                type: "boolean",
                role: "button",
                read: false,
                write: true,
                desc: a.description,
            },
        };
    }
    if (a.args.length === 1) {
        const common = argCommon(a.name, a.args[0]);
        if (a.description) {
            common.desc = a.description;
        }
        return { kind: "single", action: a, common };
    }
    const sig = a.args.map((x) => `${x.name}${x.optional ? "?" : ""}: ${x.kind}`).join(", ");
    return {
        kind: "json",
        action: a,
        common: {
            name: humanize(a.name),
            type: "string",
            role: "json",
            read: false,
            write: true,
            desc: `${a.description ? `${a.description} — ` : ""}JSON array or object: (${sig})`,
        },
    };
}

/**
 * Turn the JSON written to a multi-argument action state into the positional argument list.
 * Accepts either an array (`[1, 2]`) or an object keyed by argument name (`{"x": 1, "y": 2}`).
 */
export function parseJsonArgs(raw: unknown, args: readonly ActionArgLike[]): unknown[] {
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    if (Array.isArray(parsed)) {
        return parsed;
    }
    if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const out = args.map((a) => obj[a.name]);
        while (out.length && out[out.length - 1] === undefined) {
            out.pop();
        }
        return out;
    }
    return [parsed];
}

/** Convert an SDK value into what ioBroker stores. */
export function toStateValue(value: unknown, codec: ValueCodec, type: ioBroker.CommonType): ioBroker.StateValue {
    if (value === undefined || value === null) {
        return null;
    }
    if (codec === "timestamp" && typeof value === "number") {
        // The SDK reports instants in unix seconds; ioBroker's value.time role is milliseconds.
        return value < 1e11 ? value * 1000 : value;
    }
    if (typeof value === "bigint") {
        return Number(value);
    }
    if (Buffer.isBuffer(value)) {
        return value.toString("base64");
    }
    if (typeof value === "object") {
        return JSON.stringify(value);
    }
    if (type === "boolean" && typeof value === "number") {
        return value !== 0;
    }
    if (type === "number" && typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
        return Number(value);
    }
    if (type === "string" && typeof value !== "string") {
        return String(value);
    }
    return value as ioBroker.StateValue;
}

/** Convert a value written in ioBroker into what the SDK setter takes. */
export function fromStateValue(value: ioBroker.StateValue, codec: ValueCodec, type: ioBroker.CommonType): unknown {
    if (codec === "timestamp" && typeof value === "number") {
        return Math.round(value / 1000);
    }
    if (codec === "json" && typeof value === "string") {
        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    }
    if (type === "number" && typeof value === "string" && value.trim() !== "") {
        const n = Number(value);
        return Number.isNaN(n) ? value : n;
    }
    if (type === "boolean" && typeof value !== "boolean") {
        return value === "true" || value === 1 || value === "1";
    }
    return value;
}
