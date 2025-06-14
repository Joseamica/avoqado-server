import { Order, OriginSystem, StaffRole } from '@prisma/client';

// Payloads from POS systems

export interface PosOrderPayload {
  externalId: string;
  venueId: string; // The Avoqado ID of the Venue
  orderNumber: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  createdAt: string;
  posRawData: any;
  discountAmount: number;
  tipAmount: number;
}

export interface PosStaffPayload {
  externalId: string | null;
  name: string | null;
  pin: string | null;
}

export interface PosTablePayload {
  externalId: string | null;
}

export interface PosShiftPayload {
  externalId: string | null;
  startTime?: string | null;
}

export interface PosOrderData {
  externalId: string;
  orderNumber: string;
  status: Order['status'];
  paymentStatus: Order['paymentStatus'];
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  tipAmount: number;
  total: number;
  createdAt: string;
  completedAt: string | null;
  posRawData: any;
}

export interface PosAreaData {
  externalId: string;
  name: string;
  posRawData: any;
}

/**
 * Represents a comprehensive payload from the POS, typically for an order event,
 * containing nested data for related entities like staff, table, and shift.
 */
export interface RichPosPayload {
  venueId: string; // This is the Avoqado Venue ID, not the one from the POS
  orderData: PosOrderData;
  staffData: PosStaffPayload;
  tableData: PosTablePayload;
  shiftData: PosShiftPayload;
}
