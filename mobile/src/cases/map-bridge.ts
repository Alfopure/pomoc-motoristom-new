import type { MobileCasePlaceSelection } from "../../../src/lib/mobile-api";
import { draftId, draftKeys, draftObject } from "../drafts/port";
import { locationText, placeSelection } from "./location";
export type MapIdentity = { version: 1; nonce: string; mode: "view" | "pick"; target: "pickup" | "destination"; environment: "test" | "production"; profileId: string; organizationId: string; caseId: string | null };
export type MapRequest = Pick<MapIdentity, "mode" | "target" | "nonce" | "caseId">;
export type MapSource = { uri: string; headers: Record<string, string>; identity: MapIdentity };
export type MapSeed = { selection: MobileCasePlaceSelection | null; address: string };
export const mapOriginWhitelist = ["*"]; // WebView otherwise launches rejected whitelist URLs through Linking before our guard.
export function allowsMapNavigation(url: string, expected: string) { return url === expected; }
export class MapBridge {
  private ready = false;
  private closed = false;
  constructor(readonly source: MapSource, private seed: MapSeed) {
    if (!draftId(source.identity.nonce) || !locationText(seed.address, 500, true)) throw new Error("Neplatné miesto mapy.");
    this.seed = { address: seed.address, selection: seed.selection === null ? null : placeSelection(seed.selection) };
  }
  receive(url: string, data: string): { seed?: string; selection?: MobileCasePlaceSelection; error?: string } | null {
    if (this.closed || !allowsMapNavigation(url, this.source.uri) || data.length > 12000) return null;
    try {
      const v = draftObject(JSON.parse(data)), identity = this.source.identity;
      const type = v.type;
      if (!["ready", "candidate", "error"].includes(type as string)) return null;
      draftKeys(v, [...Object.keys(identity), "type", ...(type === "candidate" ? ["selection"] : type === "error" ? ["message"] : [])]);
      if (Object.entries(identity).some(([key, value]) => v[key] !== value)) return null;
      if (type === "ready") {
        if (this.ready) return null;
        this.ready = true;
        return { seed: JSON.stringify({ ...identity, type: "seed", ...this.seed }) };
      }
      if (!this.ready) return null;
      if (type === "error") return locationText(v.message, 500) ? { error: v.message } : null;
      if (identity.mode !== "pick") return null;
      return { selection: placeSelection(v.selection) };
    } catch { return null; }
  }
  isOpen() { return !this.closed; }
  close() { this.closed = true; }
}
