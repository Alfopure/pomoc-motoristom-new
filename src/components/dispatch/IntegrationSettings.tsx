"use client";

import { useCallback, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { BellRing, BookUser, PhoneCall, Users } from "lucide-react";
import type { DispatchData } from "@/data/dispatch-types";
import type { AccessUser, AppRole, Branch, PartnerDirectoryEntry } from "@/domain/types";
import type { MyPhoneTestCall } from "./MyPhonePanel";
import { RoutingUnsavedDialog } from "./settings/RoutingUnsavedDialog";
import { TelephonyConfigPanel } from "./settings/TelephonyConfigPanel";
import { DirectoryPanel } from "./settings/DirectoryPanel";
import { UserAccessSettings } from "./UserAccessSettings";
import { PushNotificationSettings } from "@/components/pwa/PushNotificationSettings";

import type { DraftEditorState } from "./useDraftEditors";
import type { RoutingNavigationTarget } from "@/lib/telephony/routing-summary";

type IntegrationSettingsProps = {
  routingTarget?: RoutingNavigationTarget | null;
  onRoutingDirtyChange?: (dirty: boolean) => void;
  onRoutingEditorStateChange?: (state: DraftEditorState | null) => void;
  branches: Branch[];
  partnerDirectory: PartnerDirectoryEntry[];
  users: AccessUser[];
  onDataChange: (dispatchData: DispatchData) => void;
  onTestCall?: MyPhoneTestCall;
  onDial?: (phone: string) => Promise<void>;
  viewerRole?: AppRole;
  pushEnabled?: boolean;
};

type SettingsSection = "notifications" | "users" | "telephony" | "directory";
const settingsSections: Array<{ icon: LucideIcon; label: string; shortLabel: string; value: SettingsSection }> = [
  { icon: BellRing, label: "Upozornenia", shortLabel: "Upozornenia", value: "notifications" },
  { icon: Users, label: "Používatelia", shortLabel: "Používatelia", value: "users" },
  { icon: PhoneCall, label: "Telefonovanie", shortLabel: "Telefóny", value: "telephony" },
  { icon: BookUser, label: "Adresár", shortLabel: "Adresár", value: "directory" },
];

export function IntegrationSettings({ routingTarget, onRoutingDirtyChange, onRoutingEditorStateChange, onDataChange, onTestCall, onDial, users, viewerRole, pushEnabled = true }: IntegrationSettingsProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>(routingTarget ? "telephony" : "notifications");
  const [routingDirty, setRoutingDirty] = useState(false);
  const [pendingSection, setPendingSection] = useState<SettingsSection | null>(null);
  const routingEditor = useRef<DraftEditorState | null>(null);
  const editorChanged = useCallback((editor: DraftEditorState | null) => { routingEditor.current = editor; onRoutingEditorStateChange?.(editor); }, [onRoutingEditorStateChange]);
  const dirtyChanged = useCallback((value: boolean) => { setRoutingDirty(value); onRoutingDirtyChange?.(value); }, [onRoutingDirtyChange]);
  const [previousTarget, setPreviousTarget] = useState(routingTarget);
  if (previousTarget !== routingTarget) { setPreviousTarget(routingTarget); if (routingTarget) setActiveSection("telephony"); }
  const [message, setMessage] = useState<string | null>(null);
  return (
    <main className="min-w-0 flex-1 bg-zinc-50 p-3 pb-[calc(84px+env(safe-area-inset-bottom))] sm:p-4 sm:pb-6">
      <h1 className="sr-only">Nastavenia</h1>
      {pendingSection && <RoutingUnsavedDialog onCancel={() => setPendingSection(null)} onSave={async () => { const next = pendingSection; const saved = await routingEditor.current?.save(); setPendingSection(null); if (saved) setActiveSection(next); }} onDiscard={() => { if (routingEditor.current?.saving) return; routingEditor.current?.discard(); setActiveSection(pendingSection); setPendingSection(null); }} />}
      <nav className="sticky top-0 z-30 mx-auto mb-4 max-w-7xl bg-zinc-50/95 py-2 backdrop-blur" aria-label="Sekcie nastavení">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {settingsSections.map(({ icon: Icon, label, shortLabel, value }) => {
            const active = activeSection === value;
            return (
              <button key={value} type="button" onClick={() => { if (routingDirty && value !== "telephony") { setPendingSection(value); return; } setActiveSection(value); setMessage(null); }} aria-current={active ? "page" : undefined}
                className={`flex min-h-12 min-w-0 items-center justify-center gap-2 rounded-xl border px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 ${active ? "border-yellow-400 bg-[#FCD703] text-zinc-950 shadow-sm" : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-100"}`}>
                <Icon size={17} aria-hidden="true" /><span className="sm:hidden">{shortLabel}</span><span className="hidden sm:inline">{label}</span>
              </button>
            );
          })}
        </div>
      </nav>
      <div className="mx-auto min-w-0 max-w-7xl">
        {activeSection === "notifications" && <PushNotificationSettings enabled={pushEnabled} />}
        {message && <div role="status" aria-live="polite" className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-900">{message}</div>}
        {activeSection === "users" && <UserAccessSettings users={users} onDataChange={onDataChange} onNotice={setMessage} viewerRole={viewerRole} />}
        {activeSection === "telephony" && <TelephonyConfigPanel onTestCall={onTestCall} routingTarget={routingTarget} onRoutingDirtyChange={dirtyChanged} onRoutingEditorStateChange={editorChanged} />}
        {activeSection === "directory" && <DirectoryPanel onDataChange={onDataChange} onDial={onDial} />}
      </div>
    </main>
  );
}
