"use client";

import { useId, useState, type HTMLInputTypeAttribute, type ReactNode } from "react";
import { CheckCircle2, ChevronDown, CircleAlert } from "lucide-react";
import type { CustomerContactRole } from "@/domain/types";

/**
 * Shared form primitives used by both the new-case form (NewCaseDrawer) and the
 * edit-case form (CaseDetail). Keeping them in one place guarantees the two forms
 * stay visually identical and prevents subtle divergence (e.g. a stray
 * `col-span-2`) from breaking one form but not the other.
 */

export type ContactDraft = {
  id: string;
  firstName: string;
  lastName: string;
  phonePrefix: string;
  phoneNational: string;
  email: string;
  role: CustomerContactRole;
  note: string;
  isPrimary: boolean;
};

export function RequiredMark() {
  return (
    <span className="ml-0.5 text-red-600" role="img" aria-label="povinné" data-required-marker>*</span>
  );
}

export const countryPrefixes = [
  ["+421", "SK"],
  ["+420", "CZ"],
  ["+48", "PL"],
  ["+36", "HU"],
  ["+43", "AT"],
  ["+49", "DE"],
  ["+39", "IT"],
] as const;

/** Keep arbitrary international prefixes intact; the list above is only a convenience list. */
export function normalizePhonePrefixInput(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 3);
  return digits ? `+${digits}` : "+";
}

export function splitContactPhone(phone: string) {
  const trimmed = phone.trim();
  const normalized = trimmed.startsWith("00") ? `+${trimmed.slice(2)}` : trimmed;
  const knownPrefix = [...countryPrefixes]
    .sort(([left], [right]) => right.length - left.length)
    .find(([candidate]) => normalized.startsWith(candidate))?.[0];

  if (knownPrefix) {
    return {
      prefix: knownPrefix,
      national: normalized.slice(knownPrefix.length).replace(/\D/g, ""),
    };
  }

  if (normalized.startsWith("+")) {
    // An unknown country-code boundary cannot be guessed safely. A standalone
    // "+" preserves every digit instead of silently rewriting the number as Slovak.
    return { prefix: "+", national: normalized.slice(1).replace(/\D/g, "") };
  }

  return { prefix: "+421", national: normalized.replace(/\D/g, "") };
}

export function joinContactPhone(contact: ContactDraft | undefined) {
  if (!contact) return "";

  const national = contact.phoneNational.replace(/\D/g, "");
  if (!national) return "";

  const prefix = normalizePhonePrefixInput(contact.phonePrefix);
  return prefix === "+" ? `+${national}` : `${prefix} ${national}`;
}

