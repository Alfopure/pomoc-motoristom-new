import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MobileBranchCommand, MobileOperationCommand, MobileTowingCommand } from "../../../src/lib/mobile-api";
import { MobileApiError, type MobileTransport } from "../lib/api";
import type { MobileConfig } from "../lib/config";
import { createDeliveryCommandStorage } from "../delivery/command-storage";
import { phoneLocation } from "../delivery/location";
import { canUseDeliveryCache } from "../delivery/model";
import { createOperationSharing } from "../delivery/native-sharing";
import type { DeliverySession } from "../delivery/session";
import type { LocationSharing, SharingState } from "../delivery/sharing";
import { DeliveryTracker } from "../delivery/tracker";
import type { FieldModules } from "../shell/modules";
import { createFieldWorkApi, type BranchSnapshot, type FieldWorkApi, type FieldWorkList } from "./api";
import { WorkCommands, type WorkIntent } from "./commands";
import { trackedOperation, towingMultipart } from "./model";
import { createUploadFiles } from "./upload-files";
import { TowingUploads, towingUploadsKey } from "./uploads";

/** Moja práca and Pobočka of the signed-in field member, for as long as the account:
 * the work list, the stored steps and towing uploads, and the position during an
 * accepted jazda (in the native app also in the background, otherwise while the app is
 * open). Built on the verified field identity of the delivery session. */
export type FieldWorkSession = {
  api: FieldWorkApi; key: readonly string[]; memberId: string; modules: FieldModules; capabilities: readonly string[];
  list: UseQueryResult<FieldWorkList>; commands: WorkCommands;
  /** Unfinished towing uploads; null without Moja práca. */
  uploads: TowingUploads | null;
  /** The position sharing the screens show and control. */
  tracker: LocationSharing;
  /** Logout: the background secret is revoked and nothing more is sent. */
  forget: () => Promise<void>;
  /** Pobočka's open requests (queue and running work); also for the bar badge. */
  branch: UseQueryResult<BranchSnapshot>;
};

const nativeUpload = async (): Promise<MobileTransport> => {
  try { return (await import("expo/fetch")).fetch as MobileTransport; }
  catch { throw new MobileApiError("Nahrávanie súborov v tejto zostave nie je dostupné. Použite aktuálnu aplikáciu.", 400, "mobile_upload_unavailable"); }
};
const OFF: SharingState = { status: "off", lastSentAt: null, background: null };
const quiet = () => () => undefined, off = () => OFF;

