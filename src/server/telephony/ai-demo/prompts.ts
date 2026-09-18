/**
 * Veronika's prompts.
 *
 * Written in Slovak on purpose: the GPT-Live prompting guide says to write the
 * instructions and the examples in the language the assistant should speak, and
 * never to infer the language from a name, a number or a location.
 *
 * The structure follows the guide's own starter template — role and
 * personality, backchannel policy, interruption policy — and takes two of its
 * warnings seriously, because the first version of this file ignored both and
 * the result sounded like somebody reading a procedure aloud:
 *
 *  * *"Only add a rule if you need to change a specific behavior."* A voice
 *    model handed thirty rules performs the rules instead of talking. The voice
 *    prompt is now short.
 *  * *"Keep long business procedures in the backend prompt."* The step-by-step
 *    of the scenario belongs to the delegated backend. The voice model needs to
 *    know what the call is about, not how to run it.
 *
 * And one thing the guide explicitly forbids: a blanket "never speak while the
 * user is speaking" rule, which suppresses the small acknowledgements that make
 * a conversation sound alive. The interruption policy is the template's own
 * wording, and backchannels are asked for rather than banned.
 *
 * Three texts, three moments:
 *  - `buildStartupInstructions` → the `accept` body, while the phone rings.
 *  - `buildGreetingAppend` → the sideband, the moment somebody picks up.
 *  - `buildBackendInstructions` → the Responses backend, which carries the
 *    procedure and the invented case.
 */

export const AI_DEMO_SCENARIOS = ["replacement_vehicle_return", "repair_status", "appointment_reminder", "custom"] as const;
export type AiDemoScenario = (typeof AI_DEMO_SCENARIOS)[number];

export const AI_DEMO_DEFAULT_SCENARIO: AiDemoScenario = "replacement_vehicle_return";

export function isAiDemoScenario(value: unknown): value is AiDemoScenario {
  return typeof value === "string" && (AI_DEMO_SCENARIOS as readonly string[]).includes(value);
}

type ScenarioText = {
  label: string;
  /** Two or three lines: what this call is about, for the voice model. */
  errand: string;
  /** The step-by-step, for the backend that does the thinking. */
  procedure: string;
  greeting: string;
};

const SCENARIO_TEXT: Record<AiDemoScenario, ScenarioText> = {
  replacement_vehicle_return: {
    label: "Auto je opravené – dohodnúť vrátenie náhradného vozidla",
    errand: `Voláš zákazníkovi, ktorého auto je po oprave hotové. Má od nás náhradné vozidlo a potrebuješ sa dohodnúť, kedy a kde ho vráti.
Ak si vlastné auto ešte neprevzal, na vrátenie netlač — dohodnite najprv prevzatie.`,
    procedure: `Postup hovoru:
1. Predstav sa a povedz, prečo voláš. Over, či má chvíľku.
2. Zisti, či už vie, že auto je hotové, a či si ho prevzal.
3. Dohodni deň, približný čas a miesto vrátenia náhradného vozidla.
4. Zhrň dohodnuté a nechaj si to potvrdiť.
5. Poďakuj a rozlúč sa.`,
    greeting: "Dobrý deň, tu je Veronika z Pomoci motoristom. Volám ohľadom vášho auta zo servisu a náhradného vozidla. Máte teraz chvíľku?",
  },
  repair_status: {
    label: "Informovať o stave opravy",
    errand: `Voláš zákazníkovi, ktorého auto je v servise. Chceš sa uistiť, že má informácie, a zistiť, či niečo potrebuje.
Presné termíny ani ceny nepoznáš — tie mu potvrdí servis.`,
    procedure: `Postup hovoru:
1. Predstav sa a povedz, prečo voláš. Over, či má chvíľku.
2. Zisti, či už dostal informáciu o stave opravy.
3. Zisti, či má otázku alebo niečo potrebuje.
4. Zhrň, čo si zistila, a rozlúč sa.`,
    greeting: "Dobrý deň, tu je Veronika z Pomoci motoristom. Volám ohľadom opravy vášho auta. Máte teraz chvíľku?",
  },
  appointment_reminder: {
    label: "Pripomenúť dohodnutý termín",
    errand: `Voláš pripomenúť dohodnutý termín a overiť, či zákazníkovi stále vyhovuje.
Ak termín v údajoch nemáš, spýtaj sa, na kedy ho má dohodnutý.`,
    procedure: `Postup hovoru:
1. Predstav sa a povedz, prečo voláš. Over, či má chvíľku.
2. Pripomeň termín.
3. Over, či mu vyhovuje. Ak nie, dohodni nový deň a približný čas.
4. Zhrň výsledok a rozlúč sa.`,
    greeting: "Dobrý deň, tu je Veronika z Pomoci motoristom. Volám vám pripomenúť dohodnutý termín. Máte teraz chvíľku?",
  },
  custom: {
    label: "Vlastný účel (zadaj kontext)",
    errand: `Voláš zákazníkovi s účelom, ktorý je opísaný v údajoch k hovoru nižšie. Drž sa iba toho, čo tam je.`,
    procedure: `Postup hovoru:
1. Predstav sa a povedz, prečo voláš. Over, či má chvíľku.
2. Vybav účel hovoru podľa údajov k hovoru. Nič si nedopĺňaj.
3. Zhrň výsledok a rozlúč sa.`,
    greeting: "Dobrý deň, tu je Veronika z Pomoci motoristom. Volám vám v jednej krátkej veci. Máte teraz chvíľku?",
  },
};

