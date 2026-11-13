export type UserRole = 'client' | 'rider' | 'admin';

export type AccountStatus = 'active' | 'suspended';

export type VerificationStatus = 'pending' | 'verified' | 'rejected';

export type ServiceTier = 'local' | 'inter_city' | 'inter_state';

export type ParcelCategory =
  | 'Documents'
  | 'Electronics'
  | 'Fashion & Apparel'
  | 'Food & Perishables'
  | 'Medical & Fragile'
  | 'General Cargo';

export type DeliveryStatus =
  | 'pending_dispatch'
  | 'assigned'
  | 'accepted'
  | 'heading_to_pickup'
  | 'parcel_picked_up'
  | 'in_transit'
  | 'arrived_at_destination'
  | 'delivered'
  | 'cancelled'
  | 'no_rider_available';

export type AssignmentStatus = 'offered' | 'accepted' | 'rejected' | 'timed_out' | 'reassigned';

export interface Profile {
  id: string;
  email: string;
  fullName: string;
  phone: string;
  role: UserRole;
  accountStatus: AccountStatus;
  createdAt: string;
}

export interface RiderProfile extends Profile {
  riderId: string;
  vehicleType: 'Motorcycle' | 'Van' | 'Inter-State Sprinter';
  plateNumber: string;
  homeState: string;
  verificationStatus: VerificationStatus;
  isOnline: boolean;
  currentLat: number;
  currentLng: number;
  lastLocationAt: string;
  activeParcelsCount: number;
  completedDeliveriesCount: number;
  totalEarningsNgn: number;
  rating: number;
}

export interface CustomerSummary extends Profile {
  customerId: string;
  defaultState: string;
  totalRequests: number;
  completedRequests: number;
}

export interface DeliveryRequest {
  id: string;
  trackingCode: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  pickupState: string;
  pickupAddress: string;
  pickupLat: number;
  pickupLng: number;
  destinationState: string;
  destinationAddress: string;
  destinationLat: number;
  destinationLng: number;
  recipientName: string;
  recipientPhone: string;
  parcelCategory: ParcelCategory;
  parcelDescription: string;
  weightKg: number;
  serviceTier: ServiceTier;
  distanceKm: number;
  estimatedMinutes: number;
  deliveryFeeNgn: number;
  deliveryOtp: string;
  otpVerified: boolean;
  status: DeliveryStatus;
  assignedRiderId: string | null;
  assignedRiderName: string | null;
  assignedRiderPhone: string | null;
  assignedRiderVehicle: string | null;
  assignedRiderVerified?: boolean;
  assignedRiderLat: number | null;
  assignedRiderLng: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryAssignment {
  id: string;
  deliveryId: string;
  trackingCode: string;
  riderId: string;
  riderName: string;
  status: AssignmentStatus;
  score: number;
  distanceToPickupKm: number;
  routeCompatibilityScore: number;
  offeredAt: string;
  expiresAt: string;
  respondedAt: string | null;
  delivery?: DeliveryRequest;
}

export interface DeliveryStatusHistoryItem {
  id: string;
  deliveryId: string;
  status: DeliveryStatus;
  note: string;
  actorRole: UserRole | 'system';
  createdAt: string;
}

export interface PaymentRecord {
  id: string;
  deliveryId: string;
  trackingCode: string;
  customerName: string;
  amountNgn: number;
  riderPayoutNgn: number;
  platformFeeNgn: number;
  status: 'pending' | 'settled' | 'refunded';
  createdAt: string;
}

export interface NotificationItem {
  id: string;
  userId: string;
  title: string;
  message: string;
  deliveryId: string | null;
  isRead: boolean;
  createdAt: string;
}

export type TicketType = 'complaint' | 'suggestion';

export interface ComplaintRecord {
  id: string;
  ticketType: TicketType;
  deliveryId: string | null;
  trackingCode: string | null;
  reporterId: string;
  reporterName: string;
  reporterEmail?: string;
  reporterPhone?: string;
  subject: string;
  details: string;
  status: 'open' | 'investigating' | 'resolved';
  resolutionNote: string | null;
  createdAt: string;
}

export interface PlatformSettings {
  maxActiveParcelsPerRider: number;
  searchRadiusKm: number;
  offerTimeoutSeconds: number;
  baseLocalFeeNgn: number;
  perKmRateNgn: number;
  interStateSurchargeNgn: number;
  riderCommissionPercent: number;
  whatsappSupportNumber: string;
}

export interface PriceQuote {
  serviceTier: ServiceTier;
  distanceKm: number;
  estimatedMinutes: number;
  deliveryFeeNgn: number;
  targetLabel: string;
}

export type SupportConversationStatus = 'open' | 'pending' | 'resolved' | 'closed';

export type SupportSenderRole = 'visitor' | 'client' | 'admin' | 'system';

export interface SupportConversation {
  id: string;
  visitorToken: string;
  userId: string | null;
  visitorName: string;
  visitorEmail: string | null;
  visitorPhone: string | null;
  trackingCode: string | null;
  status: SupportConversationStatus;
  assignedAdminId: string | null;
  unreadByAdmin: number;
  unreadByVisitor: number;
  lastMessagePreview: string | null;
  lastMessageAt: string;
  createdAt: string;
}

export interface SupportMessage {
  id: string;
  conversationId: string;
  senderRole: SupportSenderRole;
  senderName: string;
  body: string;
  createdAt: string;
}

export interface SupportPresence {
  adminOnline: boolean;
  onlineAdminCount: number;
}

export interface LiveWsEvent {
  type:
    | 'connected'
    | 'delivery:created'
    | 'delivery:updated'
    | 'assignment:offered'
    | 'assignment:updated'
    | 'rider:location'
    | 'rider:availability'
    | 'notification:created'
    | 'settings:updated'
    | 'complaint:updated'
    | 'support:presence'
    | 'support:message'
    | 'support:conversation'
    | 'support:typing';
  payload: unknown;
  timestamp: string;
}
