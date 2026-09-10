"use client";
import { createContext, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { WorkspaceTask } from "@/domain/task-workspace";
import { TaskWorkspaceStore } from "./task-workspace-store";
import type { DraftEditorState } from "./useDraftEditors";
const Context = createContext<TaskWorkspaceStore | null>(null);
type TaskWorkspaceProviderProps = {
  children: ReactNode; actorKey?: string; enabled?: boolean; initialTasks?: WorkspaceTask[]; viewerProfileId?: string;
  onEditorStateChange?: (state: DraftEditorState | null) => void; onTasksChange?: (tasks: WorkspaceTask[]) => void;
};
export function TaskWorkspaceProvider(props: TaskWorkspaceProviderProps) {
  return <TaskWorkspaceSession key={`${props.actorKey ?? ""}:${props.viewerProfileId ?? "anonymous"}`} {...props} />;
}
function TaskWorkspaceSession({ children, actorKey, enabled = false, initialTasks, viewerProfileId, onEditorStateChange, onTasksChange }: TaskWorkspaceProviderProps) {
  const [store] = useState(() => new TaskWorkspaceStore(enabled, viewerProfileId, undefined, initialTasks));
  useLayoutEffect(() => { store.setEnabled(enabled); }, [store, enabled]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => { store.setOnTasksChange(onTasksChange); return () => { store.setOnTasksChange(undefined); }; }, [store, onTasksChange]);
  useEffect(() => { if (initialTasks) store.setTasks(initialTasks); }, [store, initialTasks]);
  useEffect(() => {
    if (!enabled) return;
    void store.refresh();
    const refresh = () => { if (document.visibilityState === "visible") { void store.refresh(); const id = store.getSnapshot().selectedId; if (id) void store.loadMessages(id); } };
    const resume = () => { if (document.visibilityState === "visible") void store.reauthorize(); };
    window.addEventListener("focus", resume); window.addEventListener("online", resume); document.addEventListener("visibilitychange", resume);
    const interval = window.setInterval(refresh, 30_000);
    let cleanupAuth: (() => void) | undefined, cleanupChannel: (() => void) | undefined;
    try {
      const client = createSupabaseBrowserClient();
      let userId: string | undefined;
      const { data } = client.auth.onAuthStateChange((event, session) => {
        if (!session || event === "SIGNED_OUT" || (userId && session.user.id !== userId)) store.clear();
        if (session?.user.id) userId = session.user.id;
      });
      cleanupAuth = () => data.subscription.unsubscribe();
      const organizationId = actorKey?.split(":")[0];
      if (organizationId) {
        const channel = client.channel(`tasks:${organizationId}`, { config: { private: true } }).on("broadcast", { event: "invalidate" }, refresh).subscribe();
        cleanupChannel = () => { void client.removeChannel(channel); };
      }
    } catch { /* Polling and resume authorization remain available without Realtime. */ }
    return () => { window.clearInterval(interval); window.removeEventListener("focus", resume); window.removeEventListener("online", resume); document.removeEventListener("visibilitychange", resume); cleanupAuth?.(); cleanupChannel?.(); };
  }, [actorKey, enabled, store]);
  useEffect(() => { if (!enabled) onEditorStateChange?.(null); else onEditorStateChange?.({ dirty: store.dirty, saving: snapshot.saving, save: store.saveAll, discard: store.discard, hasPendingChanges: () => store.dirty || store.getSnapshot().saving }); }, [enabled, store, snapshot, onEditorStateChange]);
  useEffect(() => () => onEditorStateChange?.(null), [onEditorStateChange]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useTaskWorkspace() {
  const store = useContext(Context);
  if (!store) throw new Error("TaskWorkspaceProvider is required for task workspace views.");
  return { store, snapshot: useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot) };
}
