import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Crosshair, Minus, Plus } from 'lucide-react';
import type { DeliveryRequest, RiderProfile } from '../shared/types';

interface LiveNigeriaMapProps {
  deliveries?: DeliveryRequest[];
  riders?: RiderProfile[];
  focusedDelivery?: DeliveryRequest | null;
  heightClass?: string;
  darkTheme?: boolean;
  onSelectDelivery?: (delivery: DeliveryRequest) => void;
}

export const LiveNigeriaMap: React.FC<LiveNigeriaMapProps> = ({
  deliveries = [],
  riders = [],
  focusedDelivery = null,
  heightClass = 'h-[400px]',
  darkTheme = false,
  onSelectDelivery,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const [centerMode, setCenterMode] = useState<'nigeria' | 'focused'>(
    focusedDelivery ? 'focused' : 'nigeria'
  );

  const mapboxToken = (import.meta as any).env?.VITE_MAPBOX_TOKEN as string | undefined;

  useEffect(() => {
    setCenterMode(focusedDelivery ? 'focused' : 'nigeria');
  }, [focusedDelivery?.id]);

  // Initialize real Leaflet map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [9.082, 8.6753],
      zoom: 6,
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

    return () => {
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
    };
  }, [mapboxToken, darkTheme]);

  // Sync routes, pickup/dropoff pins, and live rider markers
  useEffect(() => {
    const map = mapRef.current;
    const layerGroup = layerGroupRef.current;
    if (!map || !layerGroup) return;

    layerGroup.clearLayers();

    const activeDeliveries = deliveries.filter(
      (d) => !['delivered', 'cancelled'].includes(d.status)
    );

    const boundsPoints: L.LatLngExpression[] = [];

    for (const del of activeDeliveries) {
      const isFocused = focusedDelivery?.id === del.id;
      const pickupLatLng: L.LatLngExpression = [del.pickupLat, del.pickupLng];
      const destLatLng: L.LatLngExpression = [del.destinationLat, del.destinationLng];

      if (!focusedDelivery || isFocused) {
        boundsPoints.push(pickupLatLng, destLatLng);
      }

      const routeLine = L.polyline([pickupLatLng, destLatLng], {
        color: '#000000',
        weight: isFocused ? 4 : 2,
        opacity: isFocused || !focusedDelivery ? 0.9 : 0.3,
        dashArray: isFocused ? undefined : '6 6',
      });

      if (onSelectDelivery) {
        routeLine.on('click', () => onSelectDelivery(del));
      }
      routeLine.addTo(layerGroup);

      // Pickup marker (solid black circle)
      const pickupMarker = L.marker(pickupLatLng, {
        icon: L.divIcon({
          className: '',
          iconSize: [14, 14],
          iconAnchor: [7, 7],
          html: `<div style="width:14px;height:14px;border-radius:9999px;background:#000;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>`,
        }),
      }).bindTooltip(`Pickup: ${del.pickupAddress}, ${del.pickupState}`, {
        direction: 'top',
        offset: [0, -8],
      });
      pickupMarker.addTo(layerGroup);

      // Destination marker (hollow crisp square)
      const destMarker = L.marker(destLatLng, {
        icon: L.divIcon({
          className: '',
          iconSize: [14, 14],
          iconAnchor: [7, 7],
          html: `<div style="width:14px;height:14px;background:#fff;border:3px solid #000;box-shadow:0 1px 4px rgba(0,0,0,0.35);"></div>`,
        }),
      }).bindTooltip(`Destination: ${del.destinationAddress}, ${del.destinationState}`, {
        direction: 'top',
        offset: [0, -8],
      });
      destMarker.addTo(layerGroup);
    }

    // Live Rider markers
    for (const rider of riders) {
      const latLng: L.LatLngExpression = [rider.currentLat, rider.currentLng];
      const isFocusedRider = focusedDelivery?.assignedRiderId === rider.riderId;
      if (isFocusedRider) {
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

    if (centerMode === 'focused' && boundsPoints.length >= 2) {
      map.fitBounds(L.latLngBounds(boundsPoints), {
        padding: [48, 48],
        maxZoom: 13,
        animate: false,
      });
    } else if (centerMode === 'nigeria') {
      map.setView([9.082, 8.6753], 6, { animate: false });
    }
  }, [deliveries, riders, focusedDelivery, centerMode, onSelectDelivery]);

  return (
    <div
      data-testid="live-nigeria-map"
      className={`isolate z-0 relative w-full ${heightClass} rounded-xl border border-neutral-200 overflow-hidden bg-neutral-100`}
    >
      {/* Real Leaflet Street Map Canvas with strict monochrome grayscale styling */}
      <div
        ref={containerRef}
        aria-label="Live Nigeria Parcel Dispatch Map"
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

      {/* Top-right zoom & center controls */}
      <div className="absolute top-3 right-3 z-[400] flex items-center gap-1">
        {focusedDelivery && (
          <button
            type="button"
            onClick={() =>
              setCenterMode((m) => (m === 'focused' ? 'nigeria' : 'focused'))
            }
            aria-label={centerMode === 'focused' ? 'Show all Nigeria' : 'Focus active route'}
            title={centerMode === 'focused' ? 'Show all Nigeria' : 'Focus active route'}
            className="h-8 w-8 sm:w-auto sm:px-2.5 rounded-lg border border-neutral-200 bg-white/95 text-black text-xs font-medium inline-flex items-center justify-center gap-1.5 hover:bg-neutral-100 shadow-sm cursor-pointer"
          >
            <Crosshair className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden sm:inline">
              {centerMode === 'focused' ? 'All Nigeria' : 'Focus Route'}
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