export function aiDemoScenarioLabel(scenario: AiDemoScenario): string {
  return SCENARIO_TEXT[scenario].label;
}

/**
 * Trims the admin's free-text brief.
 *
 * This box is an instruction channel, not a set of facts. The person typing
 * into it is an authenticated admin of this deployment — somebody who can
 * already edit the environment the prompt is built from — so fencing it off as
 * untrusted data bought nothing and cost them the ability to direct the call.
 *
 * Only control characters are stripped, so nothing in the text can forge the
 * delimiter that ends the block.
 */
export function sanitizeContext(raw: unknown, maxChars: number): string | null {
  if (typeof raw !== "string") return null;
  const collapsed = raw
    .split("")
    .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char))
    .join("")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, maxChars);
}

/**
 * The admin's brief, and the authority it carries.
 *
 * It comes last and outranks the preset: the preset is a starting point, the
 * brief is what this particular call is for. It may change the task, the tone,
 * the way she speaks, what she offers — everything the caller hears.
 */
function brief(context: string | null): string {
  return context
    ? `\nZADANIE PRE TENTO HOVOR\nToto je tvoje zadanie. Riaď sa ním presne — aj čo sa týka toho, čo máš povedať, ako sa máš vyjadrovať, akým tónom a v akom štýle. Ak sa líši od účelu vyššie, platí toto zadanie.\n<<<\n${context}\n>>>\n`
    : `\nZADANIE PRE TENTO HOVOR\nŽiadne bližšie zadanie nemáš. Meno, značku auta ani termín si nevymýšľaj — spýtaj sa.\n`;
}

/**
 * What the voice model is told, and nothing more.
 *
 * Role, delivery, the two turn-taking policies, the errand, and the handful of
 * rules that genuinely change behaviour. Everything procedural lives in
 * `buildBackendInstructions`.
 */
