"use client";

import { useState } from "react";
import { RoutePlaceField, type RoutePlace } from "./map/RoutePlaceField";

export function WorkspacePlaceSearch({ active }: { active: boolean }) {
  const [place, setPlace] = useState<RoutePlace | null>(null);
  const [query, setQuery] = useState("");
  return <div className="space-y-3">
    <RoutePlaceField label="Vyhľadať miesto" value={place} query={query} active={active} onChange={(value, text) => { setPlace(value); setQuery(text); }} />
    {place && <div className="space-y-2 text-sm"><p>{place.label}</p><p>{place.lat.toFixed(6)}, {place.lng.toFixed(6)}</p><a className="inline-flex min-h-11 items-center underline" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${place.lat},${place.lng}`)}`} target="_blank" rel="noopener noreferrer">Otvoriť miesto v Google Mapách</a></div>}
  </div>;
}
