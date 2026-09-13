import { CarFront, MapPin, Phone, UserRound } from "lucide-react";
import type { HandoffPlace, HandoffPublished } from "@/domain/case-handoff";

function Navigation({ place }: { place: HandoffPlace }) {
  const query = place.lat !== null && place.lng !== null ? `${place.lat},${place.lng}` : place.address;
  return <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`} target="_blank" rel="noopener noreferrer">Otvoriť navigáciu</a>;
}

export function HandoffSummary({ value }: { value: HandoffPublished }) {
  return <div className="handoff-summary">
    <div><UserRound size={17} /><section><span>Kontakt klienta</span><strong>{value.contact.name || "Neuvedený"}</strong>{value.contact.phone && <a href={`tel:${value.contact.phone.replace(/[^+\d]/g, "")}`}><Phone size={13} />{value.contact.phone}</a>}</section></div>
    <div><CarFront size={17} /><section><span>Vozidlo</span><strong>{[value.vehicle.make, value.vehicle.model].filter(Boolean).join(" ") || "Neuvedené"}</strong><p>{value.vehicle.plate || "EČV neuvedené"}</p></section></div>
    <div><MapPin size={17} /><section><span>Miesto úkonu</span><strong>{value.pickup?.address || "Miesto nie je vyplnené"}</strong>{value.pickup?.lat !== null && value.pickup?.lat !== undefined && <p>{value.pickup.lat}, {value.pickup.lng}</p>}{value.pickup && <Navigation place={value.pickup} />}</section></div>
    {value.destination && <div><MapPin size={17} /><section><span>Cieľ</span><strong>{value.destination.address}</strong>{value.destination.lat !== null && <p>{value.destination.lat}, {value.destination.lng}</p>}<Navigation place={value.destination} /></section></div>}
    {value.scheduledAt && <div><section><span>Dohodnutý čas</span><strong>{new Date(value.scheduledAt).toLocaleString("sk-SK")}</strong></section></div>}
    {value.instructions && <div className="handoff-instructions"><section><span>Pokyny pre kolegu</span><p>{value.instructions}</p></section></div>}
  </div>;
}