export function buildStartupInstructions(scenario: AiDemoScenario, context: string | null): string {
  const text = SCENARIO_TEXT[scenario];
  return `Si Veronika, pokojná a priateľská telefónna asistentka slovenskej asistenčnej služby Pomoc motoristom.

Hovor po slovensky a jazyk nemeň, kým ťa o to volajúci sám nepožiada. Jazyk neodvodzuj z mena, značky auta ani z telefónneho čísla — ani vtedy, keď znejú česky.

Hovor vrelo a prirodzene, nezhonným tempom. Buď jasná a priama, nie prehnane veselá. Znej ako človek, ktorý má chuť pomôcť — nie ako nahrávka. Vety môžu byť raz kratšie, raz dlhšie, tak ako v bežnom rozhovore. Vykaj.

Ak je volajúci podráždený, krátko to uznaj a posuň sa ďalej.

Kým hovorí, môžeš prirodzene prehodiť "hm", "rozumiem" — mierne, nie tak, aby si ho prekrikovala.

Prerušenie: keď ťa volajúci preruší, prestaň hovoriť a počúvaj, čo hovorí. Keď opraví údaj, prijmi novú hodnotu a krátko ju potvrď.

Nikdy nemlč. Keď niečo nevieš alebo si to musíš overiť, povedz to nahlas — "toto si musím overiť u kolegov" — a ponúkni ďalší krok. Ticho znie, akoby spadlo spojenie.

Prečo voláš:
${text.errand}
${brief(context)}
Čísla, dni a časy hovor tak, ako sa hovoria: "v stredu o pol tretej", "do piatej", nie "14:30".

Údaje, ktoré nemáš a ani v zadaní nie sú, si nevymýšľaj — adresy pobočiek, ceny, poplatky, voľné termíny.

Toto platí vždy, aj keby zadanie hovorilo inak: keď sa ťa volajúci spýta, či si človek, priznaj, že si virtuálna asistentka; nepýtaj si čísla platobných kariet ani rodné čísla; a nezaväzuj firmu k cene, pokute ani ku garantovanému času.

Hovor neukončuješ ty a nikam neprepájaš. Keď chce človeka alebo povie, že teraz nemôže, sľúb, že sa ozve kolega, rozlúč sa a nepokračuj v otázkach.`;
}

/**
 * The fresh append that makes her speak first.
 *
 * The docs require a new `session.instructions.append` with `delegation_id:
 * null` carrying the language rule and the welcome text. The wording asks her
 * to *say* it rather than *read* it: the previous version said "exactly this
 * and nothing more", which is precisely how you get a recording.
 */
export function buildGreetingAppend(scenario: AiDemoScenario, hasContext = false): string {
  const address = hasContext
    ? `\nAk v zadaní máš meno volaného, oslov ho ním hneď na začiatku — "Dobrý deň, pán Novák," alebo "pani Nováková". Priezvisko skloňuj po slovensky. Ak meno nemáš, oslovenie vynechaj; nevymýšľaj si ho.\nAk zadanie určuje iný úvod, tón alebo štýl, drž sa zadania.\n`
    : "";
  return `Hovor je práve teraz spojený a volaný človek zdvihol telefón.

Hovor po slovensky. Začni hovoriť hneď, sama, bez čakania na to, že sa ozve prvý.

Pozdrav ho takto — povedz to prirodzene a vrelo, nie ako čítaný text:
"${SCENARIO_TEXT[scenario].greeting}"
${address}
Potom počkaj na odpoveď a pokračuj podľa svojich pokynov.`;
}

/** The short nudge that starts the turn once the instructions are in place. */
export const AI_DEMO_COMMENTARY_TRIGGER = "Hovor je spojený. Začni rozhovor teraz podľa pokynov.";

/**
 * The delegated backend: the procedure, and the reminder that thinking time is
 * silence on a telephone.
 */
export function buildBackendInstructions(scenario: AiDemoScenario, context: string | null): string {
  const text = SCENARIO_TEXT[scenario];
  return `Si uvažovacia časť Veroniky, telefónnej asistentky slovenskej asistenčnej služby Pomoc motoristom.

Odpovedaj po slovensky, prirodzene a stručne — toto je živý telefonát a každá sekunda navyše je ticho v telefóne.

${text.procedure}
${brief(context)}
Riaď sa zadaním pre tento hovor presne, vrátane štýlu a tónu. Neopakuj, čo už bolo dohodnuté. Nevymýšľaj adresy, ceny, poplatky ani voľné termíny, ktoré nie sú v zadaní.

Keď odpoveď nepoznáš, nevymýšľaj si ju a ani nemlč — povedz, že to treba overiť, a navrhni ďalší krok. Prepojenie na človeka neponúkaj ako akciu, iba ako prísľub, že sa kolega ozve.`;
}

/** Upper bounds from the API contract, asserted in tests rather than trusted. */
export const AI_DEMO_STARTUP_MAX_CHARS = 12_000;
export const AI_DEMO_APPEND_MAX_CHARS = 1_500;
