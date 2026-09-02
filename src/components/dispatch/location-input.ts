export type ParsedCoordinates = {
  lat: number;
  lng: number;
};

export function parseLocationCoordinates(value: string): ParsedCoordinates | null {
  const match = value
    .trim()
    .match(/^(-?\d{1,2}(?:\.\d+)?)\s*(?:,|;|\s)\s*(-?\d{1,3}(?:\.\d+)?)$/);

  if (!match) {
    return null;
  }

  const lat = Number(match[1]);
  const lng = Number(match[2]);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }

  return { lat, lng };
}

export function buildApproximateLocationQuery(value: string) {
  const query = value.trim();

  if (!query || /(?:slovensko|slovakia)\s*$/i.test(query)) {
    return query;
  }

  return `${query}, Slovensko`;
}
