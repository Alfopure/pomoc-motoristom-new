/** Maps receives only an encoded destination on the fixed HTTPS directions URL. */
export function directionsUrl(address: string): string {
  const destination = address.trim();
  if (!destination || /[\u0000-\u001f]/.test(destination)) throw new Error("Doplňte platnú adresu pre navigáciu.");
  const url = "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(destination) + "&travelmode=driving&dir_action=navigate";
  if (url.length > 2048) throw new Error("Adresa je príliš dlhá pre navigáciu.");
  return url;
}
