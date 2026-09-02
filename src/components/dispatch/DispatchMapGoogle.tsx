"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  LocateFixed,
  Mail,
  MapPinned,
  Navigation,
  Route,
  Send,
  ShieldCheck,
  Truck,
  X,
} from "lucide-react";
import type { DispatchLocation, FleetAsset, FleetAssetStatus, GeoPoint } from "@/domain/types";
import { formatCurrency } from "@/lib/dispatch-calculations";
import type { DispatchRouteSegment } from "@/lib/dispatch-calculations";
import { loadGoogleMaps } from "@/lib/google-maps-client";
import { createPlaceAutocompleteElement } from "@/lib/google-maps-places";
import { createDispatchMapModel, createDispatchOverviewMapModel } from "@/lib/map-adapter";
import type { DispatchMapModel } from "@/lib/map-adapter";
import { matchesSearch } from "@/lib/fleet-presentation";
import { createFleetBubbleContent, createFleetBubbleHeader } from "./map/fleet-info-bubble";
import { FleetMapFilter } from "./map/FleetMapFilter";
import type { FleetGpsFreshnessFilter, FleetGpsSourceFilter, FleetKindFilter, FleetStatusFilter } from "./map/FleetMapFilter";
import { MapControlBar } from "./map/MapControlBar";
import type { FleetLayerKey, MapLayerState, MapPanelKey } from "./map/MapControlBar";
import { MapPlaceSearch } from "./map/MapPlaceSearch";
import { useFleetPositions } from "./map/useFleetPositions";
import type { DispatchMapProps } from "./DispatchMap";

const googleMapsApiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;
const googleMapsMapId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID";

type EditableLocationKey = "pickup" | "destination";

type GoogleLoadState = "idle" | "loading" | "ready" | "error";

type RouteState = {
  signature: string;
  source: "google" | "fallback";
  totalKm: number;
  totalEta: number;
  label: string;
};

type RouteRuntimeState = {
  fallbackRouteState: RouteState;
  nearestAssetPoint?: GeoPoint;
  nearestBranchPoint: GeoPoint;
  routeSegments: DispatchRouteSegment[];
  routeSignature: string;
};

type GoogleMapMarker = google.maps.marker.AdvancedMarkerElement | google.maps.Marker;

type MarkerListenerRecord = {
  content?: HTMLElement;
  listener?: EventListener;
  mapsListener?: google.maps.MapsEventListener;
};

type LocationDraftState = {
  caseId: string;
  pickup?: DispatchLocation;
  destination?: DispatchLocation;
};

type GoogleRouteResult = {
  distanceMeters: number;
  durationSeconds: number;
  encodedPolyline: string | null;
  legs: GoogleRouteLegResult[];
  provider: "google-routes";
};

type GoogleRouteLegResult = {
  distanceMeters: number;
  durationSeconds: number;
  encodedPolyline: string | null;
};

const DEFAULT_MAP_LAYERS: MapLayerState = {
  route: false,
  branches: false,
  fleet: {
    tow: false,
    replacement_car: false,
  },
};

const OVERVIEW_MAP_LAYERS: MapLayerState = {
  route: false,
  branches: true,
  fleet: {
    tow: true,
    replacement_car: true,
  },
};

// Neutrálny pohľad na celé Slovensko, kým operátor nezapne žiadnu vrstvu.
const EMPTY_MAP_CENTER: google.maps.LatLngLiteral = { lat: 48.7, lng: 19.5 };
const EMPTY_MAP_ZOOM = 7;

