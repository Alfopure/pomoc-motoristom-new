"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, LocateFixed, MapPinOff, ShieldCheck } from "lucide-react";

type LinkState = "active" | "expired" | "used" | "revoked";
type Phase = "checking" | "requesting" | "saving" | "done" | "expired" | "used" | "revoked" | "unsupported" | "error";

type LocationShareClientProps = {
  token: string;
};

export default function LocationShareClient({ token }: LocationShareClientProps) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [message, setMessage] = useState("Overujeme bezpecny link.");
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const requestedRef = useRef(false);

  const requestLocation = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setPhase("unsupported");
      setMessage("Tento prehliadac nepodporuje odoslanie GPS polohy.");
      return;
    }

    setPhase("requesting");
    setMessage("Potvrdte zdielanie polohy v prehliadaci.");

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        setAccuracy(position.coords.accuracy);
        setPhase("saving");
        setMessage("Ukladame polohu pre dispecing.");

        try {
          const response = await fetch(`/api/public/location-links/${encodeURIComponent(token)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              accuracy: position.coords.accuracy,
              clientTimestamp: new Date(position.timestamp).toISOString(),
              lat: position.coords.latitude,
              lng: position.coords.longitude,
            }),
          });
          const result = (await response.json().catch(() => null)) as { error?: string } | null;

          if (!response.ok) {
            throw new Error(result?.error ?? "Polohu sa nepodarilo odoslat.");
          }

          setPhase("done");
          setMessage("Dakujeme, poloha bola odoslana dispecingu.");
        } catch (error) {
          setPhase("error");
          setMessage(error instanceof Error ? error.message : "Polohu sa nepodarilo odoslat.");
        }
      },
      (error) => {
        setPhase("error");
        setMessage(locationErrorMessage(error));
      },
      {
        enableHighAccuracy: true,
        maximumAge: 30000,
        timeout: 15000,
      },
    );
  }, [token]);

  useEffect(() => {
    if (requestedRef.current) {
      return;
    }

    requestedRef.current = true;

    async function verifyAndStart() {
      try {
        const response = await fetch(`/api/public/location-links/${encodeURIComponent(token)}`, { method: "GET" });
        const result = (await response.json().catch(() => null)) as { error?: string; status?: LinkState } | null;

        if (!response.ok) {
          throw new Error(result?.error ?? "Link na polohu sa nepodarilo overit.");
        }

        if (result?.status !== "active") {
          const nextPhase = result?.status ?? "revoked";
          setPhase(nextPhase);
          setMessage(statusMessage(nextPhase));
          return;
        }

        requestLocation();
      } catch (error) {
        setPhase("error");
        setMessage(error instanceof Error ? error.message : "Link na polohu sa nepodarilo overit.");
      }
    }

    void verifyAndStart();
  }, [requestLocation, token]);

  const isBusy = phase === "checking" || phase === "requesting" || phase === "saving";
  const isComplete = phase === "done" || phase === "used";

  return (
    <main className="min-h-dvh bg-zinc-950 px-4 py-6 text-zinc-50">
      <div className="mx-auto flex min-h-[calc(100dvh-48px)] w-full max-w-md flex-col justify-center">
        <div className="rounded-lg border border-white/10 bg-white p-5 text-zinc-950 shadow-2xl">
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-md bg-yellow-300 text-zinc-950">
              {iconForPhase(phase)}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-normal text-zinc-500">Pomoc motoristom</p>
              <h1 className="text-xl font-semibold text-zinc-950">Odoslanie polohy</h1>
            </div>
          </div>

          <div className="mt-5 rounded-md border border-zinc-200 bg-zinc-50 p-4">
            <p className="text-base font-semibold text-zinc-950">{message}</p>
            {accuracy !== null && (
              <p className="mt-2 text-sm text-zinc-600">Presnost GPS: približne {Math.round(accuracy)} m.</p>
            )}
          </div>

          {!isComplete && (
            <button
              type="button"
              onClick={requestLocation}
              disabled={isBusy}
              className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
            >
              {isBusy ? <Loader2 size={17} className="animate-spin" /> : <LocateFixed size={17} />}
              Odoslat aktualnu polohu
            </button>
          )}

          <div className="mt-4 flex items-center gap-2 text-xs leading-5 text-zinc-500">
            <ShieldCheck size={15} />
            Link neukazuje detail zasahu a po pouziti prestane byt aktivny.
          </div>
        </div>
      </div>
    </main>
  );
}

function iconForPhase(phase: Phase) {
  if (phase === "done" || phase === "used") {
    return <CheckCircle2 size={22} />;
  }

  if (phase === "expired" || phase === "revoked" || phase === "unsupported" || phase === "error") {
    return <MapPinOff size={22} />;
  }

  if (phase === "checking" || phase === "requesting" || phase === "saving") {
    return <Loader2 size={22} className="animate-spin" />;
  }

  return <LocateFixed size={22} />;
}

function statusMessage(status: LinkState) {
  if (status === "used") {
    return "Poloha uz bola prijata.";
  }

  if (status === "expired") {
    return "Link na odoslanie polohy uz vyprsal.";
  }

  return "Link na odoslanie polohy uz nie je aktivny.";
}

function locationErrorMessage(error: GeolocationPositionError) {
  if (error.code === error.PERMISSION_DENIED) {
    return "Zdielanie polohy nebolo povolene.";
  }

  if (error.code === error.POSITION_UNAVAILABLE) {
    return "Telefon teraz nevie zistit polohu.";
  }

  if (error.code === error.TIMEOUT) {
    return "Zistenie polohy trvalo prilis dlho.";
  }

  return "Polohu sa nepodarilo ziskat.";
}
