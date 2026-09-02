"use client";

const GOOGLE_MAPS_CALLBACK = "__motoristGoogleMapsReady";

let googleMapsPromise: Promise<typeof google> | null = null;

declare global {
  interface Window {
    __motoristGoogleMapsReady?: () => void;
  }
}

export function loadGoogleMaps(apiKey: string) {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Google Maps can be loaded only in the browser."));
  }

  if (window.google?.maps?.Map && window.google.maps.places?.PlaceAutocompleteElement) {
    return Promise.resolve(window.google);
  }

  if (googleMapsPromise) {
    return googleMapsPromise;
  }

  googleMapsPromise = new Promise<typeof google>((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>('script[data-motorist-google-maps="true"]');

    window.__motoristGoogleMapsReady = () => {
      if (window.google?.maps) {
        resolve(window.google);
        return;
      }
      reject(new Error("Google Maps script loaded without the maps namespace."));
    };

    if (existingScript) {
      existingScript.addEventListener("error", () => reject(new Error("Google Maps script failed to load.")), { once: true });
      return;
    }

    const params = new URLSearchParams({
      key: apiKey,
      loading: "async",
      callback: GOOGLE_MAPS_CALLBACK,
      libraries: "places,geometry,marker",
      language: "sk",
      region: "SK",
      v: "weekly",
    });

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.defer = true;
    script.dataset.motoristGoogleMaps = "true";
    script.onerror = () => reject(new Error("Google Maps script failed to load."));
    document.head.appendChild(script);
  });

  return googleMapsPromise;
}