export default function DispatchMapGoogle({ caseItem, branches, assets, priceRule, avoidMobileNav, onAssignAsset, onSendLocationSms, onSendEtaSms, workspaceMode = "collapsed" }: DispatchMapProps) {
  const caseId = caseItem?.id ?? "overview";
  const hasCase = Boolean(caseItem);
  const hasGoogleKey = isConfiguredGoogleKey(googleMapsApiKey);
  const [loadState, setLoadState] = useState<GoogleLoadState>(() => (hasGoogleKey ? "loading" : "idle"));
  const [, setLoadError] = useState<string | null>(null);
  const [routeState, setRouteState] = useState<RouteState | null>(null);
  const [locationDraft, setLocationDraft] = useState<LocationDraftState>(() => ({ caseId }));
  const [mapLayers, setMapLayers] = useState<MapLayerState>(() => hasCase ? DEFAULT_MAP_LAYERS : OVERVIEW_MAP_LAYERS);
  const [planOpen, setPlanOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [activePanel, setActivePanel] = useState<MapPanelKey | null>(null);
  const [selectedFleetAssetId, setSelectedFleetAssetId] = useState<string | null>(null);
  const [fleetSearch, setFleetSearch] = useState("");
  const [fleetKindFilter, setFleetKindFilter] = useState<FleetKindFilter>("all");
  const [fleetStatusFilter, setFleetStatusFilter] = useState<FleetStatusFilter>("all");
  const [fleetGpsSourceFilter, setFleetGpsSourceFilter] = useState<FleetGpsSourceFilter>("all");
  const [fleetGpsFreshnessFilter, setFleetGpsFreshnessFilter] = useState<FleetGpsFreshnessFilter>("all");

  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const pickupAutocompleteHostRef = useRef<HTMLDivElement | null>(null);
  const destinationAutocompleteHostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<GoogleMapMarker[]>([]);
  const fleetMarkersRef = useRef<Map<string, GoogleMapMarker>>(new Map());
  const fleetMarkerListenersRef = useRef<Map<string, MarkerListenerRecord>>(new Map());
  const fleetViewportSignatureRef = useRef("");
  const searchMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const infoWindowAssetIdRef = useRef<string | null>(null);
  const nearestIdsRef = useRef<{ asset: string; branch: string }>({ asset: "", branch: "" });
  const fallbackPolylinesRef = useRef<google.maps.Polyline[]>([]);
  const googleRoutePolylinesRef = useRef<google.maps.Polyline[]>([]);
  const routeSequenceRef = useRef(0);
  const positionOverrides = useFleetPositions(assets);
  const previousHasCaseRef = useRef(hasCase);

  useEffect(() => {
    if (previousHasCaseRef.current === hasCase) return;
    previousHasCaseRef.current = hasCase;
    setMapLayers(hasCase ? DEFAULT_MAP_LAYERS : OVERVIEW_MAP_LAYERS);
    setActivePanel(null);
    setPlanOpen(false);
    setFocusMode(false);
  }, [hasCase]);

  const draftLocations = useMemo(() => {
    if (!caseItem) {
      return { pickup: undefined, destination: undefined };
    }
    if (locationDraft.caseId !== caseItem.id) {
      return {
        pickup: caseItem.pickup,
        destination: caseItem.destination,
      };
    }

    return {
      pickup: locationDraft.pickup ?? caseItem.pickup,
      destination: locationDraft.destination ?? caseItem.destination,
    };
  }, [caseItem, locationDraft]);

  const draftCase = useMemo(
    () => caseItem ? ({
        ...caseItem,
        pickup: draftLocations.pickup,
        destination: draftLocations.destination,
      }) : undefined,
    [caseItem, draftLocations.destination, draftLocations.pickup],
  );

  const model = useMemo(
    () => draftCase
      ? createDispatchMapModel(draftCase, branches, assets, priceRule)
      : createDispatchOverviewMapModel(branches),
    [assets, branches, draftCase, priceRule],
  );

  const routeSignature = `${caseId}:${draftLocations.pickup?.lat ?? "none"}:${draftLocations.pickup?.lng ?? "none"}:${draftLocations.destination?.lat ?? "none"}:${draftLocations.destination?.lng ?? "none"}`;
  const fallbackRouteState = useMemo<RouteState | null>(() => {
    if (!model.routePlan) return null;
    return {
      signature: routeSignature,
      source: "fallback",
      totalKm: model.routePlan.totalOperationalKm,
      totalEta: model.routePlan.totalEta,
      label: "Orientačný výpočet",
    };
  }, [model.routePlan, routeSignature]);

  const displayRoute = routeState?.signature === routeSignature ? routeState : fallbackRouteState;
  const routeRuntimeRef = useRef<RouteRuntimeState | null>(null);
  const nearestAssetId = model.nearestAsset?.asset.id ?? "";
  const nearestBranchId = model.nearestBranch?.branch.id ?? "";
  const expandedWorkspace = workspaceMode === "expanded";
  const compactWorkspace = workspaceMode === "split" || expandedWorkspace;
  const rootClassName = expandedWorkspace
    ? "dispatch-map-expanded relative h-full min-h-[180px] overflow-hidden rounded-md border border-zinc-200 bg-zinc-100 lg:min-h-0"
    : "relative h-full min-h-[360px] overflow-hidden rounded-md border border-zinc-200 bg-zinc-100 sm:min-h-[420px]";
  const canvasClassName = expandedWorkspace ? "dispatch-google-map-canvas h-full min-h-[180px] lg:min-h-0" : "dispatch-google-map-canvas h-full min-h-[360px] sm:min-h-[420px]";
  const planPanelBottomClass = avoidMobileNav
    ? "bottom-[calc(80px+env(safe-area-inset-bottom))] sm:bottom-3"
    : "bottom-2 sm:bottom-3";
  // Keď je vpravo hore karta trasy, ľavý stĺpec overlayov jej nechá miesto.
  const desktopRouteCardVisible = !expandedWorkspace && !focusMode && mapLayers.route && Boolean(displayRoute);
  const fleetLayersActive = mapLayers.fleet.tow || mapLayers.fleet.replacement_car;
  const fleetFilterCount =
    (fleetSearch.trim() !== "" ? 1 : 0) +
    (fleetKindFilter !== "all" ? 1 : 0) +
    (fleetStatusFilter !== "all" ? 1 : 0) +
    (fleetGpsSourceFilter !== "all" ? 1 : 0) +
    (fleetGpsFreshnessFilter !== "all" ? 1 : 0);
  const canClear =
    mapLayers.route ||
    mapLayers.branches ||
    fleetLayersActive ||
    planOpen ||
    focusMode ||
    activePanel !== null ||
    selectedFleetAssetId !== null ||
    fleetFilterCount > 0;

  useEffect(() => {
    if (!fallbackRouteState || !model.nearestBranch || !model.routePlan) {
      routeRuntimeRef.current = null;
      return;
    }
    routeRuntimeRef.current = {
      fallbackRouteState,
      nearestAssetPoint: model.nearestAsset?.asset.point,
      nearestBranchPoint: model.nearestBranch.branch.point,
      routeSegments: model.routePlan.segments,
      routeSignature,
    };
  }, [
    fallbackRouteState,
    model.nearestAsset?.asset.point,
    model.nearestBranch,
    model.routePlan,
    routeSignature,
  ]);

  useEffect(() => {
    nearestIdsRef.current = { asset: nearestAssetId, branch: nearestBranchId };
  }, [nearestAssetId, nearestBranchId]);

  function toggleMapLayer(layer: "route" | "branches") {
    setMapLayers((current) => ({
      ...current,
      [layer]: !current[layer],
    }));
  }

  function toggleFleetLayer(layer: FleetLayerKey) {
    const nextFleet = { ...mapLayers.fleet, [layer]: !mapLayers.fleet[layer] };
    setMapLayers((current) => ({
      ...current,
      fleet: {
        ...current.fleet,
        [layer]: !current.fleet[layer],
      },
    }));
    // Bez zapnutej flotilovej vrstvy nemá filter čo filtrovať – panel sa zavrie.
    if (!nextFleet.tow && !nextFleet.replacement_car) {
      setActivePanel((panel) => (panel === "filter" ? null : panel));
    }
  }

  function togglePanel(panel: MapPanelKey) {
    const next = activePanel === panel ? null : panel;
    setActivePanel(next);
    if (next) {
      setFocusMode(false);
    }
  }

  function toggleFocusMode() {
    const next = !focusMode;
    setFocusMode(next);
    if (next) {
      setActivePanel(null);
    }
  }

  function resetFleetFilters() {
    setFleetSearch("");
    setFleetStatusFilter("all");
    setFleetKindFilter("all");
    setFleetGpsSourceFilter("all");
    setFleetGpsFreshnessFilter("all");
  }

  function handleClearAll() {
    setMapLayers(DEFAULT_MAP_LAYERS);
    setPlanOpen(false);
    setActivePanel(null);
    setFocusMode(false);
    setSelectedFleetAssetId(null);
    resetFleetFilters();
    fleetViewportSignatureRef.current = "";
    if (searchMarkerRef.current) {
      searchMarkerRef.current.map = null;
      searchMarkerRef.current = null;
    }
    if (mapRef.current) {
      mapRef.current.panTo(EMPTY_MAP_CENTER);
      mapRef.current.setZoom(EMPTY_MAP_ZOOM);
    }
  }

  const applyPlacePrediction = useCallback(async (target: EditableLocationKey, placePrediction: google.maps.places.PlacePrediction) => {
    if (!caseItem) return;
    const currentCase = caseItem;
    const place = placePrediction.toPlace();
    await place.fetchFields({ fields: ["displayName", "formattedAddress", "location", "id"] });

    const location = place.location;
    if (!location) {
      return;
    }

    const address = place.formattedAddress ?? place.displayName ?? "";
    const label = place.displayName ?? place.formattedAddress ?? address;

    setLocationDraft((current) => ({
      ...(current.caseId === currentCase.id ? current : { caseId: currentCase.id }),
      [target]: {
        ...(target === "pickup" ? currentCase.pickup : currentCase.destination),
        address,
        label,
        lat: location.lat(),
        lng: location.lng(),
        notes: place.id ? `Google Place ID: ${place.id}` : undefined,
      },
    }));
  }, [caseItem]);

  useEffect(() => {
    if (!hasGoogleKey || !googleMapsApiKey) {
      return;
    }

    let cancelled = false;

    loadGoogleMaps(googleMapsApiKey)
      .then(async (googleMaps) => {
        await Promise.allSettled([
          googleMaps.maps.importLibrary?.("maps"),
          googleMaps.maps.importLibrary?.("places"),
          googleMaps.maps.importLibrary?.("geometry"),
          googleMaps.maps.importLibrary?.("marker"),
        ]);

        if (cancelled || !mapElementRef.current) {
          return;
        }

        if (!mapRef.current) {
          mapRef.current = new googleMaps.maps.Map(mapElementRef.current, {
            cameraControl: false,
            center: EMPTY_MAP_CENTER,
            zoom: EMPTY_MAP_ZOOM,
            clickableIcons: true,
            fullscreenControl: false,
            gestureHandling: "greedy",
            mapId: googleMapsMapId,
            mapTypeControl: false,
            rotateControl: false,
            scaleControl: true,
            streetViewControl: false,
            zoomControl: true,
          });
        }

        setLoadState("ready");
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setLoadState("error");
          setLoadError(error.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hasGoogleKey]);

  useEffect(() => {
    if (loadState !== "ready" || !pickupAutocompleteHostRef.current || !destinationAutocompleteHostRef.current) {
      return;
    }

    const pickupHost = pickupAutocompleteHostRef.current;
    const destinationHost = destinationAutocompleteHostRef.current;
    const pickupElement = createPlaceAutocompleteElement("Vyzdvihnutie", draftLocations.pickup?.address || draftLocations.pickup?.label || "");
    const destinationElement = createPlaceAutocompleteElement("Cieľ / servis", draftLocations.destination?.address || draftLocations.destination?.label || "");
    const pickupListener: EventListener = (event) => {
      const selectEvent = event as google.maps.places.PlacePredictionSelectEvent;
      void applyPlacePrediction("pickup", selectEvent.placePrediction);
    };
    const destinationListener: EventListener = (event) => {
      const selectEvent = event as google.maps.places.PlacePredictionSelectEvent;
      void applyPlacePrediction("destination", selectEvent.placePrediction);
    };

    pickupElement.addEventListener("gmp-select", pickupListener);
    destinationElement.addEventListener("gmp-select", destinationListener);
    pickupHost.replaceChildren(pickupElement);
    destinationHost.replaceChildren(destinationElement);

    return () => {
      pickupElement.removeEventListener("gmp-select", pickupListener);
      destinationElement.removeEventListener("gmp-select", destinationListener);
      pickupHost.replaceChildren();
      destinationHost.replaceChildren();
    };
  }, [
    applyPlacePrediction,
    caseId,
    draftLocations.destination?.address,
    draftLocations.destination?.label,
    draftLocations.pickup?.address,
    draftLocations.pickup?.label,
    loadState,
  ]);

  useEffect(() => {
    if (loadState !== "ready" || !mapRef.current) {
      return;
    }

    const googleMaps = window.google;
    const map = mapRef.current;

    clearMarkers(markersRef.current);

    const visibleMarkers = model.markers.filter((marker) => isVisibleMapMarker(marker, model, mapLayers.route, mapLayers.branches));
    const bounds = new googleMaps.maps.LatLngBounds();
    visibleMarkers.forEach((marker) => {
      const active = isPrimaryMapMarker(marker, model);
      bounds.extend(marker.point);
      markersRef.current.push(
        createMapMarker(googleMaps, {
          active,
          kind: marker.kind,
          map,
          position: marker.point,
          title: marker.label,
          zIndex: active ? 20 : 10,
        }),
      );
    });
    if (visibleMarkers.length > 0) {
      map.fitBounds(bounds, 42);
    }
  }, [loadState, mapLayers.branches, mapLayers.route, model]);

  useEffect(() => {
    if (loadState !== "ready" || !mapRef.current) {
      return;
    }

    const runtime = routeRuntimeRef.current;
    const pickup = draftCase?.pickup;
    if (!runtime || !pickup || !draftCase) {
      return;
    }

    const googleMaps = window.google;
    const map = mapRef.current;
    const sequence = routeSequenceRef.current + 1;
    routeSequenceRef.current = sequence;
    const abortController = new AbortController();

    clearPolylines(fallbackPolylinesRef.current);
    clearPolylines(googleRoutePolylinesRef.current);

    if (!mapLayers.route) {
      return () => {
        routeSequenceRef.current += 1;
        abortController.abort();
      };
    }

    const needsDestination = runtime.routeSegments.some((segment) => segment.id === "pickup-to-destination");
    const routeOrigin = runtime.nearestAssetPoint ?? pickup;
    const routeIntermediates: GeoPoint[] = [
      ...(runtime.nearestAssetPoint ? [pickup] : []),
      ...(needsDestination && draftCase.destination ? [draftCase.destination] : []),
    ];

    fetch("/api/maps/route", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destination: toLatLngLiteral(runtime.nearestBranchPoint),
        intermediates: routeIntermediates.map(toLatLngLiteral),
        origin: toLatLngLiteral(routeOrigin),
      }),
      signal: abortController.signal,
    })
      .then(async (response) => {
        const data = (await response.json()) as GoogleRouteResult | { error?: string };
        if (!response.ok || "error" in data) {
          throw new Error("error" in data ? (data.error ?? "Google Routes API unavailable.") : "Google Routes API unavailable.");
        }
        if (!isGoogleRouteResult(data)) {
          throw new Error("Google Routes API returned an invalid route payload.");
        }
        return data;
      })
      .then((result) => {
        if (routeSequenceRef.current !== sequence) {
          return;
        }

        if (googleMaps.maps.geometry?.encoding) {
          googleRoutePolylinesRef.current = drawGoogleRoute(map, result, runtime.routeSegments, googleMaps);
        }

        if (googleRoutePolylinesRef.current.length === 0) {
          fallbackPolylinesRef.current = drawFallbackRoute(map, runtime.routeSegments, googleMaps);
        }

        setRouteState(routeStateFromGoogleRoute(result, runtime.routeSignature));
      })
      .catch((error: Error) => {
        if (abortController.signal.aborted || routeSequenceRef.current !== sequence) {
          return;
        }

        fallbackPolylinesRef.current = drawFallbackRoute(map, runtime.routeSegments, googleMaps);
        setRouteState({
          ...runtime.fallbackRouteState,
          label: error.message.includes("GOOGLE_MAPS_API_KEY") ? "Fallback trasa (server key chýba)" : "Fallback trasa",
        });
      });

    return () => {
      routeSequenceRef.current += 1;
      abortController.abort();
    };
  }, [draftCase, loadState, mapLayers.route, nearestAssetId, nearestBranchId, routeSignature]);

  useEffect(() => {
    if (loadState !== "ready" || !mapRef.current) {
      return;
    }

    const map = mapRef.current;
    const visibleAssets = assets.filter((asset) =>
      isFleetAssetVisible(
        asset,
        mapLayers.fleet.tow,
        mapLayers.fleet.replacement_car,
        fleetSearch,
        fleetKindFilter,
        fleetStatusFilter,
        fleetGpsSourceFilter,
        fleetGpsFreshnessFilter,
        mapLayers.route,
        nearestIdsRef.current.asset,
      ),
    );
    const visibleAssetById = new Map(visibleAssets.map((asset) => [asset.id, asset]));

    Array.from(fleetMarkersRef.current.entries()).forEach(([assetId, marker]) => {
      if (!visibleAssetById.has(assetId)) {
        removeFleetMarker(assetId, marker, fleetMarkerListenersRef.current);
        fleetMarkersRef.current.delete(assetId);
      }
    });

    if (selectedFleetAssetId && !visibleAssetById.has(selectedFleetAssetId)) {
      setSelectedFleetAssetId(null);
    }

    visibleAssets.forEach((asset) => {
      const layer = fleetLayerForAsset(asset);
      const position = positionOverrides.get(asset.id)?.point ?? asset.point;
      const active = selectedFleetAssetId === asset.id;
      const existingMarker = fleetMarkersRef.current.get(asset.id);

      if (existingMarker) {
        updateMapMarker(window.google, existingMarker, {
          active,
          kind: layer,
          position,
          title: fleetMarkerTitle(asset),
          zIndex: active ? 24 : 12,
        });
        return;
      }

      const listener: EventListener = () => setSelectedFleetAssetId(asset.id);
      const { marker, listenerRecord } = createClickableMapMarker(window.google, {
        active,
        kind: layer,
        map,
        position,
        title: fleetMarkerTitle(asset),
        zIndex: active ? 24 : 12,
        onClick: listener,
      });
      fleetMarkerListenersRef.current.set(asset.id, listenerRecord);
      fleetMarkersRef.current.set(asset.id, marker);
    });

    const viewportSignature = visibleAssets
      .map((asset) => {
        const position = positionOverrides.get(asset.id)?.point ?? asset.point;
        return `${asset.id}:${position.lat}:${position.lng}`;
      })
      .sort()
      .join("|");

    if (visibleAssets.length === 0) {
      fleetViewportSignatureRef.current = "";
    } else if (viewportSignature && viewportSignature !== fleetViewportSignatureRef.current) {
      const bounds = new window.google.maps.LatLngBounds();
      visibleAssets.forEach((asset) => {
        const position = positionOverrides.get(asset.id)?.point ?? asset.point;
        bounds.extend(position);
      });
      map.fitBounds(bounds, 56);
      fleetViewportSignatureRef.current = viewportSignature;
    }
  }, [
    assets,
    fleetGpsFreshnessFilter,
    fleetGpsSourceFilter,
    fleetKindFilter,
    fleetSearch,
    fleetStatusFilter,
    loadState,
    mapLayers.fleet.replacement_car,
    mapLayers.fleet.tow,
    mapLayers.route,
    positionOverrides,
    selectedFleetAssetId,
  ]);

  // Malá bublina so základnými údajmi priamo nad markerom vozidla.
  useEffect(() => {
    if (loadState !== "ready" || !mapRef.current) {
      return;
    }

    const asset = selectedFleetAssetId ? assets.find((candidate) => candidate.id === selectedFleetAssetId) : undefined;
    const marker = selectedFleetAssetId ? fleetMarkersRef.current.get(selectedFleetAssetId) : undefined;

    if (!asset || !marker) {
      infoWindowRef.current?.close();
      infoWindowAssetIdRef.current = null;
      return;
    }

    if (!infoWindowRef.current) {
      infoWindowRef.current = new window.google.maps.InfoWindow({ maxWidth: 280 });
    }

    const infoWindow = infoWindowRef.current;
    const branch = branches.find((candidate) => candidate.id === asset.branchId);
    infoWindow.setHeaderContent(createFleetBubbleHeader(asset));
    infoWindow.setContent(createFleetBubbleContent(asset, branch));

    if (infoWindowAssetIdRef.current !== asset.id || !infoWindow.isOpen) {
      infoWindow.open({ anchor: marker, map: mapRef.current, shouldFocus: false });
      infoWindowAssetIdRef.current = asset.id;
    }

    const closeListener = infoWindow.addListener("closeclick", () => setSelectedFleetAssetId(null));
    return () => closeListener.remove();
  }, [assets, branches, loadState, selectedFleetAssetId]);

  useEffect(
    () => () => {
      infoWindowRef.current?.close();
      clearFleetMarkers(fleetMarkersRef.current, fleetMarkerListenersRef.current);
    },
    [],
  );

  if (!hasGoogleKey) {
    return <MapUnavailable />;
  }

  if (loadState === "error") {
    return <MapUnavailable detail="Mapu sa teraz nepodarilo načítať. Skúste obnoviť stránku alebo to skúste o chvíľu znova." />;
  }

  return (
    <section className={rootClassName}>
      <div ref={mapElementRef} className={canvasClassName} />

      {loadState !== "ready" && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-100 text-sm font-semibold text-zinc-700">
          Načítava sa Google mapa
        </div>
      )}

      <div
        className={`pointer-events-none absolute left-2 right-2 top-2 z-20 flex flex-col items-stretch gap-2 sm:left-3 sm:top-3 sm:items-start ${
          desktopRouteCardVisible ? "sm:right-[334px]" : "sm:right-3"
        }`}
      >
        <MapControlBar
          activePanel={activePanel}
          canClear={canClear}
          compactWorkspace={compactWorkspace}
          expandedWorkspace={expandedWorkspace}
          filterCount={fleetFilterCount}
          focusMode={focusMode}
          layers={mapLayers}
          planOpen={planOpen}
          showCaseTools={hasCase}
          showFilter={fleetLayersActive}
          onClearAll={handleClearAll}
          onToggleBranches={() => toggleMapLayer("branches")}
          onToggleFleet={toggleFleetLayer}
          onToggleFocus={toggleFocusMode}
          onTogglePanel={togglePanel}
          onTogglePlan={() => setPlanOpen((current) => !current)}
          onToggleRoute={() => toggleMapLayer("route")}
        />

        <MapPlaceSearch
          loadState={loadState}
          mapRef={mapRef}
          open={activePanel === "search" && !focusMode}
          searchMarkerRef={searchMarkerRef}
          onClose={() => setActivePanel(null)}
        />

        {!expandedWorkspace && caseItem && (
          <div
            className={`pointer-events-auto w-full rounded-xl bg-white/95 shadow-sm ring-1 ring-zinc-200 backdrop-blur sm:w-[400px] ${
              activePanel === "addresses" && !focusMode ? "" : "hidden"
            }`}
          >
            <div className="flex items-center justify-between gap-2 py-1 pl-3 pr-1.5">
              <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-normal text-zinc-500">
                <MapPinned size={14} className="text-zinc-400" />
                Adresy zásahu
              </span>
              <button
                type="button"
                onClick={() => setActivePanel(null)}
                aria-label="Zavrieť adresy zásahu"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
              >
                <X size={14} />
              </button>
            </div>
            <div className="border-t border-zinc-200 px-3 pb-3">
              <AddressAutocomplete label="Vyzdvihnutie" hostRef={pickupAutocompleteHostRef} />
              <AddressAutocomplete label="Cieľ / servis" hostRef={destinationAutocompleteHostRef} />
            </div>
          </div>
        )}

        {activePanel === "filter" && !focusMode && fleetLayersActive && (
          <FleetMapFilter
            activeCount={fleetFilterCount}
            freshnessFilter={fleetGpsFreshnessFilter}
            gpsSourceFilter={fleetGpsSourceFilter}
            kindFilter={fleetKindFilter}
            search={fleetSearch}
            statusFilter={fleetStatusFilter}
            onClose={() => setActivePanel(null)}
            onFreshnessFilterChange={setFleetGpsFreshnessFilter}
            onGpsSourceFilterChange={setFleetGpsSourceFilter}
            onKindFilterChange={setFleetKindFilter}
            onReset={resetFleetFilters}
            onSearchChange={setFleetSearch}
            onStatusFilterChange={setFleetStatusFilter}
          />
        )}

        {!expandedWorkspace && !focusMode && mapLayers.route && displayRoute && (
          <RouteSummaryCard
            caseNumber={caseItem?.caseNumber ?? ""}
            className="sm:hidden"
            displayRoute={displayRoute}
            model={model}
          />
        )}
      </div>

      {desktopRouteCardVisible && displayRoute && (
        <RouteSummaryCard
          caseNumber={caseItem?.caseNumber ?? ""}
          className="absolute right-3 top-3 hidden w-[310px] max-w-[calc(100vw-48px)] sm:block"
          displayRoute={displayRoute}
          model={model}
        />
      )}

      {!compactWorkspace && !focusMode && planOpen && model.routePlan && (
        <div className={`pointer-events-auto absolute left-2 right-2 w-auto max-w-none rounded-md bg-white/95 p-2.5 shadow-sm ring-1 ring-zinc-200 backdrop-blur sm:left-3 sm:right-auto sm:w-[410px] sm:max-w-[calc(100%-24px)] sm:p-3 ${planPanelBottomClass}`}>
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex min-w-0 items-center gap-2 text-sm font-semibold text-zinc-950">
              <Navigation size={16} className="shrink-0" />
              <span>Operačný plán</span>
              <span className="hidden truncate text-xs font-medium text-zinc-500 sm:inline">asset → klient → cieľ → pobočka</span>
            </span>
          </div>
          <div className="mt-3 grid gap-2">
            {model.routePlan.segments.map((segment) => (
              <RouteSegmentRow key={segment.id} segment={segment} />
            ))}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <ActionPill icon={Send} label="SMS poloha" onClick={() => onSendLocationSms?.()} disabled={!onSendLocationSms} />
            <ActionPill
              icon={CheckCircle2}
              label={caseItem?.status === "assigned" ? "Priradené" : "Priradiť"}
              onClick={() => model.nearestAsset && onAssignAsset?.(model.nearestAsset.asset.id)}
              disabled={!onAssignAsset || !model.nearestAsset || caseItem?.status === "assigned"}
            />
            <ActionPill icon={Clock3} label="ETA klientovi" onClick={() => onSendEtaSms?.()} disabled={!onSendEtaSms} />
          </div>
        </div>
      )}

      {!focusMode && mapLayers.route && !model.routePlan && (
        <div className="pointer-events-none absolute bottom-3 left-3 right-3 z-20 rounded-md border border-zinc-200 bg-white/95 px-3 py-2 text-sm font-medium text-zinc-700 shadow-sm sm:right-auto sm:max-w-sm">
          Poloha nezadaná — trasa, ETA a návrh techniky sa zatiaľ nevytvárajú.
        </div>
      )}

    </section>
  );
}