export function FormSection({
  children,
  collapsible = false,
  defaultOpen = false,
  errorCount = 0,
  title,
  valid = false,
}: {
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  errorCount?: number;
  title: string;
  valid?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const stateLabel = valid ? "Vyplnené správne" : errorCount > 0 ? `Doplniť · ${errorCount}` : "Doplniť";
  const stateIcon = valid ? (
    <CheckCircle2 size={17} className="shrink-0 text-emerald-700" />
  ) : (
    <CircleAlert size={17} className="shrink-0 text-red-700" />
  );
  const headerTone = valid ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50";
  const stateTone = valid ? "text-emerald-800" : "text-red-800";

  if (collapsible) {
    return (
      <details
        className={`group min-w-0 overflow-hidden rounded-lg border bg-white shadow-sm ${
          valid ? "border-emerald-300" : "border-red-300"
        }`}
        data-form-section-state={valid ? "valid" : "invalid"}
        open={isOpen}
        onToggle={(event) => setIsOpen(event.currentTarget.open)}
      >
        <summary
          className={`flex cursor-pointer list-none items-center justify-between gap-3 border-b border-l-4 border-l-[#FCD703] px-3 py-2.5 transition hover:brightness-[0.98] [&::-webkit-details-marker]:hidden ${headerTone}`}
        >
          <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-zinc-950">
            {stateIcon}
            <span>{title}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span className={`hidden text-xs font-semibold sm:inline ${stateTone}`}>{stateLabel}</span>
            <ChevronDown size={17} className="text-zinc-500 transition-transform group-open:rotate-180" aria-hidden="true" />
          </span>
        </summary>
        <div className="grid min-w-0 gap-3 p-3 [&>*]:min-w-0">{children}</div>
      </details>
    );
  }

  return (
    <section
      className={`min-w-0 overflow-hidden rounded-lg border bg-white shadow-sm ${
        valid ? "border-emerald-300" : "border-red-300"
      }`}
      data-form-section-state={valid ? "valid" : "invalid"}
    >
      <div className={`flex items-center justify-between gap-3 border-b px-3 py-2.5 ${
        valid ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"
      }`}>
        <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-zinc-950">
          {stateIcon}
          <span>{title}</span>
        </h3>
        <span className={`shrink-0 text-xs font-semibold ${stateTone}`}>{stateLabel}</span>
      </div>
      <div className="grid min-w-0 gap-3 p-3 [&>*]:min-w-0">{children}</div>
    </section>
  );
}

export function TextField({
  disabled,
  label,
  error,
  onBlur,
  onChange,
  placeholder,
  required,
  reserveErrorSpace,
  inputMode,
  max,
  maxLength,
  min,
  step,
  transformValue,
  type = "text",
  value,
}: {
  disabled?: boolean;
  label: string;
  error?: string;
  onBlur?: () => void;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  reserveErrorSpace?: boolean;
  inputMode?: "decimal" | "email" | "numeric" | "search" | "tel" | "text" | "url";
  max?: number | string;
  maxLength?: number;
  min?: number | string;
  step?: number | string;
  transformValue?: (value: string) => string;
  type?: HTMLInputTypeAttribute;
  value: string;
}) {
  const errorId = useId();

  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-semibold text-zinc-600">{label}{required && <RequiredMark />}</span>
      <input
        type={type}
        aria-label={label}
        aria-required={required}
        required={required}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        inputMode={inputMode}
        max={max}
        maxLength={maxLength}
        min={min}
        step={step}
        onBlur={onBlur}
        onKeyDown={(event) => {
          if (type === "number" && ["e", "E", "+", "-"].includes(event.key)) {
            event.preventDefault();
          }
        }}
        onChange={(event) => onChange(transformValue ? transformValue(event.target.value) : event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className={`h-10 w-full min-w-0 rounded-md border bg-white px-3 text-sm outline-none transition focus:ring-2 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500 ${
          error ? "border-red-300 ring-red-200" : "border-zinc-200 ring-yellow-300"
        }`}
      />
      <FieldError id={errorId} error={error} reserveSpace={reserveErrorSpace} />
    </label>
  );
}

export function TextareaField({
  disabled,
  error,
  label,
  onChange,
  required,
  reserveErrorSpace,
  value,
}: {
  disabled?: boolean;
  error?: string;
  label: string;
  onChange: (value: string) => void;
  required?: boolean;
  reserveErrorSpace?: boolean;
  value: string;
}) {
  const errorId = useId();

  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-semibold text-zinc-600">{label}{required && <RequiredMark />}</span>
      <textarea
        aria-label={label}
        aria-required={required}
        required={required}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className={`min-h-28 w-full min-w-0 resize-y rounded-md border bg-white px-3 py-2 text-sm outline-none transition focus:ring-2 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500 ${
          error ? "border-red-300 ring-red-200" : "border-zinc-200 ring-yellow-300"
        }`}
      />
      <FieldError id={errorId} error={error} reserveSpace={reserveErrorSpace} />
    </label>
  );
}

export function SelectField({
  disabled,
  error,
  label,
  onChange,
  options,
  required,
  reserveErrorSpace,
  value,
}: {
  disabled?: boolean;
  error?: string;
  label: string;
  onChange: (value: string) => void;
  options: Array<string | [string, string]>;
  required?: boolean;
  reserveErrorSpace?: boolean;
  value: string;
}) {
  const errorId = useId();

  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-semibold text-zinc-600">{label}{required && <RequiredMark />}</span>
      <select
        aria-label={label}
        aria-required={required}
        required={required}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className={`h-10 w-full min-w-0 rounded-md border bg-white px-3 text-sm font-medium outline-none transition focus:ring-2 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500 ${
          error ? "border-red-300 ring-red-200" : "border-zinc-200 ring-yellow-300"
        }`}
      >
        {options.map((option) => {
          const [optionValue, optionLabel] = Array.isArray(option) ? option : [option, option];
          return (
            <option key={optionValue} value={optionValue}>
              {optionLabel}
            </option>
          );
        })}
      </select>
      <FieldError id={errorId} error={error} reserveSpace={reserveErrorSpace} />
    </label>
  );
}

