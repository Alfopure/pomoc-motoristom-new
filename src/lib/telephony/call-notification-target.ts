import type { PhoneBarCall, PhoneBarModel } from "./active-calls-model";
import { matchesIncomingBrowserInvite } from "./browser-invite";
import { canPickUpCall } from "./call-pickup";
import { canPickUpWithCurrentPresence } from "./call-pickup-presence";
import type { WebphoneSnapshot } from "./telnyx-webphone";

export type CallNotificationFocus = { sessionId: string; snapshotAtOpen: string };

export type CallNotificationTarget = {
  call: PhoneBarCall | null;
  message: string;
  canAnswer: boolean;
  canPickup: boolean;
  canReconnect: boolean;
};

/** Only current authenticated state may enable a call notification's actions. */
export function callNotificationTarget(input: {
  focus: CallNotificationFocus;
  model?: PhoneBarModel;
  phone?: WebphoneSnapshot;
  configured: boolean;
  stale: boolean;
  busy: boolean;
  outboundPending: boolean;
}): CallNotificationTarget {
  const empty = { call: null, canAnswer: false, canPickup: false, canReconnect: false };
  if (!input.configured) return { ...empty, message: "Telefónia zatiaľ nie je dostupná. Skontrolujte pripojenie a obnovte stav hovoru." };
  if (input.stale) return { ...empty, message: "Aktuálny stav hovoru sa nepodarilo načítať. Obnovte ho pred prevzatím." };
  if (!input.model?.checkedAt || input.model.checkedAt === input.focus.snapshotAtOpen) {
    return { ...empty, message: "Overujem aktuálny stav hovoru…" };
  }
  const call = input.model.teamCalls.find((candidate) => candidate.sessionId === input.focus.sessionId) ?? null;
  if (!call) return { ...empty, message: "Hovor už nie je dostupný. Mohol sa skončiť alebo už nepatrí do vášho prehľadu." };
  const browser = input.phone?.call;
  const matches = Boolean(browser && (browser.sessionId
    ? browser.sessionId === call.sessionId
    : browser.telnyxCallControlId && call.browserCallControlIds?.includes(browser.telnyxCallControlId)));
  const busy = input.busy || input.outboundPending || Boolean(input.phone?.answering) || (input.phone?.pendingOperatorLegs ?? 0) > 0;
  const registered = input.phone?.status === "registered" || Boolean(input.phone?.onDemand && input.phone.status === "idle");
  const canReconnect = !busy && !browser && ["idle", "failed", "superseded"].includes(input.phone?.status ?? "");
  const base = { ...empty, call };
  // Internal, transfer and conference legs do not necessarily have a queue
  // ring attempt. The exact live browser invite is the evidence that this
  // actor can answer, even while the shared session already says "active".
  if (matchesIncomingBrowserInvite(call, browser)) return {
    ...base,
    canAnswer: registered && !busy,
    message: input.phone?.answering ? "Hovor sa prijíma…" : !registered
      ? "Čakám na pripojenie telefónu. Potom môžete tento hovor prijať."
      : busy ? "Počkajte na dokončenie rozpracovanej akcie telefónu."
        : "Hovor zvoní na tomto telefóne. Prijatie potvrďte tlačidlom.",
  };
  if (matches && browser?.active) return { ...base, message: "Hovor sa pripája alebo už prebieha. Ovládanie je v hornej lište." };
  if (call.browserIncomingCallControlIds?.length && !canPickUpCall(call)) {
    if (input.phone?.onDemand && !browser && !busy && registered && canPickUpWithCurrentPresence(input.model, { ...call, offeredToMe: true })) return { ...base, canPickup: true, message: "Pozvánka na hovor stále platí. Prijatie potvrďte v appke." };
    if (browser) return { ...base, message: "Tento telefón má iný hovor. Upozornenie sa týka vyššie uvedeného volajúceho." };
    if (!registered) return { ...base, canReconnect, message: "Pripojte telefón v tejto aplikácii. Hovor prijmete, keď tu začne zvoniť." };
    return { ...base, message: "Čakám, kým hovor začne zvoniť na tomto telefóne. Samotné upozornenie ho neprijíma." };
  }
  if (call.kind === "active") {
    return { ...base, message: call.mine ? "Hovor už prebieha na vašom druhom zariadení." : call.operatorName ? `Hovor už vybavuje ${call.operatorName}.` : "Hovor už prevzal iný operátor." };
  }
  if (canPickUpCall(call)) {
    if (browser && !matches) return { ...base, message: "Tento telefón má iný hovor. Upozornenie sa týka vyššie uvedeného volajúceho." };
    if (browser || input.model.active || busy) return { ...base, message: "Najprv dokončite svoj rozpracovaný hovor alebo počkajte na jeho spojenie." };
    if (!registered) return { ...base, canReconnect, message: "Hovor možno prevziať. Najprv pripojte telefón v tejto aplikácii." };
    if (!canPickUpWithCurrentPresence(input.model, call)) return { ...base, message: "Pre prevzatie tohto hovoru musíte byť dostupný alebo mať rezervované jeho zvonenie." };
    return { ...base, canPickup: true, message: call.kind === "waiting"
      ? "Hovor stále čaká na operátora. Prevzatie potvrďte tlačidlom."
      : "Prichádzajúci hovor možno prevziať na tomto telefóne. Prevzatie potvrďte tlačidlom." };
  }
  if (call.kind === "offer") {
    if (!call.offeredToMe) return { ...base, message: "Hovor teraz zvoní inému operátorovi. Jeho stav sa priebežne aktualizuje." };
    if (browser && !matches) return { ...base, message: "Tento telefón má iný hovor. Upozornenie sa týka vyššie uvedeného volajúceho." };
    if (!registered) return { ...base, canReconnect, message: "Pripojte telefón v tejto aplikácii. Hovor prijmete, keď tu začne zvoniť." };
    return { ...base, message: "Čakám, kým hovor začne zvoniť na tomto telefóne. Samotné upozornenie ho neprijíma." };
  }
  return { ...base, message: "Tento hovor momentálne nemožno prevziať. Obnovte jeho aktuálny stav." };
}
