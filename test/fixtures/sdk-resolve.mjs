export async function resolve(specifier, context, next) {
    if (specifier === "@mega-yfue/eufy-sdk" && !context.parentURL?.endsWith("/fake-sdk.mjs")) {
        return { url: new URL("./fake-sdk.mjs", import.meta.url).href, shortCircuit: true };
    }
    return next(specifier, context);
}
