import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Crosshair, Minus, Plus } from 'lucide-react';
import type { DeliveryRequest, RiderProfile } from '../shared/types';

export interface RoutePreview {
  pickupLat?: number;
  pickupLng?: number;
  pickupAddress: string;
  pickupState: string;
  destinationLat?: number;
  destinationLng?: number;
  destinationAddress: string;
  destinationState: string;
}

interface LiveNigeriaMapProps {
  deliveries?: DeliveryRequest[];
  riders?: RiderProfile[];
  focusedDelivery?: DeliveryRequest | null;
  previewRoute?: RoutePreview | null;
  heightClass?: string;
  darkTheme?: boolean;
  onSelectDelivery?: (delivery: DeliveryRequest) => void;
}

const KATSINA_CENTER: [number, number] = [12.9816, 7.6223];
const KATSINA_DEFAULT_ZOOM = 12;
const routingEndpoint = import.meta.env.VITE_OSRM_URL || 'https://routing.openstreetmap.de/routed-car/route/v1/driving/';

function mapTooltip(text: string): HTMLElement {
  const label = document.createElement('span');
  label.textContent = text;
  return label;
}

export const LiveNigeriaMap: React.FC<LiveNigeriaMapProps> = ({
  deliveries = [],
  riders = [],
  focusedDelivery = null,
  previewRoute = null,
  heightClass = 'h-[400px]',
  darkTheme = false,
  onSelectDelivery,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const [centerMode, setCenterMode] = useState<'hub' | 'focused'>(
    focusedDelivery || previewRoute ? 'focused' : 'hub'
  );

  const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN;
  const [roadRoute, setRoadRoute] = useState<{ key: string; points: L.LatLngTuple[] | null } | null>(null);
  const { pickupLat, pickupLng, destinationLat, destinationLng } = focusedDelivery || previewRoute || {};
  const routeKey = [pickupLat, pickupLng, destinationLat, destinationLng].every(Number.isFinite) &&
    (pickupLat !== destinationLat || pickupLng !== destinationLng)
    ? `${pickupLng},${pickupLat};${destinationLng},${destinationLat}`
    : null;
  const route = routeKey && roadRoute?.key === routeKey ? roadRoute : null;

  useEffect(() => {
    if (!routeKey) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort('timeout'), 7000);
    const loadRoute = async () => {
      try {
        const base = routingEndpoint.endsWith('/') ? routingEndpoint : `${routingEndpoint}/`;
        const url = new URL(base + routeKey, window.location.origin);
        url.searchParams.set('overview', 'full');
        url.searchParams.set('geometries', 'geojson');
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error('Routing unavailable');
        const result = await response.json();
        const coordinates: Array<[number, number]> | undefined = result.routes?.[0]?.geometry?.coordinates;
        if (result.code !== 'Ok' || !Array.isArray(coordinates) || coordinates.length < 2) {
          throw new Error('No road route found');
        }
        if (!controller.signal.aborted) {
          setRoadRoute({ key: routeKey, points: coordinates.map(([lng, lat]) => [lat, lng]) });
        }
      } catch {
        if (!controller.signal.aborted || controller.signal.reason === 'timeout') {
          setRoadRoute({ key: routeKey, points: null });
        }
      } finally {
        window.clearTimeout(timeout);
      }
    };
    loadRoute();
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [routeKey]);

  useEffect(() => {
    setCenterMode(focusedDelivery || previewRoute ? 'focused' : 'hub');
  }, [
    focusedDelivery?.id,
    previewRoute?.pickupLat,
    previewRoute?.pickupLng,
    previewRoute?.destinationLat,
    previewRoute?.destinationLng,
  ]);

  // Initialize real Leaflet map once + handle container resizing cleanly
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: KATSINA_CENTER,
      zoom: KATSINA_DEFAULT_ZOOM,
      zoomControl: false,
      attributionControl: true,
    });

    const tileUrl = mapboxToken
      ? `https://api.mapbox.com/styles/v1/mapbox/${
          darkTheme ? 'dark-v11' : 'light-v11'
        }/tiles/256/{z}/{x}/{y}@2x?access_token=${mapboxToken}`
      : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';

    const tileLayer = L.tileLayer(tileUrl, {
      maxZoom: 19,
      attribution: mapboxToken
        ? '© Mapbox © OpenStreetMap'
        : '© OpenStreetMap contributors © CARTO',
    });

    tileLayer.addTo(map);
    const layerGroup = L.layerGroup().addTo(map);

    mapRef.current = map;
    layerGroupRef.current = layerGroup;

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        map.invalidateSize({ pan: false });
      });
      resizeObserver.observe(containerRef.current);
    }

    const initTimer = window.setTimeout(() => {
      map.invalidateSize({ pan: false });
    }, 80);

    return () => {
      window.clearTimeout(initTimer);
      resizeObserver?.disconnect();
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
    };
  }, [mapboxToken, darkTheme]);

  // Sync routes, preview route, pickup/dropoff pins, and live rider markers
  useEffect(() => {
    const map = mapRef.current;
    const layerGroup = layerGroupRef.current;
    if (!map || !layerGroup) return;

    layerGroup.clearLayers();

    const activeDeliveries = focusedDelivery
      ? [focusedDelivery, ...deliveries.filter((d) => d.id !== focusedDelivery.id && !['delivered', 'cancelled'].includes(d.status))]
      : deliveries.filter((d) => !['delivered', 'cancelled'].includes(d.status));

    const boundsPoints: L.LatLngExpression[] = [];

    for (const del of activeDeliveries) {
      if (
        !Number.isFinite(del.pickupLat) ||
        !Number.isFinite(del.pickupLng) ||
        !Number.isFinite(del.destinationLat) ||
        !Number.isFinite(del.destinationLng)
      ) {
        continue;
      }

      const isFocused = focusedDelivery?.id === del.id;
      const pickupLatLng: L.LatLngExpression = [del.pickupLat, del.pickupLng];
      const destLatLng: L.LatLngExpression = [del.destinationLat, del.destinationLng];

      if (!focusedDelivery || isFocused) {
        boundsPoints.push(pickupLatLng, destLatLng);
      }

      const routeLine = L.polyline((isFocused && route?.points) || [pickupLatLng, destLatLng], {
        color: '#000000',
        weight: isFocused ? 4 : 2,
        opacity: isFocused || !focusedDelivery ? 0.9 : 0.3,
        dashArray: isFocused && route?.points ? undefined : '6 6',
      });

      if (onSelectDelivery) {
        routeLine.on('click', () => onSelectDelivery(del));
      }
      routeLine.addTo(layerGroup);

      const pickupMarker = L.marker(pickupLatLng, {
        icon: L.divIcon({
          className: '',
          iconSize: [14, 14],
          iconAnchor: [7, 7],
          html: `<div style="width:14px;height:14px;border-radius:9999px;background:#000;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>`,
        }),
      }).bindTooltip(mapTooltip(`Pickup: ${del.pickupAddress}, ${del.pickupState}`), {
        direction: 'top',
        offset: [0, -8],
      });
      pickupMarker.addTo(layerGroup);

      const destMarker = L.marker(destLatLng, {
        icon: L.divIcon({
          className: '',
          iconSize: [14, 14],
          iconAnchor: [7, 7],
          html: `<div style="width:14px;height:14px;background:#fff;border:3px solid #000;box-shadow:0 1px 4px rgba(0,0,0,0.35);"></div>`,
        }),
      }).bindTooltip(mapTooltip(`Destination: ${del.destinationAddress}, ${del.destinationState}`), {
        direction: 'top',
        offset: [0, -8],
      });
      destMarker.addTo(layerGroup);
    }

    if (previewRoute && !focusedDelivery) {
      const pickupPoint: L.LatLngTuple | null =
        Number.isFinite(pickupLat) && Number.isFinite(pickupLng) ? [pickupLat!, pickupLng!] : null;
      const destinationPoint: L.LatLngTuple | null =
        Number.isFinite(destinationLat) && Number.isFinite(destinationLng) ? [destinationLat!, destinationLng!] : null;

      if (pickupPoint && destinationPoint && routeKey) {
        L.polyline(route?.points || [pickupPoint, destinationPoint], {
          color: '#000',
          weight: 3,
          opacity: 0.85,
          dashArray: route?.points ? undefined : '8 6',
        }).addTo(layerGroup);
        if (route?.points && centerMode === 'focused') {
          const roadBounds = L.latLngBounds(route.points);
          boundsPoints.push(roadBounds.getSouthWest(), roadBounds.getNorthEast());
        }
      }

      const stops = [
        { point: pickupPoint, label: `From: ${previewRoute.pickupAddress}`, pickup: true },
        { point: destinationPoint, label: `To: ${previewRoute.destinationAddress}`, pickup: false },
      ];
      for (const { point, label, pickup } of stops) {
        if (!point) continue;
        boundsPoints.push(point);
        L.marker(point, {
          alt: label,
          icon: L.divIcon({
            className: '',
            iconSize: [16, 16],
            iconAnchor: [8, 8],
            html: pickup
              ? '<div style="width:16px;height:16px;border-radius:50%;background:#000;border:2px solid #fff;box-shadow:0 2px 6px #0006"></div>'
              : '<div style="width:16px;height:16px;background:#fff;border:3px solid #000;box-shadow:0 2px 6px #0006"></div>',
          }),
        })
          .bindTooltip(mapTooltip(label), { direction: 'top', offset: [0, -10] })
          .addTo(layerGroup);
      }
    }

    // Live Rider markers
    for (const rider of riders) {
      if (!Number.isFinite(rider.currentLat) || !Number.isFinite(rider.currentLng)) continue;
      const latLng: L.LatLngExpression = [rider.currentLat, rider.currentLng];
      const isFocusedRider = focusedDelivery?.assignedRiderId === rider.riderId;
      if (isFocusedRider || (!focusedDelivery && !previewRoute && activeDeliveries.length === 0)) {
        boundsPoints.push(latLng);
      }

      const riderMarker = L.marker(latLng, {
        icon: L.divIcon({
          className: '',
          iconSize: [28, 28],
          iconAnchor: [14, 14],
          html: `<div style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:9999px;background:${
            rider.isOnline ? '#000' : '#737373'
          };color:#fff;border:2px solid #fff;font-family:JetBrains Mono,monospace;font-size:10px;font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,0.45);">${rider.fullName
            .split(' ')
            .map((p) => p[0])
            .join('')
            .slice(0, 2)}</div>`,
        }),
      }).bindTooltip(
        `${rider.fullName} · ${rider.vehicleType} (${rider.isOnline ? 'Online' : 'Offline'})`,
        { direction: 'top', offset: [0, -12] }
      );
      riderMarker.addTo(layerGroup);
    }

    if (centerMode === 'focused' && boundsPoints.length >= 1) {
      const bounds = L.latLngBounds(boundsPoints);
      if (bounds.isValid()) {
        if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
          map.setView(bounds.getCenter(), 14, { animate: false });
        } else {
          map.fitBounds(bounds, {
            padding: [48, 48],
            maxZoom: 15,
            animate: false,
          });
        }
      }
    } else if (boundsPoints.length >= 2 && !previewRoute) {
      const bounds = L.latLngBounds(boundsPoints);
      if (bounds.isValid()) {
        map.fitBounds(bounds, {
          padding: [44, 44],
          maxZoom: 14,
          animate: false,
        });
      }
    } else {
      map.setView(KATSINA_CENTER, KATSINA_DEFAULT_ZOOM, { animate: false });
    }
  }, [
    deliveries, riders, focusedDelivery, previewRoute, centerMode, onSelectDelivery,
    pickupLat, pickupLng, destinationLat, destinationLng, routeKey, route, mapboxToken, darkTheme,
  ]);

  return (
    <div
      data-testid="live-nigeria-map"
      className={`isolate z-0 relative w-full ${heightClass} rounded-xl border border-neutral-200 overflow-hidden bg-neutral-100`}
    >
      {/* Real Leaflet Street Map Canvas with strict monochrome grayscale styling */}
      <div
        ref={containerRef}
        aria-label="Live Katsina & Nigeria Parcel Dispatch Map"
        className="w-full h-full [&_.leaflet-tile-pane]:grayscale [&_.leaflet-tile-pane]:contrast-125"
      />

      {/* Top-left clean legend */}
      <div className="absolute top-3 left-3 z-[400] px-2.5 sm:px-3 py-1.5 rounded-lg border border-neutral-200 bg-white/95 text-black text-[11px] sm:text-xs font-medium flex items-center gap-2 sm:gap-3 shadow-sm pointer-events-none">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full bg-black shrink-0" />
          <span>Pickup / Rider</span>
        </span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 sm:w-2.5 sm:h-2.5 border-2 border-black bg-white shrink-0" />
          <span>Destination</span>
        </span>
        {mapboxToken && (
          <span className="hidden sm:inline-flex items-center gap-3">
            <span aria-hidden="true">·</span>
            <span className="font-mono">Mapbox</span>
          </span>
        )}
      </div>

      {routeKey && !route?.points && (
        <p role="status" className="absolute bottom-7 left-3 z-[400] rounded-md bg-white/95 px-2.5 py-1.5 text-[11px] shadow-sm">
          {route ? 'Road route unavailable · straight-line preview' : 'Finding road route…'}
        </p>
      )}

      {/* Top-right zoom & center controls */}
      <div className="absolute top-3 right-3 z-[400] flex items-center gap-1">
        {(focusedDelivery || previewRoute) && (
          <button
            type="button"
            onClick={() =>
              setCenterMode((m) => (m === 'focused' ? 'hub' : 'focused'))
            }
            aria-label={centerMode === 'focused' ? 'Center on Katsina Hub' : 'Focus active route'}
            title={centerMode === 'focused' ? 'Center on Katsina Hub' : 'Focus active route'}
            className="h-8 w-8 sm:w-auto sm:px-2.5 rounded-lg border border-neutral-200 bg-white/95 text-black text-xs font-medium inline-flex items-center justify-center gap-1.5 hover:bg-neutral-100 shadow-sm cursor-pointer"
          >
            <Crosshair className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden sm:inline">
              {centerMode === 'focused' ? 'Katsina Hub' : 'Focus Route'}
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={() => mapRef.current?.zoomIn()}
          aria-label="Zoom in map"
          className="w-8 h-8 rounded-lg border border-neutral-200 bg-white/95 text-black flex items-center justify-center hover:bg-neutral-100 shadow-sm cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => mapRef.current?.zoomOut()}
          aria-label="Zoom out map"
          className="w-8 h-8 rounded-lg border border-neutral-200 bg-white/95 text-black flex items-center justify-center hover:bg-neutral-100 shadow-sm cursor-pointer"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
