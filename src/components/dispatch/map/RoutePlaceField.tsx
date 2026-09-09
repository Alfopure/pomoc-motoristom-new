"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPlaceAutocompleteElement } from "@/lib/google-maps-places";

export type RoutePlace = { lat: number; lng: number; label: string };

export function RoutePlaceField({ label, value, onChange, actions }: {
  label: string;
  value: RoutePlace | null;
  onChange: (place: RoutePlace | null) => void;
  actions?: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<google.maps.places.PlaceAutocompleteElement | null>(null);
  const onChangeRef = useRef(onChange);
  const textRef = useRef(value?.label ?? "");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const element = createPlaceAutocompleteElement(label, textRef.current, "Mesto alebo adresa aj v zahraničí");
    let sequence = 0;
    const onInput = () => {
      sequence += 1;
      textRef.current = element.value;
      setNotice(null);
      onChangeRef.current(null);
    };
    const onSelect: EventListener = (event) => {
      const requestId = ++sequence;
      onChangeRef.current(null);
      setNotice("Načítavam miesto…");
      const place = (event as google.maps.places.PlacePredictionSelectEvent).placePrediction.toPlace();
      void place.fetchFields({ fields: ["formattedAddress", "displayName", "location"] }).then(() => {
        if (requestId !== sequence) return;
        const lat = place.location?.lat();
        const lng = place.location?.lng();
        if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) {
          setNotice("Vyberte miesto s platnou polohou.");
          return;
        }
        const address = place.formattedAddress ?? place.displayName ?? `${lat}, ${lng}`;
        textRef.current = address;
        element.value = address;
        onChangeRef.current({ label: address, lat, lng });
        setNotice(null);
      }).catch(() => {
        if (requestId === sequence) setNotice("Miesto sa nepodarilo načítať. Vyberte ho znova.");
      });
    };
    const onError = () => {
      sequence += 1;
      onChangeRef.current(null);
      setNotice("Vyhľadávanie nie je dostupné. Skúste to znova.");
    };
    elementRef.current = element;
    element.addEventListener("input", onInput);
    element.addEventListener("gmp-select", onSelect);
    element.addEventListener("gmp-error", onError);
    host.replaceChildren(element);
    return () => {
      sequence += 1;
      element.removeEventListener("input", onInput);
      element.removeEventListener("gmp-select", onSelect);
      element.removeEventListener("gmp-error", onError);
      elementRef.current = null;
      host.replaceChildren();
    };
  }, [label]);

  useEffect(() => {
    if (value && elementRef.current) {
      textRef.current = value.label;
      elementRef.current.value = value.label;
    }
  }, [value]);

  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 flex min-h-6 items-center justify-between gap-1">
        <span className="text-xs font-semibold text-zinc-600">{label}</span>
        {actions}
      </div>
      <div ref={hostRef} className="google-place-autocomplete-host min-h-10" />
      {notice && <p role="status" className="mt-1 text-xs text-amber-800">{notice}</p>}
    </div>
  );
}
