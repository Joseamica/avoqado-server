import { z } from 'zod'

// Standardized Receipt Data Snapshot Schema
export const ReceiptDataSnapshotSchema = z.object({
  payment: z.object({
    id: z.string(),
    amount: z.number(),
    tipAmount: z.number(),
    totalAmount: z.number(), // amount + tipAmount for consistency
    method: z.string(),
    status: z.string(),
    createdAt: z.string(),
    cardBrand: z.string().optional(),
    maskedPan: z.string().optional(),
    entryMode: z.string().optional(),
    authorizationNumber: z.string().optional(),
    referenceNumber: z.string().optional(),
    splitType: z.string().optional(),
  }),
  venue: z.object({
    id: z.string(),
    name: z.string(),
    address: z.string(),
    city: z.string(),
    state: z.string(),
    zipCode: z.string().optional(),
    phone: z.string(),
    email: z.string().optional(),
    logo: z.string().optional(),
    primaryColor: z.string().optional(),
    currency: z.string().default('MXN'),
  }),
  order: z.object({
    id: z.string(),
    number: z.union([z.string(), z.number()]), // Handle both string and number
    items: z.array(
      z.object({
        name: z.string(),
        quantity: z.number(),
        price: z.number(),
        totalPrice: z.number(),
        modifiers: z
          .array(
            z.object({
              name: z.string(),
              price: z.number(),
            }),
          )
          .default([]),
      }),
    ),
    subtotal: z.number(),
    taxAmount: z.number(), // Standardized to taxAmount (not tax)
    total: z.number(),
    createdAt: z.string(),
    type: z.string().optional(),
    source: z.string().optional(),
    table: z
      .object({
        number: z.string(),
        area: z.string().optional(),
      })
      .optional(),
  }),
  processedBy: z
    .object({
      name: z.string(),
    })
    .optional(),
  customer: z
    .object({
      name: z.string(),
      email: z.string().optional(),
    })
    .optional(),
})

export type ReceiptDataSnapshot = z.infer<typeof ReceiptDataSnapshotSchema>

// Email receipt request schema
export const SendReceiptEmailSchema = z.object({
  recipientEmail: z.string().email(),
})

export type SendReceiptEmailRequest = z.infer<typeof SendReceiptEmailSchema>

// Receipt query schemas
export const ReceiptParamsSchema = z.object({
  receiptId: z.string().cuid(),
})

export const AccessKeyParamsSchema = z.object({
  accessKey: z.string(),
})

export type ReceiptParams = z.infer<typeof ReceiptParamsSchema>
export type AccessKeyParams = z.infer<typeof AccessKeyParamsSchema>
