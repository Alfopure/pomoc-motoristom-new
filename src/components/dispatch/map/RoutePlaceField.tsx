"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { loadGoogleMaps } from "@/lib/google-maps-client";
import { createPlaceAutocompleteElement } from "@/lib/google-maps-places";
import type { RoutePlace } from "./route-planner-model";
export type { RoutePlace } from "./route-planner-model";

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
  const [notice, setNotice] = useState<string | null>(null);
  const [libraryReady, setLibraryReady] = useState(() => typeof google !== "undefined" && Boolean(google.maps.places?.PlaceAutocompleteElement));
  const loadingRef = useRef(false);
  const mountedRef = useRef(false);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

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
      sequenceRef.current += 1;
      textRef.current = element.value;
      setNotice(null);
      onChangeRef.current(null, element.value);
    };
    const onSelect: EventListener = (event) => {
      const requestId = ++sequenceRef.current;
      onChangeRef.current(null, element.value);
      setNotice("Načítavam miesto…");
      const place = (event as google.maps.places.PlacePredictionSelectEvent).placePrediction.toPlace();
      // Google fetchFields cannot be aborted; sequence checks discard stale
      // responses after edits, reordering, or switching away from the widget.
      void place.fetchFields({ fields: ["formattedAddress", "displayName", "location"] }).then(() => {
        if (requestId !== sequenceRef.current) return;
        const lat = place.location?.lat(), lng = place.location?.lng();
        if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) { setNotice("Vyberte miesto s platnou polohou."); return; }
        const address = place.formattedAddress ?? place.displayName ?? `${lat}, ${lng}`;
        textRef.current = address;
        element.value = address;
        onChangeRef.current({ label: address, lat, lng }, address);
        setNotice(null);
      }).catch(() => { if (requestId === sequenceRef.current) setNotice("Miesto sa nepodarilo načítať. Vyberte ho znova."); });
    };
    const onError = () => {
      sequenceRef.current += 1;
      onChangeRef.current(null, element.value);
      setNotice("Vyhľadávanie nie je dostupné. Skúste to znova.");
    };
    elementRef.current = element;
    element.addEventListener("input", onInput);
    element.addEventListener("gmp-select", onSelect);
    element.addEventListener("gmp-error", onError);
    host.replaceChildren(element);
    return () => {
      sequenceRef.current += 1;
      element.removeEventListener("input", onInput);
      element.removeEventListener("gmp-select", onSelect);
      element.removeEventListener("gmp-error", onError);
      elementRef.current = null;
      host.replaceChildren();
    };
  }, [active, label, libraryReady]);

  useEffect(() => {
    if (query !== textRef.current) sequenceRef.current += 1;
    textRef.current = query;
    if (elementRef.current && elementRef.current.value !== query) elementRef.current.value = query;
  }, [query, value]);

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
