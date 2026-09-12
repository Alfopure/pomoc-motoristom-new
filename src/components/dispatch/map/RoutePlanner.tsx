"use client";

import { useEffect, useId, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, ArrowUpDown, Clock3, Copy, GripVertical, Plus, RotateCcw, Route, X } from "lucide-react";
import { formatDrivingDistance, formatDrivingDuration, MAX_ROUTE_INTERMEDIATES } from "@/lib/driving-route";
import { RoutePlaceField } from "./RoutePlaceField";
import { RoutePlannerProvider, useOptionalRoutePlannerStore, useRoutePlanner } from "./RoutePlannerProvider";

const smallButton = "inline-flex h-11 w-11 lg:h-8 lg:w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 disabled:opacity-30";
const pointButton = "inline-flex h-11 w-11 lg:h-6 lg:w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 disabled:opacity-30";

type RoutePlannerProps = {
  mapRef?: MutableRefObject<google.maps.Map | null>;
  onClose?: () => void;
  embedded?: boolean;
  active?: boolean;
};

export function RoutePlanner(props: RoutePlannerProps) {
  const store = useOptionalRoutePlannerStore();
  if (!store) return <RoutePlannerProvider><RoutePlanner {...props} /></RoutePlannerProvider>;
  return <RoutePlannerContent {...props} />;
}

