import type { Metadata } from "next";
import Link from "next/link";
import { AppPageFrame, Section, linkClass } from "../page-frame";

export const metadata: Metadata = {
  title: "Podpora – aplikácia Dispatching",
  description: "Pomoc s mobilnou aplikáciou Dispatching pre dispečerov Linky pomoci: prístup, prihlásenie, telefón a kontakt.",
  robots: { index: true, follow: true },
};

/** Support page of the native app, linked from Účet and from App Store Connect. */
export default function AppSupportPage() {
  return (
    <AppPageFrame title="Podpora aplikácie Dispatching" updated="Stránka aktualizovaná 20. októbra 2026."
      lead="Dispatching je mobilná aplikácia pre dispečerov Linky pomoci motoristom: prípady, úlohy, hovory a spätné volania v telefóne.">
      <Section id="access" title="Prístup do aplikácie">
        <p>Aplikácia je len pre pracovníkov dispečingu. Účet vám založí organizácia; prihlasujete sa rovnakým e-mailom a heslom ako do webového dispečingu. Ak účet nemáte alebo vám prístup nefunguje, obráťte sa na svojho vedúceho.</p>
        <p>Zabudnuté heslo obnovíte cez <Link className={linkClass} href="/auth/forgot-password">obnovu hesla</Link>.</p>
      </Section>
      <Section id="phone" title="Telefón a hovory">
        <ul className="list-disc space-y-2 pl-5">
          <li>Hovory idú cez ústredňu. V module Hovory → Ústredňa skontrolujte, že je telefón pripojený.</li>
          <li>Na telefonovanie povoľte aplikácii mikrofón v nastaveniach iPhonu.</li>
          <li>Prichádzajúci hovor ukáže aj systémová obrazovka iPhonu; v aplikácii ho ovládate na obrazovke hovoru alebo cez pás nad aplikáciou.</li>
        </ul>
      </Section>
      <Section id="problems" title="Keď niečo nefunguje">
        <ul className="list-disc space-y-2 pl-5">
          <li>Skontrolujte pripojenie na internet a verziu aplikácie v časti Účet. Ak aplikácia žiada aktualizáciu, nainštalujte novšiu verziu.</li>
          <li>Rozpísané koncepty ostávajú v telefóne; nájdete ich v časti Účet → Koncepty v tomto zariadení.</li>
          <li>Pri chybe aplikácia odošle krátke technické hlásenie bez čísel a e-mailov zákazníkov.</li>
        </ul>
      </Section>
      <Section id="contact" title="Kontakt">
        <p>Napíšte na <a className={linkClass} href="mailto:info@alfopure.tech">info@alfopure.tech</a> a uveďte verziu aplikácie z časti Účet, model iPhonu a čo sa stalo. Údaje zákazníkov do správy nepíšte.</p>
        <p>Ako aplikácia spracúva údaje, opisuje <Link className={linkClass} href="/aplikacia/sukromie">Ochrana súkromia</Link>.</p>
      </Section>
    </AppPageFrame>
  );
}
