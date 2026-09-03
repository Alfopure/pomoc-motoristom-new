"use client";

import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Building2,
  Edit3,
  FolderDown,
  Loader2,
  MapPinned,
  PhoneCall,
  RotateCcw,
  Save,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type { PlaceSelectionInput } from "@/data/case-inputs";
import type { DispatchData } from "@/data/dispatch-types";
import { partnerDirectoryKindLabels } from "@/domain/case-card";
import type { AccessUser, Branch, PartnerDirectoryEntry, PartnerDirectoryKind } from "@/domain/types";
import { GooglePlaceAutocomplete } from "./GooglePlaceAutocomplete";
import { useReplacementVehicleAvailability } from "./useReplacementVehicleAvailability";
import type { MyPhoneTestCall } from "./MyPhonePanel";
import { TelephonyConfigPanel } from "./settings/TelephonyConfigPanel";
import { SettingsSectionHeader } from "./settings/settings-ui";
import { UserAccessSettings } from "./UserAccessSettings";

type IntegrationSettingsProps = {
  branches: Branch[];
  partnerDirectory: PartnerDirectoryEntry[];
  users: AccessUser[];
  onDataChange: (dispatchData: DispatchData) => void;
  /**
   * Click-to-call of the console. "Môj telefón" uses it for its test call so
   * the browser phone answers its own leg exactly like for any other dial.
   */
  onTestCall?: MyPhoneTestCall;
};

type ApiMutationResponse = {
  dispatchData?: DispatchData;
  error?: string;
};

type SettingsSection = "users" | "telephony" | "partners" | "branches";

const settingsSections: Array<{ icon: LucideIcon; label: string; shortLabel: string; value: SettingsSection }> = [
  { icon: Users, label: "Používatelia", shortLabel: "Používatelia", value: "users" },
  { icon: PhoneCall, label: "Telefonovanie", shortLabel: "Telefóny", value: "telephony" },
  { icon: Building2, label: "Firmy a asistencia", shortLabel: "Firmy", value: "partners" },
  { icon: MapPinned, label: "Pobočky", shortLabel: "Pobočky", value: "branches" },
];

