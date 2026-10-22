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
export function createDeliveryApi(config: MobileConfig, getToken: () => Promise<string | null>, transport: MobileTransport = fetch, current: () => boolean = () => true,
  access?: { ticket: () => number; failed: (error: MobileApiError) => void; verified: (ticket: number) => void }) {
  let memberId: string | null = null;
  const tickets = new WeakMap<Record<string, unknown>, number>();
  function refused(error: MobileApiError): never { access?.failed(error); throw error; }
  function requireCurrent() {
    if (!current()) refused(new MobileApiError("Prihlásenie sa zmenilo. Otvorte svoj účet znova.", 401));
  }
  async function request(path: string, init: { method: "GET" | "POST" | "DELETE"; body?: unknown; signal?: AbortSignal; timeout?: number }): Promise<Record<string, unknown>> {
    requireCurrent();
    const ticket = access?.ticket();
    const token = await getToken();
    requireCurrent();
    if (!token) refused(new MobileApiError("Prihlásenie vypršalo. Prihláste sa znova.", 401));
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
      requireCurrent();
      const record = object(body);
      if (!response.ok) {
        throw new MobileApiError(text(record.error, 1000) ? record.error : "Pristavenia sa nepodarilo načítať.", response.status, typeof record.code === "string" ? record.code : undefined);
      }
      if (record.ok !== true || record.apiVersion !== 1 || record.environment !== config.environment || !id(record.memberId) || memberId && record.memberId !== memberId) throw invalid();
      if (ticket !== undefined) tickets.set(record, ticket);
      return record;
    } catch (error) {
      if (error instanceof MobileApiError) refused(error);
      if (init.signal?.aborted) throw error;
      throw new MobileApiError("Nepodarilo sa spojiť s aplikáciou. Skontrolujte pripojenie a skúste znova.", 0);
    } finally { clearTimeout(timer); init.signal?.removeEventListener("abort", abort); }
  }
  return {
    me: async (signal?: AbortSignal): Promise<MobileFieldMe> => {
      const body = await request("me", { method: "GET", signal });
      const member = object(body.member);
      if (!id(member.id) || member.id !== body.memberId || !text(member.displayName, 160) || !(member.email === null || text(member.email, 320))) throw invalid();
      memberId = body.memberId as string;
      access?.verified(tickets.get(body) ?? -1);
      return body as MobileFieldMe;
    },
    list: async (signal?: AbortSignal): Promise<MobileDelivery[]> => {
      const body = await request("deliveries", { method: "GET", signal });
      if (!Array.isArray(body.deliveries) || body.deliveries.length > 100) throw invalid();
      const deliveries = body.deliveries.map(parseDelivery);
      access?.verified(tickets.get(body) ?? -1);
      return deliveries;
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
      if (delivery.id !== deliveryId.toLowerCase() || body.commandId !== input.commandId || !integer(body.committedRevision)
        || body.committedRevision !== input.expectedRevision + 1 || delivery.revision < body.committedRevision) throw invalid();
      return delivery;
    },
    /** The secret for sending this delivery's position in the background; kept only in the Keychain. */
    tracker: async (deliveryId: string): Promise<{ token: string; expiresAt: string }> => {
      if (!id(deliveryId)) throw new MobileApiError("Pristavenie sa nenašlo.", 404);
      const body = await request("deliveries/" + deliveryId + "/tracker", { method: "POST" });
      if (typeof body.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.token) || !date(body.expiresAt)) throw invalid();
      return { token: body.token, expiresAt: body.expiresAt };
    },
    untrack: async (deliveryId: string): Promise<void> => {
      if (!id(deliveryId)) return;
      await request("deliveries/" + deliveryId + "/tracker", { method: "DELETE", timeout: 4_000 });
    },
    /** Whether it was kept, and whether the delivery still takes this pristavovač's position. */
    position: async (deliveryId: string, input: MobileDeliveryPositionInput): Promise<{ stored: boolean; active: boolean }> => {
      const body = await request("deliveries/" + deliveryId + "/position", { method: "POST", body: input, timeout: 10_000 });
      if (typeof body.stored !== "boolean" || typeof body.active !== "boolean") throw invalid();
      return { stored: body.stored, active: body.active };
    },
  };
}
