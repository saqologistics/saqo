import React from 'react';
import { ArrowUpDown } from 'lucide-react';
import { NIGERIA_STATES } from '../shared/nigeria';
import { AddressPickerField } from './AddressPickerField';

export interface RouteCoords {
  lat: number;
  lng: number;
}

interface RouteLocationCardProps {
  idPrefix: string;
  showDeliveryStateSelectors: boolean;
  pickupState: string;
  pickupAddress: string;
  pickupCoords: RouteCoords | null;
  destinationState: string;
  destinationAddress: string;
  destinationCoords: RouteCoords | null;
  onPickupStateChange: (state: string) => void;
  onPickupAddressChange: (address: string) => void;
  onPickupCoordsChange: (coords: RouteCoords | null) => void;
  onDestinationStateChange: (state: string) => void;
  onDestinationAddressChange: (address: string) => void;
  onDestinationCoordsChange: (coords: RouteCoords | null) => void;
  onSwap: () => void;
  required?: boolean;
  pickupPlaceholder?: string;
  destinationPlaceholder?: string;
}

export const RouteLocationCard: React.FC<RouteLocationCardProps> = ({
  idPrefix,
  showDeliveryStateSelectors,
  pickupState,
  pickupAddress,
  pickupCoords,
  destinationState,
  destinationAddress,
  destinationCoords,
  onPickupStateChange,
  onPickupAddressChange,
  onPickupCoordsChange,
  onDestinationStateChange,
  onDestinationAddressChange,
  onDestinationCoordsChange,
  onSwap,
  required = true,
  pickupPlaceholder = 'Pickup location',
  destinationPlaceholder = 'Dropoff location',
}) => {
  return (
    <div className="space-y-3">
      {showDeliveryStateSelectors && (
        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label htmlFor={`${idPrefix}-pickup-state`} className="sr-only">
              Pickup State
            </label>
            <select
              id={`${idPrefix}-pickup-state`}
              value={pickupState}
              onChange={(e) => {
                onPickupStateChange(e.target.value);
                onPickupAddressChange('');
                onPickupCoordsChange(null);
              }}
              className="w-full rounded-xl bg-neutral-100 border border-transparent px-3 py-2.5 text-xs font-semibold text-black focus:bg-white focus:border-black focus:outline-none focus:ring-2 focus:ring-black"
            >
              <option value="Katsina">From: Katsina (Live)</option>
              {NIGERIA_STATES.filter((s) => s.name !== 'Katsina').map((s) => (
                <option key={s.name} value={s.name}>
                  From: {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${idPrefix}-dest-state`} className="sr-only">
              Destination State
            </label>
            <select
              id={`${idPrefix}-dest-state`}
              value={destinationState}
              onChange={(e) => {
                onDestinationStateChange(e.target.value);
                onDestinationAddressChange('');
                onDestinationCoordsChange(null);
              }}
              className="w-full rounded-xl bg-neutral-100 border border-transparent px-3 py-2.5 text-xs font-semibold text-black focus:bg-white focus:border-black focus:outline-none focus:ring-2 focus:ring-black"
            >
              <option value="Katsina">To: Katsina (Live)</option>
              {NIGERIA_STATES.filter((s) => s.name !== 'Katsina').map((s) => (
                <option key={s.name} value={s.name}>
                  To: {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Uber-inspired stacked From/To inputs with vertical guide bar and compact swap trigger */}
      <div className="relative space-y-2.5">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-[20px] top-[44px] bottom-[25px] w-[1.5px] bg-black/25 z-0"
        />
        <AddressPickerField
          id={`${idPrefix}-pickup-addr`}
          label="Pickup location"
          fieldTag="From"
          variant="pickup"
          stateName={pickupState}
          restrictToState={!showDeliveryStateSelectors}
          value={pickupAddress}
          oppositeAddress={destinationCoords ? destinationAddress : undefined}
          selectedCoords={pickupCoords}
          required={required}
          surfaceClassName="bg-neutral-100 border border-transparent hover:bg-neutral-200/60 focus:bg-white focus:border-black text-black"
          placeholder={pickupPlaceholder}
          onChange={(val) => {
            onPickupAddressChange(val);
            onPickupCoordsChange(null);
          }}
          onStateDetected={onPickupStateChange}
          onLocationResolved={(place) => onPickupCoordsChange({ lat: place.lat, lng: place.lng })}
        />

        <AddressPickerField
          id={`${idPrefix}-dest-addr`}
          label="Dropoff location"
          fieldTag="To"
          variant="destination"
          stateName={destinationState}
          restrictToState={!showDeliveryStateSelectors}
          value={destinationAddress}
          oppositeAddress={pickupCoords ? pickupAddress : undefined}
          selectedCoords={destinationCoords}
          required={required}
          surfaceClassName="bg-neutral-100 border border-transparent hover:bg-neutral-200/60 focus:bg-white focus:border-black text-black"
          placeholder={destinationPlaceholder}
          onChange={(val) => {
            onDestinationAddressChange(val);
            onDestinationCoordsChange(null);
          }}
          onStateDetected={onDestinationStateChange}
          onLocationResolved={(place) => onDestinationCoordsChange({ lat: place.lat, lng: place.lng })}
        />
      </div>

      <div className="flex items-center justify-between text-[11px] text-neutral-500 px-0.5">
        <span>{showDeliveryStateSelectors ? `${pickupState} → ${destinationState}` : 'Katsina State Dispatch'}</span>
        <button
          type="button"
          onClick={onSwap}
          className="inline-flex items-center gap-1.5 font-semibold text-neutral-700 hover:text-black transition-colors cursor-pointer"
        >
          <ArrowUpDown className="w-3.5 h-3.5" />
          <span>Swap route</span>
        </button>
      </div>
    </div>
  );
};
