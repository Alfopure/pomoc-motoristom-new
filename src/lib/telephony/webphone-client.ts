"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Session, SessionState, UserAgent, Web } from "sip.js";
import {
  browserCallSessionFenceMatches,
  captureBrowserCallSession,
  type BrowserCallSessionFence,
} from "@/lib/telephony/browser-call-session";
import { telephonyFetch, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";
import {
  buildDtmfTransferPlan,
  type DtmfTransferMode,
} from "@/lib/telephony/dtmf-transfer";
import {
  assertAuthorizedBrowserDtmfCall,
  captureBrowserDtmfSession,
  deliverFencedBrowserDtmfTransfer,
  type BrowserDtmfSessionFence,
} from "@/lib/telephony/webphone-dtmf-session";
import {
  isViptelWebphoneReadyForBrowser,
  type ViptelWebphoneConfig,
  type ViptelWebphoneIceServer,
  type ViptelWebphoneSession,
} from "@/lib/telephony/webphone";
import { formatViptelDialTarget } from "@/lib/telephony/phone";
import { sendSipReferAndAwaitAcceptance } from "@/lib/telephony/sip-refer-transfer";
import { placeBrowserSipInvite } from "@/lib/telephony/webphone-invite";
import {
  createBrowserSipCallAttempt,
  safeSipStatusCode,
  type BrowserSipCallAttemptController,
} from "@/lib/telephony/webphone-call-attempt";
import {
  applyWebphoneExtensionSelection,
  disconnectWebphoneForSeatTransition,
} from "@/lib/telephony/webphone-lifecycle";
import {
  completeWebphoneDisconnect,
  replaceStaleWebphoneRegistrations,
  webphoneDisconnectOutcomeForMode,
  type WebphoneDisconnectCompletion,
  type WebphoneRegistrationCancellationMode,
  type WebphoneRegistrationRefreshResult,
} from "@/lib/telephony/webphone-registration";
import type { WebphoneUnregisterOutcome } from "@/lib/telephony/webphone-unregister";
import { BrowserIncomingRingtone } from "@/lib/telephony/browser-ringtone";

export type BrowserWebphoneMode = "none" | "mock" | "live";
export type BrowserWebphoneRegistrationStatus = "idle" | "connecting" | "registered" | "disconnecting" | "failed";
export type BrowserWebphoneCallStatus = "idle" | "incoming" | "outgoing" | "in_call" | "ended" | "failed";

type WebphoneSessionResponse = {
  ok?: boolean;
  session?: ViptelWebphoneSession;
  error?: string;
};
type MockTimer = number;

/**
 * SIP.js `connect()` opens a WebSocket and has no timeout of its own. When the
 * gateway accepts the socket but never completes, the hook used to sit in
 * `connecting` forever - and the retry button only renders for `failed`, so the
 * operator had no way back. Failing here routes into the existing
 * `failConnection` path, which makes retry reachable.
 */
export const WEBPHONE_CONNECT_TIMEOUT_MS = 20_000;

export type WorkplaceWebphoneSessionFence = {
  assignmentGeneration: string;
  browserInstanceId: string;
  leaderEpoch: number;
  leaseId: string;
  leaseVersion: number;
};

type BrowserWebphoneRegistrationLifecycle = {
  cancellationMode: WebphoneRegistrationCancellationMode;
  promise: Promise<WebphoneRegistrationRefreshResult>;
  simpleUser: Web.SimpleUser;
};

export type BrowserWebphoneDisconnectOutcome = WebphoneUnregisterOutcome | "not_connected";

/**
 * Rejecting here does not orphan the SimpleUser: the caller's catch tears it
 * down through the same serialized `disconnect()` as every other failure,
 * because `simpleUserRef` was already pointed at it.
 */
async function connectWithinBudget(simpleUser: Web.SimpleUser) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      simpleUser.connect(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Telefón sa nepodarilo pripojiť k VIPTel v časovom limite.")),
          WEBPHONE_CONNECT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function useViptelBrowserWebphone(
  config: ViptelWebphoneConfig | null,
  selectedExtension: string,
  workplaceFence?: WorkplaceWebphoneSessionFence,
  options: { suspendExtensionSelection?: boolean } = {},
) {
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const incomingRingtoneRef = useRef<BrowserIncomingRingtone | null>(null);
  const simpleUserRef = useRef<Web.SimpleUser | null>(null);
  const mockTimerRef = useRef<MockTimer | null>(null);
  const callStatusRef = useRef<BrowserWebphoneCallStatus>("idle");
  const registrationStatusRef = useRef<BrowserWebphoneRegistrationStatus>("idle");
  const connectionGenerationRef = useRef(0);
  const registrationRefreshInProgressRef = useRef(false);
  const registrationLifecycleRef = useRef<BrowserWebphoneRegistrationLifecycle | null>(null);
  const connectingExtensionRef = useRef<string | null>(null);
  const connectedExtensionRef = useRef<string | null>(null);
  const sessionRequestRef = useRef<AbortController | null>(null);
  const disconnectPromiseRef = useRef<Promise<WebphoneDisconnectCompletion> | null>(null);
  const disconnectAllRequestedRef = useRef(false);
  const sipContactMayExistRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const lifecycleExtensionRef = useRef(selectedExtension);
  const outgoingAttemptRef = useRef<BrowserSipCallAttemptController | null>(null);
  const localHangupRequestedRef = useRef(false);
  const remoteByeReceivedRef = useRef(false);
  const [mode, setMode] = useState<BrowserWebphoneMode>("none");
  const [registrationStatus, setRegistrationStatus] = useState<BrowserWebphoneRegistrationStatus>("idle");
  const [callStatus, setCallStatus] = useState<BrowserWebphoneCallStatus>("idle");
  const [callDirection, setCallDirection] = useState<"inbound" | "outbound" | null>(null);
  const [activeCallTarget, setActiveCallTarget] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const setTrackedCallStatus = useCallback((status: BrowserWebphoneCallStatus) => {
    callStatusRef.current = status;
    setCallStatus(status);
  }, []);
  const setTrackedRegistrationStatus = useCallback((status: BrowserWebphoneRegistrationStatus) => {
    registrationStatusRef.current = status;
    setRegistrationStatus(status);
  }, []);
  const invalidateDtmfSession = useCallback(() => {
    sessionGenerationRef.current += 1;
  }, []);

  const activeExtension = useMemo(
    () => config?.extensions.find((extension) => extension.extension === selectedExtension) ?? config?.extensions[0],
    [config, selectedExtension],
  );
  const canStart = isViptelWebphoneReadyForBrowser(config, activeExtension?.extension);
  const isRegistered = registrationStatus === "registered";
  const hasActiveCall = callStatus === "incoming" || callStatus === "outgoing" || callStatus === "in_call";

  useEffect(() => {
    const ringtone = new BrowserIncomingRingtone();
    incomingRingtoneRef.current = ringtone;
    const unlock = () => void ringtone.unlock();
    document.addEventListener("pointerdown", unlock, { capture: true });
    document.addEventListener("keydown", unlock, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", unlock, { capture: true });
      document.removeEventListener("keydown", unlock, { capture: true });
      if (incomingRingtoneRef.current === ringtone) incomingRingtoneRef.current = null;
      ringtone.dispose();
    };
  }, []);

  useEffect(() => {
    const ringtone = incomingRingtoneRef.current;
    if (!ringtone) return;
    if (callStatus === "incoming") void ringtone.start();
    else ringtone.stop();
  }, [callStatus]);

  const clearMockTimer = useCallback(() => {
    if (mockTimerRef.current) {
      window.clearTimeout(mockTimerRef.current);
      mockTimerRef.current = null;
    }
  }, []);

  const disconnect = useCallback((allContacts = false) => {
    const requiredMode = allContacts ? "all" as const : "current" as const;
    // A selection/config effect can start teardown just before an explicit
    // hotdesk transition calls disconnect. Both callers must await the same
    // un-REGISTER exchange; the second call must not observe `simpleUserRef`
    // already cleared and incorrectly continue while the first is still open.
    if (disconnectPromiseRef.current) {
      if (allContacts) {
        disconnectAllRequestedRef.current = true;
        if (registrationLifecycleRef.current) registrationLifecycleRef.current.cancellationMode = "all";
      }
      return disconnectPromiseRef.current.then((completion) =>
        webphoneDisconnectOutcomeForMode(completion, requiredMode));
    }
    disconnectAllRequestedRef.current = allContacts;

    const disconnectPromise = (async () => {
      const disconnectGeneration = connectionGenerationRef.current + 1;
      connectionGenerationRef.current = disconnectGeneration;
      connectingExtensionRef.current = null;
      connectedExtensionRef.current = null;
      registrationRefreshInProgressRef.current = false;
      sessionRequestRef.current?.abort();
      sessionRequestRef.current = null;
      clearMockTimer();
      invalidateDtmfSession();
      outgoingAttemptRef.current?.settle({ outcome: "ended_before_answer" });
      outgoingAttemptRef.current = null;
      localHangupRequestedRef.current = true;
      if (registrationStatusRef.current !== "idle") {
        setTrackedRegistrationStatus("disconnecting");
      }

      const simpleUser = simpleUserRef.current;
      simpleUserRef.current = null;
      let completion: WebphoneDisconnectCompletion = {
        cleanedContacts: "none",
        hadSipUser: false,
        outcome: sipContactMayExistRef.current && allContacts ? "send_failed" : "not_connected",
      };

      if (simpleUser) {
        await simpleUser.hangup().catch(() => undefined);
        const lifecycle = registrationLifecycleRef.current?.simpleUser === simpleUser
          ? registrationLifecycleRef.current
          : null;
        if (lifecycle) {
          lifecycle.cancellationMode = disconnectAllRequestedRef.current || lifecycle.cancellationMode === "all"
            ? "all"
            : "current";
          completion = await completeWebphoneDisconnect(simpleUser, {
            lifecycle: lifecycle.promise,
            requestedMode: () => disconnectAllRequestedRef.current ? "all" : "current",
          });
          if (registrationLifecycleRef.current === lifecycle) registrationLifecycleRef.current = null;
        } else {
          completion = await completeWebphoneDisconnect(simpleUser, {
            requestedMode: () => disconnectAllRequestedRef.current ? "all" : "current",
          });
        }
      }

      if (connectionGenerationRef.current === disconnectGeneration) {
        setMode("none");
        setTrackedCallStatus("idle");
        setCallDirection(null);
        setActiveCallTarget(null);
        setIsMuted(false);
        setTrackedRegistrationStatus("idle");
      }
      if (completion.outcome === "accepted" && completion.cleanedContacts === "all") {
        sipContactMayExistRef.current = false;
      }
      return completion;
    })();
    disconnectPromiseRef.current = disconnectPromise;
    void disconnectPromise.finally(() => {
      if (disconnectPromiseRef.current === disconnectPromise) {
        disconnectPromiseRef.current = null;
      }
    });
    return disconnectPromise.then((completion) =>
      webphoneDisconnectOutcomeForMode(completion, requiredMode));
  }, [clearMockTimer, invalidateDtmfSession, setTrackedCallStatus, setTrackedRegistrationStatus]);
  const disconnectAll = useCallback(() => disconnectWebphoneForSeatTransition({
    // Read the ref at the last synchronous boundary before teardown. A call
    // may have started while the server was preparing a durable seat change,
    // after the UI's earlier `hasActiveCall` check.
    callStatus: callStatusRef.current,
    disconnect: () => disconnect(true),
  }), [disconnect]);

  useEffect(() => () => {
    void disconnect();
  }, [disconnect]);

  useEffect(() => {
    const result = applyWebphoneExtensionSelection({
      callStatus: callStatusRef.current,
      currentExtension: lifecycleExtensionRef.current,
      nextExtension: selectedExtension,
      suspended: options.suspendExtensionSelection,
      disconnect: () => {
        lifecycleExtensionRef.current = selectedExtension;
        void disconnect();
      },
    });
    if (result === "deferred") {
      setNotice("Zmenu pracovného miesta dokončíme po skončení aktuálneho hovoru.");
    }
  }, [callStatus, disconnect, options.suspendExtensionSelection, selectedExtension]);

  const startMockSession = useCallback(
    (message: string) => {
      clearMockTimer();
      invalidateDtmfSession();
      outgoingAttemptRef.current?.settle({ outcome: "ended_before_answer" });
      outgoingAttemptRef.current = null;
      simpleUserRef.current = null;
      connectedExtensionRef.current = activeExtension?.extension ?? null;
      setMode("mock");
      setTrackedRegistrationStatus("registered");
      setTrackedCallStatus("idle");
      setIsMuted(false);
      setNotice(message);
    },
    [activeExtension?.extension, clearMockTimer, invalidateDtmfSession, setTrackedCallStatus, setTrackedRegistrationStatus],
  );

  const failConnection = useCallback(
    (message: string) => {
      clearMockTimer();
      invalidateDtmfSession();
      outgoingAttemptRef.current?.settle({ outcome: "ended_before_answer" });
      outgoingAttemptRef.current = null;
      simpleUserRef.current = null;
      connectedExtensionRef.current = null;
      setMode("none");
      setTrackedRegistrationStatus("failed");
      setTrackedCallStatus("idle");
      setIsMuted(false);
      setNotice(message);
    },
    [clearMockTimer, invalidateDtmfSession, setTrackedCallStatus, setTrackedRegistrationStatus],
  );

  const connect = useCallback(async () => {
    if (!activeExtension || !config) {
      setNotice("Test webphone klapky ešte nie sú nakonfigurované.");
      setTrackedRegistrationStatus("failed");
      return;
    }

    if (!canStart) {
      setNotice("PBX registrácia z browsera je blokovaná.");
      setTrackedRegistrationStatus("failed");
      return;
    }

    const extension = activeExtension.extension;
    if (
      connectingExtensionRef.current === extension ||
      (registrationStatusRef.current === "registered" && connectedExtensionRef.current === extension)
    ) {
      return;
    }

    const connectionGeneration = connectionGenerationRef.current + 1;
    connectionGenerationRef.current = connectionGeneration;
    connectingExtensionRef.current = extension;
    connectedExtensionRef.current = null;
    sessionRequestRef.current?.abort();
    const sessionRequest = new AbortController();
    sessionRequestRef.current = sessionRequest;
    const isCurrentConnection = () => connectionGenerationRef.current === connectionGeneration;

    setTrackedRegistrationStatus("connecting");
    setNotice(null);
    let simpleUser: Web.SimpleUser | null = null;

    try {
      const response = await telephonyFetch("/api/telephony/webphone/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extension, ...workplaceFence }),
        label: "SIP relácia",
        signal: sessionRequest.signal,
        // The route proves a fresh provider snapshot before issuing SIP
        // credentials, so it gets the snapshot budget rather than a read one.
        timeoutMs: TELEPHONY_TIMEOUT_MS.snapshot,
      });
      const result = (await response.json().catch(() => null)) as WebphoneSessionResponse | null;
      if (!isCurrentConnection()) return;

      if (!response.ok || !result?.ok || !result.session) {
        const message = result?.error ?? "SIP session nie je dostupná.";
        if (config.mockEnabled) {
          startMockSession(`Vývojový mock: ${message}`);
        } else {
          failConnection(withConnectionRetryGuidance(message));
        }
        return;
      }

      const session = result.session;
      assertRtpDtmfMode(session.dtmfMode);
      simpleUser = new Web.SimpleUser(session.sipWebSocketUrl, {
        aor: `sip:${session.extension.extension}@${session.sipDomain}`,
        delegate: {
          onCallAnswered: () => {
            if (!isCurrentConnection()) return;
            outgoingAttemptRef.current?.settle({ outcome: "accepted" });
            setTrackedCallStatus("in_call");
            setNotice("Browser hovor je spojený.");
          },
          onCallCreated: () => {
            if (!isCurrentConnection()) return;
            invalidateDtmfSession();
            setCallDirection((current) => current ?? (callStatusRef.current === "incoming" ? "inbound" : "outbound"));
            setTrackedCallStatus(callStatusRef.current === "incoming" ? "incoming" : "outgoing");
          },
          onCallReceived: () => {
            if (!isCurrentConnection()) return;
            invalidateDtmfSession();
            setCallDirection("inbound");
            setActiveCallTarget(null);
            setTrackedCallStatus("incoming");
            setNotice("Prichádzajúci hovor na browser klapku.");
          },
          onCallHangup: () => {
            if (!isCurrentConnection()) return;
            const previousStatus = callStatusRef.current;
            outgoingAttemptRef.current?.settle({ outcome: "ended_before_answer" });
            outgoingAttemptRef.current = null;
            invalidateDtmfSession();
            setTrackedCallStatus("ended");
            setIsMuted(false);
            if (localHangupRequestedRef.current) {
              setNotice("Hovor bol ukončený. Telefón je pripravený na ďalšie volanie.");
            } else if (remoteByeReceivedRef.current && previousStatus === "in_call") {
              setNotice("Hovor ukončila druhá strana alebo telefónna ústredňa. Môžeš volať znova.");
            } else if (previousStatus === "outgoing") {
              setNotice("Hovor sa nespojil. Po obnovení stavu ho môžeš skúsiť znova.");
            } else {
              setNotice("Spojenie hovoru sa skončilo. Telefón je pripravený na ďalšie volanie.");
            }
            localHangupRequestedRef.current = false;
            remoteByeReceivedRef.current = false;
          },
          onRegistered: () => {
            if (!isCurrentConnection()) return;
            if (registrationRefreshInProgressRef.current) return;
            connectedExtensionRef.current = extension;
            setTrackedRegistrationStatus("registered");
            setNotice(null);
          },
          onServerDisconnect: (error) => {
            if (!isCurrentConnection()) return;
            outgoingAttemptRef.current?.settle({ outcome: "ended_before_answer" });
            outgoingAttemptRef.current = null;
            invalidateDtmfSession();
            setTrackedCallStatus("failed");
            connectedExtensionRef.current = null;
            setTrackedRegistrationStatus("failed");
            setNotice(
              error
                ? withConnectionRetryGuidance("Spojenie s telefónnou ústredňou VIPTel sa prerušilo.")
                : withConnectionRetryGuidance("Telefón v prehliadači sa odpojil."),
            );
          },
          onUnregistered: () => {
            if (!isCurrentConnection()) return;
            if (registrationRefreshInProgressRef.current) return;
            outgoingAttemptRef.current?.settle({ outcome: "ended_before_answer" });
            outgoingAttemptRef.current = null;
            invalidateDtmfSession();
            setTrackedCallStatus("idle");
            connectedExtensionRef.current = null;
            setTrackedRegistrationStatus("failed");
            setNotice(withConnectionRetryGuidance("Telefón v prehliadači sa odregistroval."));
          },
        },
        media: {
          constraints: { audio: true, video: false },
          remote: remoteAudioRef.current ? { audio: remoteAudioRef.current } : undefined,
        },
        // SIP.js defaults to refreshing at 99% of a ten-minute registration.
        // A background tab can miss that six-second margin. Refresh halfway
        // through the accepted lifetime so the phone remains reachable.
        registererOptions: { expires: 600, refreshFrequency: 50 },
        reconnectionAttempts: 12,
        reconnectionDelay: 4,
        sendDTMFUsingSessionDescriptionHandler: true,
        userAgentOptions: {
          authorizationPassword: session.extension.password,
          authorizationUsername: session.extension.authUsername,
          displayName: session.extension.label ?? session.extension.extension,
          logBuiltinEnabled: false,
          logConfiguration: false,
          preloadedRouteSet: session.outboundProxy ? [session.outboundProxy] : undefined,
          sessionDescriptionHandlerFactoryOptions: {
            peerConnectionConfiguration: {
              iceServers: toRtcIceServers(session.iceServers),
            },
          },
          userAgentString: "Motorist Dispatch Browser Phone",
        },
      });

      invalidateDtmfSession();
      sipContactMayExistRef.current = true;
      simpleUserRef.current = simpleUser;
      await connectWithinBudget(simpleUser);
      if (!isCurrentConnection()) {
        return;
      }
      registrationRefreshInProgressRef.current = true;
      const lifecycle: BrowserWebphoneRegistrationLifecycle = {
        cancellationMode: "none" as WebphoneRegistrationCancellationMode,
        promise: Promise.resolve({
          stage: "initial_registration" as const,
          outcome: "send_failed" as const,
        }),
        simpleUser,
      };
      lifecycle.promise = replaceStaleWebphoneRegistrations(simpleUser, {
        cancellationMode: () => lifecycle.cancellationMode,
      });
      registrationLifecycleRef.current = lifecycle;
      const registrationRefresh = await lifecycle.promise;
      if (registrationLifecycleRef.current === lifecycle) registrationLifecycleRef.current = null;
      registrationRefreshInProgressRef.current = false;
      if (!isCurrentConnection()) {
        return;
      }
      if (registrationRefresh.outcome !== "accepted") {
        throw new Error(webphoneRegistrationRefreshError(registrationRefresh));
      }
      connectedExtensionRef.current = extension;
      setTrackedRegistrationStatus("registered");
      setNotice(null);
      setMode("live");
    } catch (error) {
      registrationRefreshInProgressRef.current = false;
      if (registrationLifecycleRef.current?.simpleUser === simpleUser) {
        registrationLifecycleRef.current = null;
      }
      if (!isCurrentConnection()) {
        return;
      }
      invalidateDtmfSession();
      const message = error instanceof Error ? error.message : "SIP session zlyhala.";
      if (simpleUser && simpleUserRef.current === simpleUser) {
        // Use the same serialized teardown as every other caller. In
        // particular, an explicit hotdesk disconnectAll() can now join and
        // upgrade this cleanup instead of observing a prematurely cleared ref.
        const cleanupAlreadyInProgress = Boolean(disconnectPromiseRef.current);
        const cleanupPromise = disconnect();
        const cleanupGeneration = connectionGenerationRef.current;
        await cleanupPromise;
        if (
          cleanupAlreadyInProgress ||
          disconnectAllRequestedRef.current ||
          connectionGenerationRef.current !== cleanupGeneration
        ) {
          return;
        }
      }
      if (config.mockEnabled) {
        startMockSession(`Vývojový mock: ${message}`);
      } else {
        failConnection(
          withConnectionRetryGuidance(
            "Spojenie s telefónnou ústredňou VIPTel sa nepodarilo.",
          ),
        );
      }
    } finally {
      if (isCurrentConnection()) {
        connectingExtensionRef.current = null;
        if (sessionRequestRef.current === sessionRequest) sessionRequestRef.current = null;
      }
    }
  }, [activeExtension, canStart, config, disconnect, failConnection, invalidateDtmfSession, setTrackedCallStatus, setTrackedRegistrationStatus, startMockSession, workplaceFence]);

  const answer = useCallback(async () => {
    if (mode === "mock") {
      setTrackedCallStatus("in_call");
      setNotice("Mock hovor je spojený.");
      return;
    }

    await simpleUserRef.current?.answer();
  }, [mode, setTrackedCallStatus]);

  const captureCallSession = useCallback(() => captureBrowserCallSession({
    generation: sessionGenerationRef.current,
    session: simpleUserSipSession(simpleUserRef.current),
    status: callStatusRef.current,
  }), []);

  const declineCapturedCall = useCallback(async (fence: BrowserCallSessionFence) => {
    if (!browserCallSessionFenceMatches(fence, {
      generation: sessionGenerationRef.current,
      session: simpleUserSipSession(simpleUserRef.current),
      status: callStatusRef.current,
    }, ["incoming"])) return false;

    invalidateDtmfSession();
    localHangupRequestedRef.current = true;
    if (mode === "mock") {
      setTrackedCallStatus("ended");
      setNotice("Mock hovor bol odmietnutý.");
      return true;
    }

    await simpleUserRef.current?.decline();
    return true;
  }, [invalidateDtmfSession, mode, setTrackedCallStatus]);

  const decline = useCallback(async () => {
    const fence = captureCallSession();
    if (fence) await declineCapturedCall(fence);
  }, [captureCallSession, declineCapturedCall]);

  const hangupCapturedCall = useCallback(async (fence: BrowserCallSessionFence) => {
    if (!browserCallSessionFenceMatches(fence, {
      generation: sessionGenerationRef.current,
      session: simpleUserSipSession(simpleUserRef.current),
      status: callStatusRef.current,
    }, ["incoming", "outgoing", "in_call"])) return false;

    clearMockTimer();
    invalidateDtmfSession();
    localHangupRequestedRef.current = true;

    if (mode === "mock") {
      setTrackedCallStatus("ended");
      setIsMuted(false);
      setNotice("Mock hovor bol ukončený.");
      return true;
    }

    await simpleUserRef.current?.hangup();
    return true;
  }, [clearMockTimer, invalidateDtmfSession, mode, setTrackedCallStatus]);

  const hangup = useCallback(async () => {
    const fence = captureCallSession();
    if (fence) await hangupCapturedCall(fence);
  }, [captureCallSession, hangupCapturedCall]);

  const toggleMute = useCallback(() => {
    const nextMuted = !isMuted;

    if (mode === "live") {
      if (nextMuted) {
        simpleUserRef.current?.mute();
      } else {
        simpleUserRef.current?.unmute();
      }
    }

    setIsMuted(nextMuted);
  }, [isMuted, mode]);

  const sendDtmf = useCallback(
    async (tone: string) => {
      if (!/^[0-9*#]$/.test(tone)) {
        return;
      }

      if (mode === "mock") {
        setNotice(`Mock DTMF ${tone}`);
        return;
      }

      await simpleUserRef.current?.sendDTMF(tone);
    },
    [mode],
  );

  const captureDtmfTransferSession = useCallback((callId: string, viptelUniqueId: string) => (
    captureBrowserDtmfSession({
      callId,
      callStatus: callStatusRef.current === "in_call" ? "in_call" : "inactive",
      generation: sessionGenerationRef.current,
      session: simpleUserRef.current,
      viptelUniqueId,
    })
  ), []);

  const captureSipReferSession = useCallback((callId: string, viptelUniqueId: string) => (
    captureBrowserDtmfSession({
      callId,
      callStatus: callStatusRef.current === "in_call" ? "in_call" : "inactive",
      generation: sessionGenerationRef.current,
      session: simpleUserSipSession(simpleUserRef.current),
      viptelUniqueId,
    })
  ), []);

  const sendSipReferTransfer = useCallback(
    async (
      target: unknown,
      fence: BrowserDtmfSessionFence,
      authorizedTarget: unknown,
      authorizedViptelUniqueId: unknown,
      readCurrentCallIdentity: () => { callId: string; viptelUniqueId: string } | undefined,
    ) => {
      const normalizedTarget = formatViptelDialTarget(target, "Cieľ prepojenia");
      if (normalizedTarget !== authorizedTarget) {
        throw new Error("Serverový a lokálny cieľ SIP prepojenia sa nezhodujú; prepojenie nebolo odoslané.");
      }
      assertAuthorizedBrowserDtmfCall(fence, authorizedViptelUniqueId);
      const identity = readCurrentCallIdentity();
      const currentSession = simpleUserSipSession(simpleUserRef.current);
      if (
        !identity ||
        identity.callId !== fence.callId ||
        identity.viptelUniqueId !== fence.viptelUniqueId ||
        callStatusRef.current !== "in_call" ||
        sessionGenerationRef.current !== fence.generation ||
        currentSession !== fence.session
      ) {
        throw new Error("SIP session alebo identita hovoru sa pred prepojením zmenila.");
      }
      if (mode === "mock") return { accepted: true as const, statusCode: 202 };
      if (!currentSession || currentSession.state !== SessionState.Established) {
        throw new Error("SIP session alebo identita hovoru sa pred prepojením zmenila.");
      }

      const domain = config?.sipDomain?.trim();
      const referTarget = domain ? UserAgent.makeURI(`sip:${normalizedTarget}@${domain}`) : undefined;
      if (!referTarget) throw new Error("SIP doména pre bezpečné prepojenie nie je dostupná.");

      const result = await sendSipReferAndAwaitAcceptance(currentSession, referTarget);
      setNotice("VIPTel prijal SIP prepojenie. Hovor zostane viditeľný, kým ústredňa dokončí odovzdanie.");
      return result;
    },
    [config?.sipDomain, mode],
  );

  const sendDtmfTransfer = useCallback(
    async (
      transferMode: DtmfTransferMode,
      target: unknown,
      authorizedTonePlan: readonly string[],
      fence: BrowserDtmfSessionFence,
      authorizedViptelUniqueId: unknown,
      readCurrentCallIdentity: () => { callId: string; viptelUniqueId: string } | undefined,
    ) => {
      const plan = buildDtmfTransferPlan(transferMode, target);
      if (!sameTonePlan(plan.tones, authorizedTonePlan)) {
        throw new Error("Serverový a lokálny DTMF plán sa nezhodujú; neodoslal sa žiadny tón.");
      }
      assertAuthorizedBrowserDtmfCall(fence, authorizedViptelUniqueId);

      const delivery = await deliverFencedBrowserDtmfTransfer(
        plan,
        fence,
        () => {
          const identity = readCurrentCallIdentity();
          if (!identity) return undefined;
          return {
            ...identity,
            callStatus: callStatusRef.current === "in_call" ? "in_call" : "inactive",
            generation: sessionGenerationRef.current,
            session: simpleUserRef.current,
          };
        },
        async (tone) => {
          if (mode === "mock") return;
          const simpleUser = simpleUserRef.current;
          if (!simpleUser || simpleUser !== fence.session) throw new Error("SIP hovor už nie je aktívny.");
          await simpleUser.sendDTMF(tone);
        },
        { intervalMs: mode === "mock" ? 0 : 180 },
      );

      if (delivery.complete) {
        setNotice("DTMF sekvencia bola odoslaná; výsledok prepojenia ešte musí potvrdiť priebeh hovoru.");
      } else if (delivery.deliveryUncertain) {
        setNotice("Odoslala sa iba časť DTMF sekvencie. Neopakuj ju automaticky; skontroluj hovor a prípadne akciu dokonči ručne.");
      } else {
        setNotice("Neodoslal sa žiadny DTMF tón. Po kontrole aktívneho hovoru možno prepojenie skúsiť znova.");
      }

      return { plan, delivery };
    },
    [mode],
  );

  const startDirectCall = useCallback(
    async (destination: string) => {
      if (!destination.trim()) {
        const message = "Cieľové číslo je povinné.";
        setNotice(message);
        throw new Error(message);
      }
      if (hasActiveCall) {
        const message = "Najprv ukončite alebo odmietnite aktuálny hovor.";
        setNotice(message);
        throw new Error(message);
      }

      if (mode === "mock") {
        invalidateDtmfSession();
        setCallDirection("outbound");
        setActiveCallTarget(destination);
        simulateMockOutgoingCall(clearMockTimer, mockTimerRef, setTrackedCallStatus, setNotice);
        const mockAttempt = createBrowserSipCallAttempt();
        mockAttempt.settle({ outcome: "accepted" });
        return mockAttempt.attempt;
      }

      const domain = config?.sipDomain;

      if (!domain) {
        const message = "SIP doména nie je nakonfigurovaná.";
        setNotice(message);
        throw new Error(message);
      }

      const target = toSipDestination(destination, domain);
      const simpleUser = simpleUserRef.current;
      if (!simpleUser) {
        const message = "SIP spojenie už nie je aktívne; odchádzajúci hovor sa nezačal.";
        setNotice(message);
        throw new Error(message);
      }
      const attemptController = createBrowserSipCallAttempt();
      outgoingAttemptRef.current = attemptController;
      localHangupRequestedRef.current = false;
      remoteByeReceivedRef.current = false;
      invalidateDtmfSession();
      setCallDirection("outbound");
      setActiveCallTarget(destination);
      setNotice(null);
      setTrackedCallStatus("outgoing");
      try {
        await placeBrowserSipInvite(
          () => simpleUser.call(
            target,
            {
              delegate: {
                onBye: () => {
                  remoteByeReceivedRef.current = true;
                },
              },
            },
            {
              requestDelegate: {
                onAccept: () => {
                  attemptController.settle({ outcome: "accepted" });
                },
                onRedirect: (response) => {
                  attemptController.settle({
                    outcome: "rejected",
                    statusCode: safeSipStatusCode(response.message.statusCode),
                  });
                },
                onReject: (response) => {
                  attemptController.settle({
                    outcome: "rejected",
                    statusCode: safeSipStatusCode(response.message.statusCode),
                  });
                },
              },
            },
          ),
          () => setTrackedCallStatus("failed"),
        );
      } catch (error) {
        attemptController.settle({ outcome: "ended_before_answer" });
        if (outgoingAttemptRef.current === attemptController) outgoingAttemptRef.current = null;
        throw error;
      }
      return attemptController.attempt;
    },
    [clearMockTimer, config?.sipDomain, hasActiveCall, invalidateDtmfSession, mode, setTrackedCallStatus],
  );

  const simulateIncoming = useCallback(() => {
    if (mode !== "mock" || hasActiveCall) {
      return;
    }

    invalidateDtmfSession();
    setCallDirection("inbound");
    setActiveCallTarget(null);
    setTrackedCallStatus("incoming");
    setNotice("Mock prichádzajúci hovor.");
  }, [hasActiveCall, invalidateDtmfSession, mode, setTrackedCallStatus]);

  const simulateBusy = useCallback(() => {
    if (mode !== "mock") {
      return;
    }

    clearMockTimer();
    invalidateDtmfSession();
    setTrackedCallStatus("in_call");
    setNotice("Mock klapka je obsadená.");
  }, [clearMockTimer, invalidateDtmfSession, mode, setTrackedCallStatus]);

  const simulateOutgoing = useCallback((destination?: string) => {
    invalidateDtmfSession();
    setCallDirection("outbound");
    setActiveCallTarget(destination?.trim() || null);
    simulateMockOutgoingCall(clearMockTimer, mockTimerRef, setTrackedCallStatus, setNotice);
  }, [clearMockTimer, invalidateDtmfSession, setTrackedCallStatus]);

  return {
    activeExtension,
    activeCallTarget,
    answer,
    callDirection,
    callStatus,
    canStart,
    captureCallSession,
    captureDtmfTransferSession,
    captureSipReferSession,
    connect,
    decline,
    declineCapturedCall,
    disconnect,
    disconnectAll,
    hangup,
    hangupCapturedCall,
    hasActiveCall,
    isMuted,
    isRegistered,
    mode,
    notice,
    registrationStatus,
    remoteAudioRef,
    sendDtmf,
    sendDtmfTransfer,
    sendSipReferTransfer,
    simulateBusy,
    simulateIncoming,
    simulateOutgoing,
    startDirectCall,
    toggleMute,
  };
}

export type ViptelBrowserWebphone = ReturnType<typeof useViptelBrowserWebphone>;

function simpleUserSipSession(simpleUser: Web.SimpleUser | null) {
  return (simpleUser as unknown as { session?: Session } | null)?.session ?? null;
}

function webphoneRegistrationRefreshError(result: WebphoneRegistrationRefreshResult) {
  const step = result.stage === "initial_registration"
    ? "prvotné prihlásenie"
    : result.stage === "stale_cleanup"
      ? "vyčistenie starého pripojenia"
      : "obnovené prihlásenie";
  const reason = result.outcome === "timed_out"
    ? "VIPTel neodpovedal včas"
    : result.outcome === "rejected"
      ? "VIPTel požiadavku odmietol"
      : "požiadavku sa nepodarilo odoslať";
  return `Telefón sa nepripojil: ${step} zlyhalo (${reason}).`;
}

function withConnectionRetryGuidance(message: string) {
  const normalized = message.trim().replace(/\s+/g, " ");
  const sentence = normalized.endsWith(".") ? normalized : `${normalized}.`;
  return `${sentence} Skús pripojenie znova. Ak problém pretrváva, obnov Pracovisko.`;
}

function simulateMockOutgoingCall(
  clearMockTimer: () => void,
  mockTimerRef: { current: MockTimer | null },
  setCallStatus: (status: BrowserWebphoneCallStatus) => void,
  setNotice: (notice: string) => void,
) {
  clearMockTimer();
  setCallStatus("outgoing");
  setNotice("Mock browser hovor zvoní.");
  mockTimerRef.current = window.setTimeout(() => {
    setCallStatus("in_call");
    setNotice("Mock browser hovor je spojený.");
    mockTimerRef.current = null;
  }, 800);
}

function assertRtpDtmfMode(mode: unknown): asserts mode is "rfc2833" | "rfc4733" {
  if (mode !== "rfc2833" && mode !== "rfc4733") {
    throw new Error("Browser SIP session nemá bezpečne nakonfigurovaný RTP DTMF režim.");
  }
}

function toRtcIceServers(servers: ViptelWebphoneIceServer[]): RTCIceServer[] {
  return servers.map((server) => ({
    urls: server.urls,
    username: server.username,
    credential: server.credential,
  }));
}

function toSipDestination(destination: string, domain: string) {
  const trimmed = destination.trim();

  if (trimmed.startsWith("sip:")) {
    return trimmed;
  }

  return `sip:${formatViptelDialTarget(trimmed, "Cieľové číslo")}@${domain}`;
}

function sameTonePlan(local: readonly string[], authorized: readonly string[]) {
  return local.length === authorized.length && local.every((tone, index) => tone === authorized[index]);
}
