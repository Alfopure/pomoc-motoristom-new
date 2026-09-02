"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, MapPin } from "lucide-react";
import type { PlaceSelectionInput } from "@/data/case-inputs";
import { loadGoogleMaps } from "@/lib/google-maps-client";
import { createPlaceAutocompleteElement } from "@/lib/google-maps-places";
import { RequiredMark } from "./case-form-fields";

const googleMapsApiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;

export function GooglePlaceAutocomplete({
  label,
  manualValue = "",
  onManualChange,
  onSelect,
  placeholder,
  required = false,
  value,
}: {
  label: string;
  manualValue?: string;
  onManualChange?: (value: string) => void;
  onSelect: (place: PlaceSelectionInput) => void;
  placeholder?: string;
  required?: boolean;
  value?: PlaceSelectionInput | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const elementRef = useRef<google.maps.places.PlaceAutocompleteElement | null>(null);
  const onSelectRef = useRef(onSelect);
  const requestIdRef = useRef(0);
  const valueRef = useRef(value);
  const manualInputId = useId();
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">(() =>
    isConfiguredGoogleKey(googleMapsApiKey) ? "loading" : "idle",
  );
  const [selectionState, setSelectionState] = useState<"idle" | "loading">("idle");
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const manualError = manualValue.trim().length > 0 && manualValue.trim().length < 3
    ? "Ručný opis miesta musí obsahovať aspoň 3 znaky."
    : null;

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (!isConfiguredGoogleKey(googleMapsApiKey) || !googleMapsApiKey) {
      return;
    }

    let cancelled = false;

    loadGoogleMaps(googleMapsApiKey)
      .then(async (googleMaps) => {
        await googleMaps.maps.importLibrary?.("places");
        if (!cancelled) {
          setLoadState("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadState("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (loadState !== "ready" || !hostRef.current) {
      return;
    }

    const host = hostRef.current;
    const currentValue = valueRef.current;
    const element = createPlaceAutocompleteElement(label, currentValue?.address ?? currentValue?.label ?? "", placeholder ?? label);
    const listener: EventListener = (event) => {
      const selectEvent = event as google.maps.places.PlacePredictionSelectEvent;
      const requestId = ++requestIdRef.current;
      setSelectionState("loading");
      setSelectionError(null);
      void resolvePrediction(selectEvent.placePrediction)
        .then((place) => {
          if (requestId !== requestIdRef.current) {
            return;
          }
          if (!place) {
            setSelectionError("Vybrané miesto nemá použiteľné súradnice.");
            return;
          }
          onSelectRef.current(place);
        })
        .catch(() => {
          if (requestId === requestIdRef.current) {
            setSelectionError("Miesto sa nepodarilo načítať. Skúste ho vybrať znova.");
          }
        })
        .finally(() => {
          if (requestId === requestIdRef.current) {
            setSelectionState("idle");
          }
        });
    };

    elementRef.current = element;
    element.addEventListener("gmp-select", listener);
    host.replaceChildren(element);

    return () => {
      requestIdRef.current += 1;
      elementRef.current = null;
      element.removeEventListener("gmp-select", listener);
      host.replaceChildren();
    };
  }, [label, loadState, placeholder]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }

    const nextValue = value?.address ?? value?.label ?? "";
    if (element.value !== nextValue) {
      element.value = nextValue;
    }
  }, [value?.address, value?.label]);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="text-xs font-semibold uppercase tracking-normal text-zinc-500">{label}{required && <RequiredMark />}</label>
        {value?.placeId && <span className="truncate text-[11px] font-medium text-zinc-400">Google Place ID</span>}
      </div>
      <div ref={hostRef} className="google-place-autocomplete-host min-h-10" />
      {loadState === "idle" && <AutocompleteNotice text="Chýba Google browser key pre Places našeptávač." />}
      {loadState === "error" && <AutocompleteNotice text="Places našeptávač sa nepodarilo načítať." />}
      {(loadState === "idle" || loadState === "error") && onManualChange && (
        <div className="mt-2">
          <label htmlFor={manualInputId} className="mb-1 block text-xs font-semibold text-zinc-600">
            Ručne zadaná adresa alebo opis miesta
          </label>
          <input
            id={manualInputId}
            type="text"
            value={manualValue}
            onChange={(event) => onManualChange(event.target.value)}
            placeholder={placeholder ?? "Napíšte adresu alebo opis miesta"}
            aria-invalid={Boolean(manualError)}
            aria-required={required}
            required={required}
            className={`h-10 w-full min-w-0 rounded-md border bg-white px-3 text-sm outline-none transition focus:ring-2 ${
              manualError ? "border-red-300 ring-red-200" : "border-zinc-200 ring-yellow-300"
            }`}
          />
          {manualError && <span role="alert" className="mt-1 block text-xs font-medium text-red-700">{manualError}</span>}
          <span className="mt-1 block text-[11px] font-medium text-zinc-500">
            Kartu môžete uložiť aj bez súradníc. Trasa a navigácia budú dostupné po neskoršom výbere bodu na mape.
          </span>
        </div>
      )}
      <div className="min-h-5 pt-1 text-xs font-medium" aria-live="polite">
        {selectionState === "loading" && <span className="text-zinc-500">Overujem vybrané miesto…</span>}
        {selectionError && <span role="alert" className="text-red-700">{selectionError}</span>}
      </div>
      {value && (
        <div className="mt-2 flex items-start gap-2 rounded-md bg-zinc-50 px-2 py-2 text-xs text-zinc-600">
          <MapPin size={14} className="mt-0.5 shrink-0 text-zinc-500" />
          <span className="min-w-0">
            <span className="block truncate font-semibold text-zinc-800">{value.label}</span>
            <span className="block truncate">{value.address}</span>
          </span>
        </div>
      )}
    </div>
  );
}

async function resolvePrediction(placePrediction: google.maps.places.PlacePrediction): Promise<PlaceSelectionInput | null> {
  const place = placePrediction.toPlace();
  await place.fetchFields({ fields: ["displayName", "formattedAddress", "location", "id"] });

  const location = place.location;
  if (!location) {
    return null;
  }

  const address = place.formattedAddress ?? place.displayName ?? "";
  const label = place.displayName ?? place.formattedAddress ?? address;

  return {
    label,
    address,
    lat: location.lat(),
    lng: location.lng(),
    placeId: place.id,
    provider: "google_places",
  };
}

function AutocompleteNotice({ text }: { text: string }) {
  return (
    <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-2 text-xs font-medium text-amber-900">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

function isConfiguredGoogleKey(value: string | undefined) {
  return Boolean(value && !value.startsWith("replace-with"));
}
