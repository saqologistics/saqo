import type { DeliveryStatus } from './types';

export interface TrackingStep {
  key: 'requested' | 'assigned' | 'picked_up' | 'in_transit' | 'delivered';
  label: string;
  state: 'completed' | 'current' | 'upcoming';
}

export function getTrackingProgress(status: DeliveryStatus): {
  steps: TrackingStep[];
  percent: number;
  isException: boolean;
  exceptionLabel: string | null;
} {
  if (status === 'cancelled') {
    return {
      steps: [
        { key: 'requested', label: 'Requested', state: 'completed' },
        { key: 'assigned', label: 'Assigned', state: 'upcoming' },
        { key: 'picked_up', label: 'Picked Up', state: 'upcoming' },
        { key: 'in_transit', label: 'In Transit', state: 'upcoming' },
        { key: 'delivered', label: 'Delivered', state: 'upcoming' },
      ],
      percent: 0,
      isException: true,
      exceptionLabel: 'Delivery Cancelled',
    };
  }

  if (status === 'no_rider_available') {
    return {
      steps: [
        { key: 'requested', label: 'Requested', state: 'current' },
        { key: 'assigned', label: 'Assigned', state: 'upcoming' },
        { key: 'picked_up', label: 'Picked Up', state: 'upcoming' },
        { key: 'in_transit', label: 'In Transit', state: 'upcoming' },
        { key: 'delivered', label: 'Delivered', state: 'upcoming' },
      ],
      percent: 15,
      isException: true,
      exceptionLabel: 'Awaiting Available Rider',
    };
  }

  let currentIndex = 0;
  if (status === 'pending_dispatch') {
    currentIndex = 0;
  } else if (
    status === 'assigned' ||
    status === 'accepted' ||
    status === 'heading_to_pickup'
  ) {
    currentIndex = 1;
  } else if (status === 'parcel_picked_up') {
    currentIndex = 2;
  } else if (status === 'in_transit' || status === 'arrived_at_destination') {
    currentIndex = 3;
  } else if (status === 'delivered') {
    currentIndex = 4;
  }

  const base: Array<{ key: TrackingStep['key']; label: string }> = [
    { key: 'requested', label: 'Requested' },
    { key: 'assigned', label: 'Assigned' },
    { key: 'picked_up', label: 'Picked Up' },
    { key: 'in_transit', label: 'In Transit' },
    { key: 'delivered', label: 'Delivered' },
  ];

  const steps: TrackingStep[] = base.map((step, idx) => {
    if (status === 'delivered' || idx < currentIndex) {
      return { ...step, state: 'completed' };
    }
    if (idx === currentIndex) {
      return { ...step, state: 'current' };
    }
    return { ...step, state: 'upcoming' };
  });

  const percentByIndex = [15, 35, 60, 82, 100];

  return {
    steps,
    percent: percentByIndex[currentIndex],
    isException: false,
    exceptionLabel: null,
  };
}

export function formatDeliveryStatusLabel(status: DeliveryStatus): string {
  switch (status) {
    case 'pending_dispatch':
      return 'Finding Rider';
    case 'assigned':
      return 'Rider Offered';
    case 'accepted':
      return 'Rider Accepted';
    case 'heading_to_pickup':
      return 'Heading to Pickup';
    case 'parcel_picked_up':
      return 'Parcel Picked Up';
    case 'in_transit':
      return 'In Transit';
    case 'arrived_at_destination':
      return 'Arrived at Destination';
    case 'delivered':
      return 'Delivered';
    case 'cancelled':
      return 'Cancelled';
    case 'no_rider_available':
      return 'Awaiting Rider';
    default:
      return String(status).replace(/_/g, ' ');
  }
}
