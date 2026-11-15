"use strict";
const path = require("node:path");
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
                this.timeout(120_000);
                const harness = getHarness();
                fs.rmSync(logFile, { force: true });
                // fresh login: drop a session persisted by an earlier run
                fs.rmSync(path.join(harness["testDir"], "iobroker-data", "eufy-next.0"), { recursive: true, force: true });
                await harness.changeAdapterConfig("eufy-next", {
                    native: { email: "test@example.invalid", password: "secret", countryCode: "de", eventResetSec: 0 },
                });
                // an object an older version generated for a write the device has no evidence for
                await harness.objects.setObjectAsync(`${P}.light.setObsolete`, {
                    type: "state",
                    common: { name: "obsolete", type: "boolean", role: "switch", read: false, write: true },
                    native: {},
                });
                await harness.startAdapter({
                    NODE_OPTIONS: `--import=${path.join(__dirname, "fixtures", "sdk-hook.mjs")}`,
                    FAKE_SDK_LOG: logFile,
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
                if ((await st(`${P}.events.lastEvent`))?.val !== "motion") throw new Error("lastEvent");

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
            });
        });
    },
});
