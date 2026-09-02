"use client";

import { useMemo, useState } from "react";
import { KeyRound, Mail, Power, RefreshCw, Save, UserPlus, Users } from "lucide-react";
import type { DispatchData } from "@/data/dispatch-types";
import type { AccessStatus, AccessUser, AppRole } from "@/domain/types";
import { MOTORIST_TIME_ZONE } from "@/domain/time";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type UserAccessSettingsProps = {
  users: AccessUser[];
  onDataChange: (dispatchData: DispatchData) => void;
  onNotice: (message: string) => void;
};

type UserDraft = {
  displayName: string;
  email: string;
  role: AppRole;
};

type ApiMutationResponse = {
  dispatchData?: DispatchData;
  error?: string;
  notice?: string;
};

const roleOptions: Array<[AppRole, string]> = [
  ["dispatcher", "Dispečer"],
  ["senior_dispatcher", "Senior dispečer"],
  ["manager", "Manažér"],
  ["admin", "Admin"],
];

const accessStatusLabels: Record<AccessStatus, string> = {
  not_invited: "Bez pozvánky",
  invited: "Pozvánka odoslaná",
  active: "Aktívny",
  disabled: "Deaktivovaný",
};

const accessStatusClass: Record<AccessStatus, string> = {
  not_invited: "bg-zinc-100 text-zinc-700",
  invited: "bg-sky-100 text-sky-800",
  active: "bg-emerald-100 text-emerald-800",
  disabled: "bg-red-100 text-red-800",
};

