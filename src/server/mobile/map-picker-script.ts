import type { MobileCaseMap, MobileCasePlaceSelection, MobileEnvironment } from "@/lib/mobile-api";
import type { MobileMapPreview, parseMobileMapPreview } from "@/lib/mobile-map-preview";

export type MapPickerConfiguration = {
  version: 1;
  nonce: string;
  mode: "view" | "pick";
  target: "pickup" | "destination";
  environment: MobileEnvironment;
  profileId: string;
  organizationId: string;
  caseId: string | null;
  browserKey: string;
  mapId: string;
  map: MobileCaseMap;
};

/** Serialized into the protected HTML. Keep this function free of module closures. */
export function runMobileMapPicker(configuration: MapPickerConfiguration, previewParser?: typeof parseMobileMapPreview) {
  const host = window as Window & { ReactNativeWebView?: { postMessage: (message: string) => void }; __pmMapReady?: () => void; gm_authFailure?: () => void };
  // Object rest/spread can introduce module-level compiler helpers outside the
  // serialized function. Keep every operation here executable on its own.
  const browserKey = configuration.browserKey, initialMap = configuration.map;
  const scope = { version: configuration.version, nonce: configuration.nonce, mode: configuration.mode, target: configuration.target,
    environment: configuration.environment, profileId: configuration.profileId, organizationId: configuration.organizationId, caseId: configuration.caseId };
  const status = document.getElementById("status")!;
  const address = document.getElementById("address") as HTMLInputElement;
  const confirm = document.getElementById("confirm") as HTMLButtonElement;
  let alive = true, seeded = false, generation = 0, candidate: MobileCasePlaceSelection | null = null;
  let anchor: MobileCasePlaceSelection | null = null;
  let map: google.maps.Map | null = null, marker: google.maps.marker.AdvancedMarkerElement | null = null;
  const safeText = (value: unknown, maximum: number, empty = false): value is string => typeof value === "string"
    && value.length <= maximum && (empty || !!value.trim()) && !/[\u0000-\u001f\u007f]/.test(value)
    && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
  const point = (lat: unknown, lng: unknown) => typeof lat === "number" && Number.isFinite(lat) && Math.abs(lat) <= 90
    && typeof lng === "number" && Number.isFinite(lng) && Math.abs(lng) <= 180;
  function selection(value: unknown): MobileCasePlaceSelection | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some(key => !["label", "address", "lat", "lng", "provider", "placeId"].includes(key))
      || !safeText(item.label, 200) || !safeText(item.address, 500) || !point(item.lat, item.lng)
      || item.provider !== "google_places" && item.provider !== "manual" && item.provider !== "approximate"
      || Object.hasOwn(item, "placeId") && !safeText(item.placeId, 300)) return null;
    const selected: MobileCasePlaceSelection = { label: item.label.trim(), address: item.address.trim(), lat: item.lat as number, lng: item.lng as number, provider: item.provider };
    if (typeof item.placeId === "string") selected.placeId = item.placeId.trim();
    return selected;
  }
  function emit(type: "ready" | "candidate" | "error", data: Record<string, unknown> = {}) {
    if (alive) host.ReactNativeWebView?.postMessage(JSON.stringify(Object.assign({}, scope, { type }, data)));
  }
  function notice(message: string, error = false) {
    if (!alive) return;
    status.textContent = message;
    if (error) emit("error", { message });
  }
  function show(value: MobileCasePlaceSelection | null) {
    anchor = value;
    candidate = value;
    confirm.disabled = !value || configuration.mode !== "pick";
    if (!value || !map) return;
    address.value = value.address;
    if (!marker) marker = new google.maps.marker.AdvancedMarkerElement({ map });
    marker.position = { lat: value.lat, lng: value.lng };
    map.panTo({ lat: value.lat, lng: value.lng });
  }
  const close = () => { alive = false; generation++; candidate = null; confirm.disabled = true; };
  const fatal = (message: string) => { notice(message, true); close(); };
  async function bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: number | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error("timeout")), 10_000); })]);
    } finally { window.clearTimeout(timer); }
  }
  window.addEventListener("pagehide", close);
  confirm.addEventListener("click", () => {
    if (!alive || configuration.mode !== "pick" || confirm.disabled || !candidate) return;
    const confirmed = selection(candidate);
    if (confirmed) emit("candidate", { selection: confirmed });
  });
  address.addEventListener("input", () => {
    if (!alive || configuration.mode !== "pick") return;
    generation++;
    const edited = anchor && selection(Object.assign({}, anchor, { address: address.value }));
    candidate = edited;
    confirm.disabled = !edited;
    notice(edited ? "Skontrolujte adresu a bod. Výber sa zatiaľ neuloží do prípadu." : "Vyberte bod a vyplňte adresu.");
  });

  function load(seed: { selection: MobileCasePlaceSelection | null; address: string; preview?: MobileMapPreview }) {
    const timer = window.setTimeout(() => fatal("Mapu sa nepodarilo načítať. Zavrite ju a skúste znova. Ručná adresa zostáva dostupná."), 20_000);
    host.gm_authFailure = () => { window.clearTimeout(timer); fatal("Mapová služba nie je dostupná. Ručná adresa zostáva dostupná."); };
    host.__pmMapReady = async () => {
      if (!alive) return;
      try {
        await Promise.all([google.maps.importLibrary("maps"), google.maps.importLibrary("marker")]);
        if (!alive) return;
        const initial = initialMap[configuration.target]?.point;
        const center = seed.preview?.points[0] ?? seed.selection ?? initial ?? { lat: 48.669, lng: 19.699 };
        map = new google.maps.Map(document.getElementById("map")!, { center, mapId: configuration.mapId, zoom: seed.selection || initial ? 15 : 7,
          mapTypeControl: false, streetViewControl: false, fullscreenControl: false, clickableIcons: false });
        if (configuration.mode === "view") {
          if (seed.preview) {
            const bounds = new google.maps.LatLngBounds();
            for (let index = 0; index < seed.preview.points.length; index++) {
              const location = seed.preview.points[index];
              const glyph = document.createElement("span"); glyph.className = "pin"; glyph.textContent = String(index + 1);
              new google.maps.marker.AdvancedMarkerElement({ map, position: { lat: location.lat, lng: location.lng }, title: location.label, content: glyph });
              bounds.extend(location);
            }
            if (seed.preview.encodedPolyline) {
              const geometry = await google.maps.importLibrary("geometry") as google.maps.GeometryLibrary;
              if (!alive) return;
              const path = geometry.encoding.decodePath(seed.preview.encodedPolyline);
              new google.maps.Polyline({ map, path, strokeColor: "#171719", strokeOpacity: 0.85, strokeWeight: 5 });
              for (const location of path) bounds.extend(location);
            }
            if (seed.preview.points.length > 1 || seed.preview.encodedPolyline) map.fitBounds(bounds, 40);
            else { map.setCenter(seed.preview.points[0]); map.setZoom(15); }
            window.clearTimeout(timer);
            notice(seed.preview.encodedPolyline ? "Vypočítaná cestná trasa. Číslované body sú zadané zastávky." : "Uložené polohy vozidiel. Čas a presnosť GPS skontrolujte v prehľade flotily.");
            return;
          }
          window.clearTimeout(timer);
          const bounds = new google.maps.LatLngBounds();
          let count = 0;
          for (const [key, location] of Object.entries(initialMap)) {
            if (!location?.point || !point(location.point.lat, location.point.lng)) continue;
            const glyph = document.createElement("span");
            glyph.className = "pin";
            glyph.textContent = key === "pickup" ? "P" : key === "destination" ? "C" : "K";
            new google.maps.marker.AdvancedMarkerElement({ map, position: location.point, title: location.address, content: glyph });
            bounds.extend(location.point); count++;
          }
          if (count > 1) map.fitBounds(bounds, 40);
          else if (count === 1) map.setCenter(bounds.getCenter());
          notice(count ? "P: miesto udalosti · C: cieľ · K: poloha od klienta" : "Prípad zatiaľ nemá platné súradnice. Adresu môžete upraviť vo formulári.");
          return;
        }
        address.value = seed.address;
        show(seed.selection);
        notice("Vyhľadajte adresu alebo ťuknite na mapu. Výber potvrďte tlačidlom.");
        map.addListener("click", (event: google.maps.MapMouseEvent) => {
          if (!alive || !event.latLng) return;
          const lat = event.latLng.lat(), lng = event.latLng.lng();
          if (!point(lat, lng)) return;
          generation++;
          const picked: MobileCasePlaceSelection = { label: "Bod na mape", address: `${lat.toFixed(6)}, ${lng.toFixed(6)}`, lat, lng, provider: "manual" };
          show(picked);
          notice("Skontrolujte bod. Adresu môžete napísať; poloha sa uloží až pri uložení prípadu.");
        });
        window.clearTimeout(timer);
        try {
          await bounded(google.maps.importLibrary("places"));
          if (!alive) return;
          const autocomplete = new google.maps.places.PlaceAutocompleteElement({ requestedLanguage: "sk", requestedRegion: "sk", placeholder: "Vyhľadať adresu", noInputIcon: true });
          document.getElementById("search")!.appendChild(autocomplete);
          autocomplete.addEventListener("input", () => {
            if (!alive) return;
            generation++;
            show(null);
          });
          autocomplete.addEventListener("gmp-error", () => {
            if (!alive) return;
            generation++;
            show(null);
            notice("Vyhľadávanie adries nie je dostupné. Bod môžete vybrať na mape.");
          });
          autocomplete.addEventListener("gmp-select", async (event: Event) => {
            if (!alive) return;
            const request = ++generation;
            show(null);
            notice("Načítavam vybranú adresu…");
            try {
              const prediction = (event as Event & { placePrediction?: google.maps.places.PlacePrediction }).placePrediction;
              if (!prediction) throw new Error();
              const place = prediction.toPlace();
              await bounded(place.fetchFields({ fields: ["displayName", "formattedAddress", "location", "id"] }));
              if (!alive || request !== generation) return;
              const fields: Record<string, unknown> = { label: place.displayName ?? place.formattedAddress ?? "Miesto", address: place.formattedAddress ?? place.displayName,
                lat: place.location?.lat(), lng: place.location?.lng(), provider: "google_places" };
              if (place.id) fields.placeId = place.id;
              const selected = selection(fields);
              if (!selected) throw new Error();
              show(selected); map?.setZoom(16);
              notice("Skontrolujte adresu a potvrďte výber. Prípad sa ešte neuloží.");
            } catch {
              if (!alive || request !== generation) return;
              notice("Vybranú adresu sa nepodarilo overiť. Skúste inú alebo vyberte bod na mape.");
            }
          });
        } catch {
          if (alive) notice("Vyhľadávanie adries nie je dostupné. Bod môžete vybrať na mape.");
        }
      } catch {
        window.clearTimeout(timer);
        if (alive) fatal("Mapové nástroje sa nepodarilo načítať. Zavrite mapu a skúste znova.");
      }
    };
    const script = document.createElement("script");
    script.nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce ?? "";
    script.src = "https://maps.googleapis.com/maps/api/js?" + new URLSearchParams({ key: browserKey, loading: "async", callback: "__pmMapReady", libraries: "places", language: "sk", region: "SK", v: "weekly" });
    script.async = true;
    script.onerror = () => { window.clearTimeout(timer); fatal("Mapu sa nepodarilo načítať. Skúste znova alebo zadajte adresu ručne."); };
    document.head.appendChild(script);
  }
  function receive(event: MessageEvent) {
    if (!alive || seeded || typeof event.data !== "string" || event.data.length > 500000) return;
    try {
      const value = JSON.parse(event.data);
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some(key => ![...Object.keys(scope), "type", "selection", "address", "preview"].includes(key))
        || Object.entries(scope).some(([key, item]) => value[key] !== item) || value.type !== "seed"
        || !Object.hasOwn(value, "selection") || !safeText(value.address, 500, true)) return;
      const selected = value.selection === null ? null : selection(value.selection);
      if (value.selection !== null && !selected) return;
      let preview: MobileMapPreview | undefined;
      if (Object.hasOwn(value, "preview")) {
        if (configuration.mode !== "view" || configuration.caseId !== null || !previewParser) return;
        preview = previewParser(value.preview);
      }
      seeded = true;
      load({ selection: selected, address: value.address, preview });
    } catch { /* A malformed message cannot initialize the map or alter a selection. */ }
  }
  // Android dispatches native postMessage on document; iOS dispatches on window.
  document.addEventListener("message", receive as EventListener);
  window.addEventListener("message", receive);
  emit("ready");
}
