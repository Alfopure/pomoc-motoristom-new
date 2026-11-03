export type MobileMapPreview = {
  points: { lat: number; lng: number; label: string }[];
  encodedPolyline?: string;
};

/** Also serialized into the protected map page; keep this parser self-contained. */
export function parseMobileMapPreview(value: unknown): MobileMapPreview {
  const invalid = () => { throw new Error("Neplatný náhľad mapy."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => key !== "points" && key !== "encodedPolyline")
    || !Array.isArray(item.points) || item.points.length < 1 || item.points.length > 100) return invalid();
  const points = item.points.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const point = value as Record<string, unknown>;
    if (Object.keys(point).some(key => !["lat", "lng", "label"].includes(key))
      || typeof point.lat !== "number" || !Number.isFinite(point.lat) || Math.abs(point.lat) > 90
      || typeof point.lng !== "number" || !Number.isFinite(point.lng) || Math.abs(point.lng) > 180
      || typeof point.label !== "string" || !point.label.trim() || point.label.length > 200
      || /[\u0000-\u001f\u007f]/.test(point.label)) return invalid();
    try { encodeURIComponent(point.label); } catch { return invalid(); }
    return { lat: point.lat, lng: point.lng, label: point.label.trim() };
  });
  if (!Object.hasOwn(item, "encodedPolyline")) return { points };
  const encoded = item.encodedPolyline;
  if (typeof encoded !== "string" || encoded.length < 2 || encoded.length > 200000 || !/^[?-~]+$/.test(encoded)) return invalid();
  let index = 0, lat = 0, lng = 0, count = 0;
  const delta = () => {
    let sum = 0, shift = 0, byte: number;
    do {
      if (index >= encoded.length || shift > 25) return invalid();
      byte = encoded.charCodeAt(index++) - 63;
      sum += (byte & 31) * 2 ** shift; shift += 5;
    } while (byte >= 32);
    return sum % 2 === 1 ? -(sum + 1) / 2 : sum / 2;
  };
  while (index < encoded.length) {
    lat += delta(); lng += delta(); count++;
    if (Math.abs(lat) > 9000000 || Math.abs(lng) > 18000000 || count > 50000) return invalid();
  }
  if (count < 1) return invalid();
  return { points, encodedPolyline: encoded };
}
