/**
 * What the current configuration does to a caller, in words.
 *
 * The settings page already says what a *change* will do. This says what the
 * setup as it stands already does, which is the thing nobody reads a schema to
 * find out: whether anybody's phone will ring, what happens when nobody picks
 * up, and which of it costs money.
 *
 * Nothing here forces anything. A configuration that leaves callers waiting is
 * allowed — it just should not be a surprise.
 */

import { formatPhoneNumberForDisplay } from "./phone";

/** What the queue does for an organisation that has never touched the setting. */
export const DEFAULT_ESCALATE_AFTER_SECONDS = 120;

export type CallSetupAdvisory = {
  tone: "info" | "warning" | "error";
  title: string;
  text: string;
};

type Member = { memberKind: string; profileId: string | null; externalNumber: string | null };
type Group = { id: string; name: string; active: boolean; members: readonly Member[] };
type Step = { ringGroupId: string; strategy: string };
type Plan = { name: string; active: boolean; steps: readonly Step[] };
type Operator = { displayName: string; active: boolean; settings: { deliveryMode?: string; defaultMobileNumber: string | null } | null };

export type CallSetupInput = {
  groups: readonly Group[];
  plans: readonly Plan[];
  operators: readonly Operator[];
  parkMaxMinutes: number | null;
  maxRingFanout: number | null;
  /** Seconds before the backup numbers are tried once; 0 means never. */
  escalateAfterSeconds?: number | null;
};

const minutes = (value: number) => `${value} min`;

/** Everyone a ring plan can actually reach, split by what kind of destination they are. */
function reachable(input: CallSetupInput) {
  const groupsById = new Map(input.groups.filter((group) => group.active).map((group) => [group.id, group]));
  const operators = new Set<string>();
  const numbers = new Set<string>();
  for (const plan of input.plans) {
    if (!plan.active) continue;
    for (const step of plan.steps) {
      for (const member of groupsById.get(step.ringGroupId)?.members ?? []) {
        if (member.memberKind === "external_number" && member.externalNumber) numbers.add(member.externalNumber);
        else if (member.profileId) operators.add(member.profileId);
      }
    }
  }
  return { operators, numbers };
}

export function callSetupAdvisories(input: CallSetupInput): CallSetupAdvisory[] {
  const advisories: CallSetupAdvisory[] = [];
  const activePlans = input.plans.filter((plan) => plan.active);
  const { operators, numbers } = reachable(input);
  const park = input.parkMaxMinutes && input.parkMaxMinutes > 0 ? input.parkMaxMinutes : null;

  if (!activePlans.length) {
    advisories.push({
      tone: "error",
      title: "Žiadny aktívny plán zvonenia",
      text: "Prichádzajúci hovor nikomu nezazvoní. Volajúci sa dostane rovno na správanie po vyčerpaní plánu.",
    });
    return advisories;
  }

  if (!operators.size && !numbers.size) {
    advisories.push({
      tone: "error",
      title: "Plán zvonenia nemá koho volať",
      text: "Skupiny v pláne sú prázdne alebo vypnuté, takže pri hovore nezazvoní žiadny telefón.",
    });
  }

  // The escalation is the one thing here that spends money on its own.
  const escalateSeconds = typeof input.escalateAfterSeconds === "number" ? input.escalateAfterSeconds : DEFAULT_ESCALATE_AFTER_SECONDS;
  if (numbers.size && escalateSeconds > 0) {
    const shown = [...numbers].map((number) => formatPhoneNumberForDisplay(number) || number).join(", ");
    advisories.push({
      tone: "info",
      title: "Keď nikto nedvíha, skúsi sa záložné číslo",
      text: `Ak ${Math.round(escalateSeconds / 60)} min nie je voľný nikto z operátorov, systém raz vytočí ${shown}. Je to bežný hovor a účtuje sa. Raz za hovor, nie opakovane.`,
    });
  } else if (numbers.size) {
    // Turned off deliberately: say so, rather than let the configured number
    // look as if it were in play.
    advisories.push({
      tone: "warning",
      title: "Záložné číslo sa nikdy nevytočí",
      text: park
        ? `Skúšanie záložného čísla je vypnuté (0 minút). Keď sa nikto z operátorov neuvoľní, volajúci dočaká ${minutes(park)} a dostane ponuku spätného volania. Nastavené záložné čísla sa v čakárni nepoužijú.`
        : "Skúšanie záložného čísla je vypnuté (0 minút), takže sa v čakárni nepoužije.",
    });
  } else {
    advisories.push({
      tone: "warning",
      title: "Nie je kam eskalovať",
      text: park
        ? `Žiadna skupina nemá záložné telefónne číslo. Keď sa nikto z operátorov neuvoľní, volajúci počúva hudbu celých ${minutes(park)} a potom dostane ponuku spätného volania. Nikomu ďalšiemu sa nezavolá.`
        : "Žiadna skupina nemá záložné telefónne číslo, takže keď sa nikto z operátorov neuvoľní, nikomu ďalšiemu sa nezavolá.",
    });
  }

  const onMobile = input.operators.filter((operator) => operator.active && operator.settings?.deliveryMode === "personal_mobile");
  const mobileWithoutNumber = onMobile.filter((operator) => !operator.settings?.defaultMobileNumber);
  if (mobileWithoutNumber.length) {
    advisories.push({
      tone: "error",
      title: "Doručovanie na mobil bez čísla",
      text: `${mobileWithoutNumber.map((operator) => operator.displayName).join(", ")} má nastavené doručovanie na vlastný telefón, ale číslo doplnené nemá. Hovor sa im nedoručí a prepojiť na nich nejde.`,
    });
  }
  const mobileReady = onMobile.filter((operator) => operator.settings?.defaultMobileNumber);
  if (mobileReady.length) {
    advisories.push({
      tone: "info",
      title: "Niektorí operátori berú hovory na vlastnom telefóne",
      text: `${mobileReady.map((operator) => operator.displayName).join(", ")}. Ich hovory idú na bežné číslo a účtujú sa; prehliadač na ne nepotrebujú.`,
    });
  }

  if (park) {
    advisories.push({
      tone: "info",
      title: "Ako dlho volajúci čaká",
      text: `Najviac ${minutes(park)}. Potom dostane ponuku spätného volania a hovor sa ukončí.`,
    });
  }

  // A step that rings "everybody" stops at the cap, quietly.
  const cap = input.maxRingFanout && input.maxRingFanout > 0 ? input.maxRingFanout : null;
  if (cap) {
    const groupsById = new Map(input.groups.map((group) => [group.id, group]));
    const truncated = new Set<string>();
    for (const plan of activePlans) {
      for (const step of plan.steps) {
        if (step.strategy !== "all") continue;
        const group = groupsById.get(step.ringGroupId);
        if (group && group.members.length > cap) truncated.add(group.name);
      }
    }
    if (truncated.size) {
      advisories.push({
        tone: "warning",
        title: "Nezazvonia všetci naraz",
        text: `Skupiny ${[...truncated].join(", ")} majú viac členov, než je strop súčasne zvoniacich zariadení (${cap}). Ostatní v tom kroku nezazvonia vôbec.`,
      });
    }
  }

  return advisories;
}
