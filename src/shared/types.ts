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

export type PaymentMethodCode = 'wallet' | 'flutterwave' | 'cash' | 'bank_transfer';

export type DeliveryPaymentStatus =
  | 'unpaid'
  | 'pending'
  | 'pending_verification'
  | 'collected_by_rider'
  | 'paid'
  | 'failed'
  | 'refunded'
  | 'reversed';

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
  paymentMethod: PaymentMethodCode;
  paymentStatus: DeliveryPaymentStatus;
  paymentReference: string | null;
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
  assignedRiderRating?: number | null;
  riderRating?: number | null;
  riderRatingComment?: string | null;
  ratedAt?: string | null;
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
  paymentMethod?: PaymentMethodCode;
  status: 'pending' | 'settled' | 'refunded';
  createdAt: string;
}

export interface WalletAccount {
  id: string;
  userId: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  balanceNgn: number;
  lockedBalanceNgn: number;
  currency: string;
  status: 'active' | 'frozen' | 'closed';
  createdAt: string;
  updatedAt: string;
}

export type WalletTransactionType = 'credit' | 'debit' | 'refund' | 'adjustment';
export type WalletTransactionCategory = 'funding' | 'delivery_payment' | 'refund' | 'admin_adjustment' | 'reversal';
export type WalletTransactionStatus = 'pending' | 'completed' | 'failed' | 'reversed';

export interface WalletTransaction {
  id: string;
  walletId: string;
  userId: string;
  type: WalletTransactionType;
  category: WalletTransactionCategory;
  amountNgn: number;
  balanceBeforeNgn: number;
  balanceAfterNgn: number;
  currency: string;
  reference: string;
  idempotencyKey: string | null;
  deliveryId: string | null;
  trackingCode?: string | null;
  paymentTransactionId: string | null;
  status: WalletTransactionStatus;
  description: string;
  actorUserId: string | null;
  actorRole: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type PaymentPurpose = 'wallet_funding' | 'delivery_payment';

export interface PaymentTransaction {
  id: string;
  reference: string;
  idempotencyKey: string | null;
  providerTxId: string | null;
  providerTxRef: string | null;
  userId: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  walletId: string | null;
  deliveryId: string | null;
  trackingCode: string | null;
  purpose: PaymentPurpose;
  paymentMethod: PaymentMethodCode;
  provider: 'internal' | 'flutterwave' | 'cash' | 'bank_transfer';
  amountNgn: number;
  feeNgn: number;
  currency: string;
  status: DeliveryPaymentStatus;
  checkoutUrl: string | null;
  transferReference: string | null;
  transferProofNote: string | null;
  failureReason: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentMethodConfig {
  code: PaymentMethodCode;
  name: string;
  description: string;
  isEnabled: boolean;
  sortOrder: number;
}

export interface PaymentGatewayPublicConfig {
  provider: 'flutterwave';
  configured: boolean;
  isEnabled: boolean;
  mode: 'test' | 'live';
  publicKey: string;
  bankDetails: {
    bankName: string;
    accountName: string;
    accountNumber: string;
    instructions: string;
  };
  methods: PaymentMethodConfig[];
}

export interface PaymentGatewayAdminView {
  provider: 'flutterwave';
  publicKey: string;
  secretKeyMasked: string;
  encryptionKeyMasked: string;
  webhookSecretHashMasked: string;
  hasSecretKey: boolean;
  hasEncryptionKey: boolean;
  hasWebhookSecretHash: boolean;
  webhookUrl: string;
  mode: 'test' | 'live';
  isEnabled: boolean;
  configured: boolean;
  bankName: string;
  bankAccountName: string;
  bankAccountNumber: string;
  bankInstructions: string;
  methods: PaymentMethodConfig[];
  updatedBy: string | null;
  updatedAt: string;
}

export interface CashCollectionRecord {
  id: string;
  deliveryId: string;
  trackingCode: string;
  paymentTransactionId: string | null;
  customerId: string;
  customerName?: string;
  customerPhone?: string;
  riderId: string | null;
  riderName?: string | null;
  paymentMethod: 'cash' | 'bank_transfer';
  expectedAmountNgn: number;
  collectedAmountNgn: number;
  status: 'pending' | 'pending_verification' | 'collected_by_rider' | 'reconciled' | 'disputed';
  transferReference: string | null;
  transferProofNote: string | null;
  riderConfirmedAt: string | null;
  reconciledBy: string | null;
  reconciledAt: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface RefundRecord {
  id: string;
  reference: string;
  paymentTransactionId: string | null;
  paymentReference?: string | null;
  deliveryId: string | null;
  trackingCode?: string | null;
  userId: string;
  customerName?: string;
  amountNgn: number;
  destination: 'wallet' | 'flutterwave' | 'manual';
  reason: string;
  status: 'pending' | 'completed' | 'failed';
  providerRefundId: string | null;
  initiatedBy: string;
  processedAt: string | null;
  createdAt: string;
}

export interface PaymentWebhookEventRecord {
  id: string;
  provider: string;
  eventType: string;
  eventId: string | null;
  txRef: string | null;
  flwTxId: string | null;
  idempotencyKey: string;
  signatureValid: boolean;
  status: 'received' | 'processed' | 'ignored' | 'failed';
  processingError: string | null;
  receivedAt: string;
  processedAt: string | null;
}

export interface AdminPaymentsOverview {
  metrics: {
    totalWalletBalancesNgn: number;
    totalWalletFundingNgn: number;
    totalDeliveryPaymentsNgn: number;
    totalCashCollectionsNgn: number;
    totalBankTransfersNgn: number;
    pendingTransactionsCount: number;
    pendingTransactionsAmountNgn: number;
    failedTransactionsCount: number;
    refundsCount: number;
    refundsTotalNgn: number;
  };
  transactions: {
    items: PaymentTransaction[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
  wallets: WalletAccount[];
  cashCollections: CashCollectionRecord[];
  refunds: RefundRecord[];
  webhookEvents: PaymentWebhookEventRecord[];
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
  showDeliveryStateSelectors: boolean;
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
    | 'notifications:refresh'
    | 'settings:updated'
    | 'complaint:updated'
    | 'support:presence'
    | 'support:refresh'
    | 'support:message'
    | 'support:conversation'
    | 'support:typing'
    | 'wallet:updated'
    | 'payment:updated'
    | 'cash_collection:updated'
    | 'gateway:updated';
  payload: unknown;
  timestamp: string;
}
