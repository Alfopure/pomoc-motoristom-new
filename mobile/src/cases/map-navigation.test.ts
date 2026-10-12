import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { allowsMapNavigation, mapOriginWhitelist } from "./map-bridge";

// Execute installed CommonJS source with only native UI imports adapted, avoiding RN Flow in Node.
const installed = createRequire(import.meta.url);
type Request = { url: string; lockIdentifier: number };
type Factory = (load: (allow: boolean, url: string, lock: number) => void, origins: string[], guard: (request: Request) => boolean) => (event: { nativeEvent: Request }) => void;
describe("installed WebView external-navigation boundary", () => {
  it("our all-origins callback path blocks foreign/custom URLs without Linking side effects", async () => {
    const native = { canOpenURL: vi.fn(async () => true), openURL: vi.fn() }, exports: { createOnShouldStartLoadWithRequest?: Factory } = {};
    const code = readFileSync(installed.resolve("react-native-webview/lib/WebViewShared"), "utf8");
    new Function("require", "exports", code)((name: string) => name === "react-native" ? { Linking: native } : name === "./WebView.styles" ? {} : installed(name), exports);
    const expected = "https://test.dispecing.linkapomoci.sk/api/mobile/v1/maps/picker", load = vi.fn();
    const handler = exports.createOnShouldStartLoadWithRequest!(load, mapOriginWhitelist, request => allowsMapNavigation(request.url, expected));
    for (const url of ["tel:900", "https://foreign.invalid", expected + "?other=1", "about:blank"]) handler({ nativeEvent: { url, lockIdentifier: 1 } });
    await Promise.resolve(); expect(load.mock.calls.every(call => call[0] === false)).toBe(true); expect(native.canOpenURL).not.toHaveBeenCalled(); expect(native.openURL).not.toHaveBeenCalled();
    handler({ nativeEvent: { url: expected, lockIdentifier: 2 } }); expect(load).toHaveBeenLastCalledWith(true, expected, 2);
  });
});
