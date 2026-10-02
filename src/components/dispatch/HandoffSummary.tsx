import { CarFront, MapPin, Phone, UserRound } from "lucide-react";
import { handoffDate, type HandoffPlace, type HandoffPublished } from "@/domain/case-handoff";

const conditionLabels: Record<string, string> = { immobile: "Nepojazdné", locked: "Zamknuté", no_keys: "Bez kľúčov", blocked_wheel: "Zablokované koleso", after_accident: "Po nehode", overturned: "Prevrátené", in_ditch: "V priekope" };
const categoryLabels: Record<string, string> = { small_car: "Malé osobné auto", wagon: "Kombi", suv: "SUV", van: "Dodávka" };
const preferenceLabels: Record<string, string> = { automatic: "Automat", manual: "Manuál", suv: "SUV", wagon: "Kombi", van: "Dodávka", ev: "Elektrické" };
const replacementLabels: Record<string, string> = { not_needed: "Náhradné auto nie je potrebné", not_provided: "Neposkytnuté", assigned: "Priradené", provided: "Poskytnuté · konkrétne auto neuvedené", pending: "Zatiaľ nepriradené" };

function Navigation({ place }: { place: HandoffPlace }) {
  const query = place.lat !== null && place.lng !== null ? `${place.lat},${place.lng}` : place.address;
  return <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`} target="_blank" rel="noopener noreferrer">Otvoriť navigáciu</a>;
}

export function HandoffSummary({ value }: { value: HandoffPublished }) {
  return <div className="handoff-summary">
    {value.assistance && (value.assistance.name || value.assistance.reference) && <div><section><span>Asistenčná služba</span>{value.assistance.name && <strong>{value.assistance.name}</strong>}{value.assistance.reference && <p>Číslo prípadu asistenčky: <strong>{value.assistance.reference}</strong></p>}</section></div>}
    <div><UserRound size={17} /><section><span>Kontakt klienta</span><strong>{value.contact.name || "Neuvedený"}</strong>{value.contact.phone && <a href={`tel:${value.contact.phone.replace(/[^+\d]/g, "")}`}><Phone size={13} />{value.contact.phone}</a>}</section></div>
    <div><CarFront size={17} /><section><span>Odstavené vozidlo</span><strong>{[value.vehicle.make, value.vehicle.model].filter(Boolean).join(" ") || "Neuvedené"}</strong><p>{value.vehicle.plate || "EČV neuvedené"}{value.vehicle.color ? ` · ${value.vehicle.color}` : ""}</p>{value.schemaVersion && <p>{value.vehicle.driveable === true ? "Pojazdné" : value.vehicle.driveable === false ? "Nepojazdné" : "Pojazdnosť nezistená"}</p>}{!!value.vehicle.conditionFlags?.length && <p>{value.vehicle.conditionFlags.map(flag => conditionLabels[flag]).filter(Boolean).join(" · ")}</p>}</section></div>
    {value.replacement && <div><CarFront size={17} /><section><span>Náhradné vozidlo</span><strong>{replacementLabels[value.replacement.status] || "Zatiaľ nepriradené"}</strong>{value.replacement.vehicle && <><p>{[value.replacement.vehicle.make, value.replacement.vehicle.model].filter(Boolean).join(" ") || "Značka a model neuvedené"}</p><p>{value.replacement.vehicle.plate || "EČV neuvedené"}</p></>}{value.replacement.needed !== false && <><p>{[categoryLabels[value.replacement.category], value.replacement.requestedType].filter(Boolean).join(" · ")}</p>{!!value.replacement.preferences.length && <p>{value.replacement.preferences.map(preference => preferenceLabels[preference]).filter(Boolean).join(" · ")}</p>}</>}</section></div>}
    <div><MapPin size={17} /><section><span>Miesto úkonu</span><strong>{value.pickup?.address || "Miesto nie je vyplnené"}</strong>{value.pickup?.lat !== null && value.pickup?.lat !== undefined && <p>{value.pickup.lat}, {value.pickup.lng}</p>}{value.pickup && <Navigation place={value.pickup} />}</section></div>
    {value.destination && <div><MapPin size={17} /><section><span>Cieľ</span><strong>{value.destination.address}</strong>{value.destination.lat !== null && <p>{value.destination.lat}, {value.destination.lng}</p>}<Navigation place={value.destination} /></section></div>}
    {!value.destination && value.schemaVersion && <div><MapPin size={17} /><section><span>Cieľ</span><strong>Cieľ zatiaľ neurčený</strong></section></div>}
    {value.replacement?.deliveryPlace && value.replacement.needed !== false && <div><MapPin size={17} /><section><span>Pristavenie náhradného auta</span><strong>{value.replacement.deliveryPlace}</strong><Navigation place={{ address: value.replacement.deliveryPlace, lat: null, lng: null }} /></section></div>}
    {value.incident && (value.incident.description || value.incident.passengersCount !== null || value.incident.access) && <div><section><span>Informácie k zásahu</span>{value.incident.description && <p>{value.incident.description}</p>}{value.incident.passengersCount !== null && <p>Osoby na prepravu: {value.incident.passengersCount}</p>}{value.incident.access && <p>Prístup: {value.incident.access}</p>}</section></div>}
    {value.scheduledAt && <div><section><span>Dohodnutý čas</span><strong>{handoffDate(value.scheduledAt)}</strong></section></div>}
    {value.instructions && <div className="handoff-instructions"><section><span>Pokyny pre kolegu</span><p>{value.instructions}</p></section></div>}
    {value.caseCreatedAt && <div><section><span>Prípad vytvorený</span><p>{handoffDate(value.caseCreatedAt)}</p></section></div>}
    {value.firstCallAt && <div><section><span>Prvý súvisiaci hovor</span><p>{handoffDate(value.firstCallAt)}</p></section></div>}
  </div>;
}