export function UserAccessSettings({ onDataChange, onNotice, users }: UserAccessSettingsProps) {
  const [drafts, setDrafts] = useState<Record<string, UserDraft>>({});
  const [newUser, setNewUser] = useState<UserDraft>({ displayName: "", email: "", role: "dispatcher" });
  const [sendInvite, setSendInvite] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordAgain, setNewPasswordAgain] = useState("");
  const sortedUsers = useMemo(() => [...users].sort((left, right) => left.name.localeCompare(right.name, "sk")), [users]);

  async function createUser() {
    if (!newUser.displayName.trim() || !newUser.email.trim() || pendingAction) {
      return;
    }

    setPendingAction("create");
    setError(null);

    try {
      const result = await mutate("/api/users", {
        method: "POST",
        body: {
          displayName: newUser.displayName,
          email: newUser.email,
          role: newUser.role,
          sendInvite,
        },
      });
      applyMutationResult(result, "Používateľ je vytvorený.");
      setNewUser({ displayName: "", email: "", role: "dispatcher" });
      setSendInvite(true);
    } catch (caught) {
      setError(errorMessage(caught, "Používateľa sa nepodarilo vytvoriť."));
    } finally {
      setPendingAction(null);
    }
  }

  async function saveUser(user: AccessUser) {
    const draft = drafts[user.id] ?? draftFromUser(user);

    if (!draft || pendingAction) {
      return;
    }

    setPendingAction(`save-${user.id}`);
    setError(null);

    try {
      const result = await mutate(`/api/users/${user.id}`, {
        method: "PATCH",
        body: {
          displayName: draft.displayName,
          email: draft.email,
          role: draft.role,
        },
      });
      applyMutationResult(result, "Používateľ je uložený.");
    } catch (caught) {
      setError(errorMessage(caught, "Používateľa sa nepodarilo uložiť."));
    } finally {
      setPendingAction(null);
    }
  }

  async function sendAccess(user: AccessUser) {
    await runUserAction(user, "access", `/api/users/${user.id}/access/send`, "Prístupový email bol odoslaný.");
  }

  async function sendReset(user: AccessUser) {
    await runUserAction(user, "reset", `/api/users/${user.id}/access/reset-password`, "Reset hesla bol odoslaný.");
  }

  async function setUserActive(user: AccessUser, active: boolean) {
    await runUserAction(user, active ? "reactivate" : "disable", `/api/users/${user.id}`, active ? "Používateľ je reaktivovaný." : "Používateľ je deaktivovaný.", {
      method: "PATCH",
      body: { active },
    });
  }

  async function runUserAction(user: AccessUser, action: string, url: string, fallbackNotice: string, options: { method: string; body?: Record<string, unknown> } = { method: "POST" }) {
    if (pendingAction) {
      return;
    }

    setPendingAction(`${action}-${user.id}`);
    setError(null);

    try {
      const result = await mutate(url, options);
      applyMutationResult(result, fallbackNotice);
    } catch (caught) {
      setError(errorMessage(caught, "Operáciu sa nepodarilo dokončiť."));
    } finally {
      setPendingAction(null);
    }
  }

  async function changeOwnPassword() {
    if (newPassword.length < 8) {
      setError("Nové heslo musí mať aspoň 8 znakov.");
      return;
    }

    if (newPassword !== newPasswordAgain) {
      setError("Heslá sa nezhodujú.");
      return;
    }

    setPendingAction("own-password");
    setError(null);

    const supabase = createSupabaseBrowserClient();
    const { error: passwordError } = await supabase.auth.updateUser({ password: newPassword });

    if (passwordError) {
      setError("Heslo sa nepodarilo zmeniť.");
      setPendingAction(null);
      return;
    }

    setNewPassword("");
    setNewPasswordAgain("");
    setPendingAction(null);
    onNotice("Heslo je zmenené.");
  }

  function applyMutationResult(result: ApiMutationResponse, fallbackNotice: string) {
    if (result.dispatchData) {
      setDrafts({});
      onDataChange(result.dispatchData);
    }

    onNotice(result.notice ?? fallbackNotice);
  }

  return (
    <section className="overflow-hidden rounded-md border border-zinc-200 bg-white">
      <div className="flex items-start gap-3 border-b border-yellow-200 bg-yellow-50 px-4 py-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[#FCD703] text-zinc-950">
          <Users size={20} />
        </div>
        <div>
          <h2 className="text-base font-semibold text-zinc-950">Používatelia</h2>
          <p className="mt-0.5 text-sm text-zinc-600">Účty, prístupové emaily a používateľské roly.</p>
        </div>
      </div>

      <div className="grid gap-5 p-4">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.75fr)]">
          <section className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
            <div className="mb-3 flex items-start gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white text-zinc-700 shadow-sm ring-1 ring-zinc-200">
                <UserPlus size={16} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-zinc-950">Nový používateľ</h3>
                <p className="mt-0.5 text-xs text-zinc-600">Vytvorte účet a podľa potreby hneď odošlite prístup.</p>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_150px_auto]">
              <InlineField label="Meno" value={newUser.displayName} onChange={(value) => setNewUser((draft) => ({ ...draft, displayName: value }))} />
              <InlineField label="Email" type="email" value={newUser.email} onChange={(value) => setNewUser((draft) => ({ ...draft, email: value }))} />
              <InlineRoleSelect value={newUser.role} onChange={(role) => setNewUser((draft) => ({ ...draft, role }))} />
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => void createUser()}
                  disabled={pendingAction === "create" || !newUser.displayName.trim() || !newUser.email.trim()}
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
                >
                  <UserPlus size={15} />
                  Pridať
                </button>
              </div>
              <label className="flex items-center gap-2 text-sm font-semibold text-zinc-700 md:col-span-2 xl:col-span-4">
                <input type="checkbox" checked={sendInvite} onChange={(event) => setSendInvite(event.target.checked)} className="h-4 w-4 rounded border-zinc-300" />
                Poslať prístup hneď po vytvorení
              </label>
            </div>
          </section>

          <section className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
            <div className="mb-3 flex items-start gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white text-zinc-700 shadow-sm ring-1 ring-zinc-200">
                <KeyRound size={16} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-zinc-950">Moje heslo</h3>
                <p className="mt-0.5 text-xs text-zinc-600">Zmení heslo účtu, pod ktorým ste prihlásený.</p>
              </div>
            </div>
            <div className="grid gap-3">
              <InlineField label="Nové heslo" type="password" value={newPassword} onChange={setNewPassword} />
              <InlineField label="Zopakovať heslo" type="password" value={newPasswordAgain} onChange={setNewPasswordAgain} />
              <button
                type="button"
                onClick={() => void changeOwnPassword()}
                disabled={pendingAction === "own-password" || !newPassword || !newPasswordAgain}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <KeyRound size={15} />
                Zmeniť moje heslo
              </button>
            </div>
          </section>
        </div>

        {error ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800">{error}</div> : null}

        <div className="border-t border-zinc-200 pt-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-zinc-950">Existujúci používatelia</h3>
              <p className="mt-0.5 text-xs text-zinc-600">Úprava mena, emailu, roly a prístupu.</p>
            </div>
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600">{sortedUsers.length}</span>
          </div>
          <div className="grid gap-2">
            {sortedUsers.map((user) => {
              const draft = drafts[user.id] ?? draftFromUser(user);
              const canSendInvite = user.accessStatus === "not_invited" || user.accessStatus === "invited";
              const canReset = user.accessStatus === "active";

              return (
                <div key={user.id} className="rounded-md border border-zinc-200 bg-white p-3">
                  <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-zinc-950">{user.name}</div>
                      <div className="mt-0.5 truncate text-xs text-zinc-500">
                        {user.email || "bez emailu"} · {user.extension ? `klapka ${user.extension}` : "bez klapky"} · posledné prihlásenie{" "}
                        {formatDateTime(user.lastSignInAt)}
                      </div>
                    </div>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${accessStatusClass[user.accessStatus]}`}>{accessStatusLabels[user.accessStatus]}</span>
                  </div>

                  <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_150px_auto]">
                    <InlineField label="Meno" value={draft.displayName} onChange={(value) => setDrafts((current) => ({ ...current, [user.id]: { ...draft, displayName: value } }))} />
                    <InlineField label="Email" type="email" value={draft.email} onChange={(value) => setDrafts((current) => ({ ...current, [user.id]: { ...draft, email: value } }))} />
                    <InlineRoleSelect value={draft.role} onChange={(role) => setDrafts((current) => ({ ...current, [user.id]: { ...draft, role } }))} />
                    <div className="flex items-end">
                      <button
                        type="button"
                        onClick={() => void saveUser(user)}
                        disabled={pendingAction === `save-${user.id}`}
                        className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
                      >
                        <Save size={15} />
                        Uložiť
                      </button>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <UserActionButton icon={Mail} label={user.inviteLastSentAt ? "Preposlať prístup" : "Poslať prístup"} disabled={!canSendInvite || pendingAction === `access-${user.id}`} onClick={() => void sendAccess(user)} />
                    <UserActionButton icon={RefreshCw} label="Reset hesla" disabled={!canReset || pendingAction === `reset-${user.id}`} onClick={() => void sendReset(user)} />
                    <UserActionButton
                      icon={Power}
                      label={user.accessStatus === "disabled" || !user.active ? "Reaktivovať" : "Deaktivovať"}
                      disabled={pendingAction === `disable-${user.id}` || pendingAction === `reactivate-${user.id}`}
                      onClick={() => void setUserActive(user, user.accessStatus === "disabled" || !user.active)}
                    />
                    <span className="flex items-center text-xs font-medium text-zinc-500">
                      Pozvánka {formatDateTime(user.inviteLastSentAt)} · heslo {formatDateTime(user.passwordSetAt)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function InlineField({ label, onChange, type = "text", value }: { label: string; onChange: (value: string) => void; type?: string; value: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm outline-none ring-yellow-300 transition focus:ring-2"
      />
    </label>
  );
}

function InlineRoleSelect({ onChange, value }: { onChange: (value: AppRole) => void; value: AppRole }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">Rola</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as AppRole)}
        className="h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium outline-none ring-yellow-300 transition focus:ring-2"
      >
        {roleOptions.map(([role, label]) => (
          <option key={role} value={role}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

function UserActionButton({ disabled, icon: Icon, label, onClick }: { disabled: boolean; icon: typeof Mail; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-xs font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

async function mutate(url: string, options: { method: string; body?: Record<string, unknown> }): Promise<ApiMutationResponse> {
  const response = await fetch(url, {
    method: options.method,
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const result = (await response.json().catch(() => ({}))) as ApiMutationResponse;

  if (!response.ok) {
    throw new Error(result.error ?? "Operácia zlyhala.");
  }

  return result;
}

function draftFromUser(user: AccessUser): UserDraft {
  return {
    displayName: user.name,
    email: user.email ?? "",
    role: user.role,
  };
}

function formatDateTime(value?: string) {
  if (!value) {
    return "—";
  }

  return new Intl.DateTimeFormat("sk-SK", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: MOTORIST_TIME_ZONE,
  }).format(new Date(value));
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
