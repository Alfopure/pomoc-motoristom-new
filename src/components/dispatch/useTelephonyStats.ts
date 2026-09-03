"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { TELEPHONY_TIMEOUT_MS, telephonyJson } from "@/lib/telephony/client-request";
import { wallboardPollDelayMs } from "@/lib/telephony/poll-schedule";
import type { WallboardPayload } from "@/lib/telephony/wallboard";

/**
 * The single reader of `GET /api/telephony/stats`, shared by the full-screen
 * wallboard and the widgets in the reports view.
 *
 * Three decisions live here rather than in each surface:
 *
 * * **Self-gating.** The endpoint is senior-dispatcher-and-above. A dispatcher
 *   opening the reports view gets one 403 and the poller stops for good; the
 *   widget then hides itself, exactly as `QaDashboard` does. Retrying a 403
 *   every five seconds would be a permission check turned into a load test.
 *   A 401 stops the chain the same way, but for the opposite reason: a wall
 *   display whose session expired must say so rather than keep the last good
 *   numbers on screen behind a small "Neaktuálne" badge — a board that looks
 *   merely a little behind while showing hours-old figures is the one failure
 *   mode a wallboard must not have.
 * * **Cadence.** `wallboardPollDelayMs` never polls faster than the server's
 *   own snapshot cache, and backs off when the endpoint fails.
 * * **Continuity.** A failed poll keeps the last good payload on screen and
 *   only flags it as stale. A wall display that blanks on one lost request is
 *   less useful than one that shows numbers from a minute ago and says so.
 */

export type TelephonyStatsState = {
  stats: WallboardPayload | null;
  /** Slovak message of the last failed poll; the previous payload stays visible. */
  error: string | null;
  /** The reader may not see the statistics at all: the surface hides itself. */
  forbidden: boolean;
  /** The session expired: the surface must ask for a sign-in, not show stale numbers. */
  signedOut: boolean;
  /** False until the first answer (success or failure) arrived. */
  loaded: boolean;
  reload: () => void;
};

export function useTelephonyStats(): TelephonyStatsState {
  const [stats, setStats] = useState<WallboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const failures = useRef(0);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    if (forbidden || signedOut) return;
    let cancelled = false;
    let timeoutId: number | undefined;
    const controller = new AbortController();

    const load = async () => {
      const result = await telephonyJson<WallboardPayload & { error?: string }>("/api/telephony/stats", {
        label: "štatistiky ústredne",
        signal: controller.signal,
        timeoutMs: TELEPHONY_TIMEOUT_MS.read,
      }).catch(() => null);
      if (cancelled) return;

      if (result?.status === 403) {
        setForbidden(true);
        setLoaded(true);
        return;
      }
      if (result?.status === 401) {
        setSignedOut(true);
        setLoaded(true);
        return;
      }
      if (!result?.ok || !result.body) {
        failures.current += 1;
        setError(result?.body?.error ?? "Štatistiky sa nepodarilo načítať.");
        setLoaded(true);
        return;
      }
      failures.current = 0;
      setStats(result.body);
      setError(null);
      setLoaded(true);
    };

    // One chain at a time. Clearing the timer is not enough on its own: a tab
    // that becomes visible while the previous tick is already awaiting its
    // response would otherwise leave that tick to schedule a second chain, and
    // every hide/show cycle would double the poll rate of a screen that is
    // meant to be gentle on the database.
    let chain = 0;

    const schedule = (generation: number) => {
      if (cancelled || generation !== chain) return;
      timeoutId = window.setTimeout(async () => {
        await load();
        schedule(generation);
      }, wallboardPollDelayMs({ documentHidden: document.visibilityState === "hidden", consecutiveFailures: failures.current }));
    };

    const restart = () => {
      if (cancelled) return;
      chain += 1;
      const generation = chain;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      void load().then(() => schedule(generation));
    };

    const onVisibility = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      restart();
    };

    restart();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      controller.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [forbidden, signedOut, reloadToken]);

  return { stats, error, forbidden, signedOut, loaded, reload };
}