export function IntegrationSettings({
  branches,
  onDataChange,
  onTestCall,
  partnerDirectory,
  users,
}: IntegrationSettingsProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("users");
  const [message, setMessage] = useState<string | null>(null);

  return (
    <main className="flex-1 bg-zinc-50 p-3 pb-[calc(84px+env(safe-area-inset-bottom))] sm:p-4 sm:pb-6">
      <h1 className="sr-only">Nastavenia</h1>

      <nav className="sticky top-0 z-30 mx-auto mb-4 max-w-7xl bg-zinc-50/95 py-2 backdrop-blur" aria-label="Sekcie nastavení">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {settingsSections.map(({ icon: Icon, label, shortLabel, value }) => {
            const active = activeSection === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setActiveSection(value)}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-12 items-center justify-center gap-2 rounded-md border px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 ${
                  active
                    ? "border-yellow-400 bg-[#FCD703] text-zinc-950 shadow-sm"
                    : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-100"
                }`}
              >
                <Icon size={17} aria-hidden="true" />
                <span className="sm:hidden">{shortLabel}</span>
                <span className="hidden sm:inline">{label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <div className="mx-auto max-w-7xl">
        {message && <div role="status" aria-live="polite" className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-900">{message}</div>}

        {activeSection === "users" && (
          <UserAccessSettings users={users} onDataChange={onDataChange} onNotice={setMessage} />
        )}

        {activeSection === "telephony" && <TelephonyConfigPanel onTestCall={onTestCall} />}

        {activeSection === "partners" && (
          <PartnerDirectoryForm
            entries={partnerDirectory}
            onSaved={(dispatchData) => {
              onDataChange(dispatchData);
              setMessage("Adresár firiem a asistenčných služieb je aktualizovaný.");
            }}
          />
        )}

        {activeSection === "branches" && (
          <BranchForm
            branches={branches}
            onSaved={(dispatchData) => {
              onDataChange(dispatchData);
              setMessage("Pobočka je uložená a mapa pracuje s novou kapacitou.");
            }}
          />
        )}
      </div>
    </main>
  );
}

function BranchForm({ branches, onSaved }: { branches: Branch[]; onSaved: (dispatchData: DispatchData) => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [availableReplacementCars, setAvailableReplacementCars] = useState(0);
  const [location, setLocation] = useState<PlaceSelectionInput | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const availability = useReplacementVehicleAvailability();

  async function saveBranch() {
    if (!name.trim() || !location || isSaving) return;
    setIsSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone, availableReplacementCars, location }),
      });
      const result = (await response.json()) as ApiMutationResponse;

      if (!response.ok || !result.dispatchData) {
        throw new Error(result.error ?? "Pobočku sa nepodarilo uložiť.");
      }

      setName("");
      setPhone("");
      setAvailableReplacementCars(0);
      setLocation(null);
      onSaved(result.dispatchData);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Pobočku sa nepodarilo uložiť.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-md border border-zinc-200 bg-white">
      <SettingsSectionHeader icon={MapPinned} title="Pobočky" description="Adresy, kontakty a kapacita náhradných vozidiel." />
      <div className="grid gap-5 p-4 lg:grid-cols-[minmax(300px,0.75fr)_minmax(0,1.25fr)]">
        <div>
          <h3 className="mb-3 text-sm font-semibold text-zinc-950">Nová pobočka</h3>
          <div className="grid gap-3">
            <TextField label="Názov" value={name} onChange={setName} />
            <TextField label="Telefón" type="tel" value={phone} onChange={setPhone} />
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">Náhradné vozidlá</span>
              <input
                type="number"
                min={0}
                value={availableReplacementCars}
                onChange={(event) => setAvailableReplacementCars(Math.max(0, Number(event.target.value)))}
                className="h-10 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none ring-yellow-300 transition focus:ring-2"
              />
            </label>
            <GooglePlaceAutocomplete label="Adresa pobočky" value={location} onSelect={setLocation} />
            {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800">{error}</div>}
            <button
              type="button"
              onClick={() => void saveBranch()}
              disabled={!name.trim() || !location || isSaving}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
            >
              {isSaving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              Uložiť pobočku
            </button>
          </div>
        </div>

        <div className="min-w-0 border-t border-zinc-200 pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-zinc-950">Uložené pobočky</h3>
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600">{branches.length}</span>
          </div>
          <div className="grid gap-2">
            {branches.map((branch) => {
              const live = availability.byBranch[branch.id];
              const isLive = availability.source === "swhouse" && live != null;
              const count = isLive ? live : branch.availableReplacementCars;
              return (
                <MiniRow
                  key={branch.id}
                  icon={Building2}
                  title={branch.name}
                  detail={`${branch.address} · ${count} NV${isLive ? " · live" : ""}`}
                />
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

type PartnerEntryDraft = {
  name: string;
  ico: string;
  phone: string;
  email: string;
  note: string;
};

function PartnerDirectoryForm({ entries, onSaved }: { entries: PartnerDirectoryEntry[]; onSaved: (dispatchData: DispatchData) => void }) {
  const [kind, setKind] = useState<PartnerDirectoryKind>("assistance");
  const [name, setName] = useState("");
  const [ico, setIco] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [entryDraft, setEntryDraft] = useState<PartnerEntryDraft | null>(null);
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function saveEntry() {
    if (!name.trim() || isSaving) return;
    setIsSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/partner-directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, ico, kind, name, note, phone }),
      });
      const result = (await response.json()) as ApiMutationResponse;

      if (!response.ok || !result.dispatchData) {
        throw new Error(result.error ?? "Záznam adresára sa nepodarilo uložiť.");
      }

      setName("");
      setIco("");
      setPhone("");
      setEmail("");
      setNote("");
      onSaved(result.dispatchData);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Záznam adresára sa nepodarilo uložiť.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteEntry(entryId: string) {
    if (pendingDeleteId) return;
    setPendingDeleteId(entryId);
    setError(null);

    try {
      const response = await fetch(`/api/partner-directory/${entryId}`, { method: "DELETE" });
      const result = (await response.json()) as ApiMutationResponse;

      if (!response.ok || !result.dispatchData) {
        throw new Error(result.error ?? "Záznam adresára sa nepodarilo deaktivovať.");
      }

      onSaved(result.dispatchData);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Záznam adresára sa nepodarilo deaktivovať.");
    } finally {
      setPendingDeleteId(null);
    }
  }

  async function patchEntry(entryId: string, payload: Record<string, unknown>, failureMessage: string) {
    if (pendingEntryId) return false;
    setPendingEntryId(entryId);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(`/api/partner-directory/${entryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as ApiMutationResponse;

      if (!response.ok || !result.dispatchData) {
        throw new Error(result.error ?? failureMessage);
      }

      onSaved(result.dispatchData);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : failureMessage);
      return false;
    } finally {
      setPendingEntryId(null);
    }
  }

  function startEntryEdit(entry: PartnerDirectoryEntry) {
    setEditingEntryId(entry.id);
    setEntryDraft({
      name: entry.name,
      ico: entry.ico ?? "",
      phone: entry.phone ?? "",
      email: entry.email ?? "",
      note: entry.note ?? "",
    });
    setError(null);
    setNotice(null);
  }

  async function saveEntryEdit(entryId: string) {
    if (!entryDraft || !entryDraft.name.trim()) {
      setError("Záznam adresára potrebuje názov.");
      return;
    }

    const saved = await patchEntry(entryId, entryDraft, "Záznam adresára sa nepodarilo upraviť.");

    if (saved) {
      setEditingEntryId(null);
      setEntryDraft(null);
      setNotice("Záznam adresára upravený.");
    }
  }

  async function reactivateEntry(entryId: string) {
    const saved = await patchEntry(entryId, { active: true }, "Záznam adresára sa nepodarilo reaktivovať.");

    if (saved) {
      setNotice("Záznam adresára je znova aktívny.");
    }
  }

  async function backfillFromCases() {
    if (isBackfilling) return;
    setIsBackfilling(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/partner-directory/backfill-assistance", { method: "POST" });
      const result = (await response.json()) as ApiMutationResponse & { created?: string[] };

      if (!response.ok || !result.dispatchData) {
        throw new Error(result.error ?? "Asistenčné služby sa nepodarilo prevziať z prípadov.");
      }

      onSaved(result.dispatchData);
      setNotice(
        result.created && result.created.length > 0
          ? `Prevzaté z prípadov: ${result.created.join(", ")}.`
          : "Všetky asistenčné služby z prípadov už v adresári sú.",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Asistenčné služby sa nepodarilo prevziať z prípadov.");
    } finally {
      setIsBackfilling(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-md border border-zinc-200 bg-white">
      <SettingsSectionHeader icon={Building2} title="Firmy a asistenčné služby" description="Kontakty, ktoré zamestnanci používajú pri práci s prípadmi." />
      <div className="grid gap-5 p-4 lg:grid-cols-[minmax(300px,0.75fr)_minmax(0,1.25fr)]">
        <div>
          <h3 className="mb-3 text-sm font-semibold text-zinc-950">Nový kontakt</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <SelectField
                label="Typ záznamu"
                value={kind}
                onChange={(value) => setKind(value as PartnerDirectoryKind)}
                options={(['assistance', 'company'] as const).map((value) => [value, partnerDirectoryKindLabels[value]])}
              />
            </div>
            <div className="sm:col-span-2"><TextField label="Názov" value={name} onChange={setName} /></div>
            <TextField label="IČO" value={ico} onChange={setIco} />
            <TextField label="Telefón" type="tel" value={phone} onChange={setPhone} />
            <div className="sm:col-span-2"><TextField label="Email" type="email" value={email} onChange={setEmail} /></div>
            <div className="sm:col-span-2"><TextField label="Poznámka" value={note} onChange={setNote} /></div>
            {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800 sm:col-span-2">{error}</div>}
            <button
              type="button"
              onClick={() => void saveEntry()}
              disabled={!name.trim() || isSaving}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600 sm:col-span-2"
            >
              {isSaving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              Uložiť kontakt
            </button>
          </div>
        </div>

        <div className="min-w-0 border-t border-zinc-200 pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-950">Uložené kontakty</h3>
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600">{entries.length}</span>
            </div>
            <button
              type="button"
              onClick={() => void backfillFromCases()}
              disabled={isBackfilling}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:cursor-wait disabled:opacity-60"
              title="Nájde asistenčné služby použité v prípadoch, ktoré v adresári chýbajú, a založí ich"
            >
              {isBackfilling ? <Loader2 size={13} className="animate-spin" /> : <FolderDown size={13} />}
              Prevziať asistenčky z prípadov
            </button>
          </div>
          {notice && <div className="mb-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900">{notice}</div>}
          <div className="grid gap-2">
            {entries.length > 0 ? (
              entries.map((entry) => {
                const busy = pendingEntryId === entry.id || pendingDeleteId === entry.id;

                if (editingEntryId === entry.id && entryDraft) {
                  return (
                    <div key={entry.id} className="grid gap-2 rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div className="sm:col-span-2"><TextField label="Názov" value={entryDraft.name} onChange={(value) => setEntryDraft((current) => (current ? { ...current, name: value } : current))} /></div>
                        <TextField label="IČO" value={entryDraft.ico} onChange={(value) => setEntryDraft((current) => (current ? { ...current, ico: value } : current))} />
                        <TextField label="Telefón" type="tel" value={entryDraft.phone} onChange={(value) => setEntryDraft((current) => (current ? { ...current, phone: value } : current))} />
                        <TextField label="Email" type="email" value={entryDraft.email} onChange={(value) => setEntryDraft((current) => (current ? { ...current, email: value } : current))} />
                        <TextField label="Poznámka" value={entryDraft.note} onChange={(value) => setEntryDraft((current) => (current ? { ...current, note: value } : current))} />
                      </div>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => { setEditingEntryId(null); setEntryDraft(null); }}
                          disabled={busy}
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                        >
                          <X size={13} />
                          Zrušiť
                        </button>
                        <button
                          type="button"
                          onClick={() => void saveEntryEdit(entry.id)}
                          disabled={busy || !entryDraft.name.trim()}
                          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-zinc-950 px-2.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:cursor-wait disabled:bg-zinc-300 disabled:text-zinc-600"
                        >
                          {pendingEntryId === entry.id ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                          Uložiť
                        </button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={entry.id} className="flex items-start justify-between gap-2 rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-zinc-900">{entry.name}</span>
                      <span className="block truncate">
                        {partnerDirectoryKindLabels[entry.kind]}{entry.ico ? ` · IČO ${entry.ico}` : ""}{entry.phone ? ` · ${entry.phone}` : ""}{entry.active ? "" : " · neaktívne"}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => startEntryEdit(entry)}
                        disabled={busy}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={`Upraviť záznam ${entry.name}`}
                        title="Upraviť záznam"
                      >
                        <Edit3 size={14} />
                      </button>
                      {entry.active ? (
                        <button
                          type="button"
                          onClick={() => void deleteEntry(entry.id)}
                          disabled={busy}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`Deaktivovať záznam ${entry.name}`}
                          title="Deaktivovať záznam"
                        >
                          {pendingDeleteId === entry.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void reactivateEntry(entry.id)}
                          disabled={busy}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`Reaktivovať záznam ${entry.name}`}
                          title="Reaktivovať záznam"
                        >
                          {pendingEntryId === entry.id ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                        </button>
                      )}
                    </span>
                  </div>
                );
              })
            ) : (
              <div className="rounded-md bg-zinc-50 px-3 py-3 text-xs font-medium text-zinc-500">Adresár je zatiaľ prázdny.</div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function SelectField({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: Array<readonly [string, string]>;
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium outline-none ring-yellow-300 transition focus:ring-2"
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
    </label>
  );
}

function TextField({ label, onChange, type = "text", value }: { label: string; onChange: (value: string) => void; type?: "text" | "email" | "tel"; value: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none ring-yellow-300 transition focus:ring-2"
      />
    </label>
  );
}

function MiniRow({ detail, icon: Icon, title }: { detail: string; icon: LucideIcon; title: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
      <Icon size={14} className="mt-0.5 shrink-0 text-zinc-500" />
      <span className="min-w-0">
        <span className="block truncate font-semibold text-zinc-900">{title}</span>
        <span className="block truncate">{detail}</span>
      </span>
    </div>
  );
}

