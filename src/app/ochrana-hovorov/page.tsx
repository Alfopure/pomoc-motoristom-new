import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const metadata: Metadata = {
  title: "Informácie o nahrávaní hovorov",
  description: "Ako ALFOPURE spracúva nahrávky, prepisy a kontrolu kvality hovorov a ako si uplatniť svoje práva.",
  robots: { index: true, follow: true },
};

async function publicRetention() {
  try {
    const admin = createSupabaseAdminClient();
    const signal = AbortSignal.timeout(3000);
    const organization = await admin.from("motorist_organizations")
      .select("id")
      .eq("slug", process.env.MOTORIST_ORGANIZATION_SLUG?.trim() || "pomoc-motoristom")
      .eq("active", true)
      .abortSignal(signal)
      .maybeSingle();
    if (organization.error || !organization.data) return null;
    const { data, error } = await admin
      .from("motorist_call_recording_policies")
      .select("audio_retention_days,transcript_retention_days,review_retention_days")
      .eq("organization_id", organization.data.id)
      .abortSignal(signal)
      .maybeSingle();
    if (error) return null;
    return data ?? { audio_retention_days: 30, transcript_retention_days: 30, review_retention_days: 90 };
  } catch {
    return null;
  }
}

const sectionClass = "space-y-3 border-t border-zinc-200 py-7 text-sm leading-7 text-zinc-700";
const headingClass = "text-lg font-semibold tracking-tight text-zinc-950";
const linkClass = "font-medium underline decoration-zinc-300 underline-offset-4 hover:decoration-zinc-900";

