import { useState } from "react";
import { Text } from "react-native";
import { Button, Card, ErrorNotice, styles } from "../ui";
import { formatNumber } from "../lib/display";
import type { CaseDraft, DraftState } from "./draft";
import { useForegroundVisit } from "../ui/foreground-visit";

export function CallPhoneOffer({ draft, state, number, active, onDone }: {
  draft: CaseDraft; state: DraftState; number: string; active: boolean; onDone: () => void;
}) {
  const visit = useForegroundVisit(active), [error, setError] = useState<string | null>(null);
  const previous = state.input.contactPhone ?? "";
  return <Card><Text style={styles.subheading}>Číslo z hovoru</Text><Text selectable style={styles.text}>{formatNumber(number)}</Text>
    <Text style={styles.muted}>{previous ? "Vo formulári je " + formatNumber(previous) + ". Potvrdením nahradíte iba tento telefón." : "Potvrďte vloženie telefónu zákazníka. Ostatné rozpracované údaje zostanú zachované."}</Text>
    {state.status !== "editing" && <Text style={styles.muted}>Najskôr dokončite alebo overte pôvodné uloženie prípadu.</Text>}
    {error && <ErrorNotice message={error} />}
    <Button label={previous ? "Nahradiť telefón číslom z hovoru" : "Vložiť číslo z hovoru"} disabled={!active || !draft.canApplyCallPhone()} onPress={() => {
      if (!visit.current()) return;
      if (draft.applyCallPhone(number, previous)) onDone();
      else setError("Koncept alebo telefón sa medzitým zmenil. Skontrolujte údaje a skúste znova.");
    }} />
    {state.status === "saved" && <Button label="Pripraviť nový koncept" secondary disabled={!active} onPress={() => { if (visit.current()) draft.newDraft(); }} />}
    <Button label="Pokračovať bez prenosu čísla" secondary onPress={() => { if (visit.current()) onDone(); }} />
  </Card>;
}
