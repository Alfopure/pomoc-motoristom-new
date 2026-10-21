import type { Metadata } from "next";
import Link from "next/link";
import { AppPageFrame, Section, linkClass } from "../page-frame";

export const metadata: Metadata = {
  title: "Ochrana súkromia – aplikácia Dispatching",
  description: "Aké údaje spracúva mobilná aplikácia Dispatching pre dispečerov Linky pomoci, prečo a kto k nim má prístup.",
  robots: { index: true, follow: true },
};

/** Privacy policy of the native app, linked from Účet and from App Store Connect. */
export default function AppPrivacyPage() {
  return (
    <AppPageFrame title="Ochrana súkromia v aplikácii Dispatching" updated="Informácie platné od 21. októbra 2026."
      lead="Dispatching je mobilná aplikácia pre dispečerov Linky pomoci motoristom. Nie je určená verejnosti: účet zakladá organizácia, ktorá dispečing prevádzkuje.">
      <Section id="controller" title="Kto údaje spracúva">
        <p>Prevádzkovateľom dispečingu a údajov v ňom je <strong>ALFOPURE s.r.o., IČO 11698055</strong>, Na Hřebenkách 815/130, Smíchov, 150 00 Praha 5, Česká republika. Kontakt pre ochranu osobných údajov: <a className={linkClass} href="mailto:info@alfopure.tech">info@alfopure.tech</a>.</p>
        <p>Aplikáciu v App Store vydáva <strong>MICT, s. r. o., IČO 53 167 422</strong>, Lesná 30, 010 04 Žilina, Slovensko.</p>
      </Section>
      <Section id="data" title="Aké údaje aplikácia spracúva">
        <ul className="list-disc space-y-2 pl-5">
          <li><strong>Účet dispečera:</strong> meno, e-mail, rola a organizácia. Prihlásenie overuje služba Supabase Auth; heslo sa v telefóne neukladá.</li>
          <li><strong>Dispečerská práca:</strong> prípady, mená a telefónne čísla zákazníkov, údaje o vozidle, miesta zásahu, poznámky, úlohy, spätné volania a prílohy, ktoré dispečer otvorí alebo zadá.</li>
          <li><strong>Hovory:</strong> telefónne čísla, čas a stav hovorov a zvuk hovoru počas spojenia. Nahrávanie hovorov opisujú <Link className={linkClass} href="/ochrana-hovorov">Informácie o nahrávaní hovorov</Link>.</li>
          <li><strong>Telefón dispečera:</strong> identifikátor pripojenia aplikácie k ústredni, stav pripojenia, verzia aplikácie a systému.</li>
          <li><strong>Notifikácie:</strong> ak ich dispečer zapne, identifikátor telefónu pre notifikácie (Expo push token), náhodný identifikátor inštalácie aplikácie, platforma, verzia aplikácie a zvolené druhy notifikácií. Text notifikácie neobsahuje mená, telefónne čísla, EČV ani názov úlohy, nanajvýš číslo prípadu a čas.</li>
          <li><strong>Hlásenia chýb:</strong> pri chybe aplikácie krátky technický záznam: druh a text chyby, miesto v programe, verzia aplikácie a systému. Telefónne čísla, e-mailové adresy, EČV a VIN sa v ňom maskujú už v telefóne; záznam je spojený s vaším účtom (identifikátor dispečera a organizácie). Pády aplikácie môže zbierať aj Apple, ak to dispečer povolí v nastaveniach iPhonu.</li>
        </ul>
      </Section>
      <Section id="permissions" title="Oprávnenia telefónu">
        <p><strong>Notifikácie</strong> aplikácia povolí až po ťuknutí na Zapnúť notifikácie v Účte. Vypnúť sa dajú v Účte alebo v nastaveniach telefónu; pri odhlásení sa telefón z notifikácií účtu odhlási.</p>
        <p><strong>Mikrofón</strong> aplikácia používa iba počas telefonovania. <strong>Fotoaparát a fotografie</strong> iba vtedy, keď dispečer pridáva prílohu k prípadu, a len vybraný súbor. <strong>Polohu</strong> iba na pokyn dispečera pri výbere miesta zásahu, nikdy nie na pozadí.</p>
        <p>Prihlásenie a rozpísané koncepty sú v zabezpečenom úložisku telefónu. Koncept tam ostane, kým ho dispečer neodošle alebo nezahodí.</p>
      </Section>
      <Section id="purpose" title="Prečo údaje spracúvame">
        <p>Na výkon dispečerskej práce: prijatie a vybavenie žiadostí o pomoc, komunikáciu so zákazníkmi a kolegami, bezpečnosť služby a odstraňovanie chýb. Údaje nepoužívame na reklamu, profilovanie ani sledovanie naprieč aplikáciami. Aplikácia neobsahuje reklamu ani analytické nástroje tretích strán.</p>
      </Section>
      <Section id="recipients" title="Kto sa k údajom dostane">
        <p>Oprávnení pracovníci organizácie podľa svojej roly. Technické služby zabezpečujú Supabase (prihlásenie, databáza a úložisko vo Frankfurte), Vercel (dispečerský server), Telnyx (telefonovanie), Expo – 650 Industries, Inc., USA (doručovanie notifikácií) a Apple (distribúcia aplikácie, doručenie notifikácií cez Apple Push Notification service a systémové služby iPhonu).</p>
        <p>Pri niektorých úkonoch dostanú údaje aj ďalšie služby. <strong>Google</strong> dostane adresy a súradnice pri zobrazení mapy prípadu, miesta klienta alebo flotily, pri výbere miesta zásahu a vyhľadaní adresy, pri výpočte trasy a pri navigácii v Mapách Google. <strong>Registre vozidiel</strong> dostanú pri vyhľadaní vozidla v Nástrojoch zadané EČV alebo VIN, prípadne VIN zistené z iného registra: databazavozidiel.sk, stkonline.sk, skp.sk, hakasystem.eu, dataovozidlech.cz, autokuk.cz, mycarplate.online a NHTSA.</p>
        <p>Poskytovatelia a ich subdodávatelia môžu spracúvať údaje aj mimo EHP, vrátane USA. Na prenosy sa podľa konkrétneho poskytovateľa používajú príslušné zmluvné záruky, najmä štandardné zmluvné doložky, alebo rozhodnutie o primeranosti.</p>
      </Section>
      <Section id="retention" title="Ako dlho údaje uchovávame">
        <p>Údaje dispečingu podľa pravidiel organizácie a zákonných lehôt; účet do jeho zrušenia. Hlásenia chýb ostávajú iba v krátkodobých technických záznamoch servera a neukladajú sa do databázy dispečingu.</p>
      </Section>
      <Section id="rights" title="Zrušenie účtu a vaše práva">
        <p>Účet zakladá a ruší organizácia. O zrušenie účtu a vymazanie údajov požiadajte svojho vedúceho alebo napíšte na <a className={linkClass} href="mailto:info@alfopure.tech">info@alfopure.tech</a>.</p>
        <p>Môžete žiadať informácie a prístup k svojim údajom, ich opravu, výmaz alebo obmedzenie spracovania a v príslušných prípadoch prenosnosť; proti spracovaniu založenému na oprávnenom záujme môžete namietať. Sťažnosť môžete podať na <a className={linkClass} href="https://uoou.gov.cz/">Úřad pro ochranu osobních údajů v ČR</a> alebo na dozorný orgán v mieste vášho obvyklého pobytu či pracoviska, napríklad <a className={linkClass} href="https://dataprotection.gov.sk/">Úrad na ochranu osobných údajov SR</a>.</p>
      </Section>
      <Section id="english" title="Summary in English" lang="en">
        <p>Dispatching is an internal app for dispatchers of the Linka pomoci roadside assistance line. ALFOPURE s.r.o. is the controller; MICT, s. r. o. publishes the app. The app processes the dispatcher&apos;s account, dispatch work (cases, customer contacts, vehicles, locations, notes, tasks, attachments), call data and masked error reports, only to run the dispatch service. Service providers are Supabase, Vercel, Telnyx, Expo (push delivery, only when the dispatcher switches notifications on; notices carry no names or phone numbers) and Apple; Google receives addresses and coordinates for maps, routes and navigation, and vehicle registries receive a plate or VIN (also a VIN found in another registry) when a vehicle is looked up. There is no advertising, tracking or third-party analytics. Contact <a className={linkClass} href="mailto:info@alfopure.tech">info@alfopure.tech</a> for access, correction, deletion or account removal.</p>
      </Section>
    </AppPageFrame>
  );
}
