import "server-only";
import { randomBytes } from "node:crypto";
import { canUseMapsIntegration, TEST_APP_ORIGIN } from "@/lib/app-environment";
import { isUuid } from "@/lib/telephony/uuid";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";
import { mobileEnvironment } from "./auth";
import { getMobileCase } from "./cases";
import { runMobileMapPicker, type MapPickerConfiguration } from "./map-picker-script";
import { parseMobileMapPreview } from "@/lib/mobile-map-preview";

export async function mobileMapPicker(request: Request, actor: MotoristActor): Promise<Response> {
  const url = new URL(request.url),
    environment = mobileEnvironment();
  const canonical = environment === "test" ? TEST_APP_ORIGIN : "https://dispecing.linkapomoci.sk";
  if (url.origin !== canonical || url.username || url.password || url.hash) throw new MutationError("Mapa vyžaduje správnu adresu aplikácie.", 400);
  if (request.headers.get("x-pm-expected-organization")?.toLowerCase() !== actor.organizationId.toLowerCase()) {
    throw new MutationError("Pred mapou overte organizáciu účtu.", 409, "expected_organization_mismatch");
  }
  const mode = request.headers.get("x-pm-map-mode"),
    target = request.headers.get("x-pm-map-target"),
    nonce = request.headers.get("x-pm-map-nonce");
  if (mode !== "view" && mode !== "pick"
    || target !== "pickup" && target !== "destination"
    || !isUuid(nonce)) {
    throw new MutationError("Neplatná požiadavka mapy.", 400);
  }
  for (const key of url.searchParams.keys()) {
    if (key !== "caseId" || url.searchParams.getAll(key).length !== 1) throw new MutationError("Neplatná požiadavka mapy.", 400);
  }
  const caseId = url.searchParams.get("caseId");
  if (caseId !== null && !isUuid(caseId)) throw new MutationError("Neplatný prípad mapy.", 400);
  if (!canUseMapsIntegration()) throw new MutationError("Mapa nie je v tomto prostredí dostupná.", 503, "mobile_maps_unavailable");
  const browserKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY?.trim();
  if (!browserKey || !/^[A-Za-z0-9_-]{10,200}$/.test(browserKey) || browserKey.startsWith("replace-with")) {
    throw new MutationError("Mapová služba nie je dostupná.", 503, "mobile_maps_unavailable");
  }
  const detail = caseId ? await getMobileCase(actor, caseId, request.signal) : null;
  const mapId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID?.trim() || "DEMO_MAP_ID";
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(mapId)) throw new MutationError("Mapová služba nie je dostupná.", 503, "mobile_maps_unavailable");
  const configuration: MapPickerConfiguration = {
    version: 1, nonce, mode, target, environment, profileId: actor.profileId,
    organizationId: actor.organizationId, caseId, browserKey, mapId,
    map: detail?.map ?? { pickup: null, destination: null, clientLocation: null }
  };
  const scriptNonce = randomBytes(24).toString("base64");
  const serialized = JSON.stringify(configuration).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const html = `<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><title>Mapa prípadu</title>
<style nonce="${scriptNonce}">html,body{height:100%;margin:0;font:16px system-ui;color:#18181b;background:#fafafa}body{display:flex;flex-direction:column}#map{flex:1;min-height:160px}#tools{padding:12px;display:${mode === "pick" ? "grid" : "none"};gap:8px}#search>*,input,button{box-sizing:border-box;width:100%;min-height:44px;font:inherit}input{padding:8px;border:1px solid #a1a1aa;border-radius:8px}button{padding:10px;background:#18181b;color:#FCD703;border:0;border-radius:8px}button:disabled{background:#71717a;color:#fff}#status{padding:10px 12px;margin:0;font-size:14px}label{font-size:14px}.pin{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;border:2px solid #18181b;background:#FCD703;color:#18181b;font:bold 16px system-ui}</style></head>
<body><div id="tools"><div id="search"></div><label for="address">Adresa vybraného bodu</label><input id="address" maxlength="500" autocomplete="off"><button id="confirm" disabled>Potvrdiť výber do formulára</button></div><p id="status" role="status">Pripravujem mapu…</p><div id="map" aria-label="Mapa prípadu"></div>
<script nonce="${scriptNonce}">(${runMobileMapPicker.toString()})(${serialized}, ${parseMobileMapPreview.toString()});</script></body></html>`;
  return new Response(html, { headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    Vary: "Authorization, X-PM-App-Environment, X-PM-Expected-Organization, X-PM-Map-Mode, X-PM-Map-Target, X-PM-Map-Nonce",
    "Referrer-Policy": "strict-origin", "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
    "Content-Security-Policy": `default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'nonce-${scriptNonce}' 'unsafe-eval' https://maps.googleapis.com https://maps.gstatic.com blob:; style-src 'nonce-${scriptNonce}' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com; connect-src https://*.googleapis.com https://*.gstatic.com https://*.google.com data: blob:; worker-src blob:; frame-src https://*.google.com`,
  } });
}