export function useFieldWork({ delivery, config, client, userId, liveUser, active, writable }: {
  delivery: DeliverySession; config: MobileConfig; client: SupabaseClient; userId: string; liveUser: () => string | null; active: boolean; writable: boolean;
}): FieldWorkSession | null {
  const memberId = delivery.memberId;
  const { work, branch } = delivery.modules;
  const api = useMemo(() => memberId ? createFieldWorkApi(config, memberId, async () => {
    if (liveUser() !== userId) throw new MobileApiError("Prihlásenie sa zmenilo. Otvorte svoj účet znova.", 401);
    const { data } = await client.auth.getSession();
    return liveUser() === userId && data.session?.user.id === userId ? data.session.access_token : null;
  }, fetch, nativeUpload, () => liveUser() === userId) : null, [config, client, userId, liveUser, memberId]);
  const key = delivery.key;
  const list = useQuery({ queryKey: [...key, "work", memberId], enabled: Boolean(api) && work, queryFn: ({ signal }) => api!.work(signal),
    refetchInterval: active ? 30_000 : false });
  const branchList = useQuery({ queryKey: [...key, "branch", "open", memberId], enabled: Boolean(api) && branch, queryFn: ({ signal }) => api!.branch("open", signal),
    refetchInterval: active ? 30_000 : false });
  const scope = useMemo(() => memberId ? { environment: config.environment, apiOrigin: config.apiOrigin, projectUrl: config.supabaseUrl, userId, memberId } : null,
    [config, userId, memberId]);
  const commands = useMemo(() => api && scope && (work || branch) ? new WorkCommands(createDeliveryCommandStorage(), scope,
    (intent: WorkIntent) => intent.target.kind === "operation" ? api.operationCommand(intent.target.id, intent.command as MobileOperationCommand)
      : intent.target.kind === "towing" ? api.towingCommand(intent.target.id, intent.command as MobileTowingCommand)
        : api.branchCommand(intent.command as MobileBranchCommand), { current: () => liveUser() === userId }) : null,
  [api, scope, work, branch, liveUser, userId]);
  useLayoutEffect(() => { commands?.setActive(writable); return () => { commands?.setActive(false); }; }, [commands, writable]);
  useEffect(() => { if (commands && writable) void commands.load(); }, [commands, writable]);
  useEffect(() => () => commands?.dispose(), [commands]);
  // Towing photos and scans: the same ids and bytes until the server confirms them.
  const uploads = useMemo(() => api && scope && work ? new TowingUploads(createDeliveryCommandStorage(), createUploadFiles(towingUploadsKey(scope)), scope, async (upload, bytes) => {
    const form = towingMultipart(upload, { bytes, mimeType: upload.mimeType, name: upload.fileName }, "pm" + upload.commandId.replace(/-/g, ""));
    const receipt = await api.towingAttachment(upload.orderId, form, upload.commandId);
    if (receipt.attachmentId !== upload.attachmentId) throw new MobileApiError("Odpoveď sa nepodarilo overiť. Pokračujte v tom istom nahrávaní.", 502);
  }, { current: () => liveUser() === userId }) : null, [api, scope, work, liveUser, userId]);
  useLayoutEffect(() => { uploads?.setActive(writable); return () => { uploads?.setActive(false); }; }, [uploads, writable]);
  useEffect(() => { if (uploads && writable) void uploads.load(); }, [uploads, writable]);
  useEffect(() => () => uploads?.dispose(), [uploads]);
  // The native app sends the jazda's position also in the background, with a secret of
  // the one operation. Elsewhere, and whenever that cannot start (e.g. a server without
  // background secrets yet), the open app sends as before.
  const background = useMemo(() => api ? createOperationSharing({ issue: operationId => api.operationTracker(operationId), revoke: operationId => api.operationUntrack(operationId) }, config) : null,
    [api, config]);
  useEffect(() => () => background?.dispose(), [background]);
  const backgroundState = useSyncExternalStore(background?.subscribe ?? quiet, background?.snapshot ?? off, background?.snapshot ?? off);
  const foreground = useMemo(() => new DeliveryTracker(phoneLocation, async (operationId, position) => {
    if (!api) return false;
    try { return (await api.operationPosition(operationId, position)).active; }
    // Work that is gone, access lost or positions not switched on here: stop sending.
    catch (error) { if (error instanceof MobileApiError && ([403, 404].includes(error.status) || error.code === "work_position_unavailable")) return false; throw error; }
  }), [api]);
  useEffect(() => () => foreground.dispose(), [foreground]);
  useEffect(() => { background?.setMember(memberId); }, [background, memberId]);
  // Sharing left by another account on this phone stops.
  useEffect(() => { if (background && memberId) void background.reconcile(memberId); }, [background, memberId]);
  // Until the list loads nothing changes, so a running background sending survives the start;
  // an answer whose jazdy failed to load just now is not "no jazda" either.
  const target = !work || !api || !canUseDeliveryCache(list.error) ? null
    : list.data === undefined || list.data.unavailable.includes("operations") ? undefined : trackedOperation(list.data);
  const checked = list.dataUpdatedAt;
  const fallback = !background || backgroundState.status === "error";
  useEffect(() => { if (background && target !== undefined) void background.follow(target); }, [background, target, checked]);
  useEffect(() => { void foreground.follow(fallback && active && target ? target : null); }, [foreground, fallback, active, target, checked]);
  if (!api || !memberId || !commands) return null;
  const tracker = background && !fallback ? background : foreground;
  return { api, key, memberId, modules: delivery.modules, capabilities: delivery.me.data?.capabilities ?? [], list, commands, uploads, tracker,
    forget: async () => { await foreground.forget(); await background?.forget(); }, branch: branchList };
}
