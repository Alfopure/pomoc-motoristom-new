"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { Truck } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { signOutCurrentSession } from "@/components/auth/sign-out";
import styles from "./towing.module.css";

export function Button({ primary, danger, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; danger?: boolean }) {
  return <button {...props} className={`${styles.button} ${primary ? styles.primary : ""} ${danger ? styles.danger : ""} ${className}`} />;
}
export function Field({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const id = useId();
  return <div className={styles.field}><label htmlFor={props.id ?? id}>{label}</label><input {...props} id={props.id ?? id} /></div>;
}
export function Select({ label, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  const id = useId();
  return <div className={styles.field}><label htmlFor={props.id ?? id}>{label}</label><select {...props} id={props.id ?? id}>{children}</select></div>;
}
export function TextArea({ label, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  const id = useId();
  return <div className={styles.field}><label htmlFor={props.id ?? id}>{label}</label><textarea {...props} id={props.id ?? id} /></div>;
}
export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className={styles.panel}><h2>{title}</h2>{children}</section>;
}
export function Notice({ children, kind = "notice" }: { children: ReactNode; kind?: "notice" | "error" | "success" }) {
  return <div role={kind === "error" ? "alert" : "status"} className={`${styles.notice} ${kind === "notice" ? "" : styles[kind]}`}>{children}</div>;
}
export function Shell({ children, view, canOffice, canDriver, canDispatch, canDeliver, canPartner }: { children: ReactNode; view: "office" | "driver" | "operations"; canOffice?: boolean; canDriver?: boolean; canDispatch?: boolean; canDeliver?: boolean; canPartner?: boolean }) {
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");
  return <div className={styles.shell}><header className={styles.header}><div className={styles.brand}><span className={styles.brandIcon}><Truck size={24} /></span><span>POMOC MOTORISTOM<br /><small className={styles.muted}>{view === "operations" ? "Výjazdy a odvozy" : "Zákazky odťahovej služby"}</small></span></div><nav aria-label="Rozhrania">{canOffice && <Link href="/zakazky" aria-current={view === "office" ? "page" : undefined}>Kancelária</Link>}{canDriver && <Link href="/vodic" aria-current={view === "driver" ? "page" : undefined}>Moje zákazky</Link>}{(canDriver || canDeliver) && <Link href="/moje-jazdy" aria-current={view === "operations" ? "page" : undefined}>Moje jazdy</Link>}{canDispatch && <Link href="/">Dispečing</Link>}{canPartner && <Link href="/partner">Partnerské výstupy</Link>}<button disabled={signingOut} onClick={async () => { setSigningOut(true); try { await signOutCurrentSession(); } catch { setError("Odhlásenie sa nepodarilo dokončiť. Skúste ho znova."); } finally { setSigningOut(false); } }}>{signingOut ? "Odhlasujem…" : "Odhlásiť"}</button></nav></header><main className={styles.main}>{error && <Notice kind="error">{error}</Notice>}{children}</main></div>;
}
