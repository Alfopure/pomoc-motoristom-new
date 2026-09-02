"use client";

import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { X } from "lucide-react";
import { createPlaceAutocompleteElement } from "@/lib/google-maps-places";

export function MapPlaceSearch({
  loadState,
  mapRef,
  open,
  searchMarkerRef,
  onClose,
}: {
  loadState: "idle" | "loading" | "ready" | "error";
  mapRef: MutableRefObject<google.maps.Map | null>;
  open: boolean;
  searchMarkerRef: MutableRefObject<google.maps.marker.AdvancedMarkerElement | null>;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (loadState !== "ready" || !hostRef.current) {
      return;
    }

    const host = hostRef.current;
    const element = createPlaceAutocompleteElement("Hľadať miesto", "", "Hľadať miesto");
    const listener: EventListener = (event) => {
      const selectEvent = event as google.maps.places.PlacePredictionSelectEvent;
      void applyPlaceSelection(selectEvent.placePrediction, mapRef, searchMarkerRef);
    };

    element.addEventListener("gmp-select", listener);
    host.replaceChildren(element);

    return () => {
      element.removeEventListener("gmp-select", listener);
      host.replaceChildren();
    };
  }, [loadState, mapRef, searchMarkerRef]);

  useEffect(() => {
    if (!open || loadState !== "ready") {
      return;
    }

    hostRef.current?.querySelector("input")?.focus();
  }, [loadState, open]);

  useEffect(
    () => () => {
      clearSearchMarker(searchMarkerRef);
    },
    [searchMarkerRef],
  );

  if (loadState !== "ready") {
    return null;
  }

  return (
    <div
      className={`pointer-events-auto w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5 rounded-xl bg-white/95 p-1.5 shadow-sm ring-1 ring-zinc-200 backdrop-blur sm:w-[400px] ${open ? "grid" : "hidden"}`}
    >
      <div ref={hostRef} className="google-place-autocomplete-host min-h-10 min-w-0" />
      <button
        type="button"
        onClick={onClose}
        aria-label="Zavrieť vyhľadávanie"
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
      >
        <X size={16} />
      </button>
    </div>
  );
}

async function applyPlaceSelection(
  placePrediction: google.maps.places.PlacePrediction,
  mapRef: MutableRefObject<google.maps.Map | null>,
  searchMarkerRef: MutableRefObject<google.maps.marker.AdvancedMarkerElement | null>,
) {
  const map = mapRef.current;
  if (!map) {
    return;
  }

  const place = placePrediction.toPlace();
  await place.fetchFields({ fields: ["displayName", "formattedAddress", "location"] });

  const location = place.location;
  if (!location) {
    return;
  }

  clearSearchMarker(searchMarkerRef);
  map.panTo(location);
  map.setZoom(14);
  searchMarkerRef.current = new google.maps.marker.AdvancedMarkerElement({
    content: createSearchMarkerContent(),
    map,
    position: location,
    title: place.displayName ?? place.formattedAddress ?? "Vyhľadané miesto",
    zIndex: 30,
  });
}

function clearSearchMarker(searchMarkerRef: MutableRefObject<google.maps.marker.AdvancedMarkerElement | null>) {
  if (searchMarkerRef.current) {
    searchMarkerRef.current.map = null;
    searchMarkerRef.current = null;
  }
}

function createSearchMarkerContent() {
  const shell = document.createElement("span");
  shell.className = "dispatch-map-pin-shell";

  const pin = document.createElement("span");
  pin.className = "dispatch-map-pin dispatch-map-pin-search dispatch-map-pin-active";
  shell.append(pin);

  return shell;
}
