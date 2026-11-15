// Unit tests for the manifest → ioBroker mapping. The fixture is generated LIVE from the installed SDK:
// a synthetic device bound with every capability and every param, so each read and action the SDK can
// describe is run through the mapping — a new SDK capability is covered without touching this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const m = require("../build/lib/mapping.js");
const sdk = await import("@mega-yfue/eufy-sdk");

function describeEverything() {
    const modules = Object.values(sdk.CAPABILITY_MODULES);
    const params = new Set(
        modules.flatMap((mod) => mod.properties.flatMap((p) => [p.paramType, ...(p.readAliases?.map((a) => a.paramType) ?? [])])),
    );
    const ctx = { channel: 0, codec: "camera", paramIds: params, capabilities: new Set(modules.map((x) => x.capability)) };
    const bound = sdk.buildActions(
        modules.filter((x) => x.actions || x.members).map((x) => x.capability),
        { ctx, sink: { dispatch: async () => undefined }, read: () => undefined },
    );
    return sdk.describeCapabilities(bound);
}

const details = describeEverything();
const TYPES = new Set(["boolean", "number", "string", "mixed", "json", "object", "array", "file"]);

test("SDK fixture is non-trivial", () => {
    assert.ok(details.length > 10);
    assert.ok(details.flatMap((d) => d.reads).length > 50);
});

test("every SDK read maps to a valid ioBroker state", () => {
    for (const cap of details) {
        for (const r of cap.reads) {
            const { common, codec } = m.readCommon(r);
            const where = `${cap.accessor}.${r.accessor} (${r.type}/${r.kind})`;
            assert.ok(TYPES.has(common.type), `${where}: type ${common.type}`);
            assert.ok(common.role && typeof common.role === "string", `${where}: role`);
            assert.equal(common.read, true, where);
            assert.equal(common.write, r.writable, where);
            if (common.type === "boolean") assert.equal(common.states, undefined, `${where}: boolean with states`);
            if (r.kind === "timestamp") assert.equal(codec, "timestamp", where);
            if (r.kind === "percent") assert.equal(common.unit, "%", where);
            if (common.states && common.type === "number") {
                for (const k of Object.keys(common.states)) assert.ok(!Number.isNaN(Number(k)), `${where}: state key ${k}`);
            }
            assert.match(m.sanitizeId(r.accessor), /^[A-Za-z0-9_-]+$/, where);
        }
    }
});

test("every SDK action gets a plan; stateful single-arg actions bind to their read", () => {
    for (const cap of details) {
        for (const a of cap.actions) {
            const p = m.planAction(cap, a);
            const where = `${cap.accessor}.${a.name}`;
            if (!a.args) {
                assert.equal(p.kind, "skip", where);
                continue;
            }
            if (a.form === "stateful" && a.reflects && a.args.length === 1 && cap.reads.some((r) => r.accessor === a.reflects)) {
                assert.equal(p.kind, "bindRead", where);
                assert.equal(p.readAccessor, a.reflects);
            } else {
                assert.notEqual(p.kind, "skip", where);
                assert.equal(p.common.write, true, where);
                assert.ok(TYPES.has(p.common.type), `${where}: ${p.common.type}`);
            }
        }
    }
});

test("light: isOn is a switch driven by light.set, brightness a dimmer", () => {
    const light = details.find((d) => d.accessor === "light");
    assert.ok(light);
    const set = light.actions.find((a) => a.name === "set");
    assert.deepEqual(m.planAction(light, set), { kind: "bindRead", action: set, readAccessor: "isOn" });
    const brightness = light.reads.find((r) => r.accessor === "brightness");
    const { common } = m.readCommon(brightness);
    assert.equal(common.type, "number");
    assert.equal(common.unit, "%");
});

test("lock.lock is a button", () => {
    const lock = details.find((d) => d.accessor === "lock");
    const p = m.planAction(lock, lock.actions.find((a) => a.name === "lock"));
    assert.equal(p.kind, "button");
    assert.equal(p.common.role, "button");
});

test("value conversion", () => {
    assert.equal(m.toStateValue(1700000000, "timestamp", "number"), 1700000000000);
    assert.equal(m.fromStateValue(1700000000000, "timestamp", "number"), 1700000000);
    assert.equal(m.toStateValue("42", "raw", "number"), 42);
    assert.equal(m.toStateValue(1, "raw", "boolean"), true);
    assert.equal(m.toStateValue({ a: 1 }, "json", "mixed"), '{"a":1}');
    assert.equal(m.toStateValue(undefined, "raw", "number"), null);
    assert.equal(m.fromStateValue("7", "raw", "number"), 7);
    assert.equal(m.fromStateValue("true", "raw", "boolean"), true);
});

test("JSON arguments: array and object form", () => {
    const args = [{ name: "x", kind: "scalar" }, { name: "y", kind: "scalar", optional: true }];
    assert.deepEqual(m.parseJsonArgs("[1,2]", args), [1, 2]);
    assert.deepEqual(m.parseJsonArgs('{"x":3}', args), [3]);
    assert.deepEqual(m.parseJsonArgs('{"y":4,"x":3}', args), [3, 4]);
});

test("sanitizeId and humanize", () => {
    assert.equal(m.sanitizeId("T8410.ABC 1"), "T8410_ABC_1");
    assert.equal(m.humanize("batteryTemperature"), "Battery temperature");
    assert.equal(m.humanize("smart_light"), "Smart light");
});
