"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Crosshair, MapPin, Search } from "lucide-react";
import type { PlaceSelectionInput } from "@/data/case-inputs";
import { loadGoogleMaps } from "@/lib/google-maps-client";
import { buildApproximateLocationQuery, parseLocationCoordinates } from "./location-input";

const googleMapsApiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;
// Stred Slovenska ako východiskový pohľad, keď ešte nie je vybraté miesto.
const SK_CENTER = { lat: 48.669, lng: 19.699 };

type LoadState = "idle" | "loading" | "ready" | "error";

/**
 * Druhý a tretí spôsob zadania lokality (popri Google Places našeptávači):
 *  - klik priamo do mapy -> presný bod incidentu (provider "manual"), reverse-geocode len na adresu,
 *  - voľný približný text -> forward-geocode (provider "approximate").
 * Oba produkujú platný PlaceSelectionInput s lat/lng, takže prejdú backend validáciou.
 */
export function LocationPicker({
  value,
  onSelect,
}: {
  value?: PlaceSelectionInput | null;
  onSelect: (place: PlaceSelectionInput) => void;
}) {
  const mapHostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const geocoderRef = useRef<google.maps.Geocoder | null>(null);
  const selectionRequestRef = useRef(0);
  const onSelectRef = useRef(onSelect);

  const [loadState, setLoadState] = useState<LoadState>(() =>
    isConfiguredGoogleKey(googleMapsApiKey) ? "loading" : "idle",
  );
  const [approxText, setApproxText] = useState("");
  const [approxBusy, setApproxBusy] = useState(false);
  const [approxError, setApproxError] = useState<string | null>(null);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (!isConfiguredGoogleKey(googleMapsApiKey) || !googleMapsApiKey) {
      return;
    }
    let cancelled = false;
    loadGoogleMaps(googleMapsApiKey)
      .then(async (googleMaps) => {
        await Promise.all([
          googleMaps.maps.importLibrary?.("maps"),
          googleMaps.maps.importLibrary?.("geocoding"),
        ]);
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

  // Inicializuj mapu raz, keď je API pripravené.
  useEffect(() => {
    if (loadState !== "ready" || !mapHostRef.current || mapRef.current) {
      return;
    }
    const hasValue = Boolean(value && Number.isFinite(value.lat) && Number.isFinite(value.lng));
    const map = new google.maps.Map(mapHostRef.current, {
      center: hasValue ? { lat: value!.lat, lng: value!.lng } : SK_CENTER,
      zoom: hasValue ? 14 : 7,
      disableDefaultUI: true,
      zoomControl: true,
      clickableIcons: false,
    });
    geocoderRef.current = new google.maps.Geocoder();
    mapRef.current = map;
    const clickListener = map.addListener("click", (event: google.maps.MapMouseEvent) => {
      const latLng = event.latLng;
      if (latLng) {
        void handlePickedPoint(latLng.lat(), latLng.lng());
      }
    });
    if (hasValue) {
      setMarker(value!.lat, value!.lng);
    }
    return () => {
      clickListener.remove();
      markerRef.current?.setMap(null);
      markerRef.current = null;
      geocoderRef.current = null;
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadState]);

  // Ak sa miesto zmení zvonka (napr. cez Google Places našeptávač), premietni ho do mapy.
  useEffect(() => {
    selectionRequestRef.current += 1;
    if (!mapRef.current || !value || !Number.isFinite(value.lat) || !Number.isFinite(value.lng)) {
      return;
    }
    setMarker(value.lat, value.lng);
    mapRef.current.setCenter({ lat: value.lat, lng: value.lng });
    if ((mapRef.current.getZoom() ?? 7) < 12) {
      mapRef.current.setZoom(14);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.lat, value?.lng]);

  function setMarker(lat: number, lng: number) {
    if (!mapRef.current) {
      return;
    }
    if (!markerRef.current) {
      markerRef.current = new google.maps.Marker({ map: mapRef.current });
    }
    markerRef.current.setPosition({ lat, lng });
  }

  async function handlePickedPoint(lat: number, lng: number) {
    const requestId = ++selectionRequestRef.current;
    setApproxBusy(false);
    setMarker(lat, lng);
    // Bod na mape platí aj bez adresy; reverse-geocode je len doplnenie adresy.
    let address = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    try {
      const result = await geocoderRef.current?.geocode({ location: { lat, lng } });
      const first = result?.results?.[0];
      if (first?.formatted_address) {
        address = first.formatted_address;
      }
    } catch {
      // ignoruj – bod na mape je platný aj bez reverse-geocode
    }
    if (requestId !== selectionRequestRef.current) {
      return;
    }
    onSelectRef.current({ label: "Bod na mape", address, lat, lng, provider: "manual" });
  }

  async function submitApproximate() {
    const query = approxText.trim();
    if (!query) {
      return;
    }
    const requestId = ++selectionRequestRef.current;
    setApproxError(null);

    const coordinates = parseLocationCoordinates(query);
    if (coordinates) {
      setApproxBusy(false);
      onSelectRef.current({
        label: "GPS súradnice",
        address: `${coordinates.lat.toFixed(6)}, ${coordinates.lng.toFixed(6)}`,
        lat: coordinates.lat,
        lng: coordinates.lng,
        provider: "manual",
      });
      return;
    }

    if (!geocoderRef.current) {
      setApproxError("Vyhľadávanie adries nie je dostupné. Môžete vložiť GPS súradnice.");
      return;
    }
    setApproxBusy(true);
    try {
      const result = await geocoderRef.current.geocode({ address: buildApproximateLocationQuery(query) });
      const first = result.results?.[0];
      const location = first?.geometry?.location;
      if (!location) {
        if (requestId === selectionRequestRef.current) {
          setApproxError("Miesto sa nenašlo. Skús presnejší popis.");
        }
        return;
      }
      if (requestId !== selectionRequestRef.current) {
        return;
      }
      onSelectRef.current({
        label: query,
        address: first.formatted_address ?? query,
        lat: location.lat(),
        lng: location.lng(),
        provider: "approximate",
      });
    } catch {
      if (requestId === selectionRequestRef.current) {
        setApproxError("Približné vyhľadanie zlyhalo.");
      }
    } finally {
      if (requestId === selectionRequestRef.current) {
        setApproxBusy(false);
      }
    }
  }

  const coordinateInput = parseLocationCoordinates(approxText);
  const canSubmitApproximate = Boolean(approxText.trim()) && (loadState === "ready" || Boolean(coordinateInput));

  return (
    <div className="rounded-md border border-zinc-200 bg-white p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-normal text-zinc-500">
        <Crosshair size={13} /> Spresnenie miesta incidentu
      </div>

      {loadState === "idle" && <PickerNotice text="Chýba Google browser key pre mapu." />}
      {loadState === "error" && <PickerNotice text="Mapu sa nepodarilo načítať." />}
      {(loadState === "loading" || loadState === "ready") && (
        <div
          ref={mapHostRef}
          data-testid="location-picker-map"
          className="h-56 w-full overflow-hidden rounded-md border border-zinc-200 bg-zinc-100"
        />
      )}
      {loadState === "ready" && (
        <p className="mt-1 text-[11px] font-medium text-zinc-400">Klikni do mapy pre presný bod incidentu.</p>
      )}

      <div className="mt-3">
        <label className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">
          Približné miesto alebo GPS súradnice
        </label>
        <div className="flex gap-2">
          <input
            value={approxText}
            onChange={(event) => {
              selectionRequestRef.current += 1;
              setApproxText(event.target.value);
              setApproxBusy(false);
              setApproxError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitApproximate();
              }
            }}
            placeholder="napr. R1 pri Nitre alebo 48.1486, 17.1077"
            className="h-9 min-w-0 flex-1 rounded-md border border-zinc-200 px-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void submitApproximate()}
            disabled={approxBusy || !canSubmitApproximate}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
          >
            <Search size={14} /> Nájsť
          </button>
        </div>
        {loadState !== "ready" && (
          <p className="mt-1.5 text-[11px] font-medium text-zinc-500">
            Tu môžete vložiť GPS súradnice. Adresu bez súradníc môžete zadať ručne v poli vyššie.
          </p>
        )}
        <div className="min-h-10" aria-live="polite">
          {approxError && <PickerNotice text={approxError} />}
        </div>
      </div>

      {value && (value.provider === "manual" || value.provider === "approximate") && (
        <div className="mt-2 flex items-start gap-2 rounded-md bg-zinc-50 px-2 py-2 text-xs text-zinc-600">
          <MapPin size={14} className="mt-0.5 shrink-0 text-zinc-500" />
          <span className="min-w-0">
            <span className="block truncate font-semibold text-zinc-800">
              {value.label}
              {value.provider === "approximate" ? " · približné" : ""}
            </span>
            <span className="block truncate">{value.address}</span>
          </span>
        </div>
      )}
    </div>
  );
}

function PickerNotice({ text }: { text: string }) {
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
