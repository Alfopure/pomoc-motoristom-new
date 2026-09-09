"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Clock3, Plus, RotateCcw, Route, X } from "lucide-react";
import { formatDrivingDistance, formatDrivingDuration, isDrivingRouteResult, MAX_ROUTE_INTERMEDIATES, type DrivingRouteResult } from "@/lib/driving-route";
import { RoutePlaceField, type RoutePlace } from "./RoutePlaceField";

type RouteStop = { id: number; place: RoutePlace | null };
const smallButton = "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 disabled:opacity-30";
const pointButton = "inline-flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 disabled:opacity-30";

export function RoutePlanner({ mapRef, onClose }: {
  mapRef: MutableRefObject<google.maps.Map | null>;
  onClose: () => void;
}) {
  const [stops, setStops] = useState<RouteStop[]>([{ id: 0, place: null }, { id: 1, place: null }]);
  const nextIdRef = useRef(2);
  const requestRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [result, setResult] = useState<DrivingRouteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = stops.every(stop => stop.place !== null);

  useEffect(() => () => requestRef.current?.abort(), []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = new google.maps.LatLngBounds();
    const markers = stops.flatMap((stop, index) => {
      if (!stop.place) return [];
      bounds.extend(stop.place);
      const content = document.createElement("span");
      content.className = "flex h-8 min-w-8 items-center justify-center rounded-full border-2 border-white bg-blue-700 px-1 text-sm font-bold text-white shadow-md";
      content.textContent = String(index + 1);
      return [new google.maps.marker.AdvancedMarkerElement({
        map, position: stop.place, title: `${index + 1}. ${stop.place.label}`, content, zIndex: 40,
      })];
    });
    let polyline: google.maps.Polyline | null = null;
    if (result) {
      const path = google.maps.geometry.encoding.decodePath(result.encodedPolyline);
      path.forEach(point => bounds.extend(point));
      polyline = new google.maps.Polyline({ map, path, strokeColor: "#1d4ed8", strokeOpacity: 0.9, strokeWeight: 6, zIndex: 30 });
    }
    if (markers.length) {
      // Leave room for the form so both endpoints stay visible beside/below it.
      const panel = panelRef.current?.getBoundingClientRect();
      const mapRect = map.getDiv().getBoundingClientRect();
      const desktop = mapRect.width >= 700;
      const padding = { top: desktop ? 70 : Math.min((panel?.height ?? 200) + 70, mapRect.height * 0.65), right: 40, bottom: 40, left: desktop ? (panel?.width ?? 400) + 30 : 40 };
      if (markers.length === 1 && !result) {
        const firstPlace = stops.find(stop => stop.place)?.place;
        if (firstPlace) map.panTo(firstPlace);
        map.setZoom(12);
      } else {
        map.fitBounds(bounds, padding);
      }
    }
    return () => {
      markers.forEach(marker => { marker.map = null; });
      polyline?.setMap(null);
    };
  }, [mapRef, result, stops]);

  function invalidate() {
    requestRef.current?.abort();
    setBusy(false);
    setError(null);
    setResult(null);
  }

  function updateStops(next: RouteStop[]) {
    invalidate();
    setStops(next);
  }

  function moveStop(index: number, offset: number) {
    const next = [...stops];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    updateStops(next);
  }

  async function calculate() {
    if (!ready) return;
    invalidate();
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    const points = stops.map(stop => ({ lat: stop.place!.lat, lng: stop.place!.lng }));
    try {
      const response = await fetch("/api/maps/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin: points[0], destination: points.at(-1), intermediates: points.slice(1, -1) }),
        signal: controller.signal,
      });
      const data: unknown = await response.json();
      if (!response.ok || !isDrivingRouteResult(data)) {
        const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "Trasu sa nepodarilo vypočítať. Skúste to znova.";
        throw new Error(message);
      }
      if (!controller.signal.aborted) setResult(data);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Výpočet trasy zlyhal. Skúste to znova.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <section ref={panelRef} aria-label="Plánovač trasy" className="pointer-events-auto min-h-0 w-full overflow-y-auto overscroll-contain rounded-xl bg-white/95 p-3 shadow-sm ring-1 ring-zinc-200 backdrop-blur sm:w-[400px]">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-950"><Route size={17} /> Plánovač trasy</h2>
        <button type="button" className={smallButton} onClick={onClose} aria-label="Zavrieť plánovač trasy"><X size={16} /></button>
      </div>
      <p className="mb-3 text-xs text-zinc-500">Cesta autom na Slovensku aj v zahraničí.</p>
      <div className="space-y-3">
        {stops.map((stop, index) => (
          <div key={stop.id} className="flex items-start gap-2">
            <span className="mt-9 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-bold text-blue-700">{index + 1}</span>
            <RoutePlaceField
              label={index === 0 ? "Odkiaľ" : index === stops.length - 1 ? "Kam" : `Bod prejazdu ${index}`}
              value={stop.place}
              actions={index > 0 && index < stops.length - 1 ? (
                <div className="flex items-center">
                  <button type="button" className={pointButton} disabled={index === 1} onClick={() => moveStop(index, -1)} aria-label={`Posunúť bod ${index} vyššie`}><ArrowUp size={14} /></button>
                  <button type="button" className={pointButton} disabled={index === stops.length - 2} onClick={() => moveStop(index, 1)} aria-label={`Posunúť bod ${index} nižšie`}><ArrowDown size={14} /></button>
                  <button type="button" className={pointButton} onClick={() => updateStops(stops.filter(item => item.id !== stop.id))} aria-label={`Odstrániť bod ${index}`}><X size={14} /></button>
                </div>
              ) : undefined}
              onChange={place => {
                invalidate();
                setStops(current => current.map(item => item.id === stop.id ? { ...item, place } : item));
              }}
            />
          </div>
        ))}
      </div>
      <div className="my-3 flex flex-wrap items-center gap-2">
        <button type="button" disabled={stops.length >= MAX_ROUTE_INTERMEDIATES + 2} onClick={() => updateStops([...stops.slice(0, -1), { id: nextIdRef.current++, place: null }, stops[stops.length - 1]])} className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"><Plus size={14} /> Pridať bod prejazdu</button>
        <button type="button" onClick={() => updateStops([...stops].reverse())} className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-100"><ArrowUpDown size={14} /> Otočiť trasu</button>
      </div>
      <button type="button" disabled={!ready || busy} onClick={() => void calculate()} className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-zinc-950 px-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300">
        {result ? <RotateCcw size={15} /> : <Route size={15} />}
        {busy ? "Počítam trasu…" : result ? "Prepočítať podľa dopravy" : "Vypočítať trasu"}
      </button>
      {!ready && <p className="mt-2 text-xs text-zinc-500">Vyberte štart, cieľ a každý bod prejazdu z ponúkaných miest.</p>}
      <div aria-live="polite" aria-busy={busy}>
        {error && <p role="alert" className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{error}</p>}
        {result && (
          <div className="mt-3 border-t border-zinc-200 pt-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-blue-50 p-3"><span className="flex items-center gap-1 text-xs text-blue-800"><Route size={13} /> Vzdialenosť</span><strong className="mt-1 block text-lg text-zinc-950">{formatDrivingDistance(result.distanceMeters)}</strong></div>
              <div className="rounded-lg bg-blue-50 p-3"><span className="flex items-center gap-1 text-xs text-blue-800"><Clock3 size={13} /> Čas jazdy cca</span><strong className="mt-1 block text-lg text-zinc-950">{formatDrivingDuration(result.durationSeconds)}</strong></div>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">Odhad pri odchode teraz podľa dostupnej dopravy. Čas nezahŕňa prestávky.</p>
            <p className="mt-1 text-[11px] text-zinc-500">Google Maps · Prepočítané {new Date(result.calculatedAt).toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit" })}</p>
          </div>
        )}
      </div>
    </section>
  );
}