export function CheckboxGroup<T extends string>({
  disabled,
  items,
  labels,
  onChange,
  selected,
}: {
  disabled?: boolean;
  items: T[];
  labels: Record<T, string>;
  onChange: (value: T[]) => void;
  selected: T[];
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => {
        const active = selected.includes(item);
        return (
          <label
            key={item}
            className={`inline-flex h-9 items-center gap-2 rounded-md px-3 text-xs font-semibold ring-1 ${
              disabled
                ? "cursor-not-allowed bg-zinc-100 text-zinc-400 ring-zinc-200"
                : active
                  ? "bg-yellow-100 text-zinc-950 ring-yellow-300"
                  : "bg-zinc-50 text-zinc-600 ring-zinc-200"
            }`}
          >
            <input
              type="checkbox"
              checked={active}
              disabled={disabled}
              onChange={(event) => onChange(event.target.checked ? [...selected, item] : selected.filter((candidate) => candidate !== item))}
            />
            {labels[item]}
          </label>
        );
      })}
    </div>
  );
}

export function IconButton({ children, disabled, label, onClick }: { children: ReactNode; disabled?: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} disabled={disabled} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40">
      {children}
    </button>
  );
}

export function PhoneField({
  contact,
  disabled,
  error,
  onChange,
  required,
  reserveErrorSpace,
}: {
  contact: ContactDraft;
  disabled?: boolean;
  error?: string;
  onChange: (patch: Partial<ContactDraft>) => void;
  required?: boolean;
  reserveErrorSpace?: boolean;
}) {
  const errorId = useId();
  const prefixListId = useId();

  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-semibold text-zinc-600">Telefón{required && <RequiredMark />}</span>
      <div className={`grid grid-cols-[96px_minmax(0,1fr)] rounded-md border bg-white focus-within:ring-2 ${error ? "border-red-300 focus-within:ring-red-200" : "border-zinc-200 focus-within:ring-yellow-300"}`}>
        <input
          type="tel"
          list={prefixListId}
          aria-label="Predvoľba telefónu"
          inputMode="tel"
          autoComplete="tel-country-code"
          value={contact.phonePrefix}
          disabled={disabled}
          onChange={(event) => onChange({ phonePrefix: normalizePhonePrefixInput(event.target.value) })}
          className="h-10 min-w-0 rounded-l-md border-r border-zinc-200 bg-zinc-50 px-2 text-sm font-semibold outline-none disabled:cursor-not-allowed disabled:text-zinc-400"
        />
        <datalist id={prefixListId}>
          {countryPrefixes.map(([prefix, country]) => (
            <option key={prefix} value={prefix} label={country} />
          ))}
        </datalist>
        <input
          type="tel"
          aria-label="Telefón"
          aria-required={required}
          required={required}
          inputMode="numeric"
          autoComplete="tel-national"
          value={contact.phoneNational}
          disabled={disabled}
          onChange={(event) => onChange({ phoneNational: event.target.value.replace(/\D/g, "").slice(0, 15) })}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className="h-10 min-w-0 rounded-r-md px-3 text-sm outline-none disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
        />
      </div>
      <FieldError id={errorId} error={error} reserveSpace={reserveErrorSpace} />
    </label>
  );
}

function FieldError({ error, id, reserveSpace }: { error?: string; id: string; reserveSpace?: boolean }) {
  if (!error && !reserveSpace) {
    return null;
  }

  return (
    <span id={id} role={error ? "alert" : undefined} aria-hidden={error ? undefined : true} className="mt-1.5 block min-h-4 text-xs font-semibold leading-4 text-red-700">
      {error ?? ""}
    </span>
  );
}
