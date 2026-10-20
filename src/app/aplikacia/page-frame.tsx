import Link from "next/link";
import type { ReactNode } from "react";

/** Public pages of the Dispatching app, in the style of /ochrana-hovorov. */
export const sectionClass = "space-y-3 border-t border-zinc-200 py-7 text-sm leading-7 text-zinc-700";
export const headingClass = "text-lg font-semibold tracking-tight text-zinc-950";
export const linkClass = "font-medium underline decoration-zinc-300 underline-offset-4 hover:decoration-zinc-900";

export function AppPageFrame({ title, lead, children, updated }: { title: string; lead: string; children: ReactNode; updated: string }) {
  return (
    <main className="min-h-screen bg-zinc-100 px-4 py-8 text-zinc-950 sm:py-14">
      <article className="mx-auto max-w-3xl overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
        <div className="h-2 bg-[#FCD703]" />
        <div className="px-5 py-8 sm:px-10">
          <Link href="/" className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Dispatching · Linka pomoci</Link>
          <h1 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
          <p className="mt-4 mb-7 leading-7 text-zinc-600">{lead}</p>
          {children}
          <p className="text-xs text-zinc-500">{updated}</p>
        </div>
      </article>
    </main>
  );
}

export function Section({ id, title, children, lang }: { id: string; title: string; children: ReactNode; lang?: string }) {
  return <section className={sectionClass} aria-labelledby={id} lang={lang}><h2 id={id} className={headingClass}>{title}</h2>{children}</section>;
}
