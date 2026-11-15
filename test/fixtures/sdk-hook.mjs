// Loaded via NODE_OPTIONS=--import in the e2e test: routes the adapter's import of the SDK to fake-sdk.mjs.
import { register } from "node:module";

register("./sdk-resolve.mjs", import.meta.url);
