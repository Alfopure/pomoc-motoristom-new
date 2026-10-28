import { useEffect, useLayoutEffect, useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MobileBranchCommand, MobileOperationCommand, MobileTowingCommand } from "../../../src/lib/mobile-api";
import { MobileApiError, type MobileTransport } from "../lib/api";
import type { MobileConfig } from "../lib/config";
import { createDeliveryCommandStorage } from "../delivery/command-storage";
import { phoneLocation } from "../delivery/location";
import { canUseDeliveryCache } from "../delivery/model";
import type { DeliverySession } from "../delivery/session";
import type { LocationSharing } from "../delivery/sharing";
import { DeliveryTracker } from "../delivery/tracker";
import type { FieldModules } from "../shell/modules";
import { createFieldWorkApi, type BranchSnapshot, type FieldWorkApi, type FieldWorkList } from "./api";
import { WorkCommands, type WorkIntent } from "./commands";
import { trackedOperation } from "./model";

/** Moja práca and Pobočka of the signed-in field member, for as long as the account:
 * the work list, the stored steps and the position during an accepted jazda (while
 * the app is open). Built on the verified field identity of the delivery session. */
export type FieldWorkSession = {
  api: FieldWorkApi; key: readonly string[]; memberId: string; modules: FieldModules; capabilities: readonly string[];
  list: UseQueryResult<FieldWorkList>; commands: WorkCommands; tracker: LocationSharing;
  /** Pobočka's open requests (queue and running work); also for the bar badge. */
  branch: UseQueryResult<BranchSnapshot>;
};

const nativeUpload = async (): Promise<MobileTransport> => {
  try { return (await import("expo/fetch")).fetch as MobileTransport; }
  catch { throw new MobileApiError("Nahrávanie súborov v tejto zostave nie je dostupné. Použite aktuálnu aplikáciu.", 400, "mobile_upload_unavailable"); }
};

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
  const commands = useMemo(() => api && memberId && (work || branch) ? new WorkCommands(createDeliveryCommandStorage(), {
    environment: config.environment, apiOrigin: config.apiOrigin, projectUrl: config.supabaseUrl, userId, memberId,
  }, (intent: WorkIntent) => intent.target.kind === "operation" ? api.operationCommand(intent.target.id, intent.command as MobileOperationCommand)
    : intent.target.kind === "towing" ? api.towingCommand(intent.target.id, intent.command as MobileTowingCommand)
      : api.branchCommand(intent.command as MobileBranchCommand), { current: () => liveUser() === userId }) : null,
  [api, config, userId, memberId, work, branch, liveUser]);
  useLayoutEffect(() => { commands?.setActive(writable); return () => { commands?.setActive(false); }; }, [commands, writable]);
  useEffect(() => { if (commands && writable) void commands.load(); }, [commands, writable]);
  useEffect(() => () => commands?.dispose(), [commands]);
  // Only while the app is open: the jazda's position has no background secret (yet).
  const tracker = useMemo(() => new DeliveryTracker(phoneLocation, async (operationId, position) => {
    if (!api) return false;
    try { return (await api.operationPosition(operationId, position)).active; }
    // Work that is gone, access lost or positions not switched on here: stop sending.
    catch (error) { if (error instanceof MobileApiError && ([403, 404].includes(error.status) || error.code === "work_position_unavailable")) return false; throw error; }
  }), [api]);
  useEffect(() => () => tracker.dispose(), [tracker]);
  const target = work && api && canUseDeliveryCache(list.error) ? trackedOperation(list.data) : null;
  const checked = list.dataUpdatedAt;
  useEffect(() => { void tracker.follow(active ? target : null); }, [tracker, active, target, checked]);
  if (!api || !memberId || !commands) return null;
  return { api, key, memberId, modules: delivery.modules, capabilities: delivery.me.data?.capabilities ?? [], list, commands, tracker, branch: branchList };
}
