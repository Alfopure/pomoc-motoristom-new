"use client";

import { useId, useState, type HTMLInputTypeAttribute, type ReactNode } from "react";
import { CheckCircle2, ChevronDown, CircleAlert } from "lucide-react";
import type { CustomerContactRole } from "@/domain/types";
import { normalizeEditablePhone } from "@/lib/telephony/phone-entry";
import { PhoneNumberHint, PhoneNumberInput } from "./PhoneNumberInput";
import styles from "./case-detail.module.css";

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
  phone: string;
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

export function joinContactPhone(contact: ContactDraft | undefined) {
  if (!contact) return "";
  const phone = contact.phone.trim();
  if (!phone) return "";
  try { return normalizeEditablePhone(phone) ?? ""; }
  catch { return phone; }
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
    <CheckCircle2 size={14} className="shrink-0 text-emerald-700" />
  ) : (
    <CircleAlert size={14} className="shrink-0 text-red-700" />
  );
  const stateTone = valid ? "text-emerald-800" : "text-red-800";

  if (collapsible) {
    return (
      <details
        className={`group ${styles.section}`}
        data-form-section-state={valid ? "valid" : "invalid"}
        open={isOpen}
        onToggle={(event) => setIsOpen(event.currentTarget.open)}
      >
        <summary
          className={`${styles.sectionHeader} cursor-pointer transition hover:bg-zinc-100`}
        >
          <span className={styles.sectionTitle}>
            {stateIcon}
            <span>{title}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span className={`${styles.sectionState} hidden sm:inline ${stateTone}`}>{stateLabel}</span>
            <ChevronDown size={14} className="text-zinc-500 transition-transform group-open:rotate-180" aria-hidden="true" />
          </span>
        </summary>
        <div className={styles.sectionBody}>{children}</div>
      </details>
    );
  }

  return (
    <section
      className={styles.section}
      data-form-section-state={valid ? "valid" : "invalid"}
    >
      <div className={styles.sectionHeader}>
        <h3 className={styles.sectionTitle}>
          {stateIcon}
          <span>{title}</span>
        </h3>
        <span className={`${styles.sectionState} shrink-0 ${stateTone}`}>{stateLabel}</span>
      </div>
      <div className={styles.sectionBody}>{children}</div>
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
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}{required && <RequiredMark />}</span>
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
        className={`${styles.fieldControl} w-full min-w-0 rounded-md border bg-white px-3 text-sm outline-none transition focus:ring-2 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500 ${
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
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}{required && <RequiredMark />}</span>
      <textarea
        aria-label={label}
        aria-required={required}
        required={required}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className={`${styles.textarea} w-full min-w-0 resize-y rounded-md border bg-white px-3 py-2 text-sm outline-none transition focus:ring-2 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500 ${
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
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}{required && <RequiredMark />}</span>
      <select
        aria-label={label}
        aria-required={required}
        required={required}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className={`${styles.fieldControl} w-full min-w-0 rounded-md border bg-white px-3 text-sm font-medium outline-none transition focus:ring-2 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500 ${
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
  compact = false,
  disabled,
  items,
  labels,
  onChange,
  selected,
}: {
  compact?: boolean;
  disabled?: boolean;
  items: T[];
  labels: Record<T, string>;
  onChange: (value: T[]) => void;
  selected: T[];
}) {
  return (
    <div className={compact ? "grid grid-cols-2 gap-1.5 lg:flex lg:flex-wrap lg:gap-2" : "flex flex-wrap gap-2"}>
      {items.map((item) => {
        const active = selected.includes(item);
        return (
          <label
            key={item}
            className={`${styles.choice} inline-flex min-w-0 items-center gap-1.5 rounded-md ring-1 ${
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

  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>Telefón{required && <RequiredMark />}</span>
      <PhoneNumberInput
        aria-label="Telefón"
        aria-required={required}
        required={required}
        disabled={disabled}
        value={contact.phone}
        onChange={(value) => onChange({ phone: value })}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className={`${styles.fieldControl} w-full min-w-0 rounded-md border bg-white px-3 text-sm outline-none transition focus:ring-2 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400 ${error ? "border-red-300 focus:ring-red-200" : "border-zinc-200 focus:ring-yellow-300"}`}
      />
      <PhoneNumberHint value={contact.phone} className="mt-1 block text-[11px] leading-4 text-zinc-500" />
      <FieldError id={errorId} error={error} reserveSpace={reserveErrorSpace} />
    </div>
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