function RoutePlannerContent({ mapRef, onClose, embedded = false, active = true }: RoutePlannerProps) {
  const dragId = useId();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const store = useOptionalRoutePlannerStore()!;
  const { stops, result, busy, error } = useRoutePlanner(store);
  const panelRef = useRef<HTMLElement>(null);
  const viewportSignatureRef = useRef("");
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [orderNotice, setOrderNotice] = useState("");
  const ready = stops.every(stop => stop.place !== null);

  useEffect(() => {
    const map = mapRef?.current;
    if (!active || !map) return;
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
    const signature = JSON.stringify([stops.map(stop => stop.place && [stop.place.lat, stop.place.lng]), result?.encodedPolyline]);
    if (markers.length && signature !== viewportSignatureRef.current) {
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
    viewportSignatureRef.current = signature;
    return () => {
      markers.forEach(marker => { marker.map = null; });
      polyline?.setMap(null);
    };
  }, [active, mapRef, result, stops]);

  async function copyDistance() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(formatDrivingDistance(result.distanceMeters));
      setCopyNotice("Vzdialenosť skopírovaná.");
    } catch { setCopyNotice("Vzdialenosť sa nepodarilo skopírovať."); }
  }

  return (
    <section ref={panelRef} aria-label="Plánovač trasy" className={`pointer-events-auto min-h-0 w-full overflow-y-auto overscroll-contain rounded-xl bg-white/95 p-3 shadow-sm ring-1 ring-zinc-200 backdrop-blur ${embedded ? "" : "sm:w-[400px]"}`}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-950"><Route size={17} /> Plánovač trasy</h2>
        {onClose && <button type="button" className={smallButton} onClick={onClose} aria-label="Zavrieť plánovač trasy"><X size={16} /></button>}
      </div>
      <p className="mb-3 text-xs text-zinc-500">Usporiadajte miesta potiahnutím alebo šípkami. Trasa sa prepočíta na požiadanie.</p>
      <DndContext id={dragId} sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active: dragged, over }) => {
        if (active && over && dragged.id !== over.id) { store.reorderStop(Number(dragged.id), Number(over.id)); setOrderNotice("Poradie bodov je zmenené. Trasu môžete prepočítať."); }
      }} accessibility={{ announcements: {
        onDragStart: ({ active: dragged }) => `Zdvíhate miesto ${stops.findIndex(stop => stop.id === dragged.id) + 1}.`,
        onDragOver: ({ over }) => over ? `Miesto je nad pozíciou ${stops.findIndex(stop => stop.id === over.id) + 1}.` : "Miesto je mimo poradia.",
        onDragEnd: ({ over }) => over ? `Presun na pozíciu ${stops.findIndex(stop => stop.id === over.id) + 1} je potvrdený.` : "Poradie zostalo zachované.",
        onDragCancel: () => "Presun je zrušený. Poradie zostalo zachované.",
      }, screenReaderInstructions: { draggable: "Medzerníkom zdvihnite bod, šípkami hore a dole zmeňte poradie a medzerníkom potvrďte. Escape presun zruší." } }}>
      <SortableContext items={stops.map(stop => stop.id)} strategy={verticalListSortingStrategy}>
      <div className="space-y-3">
        {stops.map((stop, index) => (
          <RouteStopRow key={stop.id} id={stop.id} index={index} disabled={!active}>
            <RoutePlaceField
              label={index === 0 ? "Odkiaľ" : index === stops.length - 1 ? "Kam" : `Bod prejazdu ${index}`}
              value={stop.place}
              query={stop.query}
              active={active}
              actions={
                <div className="flex items-center">
                  <button type="button" className={pointButton} disabled={!active || index === 0} onClick={() => store.reorderStop(stop.id, stops[index - 1].id)} aria-label={`Posunúť bod ${index} vyššie`}><ArrowUp size={14} /></button>
                  <button type="button" className={pointButton} disabled={!active || index === stops.length - 1} onClick={() => store.reorderStop(stop.id, stops[index + 1].id)} aria-label={`Posunúť bod ${index} nižšie`}><ArrowDown size={14} /></button>
                  {index > 0 && index < stops.length - 1 && <button type="button" className={pointButton} onClick={() => store.removeStop(stop.id)} aria-label={`Odstrániť bod ${index}`}><X size={14} /></button>}
                </div>
              }
              onChange={(place, query) => store.updatePlace(stop.id, place, query)}
            />
          </RouteStopRow>
        ))}
      </div>
      </SortableContext>
      </DndContext>
      {orderNotice && <p role="status" className="mt-2 text-xs text-blue-800">{orderNotice}</p>}
      <div className="my-3 flex flex-wrap items-center gap-2">
        <button type="button" disabled={stops.length >= MAX_ROUTE_INTERMEDIATES + 2} onClick={() => store.addStop()} className="inline-flex min-h-11 lg:min-h-8 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"><Plus size={14} /> Pridať bod prejazdu</button>
        <button type="button" onClick={() => store.reverse()} className="inline-flex min-h-11 lg:min-h-8 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-100"><ArrowUpDown size={14} /> Otočiť trasu</button>
      </div>
      <button type="button" disabled={!active || !ready || busy} onClick={() => void store.calculate()} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-zinc-950 px-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300">
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
            <button type="button" onClick={() => void copyDistance()} className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100"><Copy size={15} /> Kopírovať vzdialenosť</button>
            {copyNotice && <p role="status" className="text-xs text-zinc-600">{copyNotice}</p>}
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">Odhad pri odchode teraz podľa dostupnej dopravy. Čas nezahŕňa prestávky.</p>
            <p className="mt-1 text-[11px] text-zinc-500">Google Maps · Prepočítané {new Date(result.calculatedAt).toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit" })}</p>
          </div>
        )}
      </div>
    </section>
  );
}

function RouteStopRow({ id, index, disabled, children }: { id: number; index: number; disabled: boolean; children: ReactNode }) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id, disabled });
  return <div ref={setNodeRef} data-route-stop={id} className={`relative flex min-w-0 items-start gap-2 rounded-lg ${isDragging ? "z-20 bg-blue-50 shadow-lg" : ""}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
    <button ref={setActivatorNodeRef} type="button" {...attributes} {...listeners} disabled={disabled} aria-label={`Presunúť miesto ${index + 1}`} title="Potiahnuť pre zmenu poradia"
      className="mt-7 flex min-h-11 w-7 shrink-0 touch-none flex-col items-center justify-center gap-0.5 rounded-lg bg-blue-50 text-xs font-bold text-blue-700 hover:bg-blue-100 focus-visible:outline-2 focus-visible:outline-blue-600">
      <span aria-hidden="true">{index + 1}</span><GripVertical size={12} aria-hidden="true" />
    </button>
    {children}
  </div>;
}