export default async function CallPrivacyPage() {
  await connection();
  const retention = await publicRetention();
  return (
    <main className="min-h-screen bg-zinc-100 px-4 py-8 text-zinc-950 sm:py-14">
      <article className="mx-auto max-w-3xl overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
        <div className="h-2 bg-[#FCD703]" />
        <div className="px-5 py-8 sm:px-10">
          <Link href="/" className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Pomoc motoristom · ALFOPURE</Link>
          <h1 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">Váš hovor a vaše súkromie</h1>
          <p className="mt-4 leading-7 text-zinc-600">Informácie o nahrávaní, automatickom prepise a kontrole kvality hovorov na linke pomoci motoristom.</p>
          <div className="my-7 rounded-xl bg-amber-50 p-5 text-sm leading-6 text-zinc-800">
            <p className="font-semibold">Pomoc môžete vybaviť aj bez nahrávania.</p>
            <p className="mt-1">Povedzte dispečerovi, že si nahrávanie neželáte. Zastaví ho; námietka nebráni vybaveniu pomoci. Informácie aj žiadosť o prístup k záznamu môžete riešiť priamo s ním alebo na <a className={linkClass} href="mailto:info@alfopure.tech">info@alfopure.tech</a>.</p>
          </div>
          <section className={sectionClass} aria-labelledby="controller">
            <h2 id="controller" className={headingClass}>Kto údaje spracúva</h2>
            <p>Prevádzkovateľom je <strong>ALFOPURE s.r.o., IČO 11698055</strong>, Na Hřebenkách 815/130, Smíchov, 150 00 Praha 5, Česká republika. Kontakt pre ochranu osobných údajov: <a className={linkClass} href="mailto:info@alfopure.tech">info@alfopure.tech</a>.</p>
          </section>
          <section className={sectionClass} aria-labelledby="purpose">
            <h2 id="purpose" className={headingClass}>Prečo a čo spracúvame</h2>
            <p>Nahrávka pomáha presne zachytiť požiadavku, dohodnutú pomoc a ďalší postup, preveriť nedorozumenie alebo reklamáciu a kontrolovať kvalitu komunikácie. Spracúvame hlas a obsah hovoru, telefónne číslo, čas a trvanie, údaje o vozidle, polohe a požadovanej pomoci, ktoré v hovore uvediete, a identitu zapojeného dispečera.</p>
            <p>Na nahrávanie, prepis, zhrnutie a kontrolu kvality sa používa oprávnený záujem podľa čl. 6 ods. 1 písm. f) GDPR: spoľahlivé vybavenie a doloženie dohodnutej pomoci, riešenie sťažností a zlepšovanie služby. Nahrávanie nie je povinné zo zákona ani podmienkou poskytnutia pomoci. Bežné údaje potrebné na vybavenie objednávky sa môžu spracúvať aj bez zvukového záznamu na účely plnenia zmluvy alebo krokov pred jej uzavretím.</p>
            <p>Nahrávanie sa začne až po oznámení. Súkromné konzultácie a interné rozhovory pri podržaní sa do zákazníckeho záznamu nemajú ukladať. Údaje, ktoré nie sú potrebné na pomoc, najmä platobné tajomstvá alebo podrobné zdravotné informácie, si prostredníctvom záznamu nevyžadujeme.</p>
          </section>
          <section className={sectionClass} aria-labelledby="analysis">
            <h2 id="analysis" className={headingClass}>Ako sa používa umelá inteligencia</h2>
            <p>ElevenLabs Scribe vytvorí prepis. OpenAI GPT pripraví zhrnutie požiadavky, dohodnutého postupu a návrh hodnotenia komunikácie. Sleduje pozdrav, zistenie potrebných údajov, pochopenie potreby, riešenie, zrozumiteľnosť, podržanie alebo odovzdanie a ukončenie hovoru. Časy reči, ticha a prekrytia sú iba odhady.</p>
            <p>Výsledok môže obsahovať chybu. Hodnotenie pred použitím kontroluje človek; oprava prepisu vyžaduje nové posúdenie. Operátor má prístup k vlastnej schválenej kontrole a môže ju namietať. Nepoužívame rozpoznávanie emócií, zdravotného stavu ani osobnosti a nevykonávame výlučne automatizované rozhodnutia s právnymi alebo obdobne významnými účinkami.</p>
          </section>
          <section className={sectionClass} aria-labelledby="recipients">
            <h2 id="recipients" className={headingClass}>Kto môže údaje dostať</h2>
            <p>K záznamom pristupujú oprávnení vedúci a pracovníci potrební na vybavenie žiadostí a kontroly. Technické služby zabezpečujú Telnyx (telefonovanie a záznam), Supabase (súkromná databáza a úložisko vo Frankfurte), Vercel (aplikácia), ElevenLabs (prepis) a OpenAI (analýza). Zvuk ani prepis nie sú verejným obsahom.</p>
            <p>Frankfurtské úložisko neznamená, že všetko spracovanie prebieha výlučne v EÚ. Poskytovatelia a ich subdodávatelia môžu spracúvať údaje aj mimo EHP, vrátane USA. Na prenosy sa podľa konkrétneho poskytovateľa používajú príslušné zmluvné záruky, najmä štandardné zmluvné doložky, alebo rozhodnutie o primeranosti. Podrobnosti a kópiu uplatnených záruk si môžete vyžiadať na našom kontaktnom e-maile.</p>
            <p className="text-xs text-zinc-500">Informácie poskytovateľov: <a className={linkClass} href="https://elevenlabs.io/dpa">ElevenLabs DPA</a>, <a className={linkClass} href="https://openai.com/policies/data-processing-addendum/">OpenAI DPA</a>.</p>
          </section>
          <section className={sectionClass} aria-labelledby="retention">
            <h2 id="retention" className={headingClass}>Ako dlho údaje uchovávame</h2>
            {retention ? <p>Aktuálne nastavené lehoty sú <strong>{retention.audio_retention_days} dní pre zvuk</strong>, <strong>{retention.transcript_retention_days} dní pre prepis</strong> a <strong>{retention.review_retention_days} dní pre kontrolu kvality</strong>. Po vypršaní lehoty zdroja sa zneprístupní aj závislý obsah; dlhšia lehota kontroly neumožňuje ďalej prehrávať vymazaný záznam.</p> : <p>Aktuálne lehoty vám potvrdíme na info@alfopure.tech alebo prostredníctvom dispečera.</p>}
            <p>Vymazanie najskôr zablokuje prístup a následne odstráni obsah z úložiska a služieb spracovania. Potvrdenie odstránenia u externého poskytovateľa môže byť oneskorené; neoznačujeme ho za dokončené pred potvrdením. Technické bezpečnostné logy poskytovateľov sa riadia aj ich vlastnými podmienkami.</p>
          </section>
          <section className={sectionClass} aria-labelledby="rights">
            <h2 id="rights" className={headingClass}>Vaše práva a vybavenie žiadosti</h2>
            <p>Môžete žiadať informácie a prístup k svojim údajom, ich opravu, výmaz alebo obmedzenie spracovania a v príslušných prípadoch prenosnosť. Proti spracovaniu založenému na oprávnenom záujme môžete namietať. Žiadosť o zastavenie nahrávania oznámte dispečerovi už počas hovoru; žiadosť o vymazanie doterajšieho záznamu vybavíme osobitne.</p>
            <p>Napíšte na <a className={linkClass} href="mailto:info@alfopure.tech">info@alfopure.tech</a> a uveďte približný čas hovoru a číslo, z ktorého ste volali. Overíme totožnosť primerane žiadosti a chránime aj údaje ostatných účastníkov. O vybavení vás informujeme spravidla do jedného mesiaca; prípadné zákonné predĺženie vysvetlíme.</p>
            <p>Sťažnosť môžete podať na <a className={linkClass} href="https://uoou.gov.cz/">Úřad pro ochranu osobních údajů v ČR</a> alebo na dozorný orgán v mieste vášho obvyklého pobytu či pracoviska, napríklad <a className={linkClass} href="https://dataprotection.gov.sk/">Úrad na ochranu osobných údajov SR</a>.</p>
          </section>
          <section className={sectionClass} lang="en" aria-labelledby="english">
            <h2 id="english" className={headingClass}>Information in another language</h2>
            <p>ALFOPURE s.r.o. records and automatically transcribes and reviews announced calls to arrange assistance, resolve complaints and check service quality. You can ask the dispatcher to stop recording and still receive assistance. Human reviewers check AI results. For the full information in your language, access, correction, deletion or an objection, contact <a className={linkClass} href="mailto:info@alfopure.tech">info@alfopure.tech</a> or ask your dispatcher.</p>
          </section>
          <p className="text-xs text-zinc-500">Informácie platné od 6. septembra 2026. Lehoty vyššie zodpovedajú aktuálnemu nastaveniu služby.</p>
        </div>
      </article>
    </main>
  );
}
