"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CallCenterCall } from "@/data/dispatch-types";
import type { Operator } from "@/domain/types";
import {
  buildPhoneBarModel,
  EMPTY_ACTIVE_CALLS,
  liveCallCenterCalls,
  pollActivityInput,
  waitingRoomCalls,
  type ActiveCallsPayload,
  type PhoneBarModel,
} from "@/lib/telephony/active-calls-model";
import { telephonyJson, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";
import { TELEPHONY_NOT_CONFIGURED_MESSAGE } from "@/lib/telephony/not-configured";
import { activeCallPollDelayMs, telephonyPollActivity } from "@/lib/telephony/poll-schedule";
import {
  deriveTelephonyOperatorPresences,
  type TelephonyAvailabilityAction,
  type TelephonyOperatorPresence,
} from "@/lib/telephony/presence";
import { TelnyxWebphone, type WebphoneSnapshot } from "@/lib/telephony/telnyx-webphone";
import { WEBPHONE_INITIAL_STATE, webphoneRegistrationView } from "@/lib/telephony/webphone-model";

import type { TransferRequest } from "./CallTransferPicker";
import type { PhonePauseReason, PhonePresenceAction } from "./PhoneBar";
import { PHONE_ACTION_ERRORS, type PhoneCallAction } from "./phone-bar-model";

/**
 * All telephony wiring of the dispatch console in one place: the browser
 * phone's lifecycle, the `calls/active` poll, presence and the call actions.
 *
 * It is a hook rather than console state because `DispatchConsole.tsx` is
 * already 2 000 lines of case management; the telephony surface it consumes is
 * exactly the object returned here, and every decision inside is delegated to
 * the pure models (`active-calls-model.ts`, `webphone-model.ts`,
 * `phone-bar-model.ts`) that are unit-tested.
 *
 * Not-configured mode is a first-class outcome, not an error: any 503 from a
 * telephony route parks the whole surface (`configured === false`), the console
 * keeps its "Telefónia nie je nakonfigurovaná" notice and nothing polls.
 */

const IDLE_SNAPSHOT: WebphoneSnapshot = {
  status: WEBPHONE_INITIAL_STATE.status,
  registration: webphoneRegistrationView(WEBPHONE_INITIAL_STATE),
  sipUsername: null,
  deviceSessionId: null,
  call: null,
  message: null,
};

export type TelephonyConsole = {
  /** `null` until the first answer arrives. */
  configured: boolean | null;
  snapshot: ActiveCallsPayload;
  phoneBar: PhoneBarModel;
  phone: WebphoneSnapshot;
  presences: TelephonyOperatorPresence[];
  pauseReasons: PhonePauseReason[];
  presenceBusy: boolean;
  busyAction: string | null;
  notice: string | null;
  degradedSessionIds: Set<string>;
  liveCalls: CallCenterCall[];
  waitingCalls: CallCenterCall[];
  dial: (phone: string, caseId?: string) => Promise<void>;
  callAction: (action: PhoneCallAction, sessionId: string, target?: TransferRequest) => Promise<void>;
  changePresence: (action: PhonePresenceAction) => void;
  availabilityAction: (action: TelephonyAvailabilityAction) => void;
  answer: () => void;
  hangupBrowser: () => void;
  toggleMute: () => void;
  sendDtmf: (digit: string) => void;
  unlockAudio: () => void;
  dismissNotice: () => void;
  refresh: () => void;
};

type PresenceResponse = {
  error?: string;
  pauseReasons?: Array<{ id: string; code: string; label: string }>;
  own?: { status?: string } | null;
};

export function useTelephonyConsole(input: { enabled: boolean; operators: Operator[] }): TelephonyConsole {
  const { enabled, operators } = input;
  const [configured, setConfigured] = useState<boolean | null>(enabled ? null : false);
  const [snapshot, setSnapshot] = useState<ActiveCallsPayload>(EMPTY_ACTIVE_CALLS);
  const [phone, setPhone] = useState<WebphoneSnapshot>(IDLE_SNAPSHOT);
  const [pauseReasons, setPauseReasons] = useState<PhonePauseReason[]>([]);
  const [presenceBusy, setPresenceBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [degraded, setDegraded] = useState<Set<string>>(() => new Set());
  const webphoneRef = useRef<TelnyxWebphone | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);

  // --- browser phone ---------------------------------------------------------

  useEffect(() => {
    if (!enabled) return;
    const webphone = new TelnyxWebphone();
    webphoneRef.current = webphone;
    const unsubscribe = webphone.subscribe((next) => {
      setPhone(next);
      if (next.status === "not_configured") setConfigured(false);
    });
    webphone.start();
    return () => {
      unsubscribe();
      webphone.stop();
      webphoneRef.current = null;
      setPhone(IDLE_SNAPSHOT);
    };
  }, [enabled]);

  // --- active calls poll -----------------------------------------------------

  useEffect(() => {
    if (!enabled || configured === false) return;

    let cancelled = false;
    let timeoutId: number | undefined;
    let inFlight = false;
    let failures = 0;
    let activity: Parameters<typeof activeCallPollDelayMs>[0]["activity"] = "idle";

    async function load() {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await telephonyJson<ActiveCallsPayload & { error?: string }>("/api/telephony/calls/active", {
          label: "aktívne hovory",
          timeoutMs: TELEPHONY_TIMEOUT_MS.snapshot,
        });
        if (cancelled) return;
        if (result.status === 503) {
          setConfigured(false);
          return;
        }
        if (!result.ok || !result.body || !Array.isArray(result.body.calls)) {
          failures += 1;
          return;
        }
        failures = 0;
        setConfigured(true);
        setSnapshot(result.body);
        activity = telephonyPollActivity(pollActivityInput(buildPhoneBarModel(result.body)));
      } catch {
        failures += 1;
      } finally {
        inFlight = false;
      }
    }

    function schedule() {
      if (cancelled) return;
      timeoutId = window.setTimeout(async () => {
        await load();
        schedule();
      }, activeCallPollDelayMs({ activity, documentHidden: document.visibilityState === "hidden", consecutiveFailures: failures }));
    }

    const refresh = () => {
      void load();
    };
    refreshRef.current = refresh;
    void load();
    schedule();

    const onVisible = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      refreshRef.current = null;
      document.removeEventListener("visibilitychange", onVisible);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [configured, enabled]);

  // --- presence --------------------------------------------------------------

  useEffect(() => {
    if (!enabled || configured === false) return;
    const controller = new AbortController();

    // Pause reasons and the operator's own status only change when a human
    // changes them, so this is a one-shot read refreshed after every write.
    async function loadPresence() {
      const result = await telephonyJson<PresenceResponse>("/api/telephony/presence", {
        label: "prezencia",
        signal: controller.signal,
        timeoutMs: TELEPHONY_TIMEOUT_MS.read,
      }).catch(() => null);
      if (!result || controller.signal.aborted) return;
      if (result.status === 503) {
        setConfigured(false);
        return;
      }
      if (result.ok && Array.isArray(result.body?.pauseReasons)) {
        setPauseReasons(result.body.pauseReasons.map((reason) => ({ id: reason.id, code: reason.code, label: reason.label })));
      }
    }

    void loadPresence();
    return () => controller.abort();
  }, [configured, enabled]);

  const changePresence = useCallback(
    (action: PhonePresenceAction) => {
      if (presenceBusy) return;
      setPresenceBusy(true);
      setNotice(null);
      void (async () => {
        try {
          const result = await telephonyJson<{ error?: string }>("/api/telephony/presence", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: action.status, pauseReasonId: action.pauseReasonId }),
            label: "zmena dostupnosti",
            timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
          });
          if (result.status === 503) {
            setConfigured(false);
            setNotice(TELEPHONY_NOT_CONFIGURED_MESSAGE);
            return;
          }
          if (!result.ok) throw new Error(result.body?.error ?? "Stav sa nepodarilo uložiť.");
          refreshRef.current?.();
        } catch (error) {
          setNotice(error instanceof Error ? error.message : "Stav sa nepodarilo uložiť.");
        } finally {
          setPresenceBusy(false);
        }
      })();
    },
    [presenceBusy],
  );

  const availabilityAction = useCallback(
    (action: TelephonyAvailabilityAction) => {
      changePresence({ status: action === "pause" ? "paused" : action });
    },
    [changePresence],
  );

  // --- call actions ----------------------------------------------------------

  const callAction = useCallback(
    async (action: PhoneCallAction, sessionId: string, target?: TransferRequest) => {
      if (busyAction) return;
      setBusyAction(action);
      setNotice(null);
      try {
        const result = await telephonyJson<{ error?: string; code?: string }>(
          `/api/telephony/calls/${encodeURIComponent(sessionId)}/${action}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(target ?? {}),
            label: PHONE_ACTION_LABEL_FOR_REQUEST[action],
            timeoutMs: TELEPHONY_TIMEOUT_MS.control,
          },
        );
        if (result.status === 503) {
          setConfigured(false);
          setNotice(TELEPHONY_NOT_CONFIGURED_MESSAGE);
          return;
        }
        if (!result.ok) {
          // A refused conference promotion keeps the call up but takes hold and
          // consultation away; remember it so the bar stops offering them
          // instead of failing the same way again (design §2.1).
          if (result.status === 502 && (action === "hold" || action === "consult")) {
            setDegraded((current) => new Set(current).add(sessionId));
          }
          throw new Error(result.body?.error ?? PHONE_ACTION_ERRORS[action]);
        }
        if (action === "unhold") {
          setDegraded((current) => {
            if (!current.has(sessionId)) return current;
            const next = new Set(current);
            next.delete(sessionId);
            return next;
          });
        }
        refreshRef.current?.();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : PHONE_ACTION_ERRORS[action]);
      } finally {
        setBusyAction(null);
      }
    },
    [busyAction],
  );

  const dial = useCallback(async (phoneNumber: string, caseId?: string) => {
    setNotice(null);
    const result = await telephonyJson<{ error?: string; sessionId?: string; operatorLegCallControlId?: string }>(
      "/api/telephony/calls",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: phoneNumber, caseId }),
        label: "odchádzajúci hovor",
        timeoutMs: TELEPHONY_TIMEOUT_MS.control,
      },
    );
    if (result.status === 503) {
      setConfigured(false);
      setNotice(TELEPHONY_NOT_CONFIGURED_MESSAGE);
      throw new Error(TELEPHONY_NOT_CONFIGURED_MESSAGE);
    }
    if (!result.ok || !result.body?.sessionId) {
      const message = result.body?.error ?? "Hovor sa nepodarilo vytočiť.";
      setNotice(message);
      throw new Error(message);
    }
    // The operator's own leg is dialled first; the browser must answer exactly
    // that invite (matched on `telnyxCallControlId`, design §2.2).
    if (result.body.operatorLegCallControlId) {
      webphoneRef.current?.expectOperatorLeg({
        callControlId: result.body.operatorLegCallControlId,
        sessionId: result.body.sessionId,
      });
    }
    refreshRef.current?.();
  }, []);

  // --- derived ---------------------------------------------------------------

  const phoneBar = useMemo(() => buildPhoneBarModel(snapshot), [snapshot]);
  const operatorName = useCallback(
    (profileId: string) => operators.find((operator) => operator.id === profileId)?.name,
    [operators],
  );
  // The snapshot's own timestamp is the clock for derived durations: it keeps
  // every row consistent with the data it was computed from and keeps this
  // memo pure across re-renders.
  const checkedAt = useMemo(() => {
    const parsed = Date.parse(snapshot.checkedAt);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [snapshot.checkedAt]);
  const liveCalls = useMemo(
    () => liveCallCenterCalls(snapshot, { now: checkedAt, operatorName }),
    [checkedAt, operatorName, snapshot],
  );
  const waitingCalls = useMemo(
    () => waitingRoomCalls(snapshot, { now: checkedAt, operatorName }),
    [checkedAt, operatorName, snapshot],
  );
  const presences = useMemo(() => {
    // Without a provider the presence list is informational only, and it has
    // to say so rather than claim the operators are "not in telephony".
    if (configured !== true) {
      return operators.map((operator) => ({
        profileId: operator.id,
        operatorName: operator.name,
        extensions: [],
        state: "unassigned" as const,
        available: false,
        queueMember: false,
        queueNumbers: [],
        availableQueues: [],
        paused: false,
        inUse: false,
        registered: false,
        detail: TELEPHONY_NOT_CONFIGURED_MESSAGE,
      }));
    }
    return deriveTelephonyOperatorPresences({ operators, snapshot: snapshot.presence });
  }, [configured, operators, snapshot.presence]);

  const refresh = useCallback(() => {
    refreshRef.current?.();
  }, []);
  // Stable identities: the PhoneBar registers window listeners keyed on them.
  const answer = useCallback(() => webphoneRef.current?.answer(), []);
  const hangupBrowser = useCallback(() => void webphoneRef.current?.hangup(), []);
  const toggleMute = useCallback(() => webphoneRef.current?.toggleMute(), []);
  const sendDtmf = useCallback((digit: string) => webphoneRef.current?.sendDtmf(digit), []);
  const unlockAudio = useCallback(() => void webphoneRef.current?.unlockAudio(), []);
  const dismissNotice = useCallback(() => setNotice(null), []);

  return {
    configured,
    snapshot,
    phoneBar,
    phone,
    presences,
    pauseReasons,
    presenceBusy,
    busyAction,
    notice,
    degradedSessionIds: degraded,
    liveCalls,
    waitingCalls,
    dial,
    callAction,
    changePresence,
    availabilityAction,
    answer,
    hangupBrowser,
    toggleMute,
    sendDtmf,
    unlockAudio,
    dismissNotice,
    refresh,
  };
}

const PHONE_ACTION_LABEL_FOR_REQUEST: Record<PhoneCallAction, string> = {
  hold: "podržanie hovoru",
  unhold: "obnovenie hovoru",
  park: "odloženie hovoru",
  pickup: "prevzatie hovoru",
  transfer: "prepojenie hovoru",
  consult: "konzultácia",
  "complete-transfer": "dokončenie prepojenia",
  "cancel-consult": "zrušenie konzultácie",
  hangup: "ukončenie hovoru",
};