function AddressAutocomplete({
  hostRef,
  label,
}: {
  hostRef: MutableRefObject<HTMLDivElement | null>;
  label: string;
}) {
  return (
    <div className="mt-2">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">{label}</span>
      <div ref={hostRef} className="google-place-autocomplete-host min-h-10" />
    </div>
  );
}

function MapUnavailable({ detail }: { detail?: string }) {
  return (
    <div className="flex h-full min-h-[360px] flex-col items-center justify-center gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-6 text-center sm:min-h-[420px]">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700">
        <AlertTriangle size={22} />
      </div>
      <div className="max-w-sm">
        <h3 className="text-sm font-semibold text-zinc-950">Mapa sa momentálne nedá zobraziť</h3>
        <p className="mt-1 text-sm text-zinc-600">
          {detail ?? "Skúste to prosím o chvíľu znova. Ak problém pretrváva, dajte nám vedieť a pozrieme sa na to."}
        </p>
      </div>
      <a
        href="mailto:info@alfopure.tech"
        className="inline-flex h-9 items-center gap-2 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white hover:bg-zinc-800"
      >
        <Mail size={15} />
        info@alfopure.tech
      </a>
    </div>
  );
}

function RouteSummaryCard({
  caseNumber,
  className = "",
  displayRoute,
  model,
}: {
  caseNumber: string;
  className?: string;
  displayRoute: RouteState;
  model: DispatchMapModel;
}) {
  const [routeDetailsOpen, setRouteDetailsOpen] = useState(false);
  const routeStatusLabel =
    displayRoute.source === "google" ? "Google live" : displayRoute.label.includes("server key") ? "Routes unavailable" : "Fallback";

  return (
    <div className={`pointer-events-auto rounded-md bg-white/95 p-2.5 shadow-sm ring-1 ring-zinc-200 backdrop-blur sm:p-3 ${className}`}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-normal text-zinc-500">Návrh trasy</div>
          <div className="text-sm font-semibold text-zinc-950">{caseNumber}</div>
        </div>
        <button
          type="button"
          onClick={() => setRouteDetailsOpen((current) => !current)}
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100"
        >
          <ShieldCheck size={13} />
          {routeStatusLabel}
          {routeDetailsOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <RouteMetric icon={Route} label="km" value={`${displayRoute.totalKm}`} />
        <RouteMetric icon={Clock3} label="ETA" value={`${displayRoute.totalEta}m`} />
        <RouteMetric icon={MapPinned} label="Cena" value={model.price ? formatCurrency(model.price.total) : "—"} />
      </div>
      {routeDetailsOpen && (
        <div className="mt-3 grid gap-1.5 text-xs">
          <InlineFact icon={Truck} label="Technika" value={model.nearestAsset?.asset.label ?? "Žiadna dostupná"} />
          <InlineFact icon={Navigation} label="Pobočka" value={model.nearestBranch?.branch.name ?? "Nepriradená"} />
          <InlineFact icon={LocateFixed} label="Zdroj trasy" value={displayRoute.label} />
        </div>
      )}
    </div>
  );
}

function RouteMetric({ icon: Icon, label, value }: { icon: typeof Route; label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-2">
      <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-normal text-zinc-500">
        <Icon size={12} />
        {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold text-zinc-950">{value}</div>
    </div>
  );
}

function InlineFact({ icon: Icon, label, value }: { icon: typeof Truck; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-zinc-50 px-2 py-1.5 text-zinc-700">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Icon size={13} className="shrink-0 text-zinc-500" />
        <span className="font-medium">{label}</span>
      </span>
      <span className="truncate font-semibold text-zinc-950">{value}</span>
    </div>
  );
}

function RouteSegmentRow({ segment }: { segment: DispatchRouteSegment }) {
  return (
    <div className="grid grid-cols-[12px_1fr] items-center gap-2 text-xs sm:grid-cols-[12px_1fr_auto]">
      <span className={`h-3 w-3 rounded-full ${segmentDotTone[segment.tone]}`} />
      <span className="min-w-0">
        <span className="block truncate font-semibold text-zinc-900">{segment.label}</span>
        <span className="block truncate text-zinc-500">{segment.detail}</span>
      </span>
      <span className="col-start-2 w-fit rounded-md bg-zinc-100 px-2 py-1 font-semibold text-zinc-700 sm:col-start-auto">
        {segment.operationalKm} km · {segment.eta}m
      </span>
    </div>
  );
}

function ActionPill({
  disabled,
  icon: Icon,
  label,
  onClick,
}: {
  disabled?: boolean;
  icon: typeof Send;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="pointer-events-auto inline-flex h-8 items-center justify-center gap-1 rounded-md bg-zinc-950 px-1.5 text-[11px] font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600 sm:px-2 sm:text-xs"
    >
      <Icon size={13} />
      <span className="truncate">{label}</span>
    </button>
  );
}

function routeStateFromGoogleRoute(result: GoogleRouteResult, signature: string): RouteState {
  return {
    signature,
    source: "google",
    totalKm: roundOne(result.distanceMeters / 1000),
    totalEta: Math.max(1, Math.round(result.durationSeconds / 60)),
    label: "Google Routes API",
  };
}

function drawFallbackRoute(map: google.maps.Map, segments: DispatchRouteSegment[], googleMaps: typeof google) {
  return segments.flatMap((segment, index) => {
    const path = segmentPolyline(segment, index).map(([lat, lng]) => ({ lat, lng }));
    const shadow = new googleMaps.maps.Polyline({
      map,
      path,
      ...ROUTE_SHADOW_STYLE,
      zIndex: 10,
    });
    const polyline = new googleMaps.maps.Polyline({
      map,
      path,
      ...routeToneStyles[segment.tone],
      zIndex: 20 + index,
    });
    return [shadow, polyline];
  });
}

function drawGoogleRoute(
  map: google.maps.Map,
  result: GoogleRouteResult,
  segments: DispatchRouteSegment[],
  googleMaps: typeof google,
) {
  const encoding = googleMaps.maps.geometry?.encoding;
  if (!encoding) {
    return [];
  }

  const legPolylines = result.legs
    .map((leg, index) => ({
      encodedPolyline: leg.encodedPolyline,
      segment: segments[index],
    }))
    .filter((leg): leg is { encodedPolyline: string; segment: DispatchRouteSegment } => Boolean(leg.encodedPolyline && leg.segment));

  if (legPolylines.length === segments.length) {
    return legPolylines.flatMap(({ encodedPolyline, segment }, index) =>
      drawRoutePath(map, encoding.decodePath(encodedPolyline), routeToneStyles[segment.tone], googleMaps, 20 + index),
    );
  }

  if (!result.encodedPolyline) {
    return [];
  }

  return drawRoutePath(map, encoding.decodePath(result.encodedPolyline), routeOverviewStyle, googleMaps, 20);
}

function drawRoutePath(
  map: google.maps.Map,
  path: google.maps.LatLng[],
  style: google.maps.PolylineOptions,
  googleMaps: typeof google,
  zIndex: number,
) {
  if (path.length === 0) {
    return [];
  }

  const shadow = new googleMaps.maps.Polyline({
    map,
    path,
    ...ROUTE_SHADOW_STYLE,
    zIndex: zIndex - 1,
  });
  const route = new googleMaps.maps.Polyline({
    map,
    path,
    ...style,
    zIndex,
  });

  return [shadow, route];
}

function segmentPolyline(segment: DispatchRouteSegment, index: number): Array<[number, number]> {
  const bend = index % 2 === 0 ? 0.045 : -0.045;
  const midpoint: [number, number] = [
    (segment.from.lat + segment.to.lat) / 2 + bend,
    (segment.from.lng + segment.to.lng) / 2 - bend,
  ];

  return [
    [segment.from.lat, segment.from.lng],
    midpoint,
    [segment.to.lat, segment.to.lng],
  ];
}

function createMarkerContent(kind: string, active = false) {
  const shell = document.createElement("span");
  shell.className = "dispatch-map-pin-shell";

  const pin = document.createElement("span");
  pin.className = `dispatch-map-pin dispatch-map-pin-${kind}${active ? " dispatch-map-pin-active" : ""}`;
  shell.append(pin);

  return shell;
}

function createMapMarker(
  googleMaps: typeof google,
  {
    active,
    kind,
    map,
    position,
    title,
    zIndex,
  }: {
    active: boolean;
    kind: string;
    map: google.maps.Map;
    position: GeoPoint;
    title: string;
    zIndex: number;
  },
): GoogleMapMarker {
  if (googleMaps.maps.Marker) {
    return new googleMaps.maps.Marker({
      icon: legacyMarkerIcon(googleMaps, kind, active),
      map,
      optimized: false,
      position,
      title,
      zIndex,
    });
  }

  return new googleMaps.maps.marker.AdvancedMarkerElement({
    content: createMarkerContent(kind, active),
    map,
    position,
    title,
    zIndex,
  });
}

function createClickableMapMarker(
  googleMaps: typeof google,
  options: {
    active: boolean;
    kind: string;
    map: google.maps.Map;
    position: GeoPoint;
    title: string;
    zIndex: number;
    onClick: EventListener;
  },
): { marker: GoogleMapMarker; listenerRecord: MarkerListenerRecord } {
  if (googleMaps.maps.Marker) {
    const marker = createMapMarker(googleMaps, options);
    if (isLegacyMarker(marker)) {
      return {
        marker,
        listenerRecord: { mapsListener: marker.addListener("click", options.onClick) },
      };
    }
  }

  const content = createMarkerContent(options.kind, options.active);
  content.style.cursor = "pointer";
  content.addEventListener("click", options.onClick);

  return {
    marker: new googleMaps.maps.marker.AdvancedMarkerElement({
      content,
      map: options.map,
      position: options.position,
      title: options.title,
      zIndex: options.zIndex,
    }),
    listenerRecord: { content, listener: options.onClick },
  };
}

function updateMapMarker(
  googleMaps: typeof google,
  marker: GoogleMapMarker,
  {
    active,
    kind,
    position,
    title,
    zIndex,
  }: {
    active: boolean;
    kind: string;
    position: GeoPoint;
    title: string;
    zIndex: number;
  },
) {
  if (isLegacyMarker(marker)) {
    marker.setIcon(legacyMarkerIcon(googleMaps, kind, active));
    marker.setPosition(position);
    marker.setTitle(title);
    marker.setZIndex(zIndex);
    return;
  }

  marker.position = position;
  marker.title = title;
  marker.zIndex = zIndex;
  updateMarkerContent(marker.content, kind, active);
}

function legacyMarkerIcon(googleMaps: typeof google, kind: string, active: boolean): google.maps.Symbol {
  return {
    fillColor: markerColor(kind),
    fillOpacity: 1,
    path: googleMaps.maps.SymbolPath.CIRCLE,
    scale: active ? 9 : 8,
    strokeColor: "#ffffff",
    strokeOpacity: 1,
    strokeWeight: active ? 4 : 3,
  };
}

function markerColor(kind: string) {
  switch (kind) {
    case "pickup":
      return "#2563eb";
    case "destination":
      return "#ef4444";
    case "branch":
      return "#fcd703";
    case "tow":
      return "#111827";
    case "replacement_car":
      return "#059669";
    case "search":
      return "#7c3aed";
    default:
      return "#18181b";
  }
}

function isLegacyMarker(marker: GoogleMapMarker): marker is google.maps.Marker {
  return "setMap" in marker;
}

function updateMarkerContent(content: Node | null | undefined, kind: string, active: boolean) {
  if (!(content instanceof HTMLElement)) {
    return;
  }

  const pin = content.querySelector(".dispatch-map-pin");
  if (pin) {
    pin.className = `dispatch-map-pin dispatch-map-pin-${kind}${active ? " dispatch-map-pin-active" : ""}`;
  }
}

function isVisibleMapMarker(
  marker: DispatchMapModel["markers"][number],
  model: DispatchMapModel,
  routeVisible: boolean,
  branchesVisible: boolean,
) {
  // Pickup, cieľ a najbližšia technika patria k vrstve „Trasa" – mapa je inak prázdna.
  if (marker.kind === "pickup" || marker.kind === "destination") {
    return routeVisible;
  }

  if (marker.id === model.nearestAsset?.asset.id) {
    return routeVisible;
  }

  if (marker.id === model.nearestBranch?.branch.id) {
    return routeVisible || branchesVisible;
  }

  if (marker.kind === "branch") {
    return branchesVisible;
  }

  return false;
}

function isPrimaryMapMarker(marker: DispatchMapModel["markers"][number], model: DispatchMapModel) {
  return marker.id === model.nearestAsset?.asset.id || marker.id === model.nearestBranch?.branch.id || marker.kind === "pickup";
}

function fleetLayerForAsset(asset: FleetAsset): FleetLayerKey {
  return asset.kind === "tow_truck" ? "tow" : "replacement_car";
}

function isFleetAssetVisible(
  asset: FleetAsset,
  towLayerVisible: boolean,
  replacementLayerVisible: boolean,
  search: string,
  kindFilter: "all" | FleetAsset["kind"],
  statusFilter: "all" | FleetAssetStatus,
  gpsSourceFilter: FleetGpsSourceFilter,
  gpsFreshnessFilter: FleetGpsFreshnessFilter,
  routeVisible: boolean,
  nearestAssetId: string,
) {
  if (routeVisible && asset.id === nearestAssetId) {
    return false;
  }

  const layer = fleetLayerForAsset(asset);
  const layerVisible = layer === "tow" ? towLayerVisible : replacementLayerVisible;
  if (!layerVisible || !matchesSearch(asset, search)) {
    return false;
  }

  if (kindFilter !== "all" && asset.kind !== kindFilter) {
    return false;
  }

  if (statusFilter !== "all" && asset.status !== statusFilter) {
    return false;
  }

  if (gpsSourceFilter === "none" && asset.gps) {
    return false;
  }

  if (gpsSourceFilter !== "all" && gpsSourceFilter !== "none" && asset.gps?.source !== gpsSourceFilter) {
    return false;
  }

  if (gpsFreshnessFilter === "none") {
    return !asset.gps;
  }

  if (gpsFreshnessFilter === "live") {
    return Boolean(asset.gps && !asset.gps.stale);
  }

  if (gpsFreshnessFilter === "stale") {
    return Boolean(asset.gps?.stale);
  }

  return true;
}

function fleetMarkerTitle(asset: FleetAsset) {
  return [asset.label, asset.licensePlate].filter(Boolean).join(" · ");
}

function clearMarkers(markers: GoogleMapMarker[]) {
  markers.forEach((marker) => {
    removeMapMarker(marker);
  });
  markers.length = 0;
}

function clearFleetMarkers(
  markers: Map<string, GoogleMapMarker>,
  listeners: Map<string, MarkerListenerRecord>,
) {
  markers.forEach((marker, assetId) => {
    removeFleetMarker(assetId, marker, listeners);
  });
  markers.clear();
}

function removeFleetMarker(
  assetId: string,
  marker: GoogleMapMarker,
  listeners: Map<string, MarkerListenerRecord>,
) {
  const listenerRecord = listeners.get(assetId);
  if (listenerRecord?.content && listenerRecord.listener) {
    listenerRecord.content.removeEventListener("click", listenerRecord.listener);
  }
  if (listenerRecord?.mapsListener) {
    listenerRecord.mapsListener.remove();
  }
  if (listenerRecord) {
    listeners.delete(assetId);
  }
  removeMapMarker(marker);
}

function removeMapMarker(marker: GoogleMapMarker) {
  if (isLegacyMarker(marker)) {
    marker.setMap(null);
    return;
  }
  marker.map = null;
}

function clearPolylines(polylines: google.maps.Polyline[]) {
  polylines.forEach((polyline) => polyline.setMap(null));
  polylines.length = 0;
}

function toLatLngLiteral(point: GeoPoint): google.maps.LatLngLiteral {
  return { lat: point.lat, lng: point.lng };
}

function isConfiguredGoogleKey(value: string | undefined) {
  return Boolean(value && !value.startsWith("replace-with"));
}

function isGoogleRouteResult(value: GoogleRouteResult | { error?: string }): value is GoogleRouteResult {
  return (
    "distanceMeters" in value &&
    typeof value.distanceMeters === "number" &&
    "durationSeconds" in value &&
    typeof value.durationSeconds === "number" &&
    "legs" in value &&
    Array.isArray(value.legs) &&
    "provider" in value &&
    value.provider === "google-routes"
  );
}

function roundOne(value: number) {
  return Math.round(value * 10) / 10;
}

const ROUTE_SHADOW_STYLE: google.maps.PolylineOptions = {
  strokeColor: "#111827",
  strokeOpacity: 0.28,
  strokeWeight: 9,
};

const routeToneStyles: Record<DispatchRouteSegment["tone"], google.maps.PolylineOptions> = {
  asset: { strokeColor: "#2563eb", strokeOpacity: 0.96, strokeWeight: 4 },
  tow: { strokeColor: "#fcd703", strokeOpacity: 1, strokeWeight: 5 },
  handover: { strokeColor: "#059669", strokeOpacity: 0.94, strokeWeight: 4 },
};

const routeOverviewStyle: google.maps.PolylineOptions = {
  strokeColor: "#111827",
  strokeOpacity: 0.86,
  strokeWeight: 5,
};

const segmentDotTone: Record<DispatchRouteSegment["tone"], string> = {
  asset: "bg-blue-600",
  tow: "bg-[#FCD703]",
  handover: "bg-emerald-600",
};
