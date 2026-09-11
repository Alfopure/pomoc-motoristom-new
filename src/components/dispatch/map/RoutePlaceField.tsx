"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { loadGoogleMaps } from "@/lib/google-maps-client";
import { createPlaceAutocompleteElement } from "@/lib/google-maps-places";
import type { RoutePlace } from "./route-planner-model";
export type { RoutePlace } from "./route-planner-model";

const PLACE_LOOKUP_TIMEOUT_MS = 15_000;

export function RoutePlaceField({ label, value, query, onChange, actions, active = true }: {
  label: string;
  value: RoutePlace | null;
  query: string;
  onChange: (place: RoutePlace | null, query: string) => void;
  actions?: ReactNode;
  active?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<google.maps.places.PlaceAutocompleteElement | null>(null);
  const onChangeRef = useRef(onChange);
  const textRef = useRef(query);
  const sequenceRef = useRef(0);
  const selectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [libraryReady, setLibraryReady] = useState(() => typeof google !== "undefined" && Boolean(google.maps.places?.PlaceAutocompleteElement));
  const loadingRef = useRef(false);
  const mountedRef = useRef(false);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  const cancelSelection = useCallback(() => {
    if (selectionTimerRef.current !== null) {
      clearTimeout(selectionTimerRef.current);
      selectionTimerRef.current = null;
    }
    return ++sequenceRef.current;
  }, []);

  async function enableSearch() {
    if (!active || loadingRef.current || libraryReady) return;
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;
    if (!apiKey || apiKey.startsWith("replace-with")) { setNotice("Vyhľadávanie miest nie je nakonfigurované."); return; }
    loadingRef.current = true;
    try {
      await loadGoogleMaps(apiKey);
      if (mountedRef.current) { setNotice(null); setLibraryReady(true); }
    } catch { if (mountedRef.current) setNotice("Vyhľadávanie nie je dostupné. Skúste to znova."); }
    finally { loadingRef.current = false; }
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!active || !host || !libraryReady) return;
    const element = createPlaceAutocompleteElement(label, textRef.current, "Mesto alebo adresa aj v zahraničí");
    element.style.fontSize = "16px";
    element.style.minHeight = "44px";
    const onInput = () => {
      if (element.value === textRef.current) return;
      cancelSelection();
      textRef.current = element.value;
      setNotice(null);
      onChangeRef.current(null, element.value);
    };
    const onSelect: EventListener = (event) => {
      const requestId = cancelSelection();
      // Google can replace the typed query with a prediction's full address
      // before gmp-select, without an input event. Record our own update before
      // publishing it so prop synchronization does not cancel this lookup.
      textRef.current = element.value;
      onChangeRef.current(null, textRef.current);
      setNotice("Načítavam miesto…");
      selectionTimerRef.current = setTimeout(() => {
        if (requestId !== sequenceRef.current) return;
        cancelSelection();
        setNotice("Načítanie miesta trvá príliš dlho. Vyberte ho znova.");
      }, PLACE_LOOKUP_TIMEOUT_MS);
      // Google fetchFields cannot be aborted; sequence checks discard stale
      // responses after edits, reordering, timeout or hiding the widget.
      // Keep toPlace inside the async boundary so synchronous SDK errors also
      // finish loading and allow the user to select another prediction.
      void (async () => {
        const place = (event as google.maps.places.PlacePredictionSelectEvent).placePrediction.toPlace();
        await place.fetchFields({ fields: ["formattedAddress", "displayName", "location"] });
        const lat = place.location?.lat(), lng = place.location?.lng();
        if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)
          || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
        return { label: place.formattedAddress?.trim() || place.displayName?.trim() || `${lat}, ${lng}`, lat, lng };
      })().then(place => {
        if (requestId !== sequenceRef.current) return;
        cancelSelection();
        if (!place) { setNotice("Vyberte miesto s platnou polohou."); return; }
        textRef.current = place.label;
        element.value = place.label;
        onChangeRef.current(place, place.label);
        setNotice(null);
      }).catch(() => {
        if (requestId !== sequenceRef.current) return;
        cancelSelection();
        setNotice("Miesto sa nepodarilo načítať. Vyberte ho znova.");
      });
    };
    const onError = () => {
      cancelSelection();
      textRef.current = element.value;
      onChangeRef.current(null, element.value);
      setNotice("Vyhľadávanie nie je dostupné. Skúste to znova.");
    };
    elementRef.current = element;
    element.addEventListener("input", onInput);
    element.addEventListener("gmp-select", onSelect);
    element.addEventListener("gmp-error", onError);
    host.replaceChildren(element);
    return () => {
      cancelSelection();
      if (mountedRef.current) setNotice(null);
      element.removeEventListener("input", onInput);
      element.removeEventListener("gmp-select", onSelect);
      element.removeEventListener("gmp-error", onError);
      elementRef.current = null;
      host.replaceChildren();
    };
  }, [active, cancelSelection, label, libraryReady]);

  useEffect(() => {
    if (query !== textRef.current) {
      cancelSelection();
      setNotice(null);
    }
    textRef.current = query;
    if (elementRef.current && elementRef.current.value !== query) elementRef.current.value = query;
  }, [cancelSelection, query, value]);

  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 flex min-h-6 items-center justify-between gap-1">
        <span className="text-xs font-semibold text-zinc-600">{label}</span>{actions}
      </div>
      {!libraryReady && <input aria-label={label} value={query} placeholder="Mesto alebo adresa aj v zahraničí" onFocus={() => void enableSearch()} onChange={event => onChange(null, event.target.value)} className="min-h-11 w-full rounded-md border border-zinc-200 px-3 text-base" />}
      <div ref={hostRef} className={libraryReady ? "google-place-autocomplete-host min-h-11" : "hidden"} />
      {notice && <p role="status" className="mt-1 text-xs text-amber-800">{notice}</p>}
    </div>
  );
}
