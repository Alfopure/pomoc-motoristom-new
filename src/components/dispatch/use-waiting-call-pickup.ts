"use client";

import { useEffect, useRef, useState } from "react";

import type { CallCenterCall } from "@/data/dispatch-types";
import {
  resolveIncomingBrowserProviderCall,
  sameTelephonyCallIdentity,
  type TelephonyExtensionIdentity,
} from "@/lib/telephony/call-endpoints";
import { telephonyFetch, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";
import {
  requireConfirmedTelephonyCommand,
  waitForTelephonyCommand,
} from "@/lib/telephony/commands";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import type { ViptelBrowserWebphone, WorkplaceWebphoneSessionFence } from "@/lib/telephony/webphone-client";
import { WAITING_PICKUP_PHASE_DEADLINE_MS } from "./busy-actions";

/**
 * Owns taking a waiting call over onto this browser's workstation.
 *
 * This used to live inside CallCenterModule, which meant the waiting room only
 * worked while the operator had the Ústredňa view open. The queue is now shown
 * on every view, so the logic has to be owned above it and shared by both
 * surfaces -- there must be exactly one pickup in flight per browser, no matter
 * which panel started it.
 */

export type WaitingCallPickup = {
  call: CallCenterCall;
  phase: "answering" | "releasing_current" | "redirecting" | "waiting_for_phone";
  startedAt: number;
};

export type WaitingCallPickupAction = {
  disabled: boolean;
  label: string;
  reason?: string;
};

type EnqueuedCommandResponse = {
  command?: { id: string; status: string };
  error?: string;
  ok?: boolean;
  requestId?: string;
};

export type WaitingCallPickupInput = {
  activeCalls: CallCenterCall[];
  browserWebphone: ViptelBrowserWebphone;
  controlStations: TelephonyExtensionIdentity[];
  currentControlStation?: TelephonyExtensionIdentity;
  defaultExtension: string;
  workplaceFence?: WorkplaceWebphoneSessionFence;
  workplacePhoneMutationPending: boolean;
  onNotice: (message: string | null) => void;
  onTelephonyChanged: () => void;
};

export type WaitingCallPickupController = {
  waitingCallPickup: WaitingCallPickup | null;
  waitingCallPickupState: (call: CallCenterCall) => WaitingCallPickupAction;
  pickupWaitingCall: (call: CallCenterCall) => Promise<void>;
};

export function useWaitingCallPickup(input: WaitingCallPickupInput): WaitingCallPickupController {
  const {
    activeCalls,
    browserWebphone,
    controlStations,
    currentControlStation,
    defaultExtension,
    workplaceFence,
    workplacePhoneMutationPending,
    onNotice,
    onTelephonyChanged,
  } = input;
  const [waitingCallPickup, setWaitingCallPickup] = useState<WaitingCallPickup | null>(null);
  const answerInFlightRef = useRef(false);
  const browserCallStatus = browserWebphone.callStatus;
  const answerBrowserCall = browserWebphone.answer;

  // The provider confirms the move slightly before the browser rings. Answer
  // exactly the call that was taken over, never whatever happens to ring next.
  useEffect(() => {
    if (!waitingCallPickup || waitingCallPickup.phase !== "waiting_for_phone") return;
    if (browserCallStatus !== "incoming") return;
    const incoming = resolveIncomingBrowserProviderCall(activeCalls, currentControlStation, controlStations);
    if (!incoming || !sameTelephonyCallIdentity(incoming, waitingCallPickup.call)) return;
    if (answerInFlightRef.current) return;

    answerInFlightRef.current = true;
    setWaitingCallPickup((current) => current && sameTelephonyCallIdentity(current.call, waitingCallPickup.call)
      ? { ...current, phase: "answering" }
      : current);
    void answerBrowserCall()
      .then(() => {
        onNotice(`Hovor od ${formatPhoneNumberForDisplay(customerNumberForCall(waitingCallPickup.call))} je prijatý.`);
        setWaitingCallPickup(null);
        onTelephonyChanged();
      })
      .catch((error: unknown) => {
        onNotice(messageFromError(error, "Hovor je na tvojom pracovisku, ale prehliadač ho neprijal. Použi tlačidlo Prijať pri hovore."));
        setWaitingCallPickup(null);
      })
      .finally(() => {
        answerInFlightRef.current = false;
      });
  }, [
    activeCalls,
    answerBrowserCall,
    browserCallStatus,
    controlStations,
    currentControlStation,
    onNotice,
    onTelephonyChanged,
    waitingCallPickup,
  ]);

  // Every phase is bounded. `redirecting` awaits command confirmation and
  // `releasing_current` awaits a local decline; when either never settled the
  // whole waiting room stayed locked with no cancel anywhere on screen.
  useEffect(() => {
    if (!waitingCallPickup) return;
    const remaining = Math.max(
      0,
      waitingCallPickup.startedAt + WAITING_PICKUP_PHASE_DEADLINE_MS[waitingCallPickup.phase] - Date.now(),
    );
    const timeout = window.setTimeout(() => {
      setWaitingCallPickup((current) => {
        if (!current || !sameTelephonyCallIdentity(current.call, waitingCallPickup.call)) return current;
        onNotice(waitingCallPickup.phase === "waiting_for_phone"
          ? "VIPTel presun potvrdil, ale zvonenie v prehliadači sa neobjavilo včas. Obnov pracovisko; hovor nepreberaj opakovane naslepo."
          : "Prevzatie hovoru sa nepotvrdilo včas. Čakáreň je znova odomknutá; over stav pred ďalším pokusom.");
        return null;
      });
    }, remaining);
    return () => window.clearTimeout(timeout);
  }, [onNotice, waitingCallPickup]);

  function waitingCallPickupState(call: CallCenterCall): WaitingCallPickupAction {
    const pending = Boolean(waitingCallPickup);
    if (waitingCallPickup && sameTelephonyCallIdentity(waitingCallPickup.call, call)) {
      return {
        disabled: true,
        label: waitingCallPickup.phase === "answering"
          ? "Prijímam…"
          : waitingCallPickup.phase === "releasing_current"
            ? "Uvoľňujem linku…"
            : "Presúvam…",
        reason: "Hovor sa práve bezpečne presúva na tvoje pracovisko.",
      };
    }
    if (pending) {
      // A pickup merely waiting on the provider or the phone must not dead-lock
      // every other caller: the operator can abandon it and choose a different
      // call. Only the two short phases actively mutating this browser's own
      // line stay blocking.
      const switchable = waitingCallPickup?.phase === "redirecting" ||
        waitingCallPickup?.phase === "waiting_for_phone";
      return switchable
        ? {
          disabled: false,
          label: "Zrušiť a vybrať tento",
          reason: "Prebiehajúce prevzatie sa zruší a prevezme sa tento hovor.",
        }
        : { disabled: true, label: "Prevziať", reason: "Najprv dokonči prevzatie vybraného hovoru." };
    }
    if (!looksLikeUuid(call.id)) return { disabled: true, label: "Prevziať", reason: "Hovor ešte čaká na zápis bezpečnej identity." };
    if (!defaultExtension || !currentControlStation) return { disabled: true, label: "Prevziať", reason: "Najprv si vyber pracovné miesto." };
    if (workplacePhoneMutationPending) return { disabled: true, label: "Prevziať", reason: "Najprv dokonči zmenu pracovného miesta." };
    if (!browserWebphone.isRegistered) return { disabled: true, label: "Prevziať", reason: "Telefón v prehliadači ešte nie je pripojený." };

    const incoming = resolveIncomingBrowserProviderCall(activeCalls, currentControlStation, controlStations);
    const alreadyRingingHere = browserWebphone.callStatus === "incoming" &&
      Boolean(incoming && sameTelephonyCallIdentity(incoming, call));
    if (alreadyRingingHere) return { disabled: false, label: "Prijať", reason: "Tento hovor už zvoní na tvojom pracovisku." };
    if (browserWebphone.callStatus === "incoming") {
      return {
        disabled: false,
        label: "Vybrať tento",
        reason: "Aktuálne zvonenie zostane v čakárni a na toto pracovisko sa presunie vybraný hovor.",
      };
    }
    if (browserWebphone.hasActiveCall) {
      return { disabled: true, label: "Prevziať", reason: "Najprv dokonči už spojený alebo odchádzajúci hovor." };
    }
    return { disabled: false, label: "Prevziať", reason: "Presunúť tento hovor na moje pracovisko a prijať ho." };
  }

  async function pickupWaitingCall(call: CallCenterCall) {
    const state = waitingCallPickupState(call);
    if (state.disabled || !currentControlStation) {
      if (state.reason) onNotice(state.reason);
      return;
    }

    // Abandoning a pickup that is waiting on the provider or the phone is a
    // local decision only: no command is retracted, the previous caller simply
    // stays in the waiting room and this browser stops waiting for it.
    if (waitingCallPickup && !sameTelephonyCallIdentity(waitingCallPickup.call, call)) {
      setWaitingCallPickup(null);
    }

    const incoming = resolveIncomingBrowserProviderCall(activeCalls, currentControlStation, controlStations);
    if (
      browserWebphone.callStatus === "incoming" &&
      incoming &&
      sameTelephonyCallIdentity(incoming, call)
    ) {
      setWaitingCallPickup({ call, phase: "answering", startedAt: Date.now() });
      onNotice(null);
      try {
        await browserWebphone.answer();
        onNotice(`Hovor od ${formatPhoneNumberForDisplay(customerNumberForCall(call))} je prijatý.`);
        onTelephonyChanged();
      } catch (error) {
        onNotice(messageFromError(error, "Hovor sa v prehliadači nepodarilo prijať."));
      } finally {
        setWaitingCallPickup(null);
      }
      return;
    }

    const mustReleaseCurrentOffer = browserWebphone.callStatus === "incoming";
    if (mustReleaseCurrentOffer) {
      const capturedCall = browserWebphone.captureCallSession();
      if (!capturedCall) {
        onNotice("Aktuálne zvonenie sa už zmenilo. Obnov čakáreň a vyber hovor znova.");
        return;
      }
      setWaitingCallPickup({ call, phase: "releasing_current", startedAt: Date.now() });
      onNotice("Aktuálny volajúci zostáva v čakárni. Uvoľňujem telefón pre vybraný hovor…");
      try {
        const released = await browserWebphone.declineCapturedCall(capturedCall);
        if (!released) throw new Error("Aktuálne zvonenie sa medzitým zmenilo.");
      } catch (error) {
        setWaitingCallPickup(null);
        onNotice(messageFromError(error, "Telefón sa nepodarilo bezpečne uvoľniť pre vybraný hovor."));
        return;
      }
    }

    setWaitingCallPickup({ call, phase: "redirecting", startedAt: Date.now() });
    onNotice(`Presúvam hovor od ${formatPhoneNumberForDisplay(customerNumberForCall(call))} na tvoje pracovisko…`);
    try {
      let result: EnqueuedCommandResponse | null = null;
      let responseOk = false;
      for (let attempt = 0; attempt < (mustReleaseCurrentOffer ? 3 : 1); attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 600 * attempt));
        const response = await telephonyFetch(`/api/telephony/calls/${encodeURIComponent(call.id)}/pickup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetExtension: currentControlStation.extension, ...workplaceFence }),
          label: "prevzatie hovoru",
          timeoutMs: TELEPHONY_TIMEOUT_MS.control,
        });
        result = (await response.json().catch(() => null)) as EnqueuedCommandResponse | null;
        responseOk = response.ok && Boolean(result?.command?.id);
        const providerStillReleasing = response.status === 409 &&
          result?.error?.includes("už zvoní alebo prebieha iný hovor");
        if (responseOk || !providerStillReleasing) break;
      }
      if (!responseOk || !result?.command?.id) {
        throw new Error(result?.error ?? "Hovor sa nepodarilo prevziať z čakárne.");
      }
      if (!result.command?.id) throw new Error(result.error ?? "Telefónny príkaz sa nevytvoril.");
      requireConfirmedTelephonyCommand(await waitForTelephonyCommand(result.command.id));
      setWaitingCallPickup((current) => current && sameTelephonyCallIdentity(current.call, call)
        ? { ...current, phase: "waiting_for_phone", startedAt: Date.now() }
        : current);
      onNotice("VIPTel presun potvrdil. Čakám na presné zvonenie v tvojom prehliadači a potom hovor prijmem.");
      onTelephonyChanged();
    } catch (error) {
      setWaitingCallPickup(null);
      onNotice(messageFromError(error, "Hovor sa nepodarilo prevziať z čakárne."));
      onTelephonyChanged();
    }
  }

  return { waitingCallPickup, waitingCallPickupState, pickupWaitingCall };
}

export function customerNumberForCall(call: Pick<CallCenterCall, "calledNumber" | "callerNumber" | "direction">) {
  return call.direction === "outbound" ? call.calledNumber : call.callerNumber;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function looksLikeUuid(value: string) {
  return UUID_PATTERN.test(value);
}

function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
