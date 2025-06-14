import { z } from 'zod';

export const posOrderPayloadSchema = z.object({
  externalId: z.string().min(1, 'External ID is required'),
  venueId: z.string().cuid('Invalid Venue ID format'),
  orderNumber: z.string().min(1, 'Order number is required'),
  subtotal: z.number().positive('Subtotal must be a positive number'),
  taxAmount: z.number().min(0, 'Tax amount cannot be negative'),
  total: z.number().positive('Total must be a positive number'),
  createdAt: z.string().datetime('Invalid date format for createdAt'),
  posRawData: z.any(),
  discountAmount: z.number().min(0, 'Discount amount cannot be negative'),
  tipAmount: z.number().min(0, 'Tip amount cannot be negative'),
});
