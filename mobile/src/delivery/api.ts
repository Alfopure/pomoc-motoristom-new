import type { MobileDelivery, MobileDeliveryCommand, MobileDeliveryPositionInput, MobileFieldMe } from "../../../src/lib/mobile-api";
import { MobileApiError, type MobileTransport } from "../lib/api";
import type { MobileConfig } from "../lib/config";
import { parseSnapshot } from "../handoff/api";

/** The pristavovač's side of the dispatch server: own deliveries, steps and position. */
const invalid = () => new MobileApiError("Odpoveď sa nepodarilo overiť. Obnovte údaje.", 502);
const id = (v: unknown): v is string => typeof v === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
const date = (v: unknown): v is string => text(v, 64) && Number.isFinite(Date.parse(v));
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= 2_147_483_647;
const STATES = ["offered", "accepted", "en_route", "arrived", "completed", "rejected", "cancelled", "expired"];
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid();
  return v as Record<string, unknown>;
}

export function parseDelivery(value: unknown): MobileDelivery {
  const v = object(value);
  if (!id(v.id) || !STATES.includes(v.status as string) || !integer(v.revision) || !integer(v.publishedVersion) || !text(v.caseNumber, 160)
    || !date(v.expiresAt) || !date(v.createdAt) || !(v.openedAt === null || date(v.openedAt)) || !(v.eta === null || date(v.eta))
    || !(v.createdBy === null || text(v.createdBy, 320)) || !Array.isArray(v.events) || v.events.length > 200 || typeof v.tracking !== "boolean") throw invalid();
  const events = v.events.map(item => {
    const e = object(item);
    if (!id(e.id) || !text(e.action, 40) || !text(e.comment, 1000) || !text(e.actor, 320) || !date(e.createdAt)) throw invalid();
    return { id: e.id, action: e.action, comment: e.comment, actor: e.actor, createdAt: e.createdAt };
  });
  let position: MobileDelivery["replacementPosition"] = null;
  if (v.replacementPosition !== null && v.replacementPosition !== undefined) {
    const p = object(v.replacementPosition);
    if (typeof p.lat !== "number" || typeof p.lng !== "number" || !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180 || !date(p.recordedAt)) throw invalid();
    position = { lat: p.lat, lng: p.lng, recordedAt: p.recordedAt };
  }
  return {
    id: v.id.toLowerCase(), status: v.status as MobileDelivery["status"], revision: v.revision, publishedVersion: v.publishedVersion, caseNumber: v.caseNumber,
    expiresAt: v.expiresAt, createdAt: v.createdAt, openedAt: v.openedAt as string | null, eta: v.eta as string | null, createdBy: v.createdBy as string | null,
    card: v.card === null ? null : parseSnapshot(v.card), events, replacementPosition: position, tracking: v.tracking,
  };
}

export type DeliveryApi = ReturnType<typeof createDeliveryApi>;
export function createDeliveryApi(config: MobileConfig, getToken: () => Promise<string | null>, transport: MobileTransport = fetch) {
  let memberId: string | null = null;
  async function request(path: string, init: { method: "GET" | "POST"; body?: unknown; signal?: AbortSignal; timeout?: number }): Promise<Record<string, unknown>> {
    const token = await getToken();
    if (!token) throw new MobileApiError("Prihlásenie vypršalo. Prihláste sa znova.", 401);
    const controller = new AbortController(), abort = () => controller.abort();
    if (init.signal?.aborted) abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, init.timeout ?? 15_000);
    try {
      const response = await transport(config.apiOrigin + "/api/mobile/v1/field/" + path, {
        method: init.method, credentials: "omit", signal: controller.signal, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": config.environment, Accept: "application/json", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      });
      let body: unknown;
      try { body = await response.json(); } catch { throw invalid(); }
      const record = object(body);
      if (!response.ok) {
        throw new MobileApiError(text(record.error, 1000) ? record.error : "Pristavenia sa nepodarilo načítať.", response.status, typeof record.code === "string" ? record.code : undefined);
      }
      if (record.ok !== true || record.apiVersion !== 1 || record.environment !== config.environment || !id(record.memberId) || memberId && record.memberId !== memberId) throw invalid();
      return record;
    } catch (error) {
      if (error instanceof MobileApiError || init.signal?.aborted) throw error;
      throw new MobileApiError("Nepodarilo sa spojiť s aplikáciou. Skontrolujte pripojenie a skúste znova.", 0);
    } finally { clearTimeout(timer); init.signal?.removeEventListener("abort", abort); }
  }
  return {
    me: async (signal?: AbortSignal): Promise<MobileFieldMe> => {
      const body = await request("me", { method: "GET", signal });
      const member = object(body.member);
      if (!id(member.id) || member.id !== body.memberId || !text(member.displayName, 160) || !(member.email === null || text(member.email, 320))) throw invalid();
      memberId = body.memberId as string;
      return body as MobileFieldMe;
    },
    list: async (signal?: AbortSignal): Promise<MobileDelivery[]> => {
      const body = await request("deliveries", { method: "GET", signal });
      if (!Array.isArray(body.deliveries) || body.deliveries.length > 100) throw invalid();
      return body.deliveries.map(parseDelivery);
    },
    read: async (deliveryId: string, signal?: AbortSignal): Promise<MobileDelivery> => {
      if (!id(deliveryId)) throw new MobileApiError("Pristavenie sa nenašlo.", 404);
      const delivery = parseDelivery((await request("deliveries/" + deliveryId, { method: "GET", signal })).delivery);
      if (delivery.id !== deliveryId.toLowerCase()) throw invalid();
      return delivery;
    },
    command: async (deliveryId: string, input: MobileDeliveryCommand): Promise<MobileDelivery> => {
      const body = await request("deliveries/" + deliveryId + "/commands", { method: "POST", body: input });
      const delivery = parseDelivery(body.delivery);
      if (delivery.id !== deliveryId.toLowerCase() || body.commandId !== input.commandId || !integer(body.committedRevision)) throw invalid();
      return delivery;
    },
    /** Whether it was kept, and whether the delivery still takes this pristavovač's position. */
    position: async (deliveryId: string, input: MobileDeliveryPositionInput): Promise<{ stored: boolean; active: boolean }> => {
      const body = await request("deliveries/" + deliveryId + "/position", { method: "POST", body: input, timeout: 10_000 });
      if (typeof body.stored !== "boolean" || typeof body.active !== "boolean") throw invalid();
      return { stored: body.stored, active: body.active };
    },
  };
}
