import { z } from 'zod'

const venueParams = z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough()
const emptyQuery = z.object({}).passthrough().optional()

const AREA_MODES = ['IMMEDIATE', 'HOLD_UNTIL_PAID', 'PREPARE_ON_PAID'] as const
const EXPIRY_POLICIES = ['BUSINESS_DAY_CLOSE', 'FIXED_DURATION'] as const
const DELIVERY_MODES = ['PAPER_CONFIRMATION', 'RECEIPT_SCAN', 'PAPER_OR_SCAN'] as const
const RESERVATION_MODES = ['NONE', 'HOLD_AVAILABLE_STOCK'] as const
const WORKSPACES = ['STANDARD_POS', 'AREA_OPERATIONS'] as const
const SCALE_CONTEXTS = ['AREA_TICKET_LINE', 'INVENTORY_RECEIPT', 'INVENTORY_TRANSFER_DISPATCH', 'STOCK_COUNT', 'STOCK_ADJUSTMENT'] as const
const SCALE_TRANSPORTS = ['ANDROID_USB_SERIAL', 'DESKTOP_BRIDGE', 'MANUAL'] as const
const SCALE_UNITS = ['GRAM', 'KILOGRAM', 'POUND', 'OUNCE'] as const

export const areaTicketOverviewSchema = z.object({
  params: venueParams,
  query: emptyQuery,
})

export const updateAreaTicketSettingsSchema = z.object({
  params: venueParams,
  query: emptyQuery,
  body: z
    .object({
      enabled: z.boolean().optional(),
      allowMixedCart: z.boolean().optional(),
      claimTtlSeconds: z.number().int().min(30).max(1800).optional(),
      checkoutSessionMaxAgeMinutes: z.number().int().min(5).max(240).optional(),
      ticketExpiryPolicy: z.enum(EXPIRY_POLICIES).optional(),
      ticketExpiryMinutes: z.number().int().min(5).max(10080).nullable().optional(),
      deliveryVerificationMode: z.enum(DELIVERY_MODES).optional(),
      requireManagerForCancel: z.boolean().optional(),
      recordWasteOnCancel: z.boolean().optional(),
      inventoryReservationMode: z.enum(RESERVATION_MODES).optional(),
    })
    .strict()
    .refine(body => Object.keys(body).length > 0, 'Envía al menos un campo a actualizar'),
})

const areaBody = z
  .object({
    name: z.string().trim().min(1, 'El nombre del área es requerido').max(80, 'Máximo 80 caracteres').optional(),
    fulfillmentMode: z.enum(AREA_MODES).optional(),
    printStationId: z.string().min(1).nullable().optional(),
    active: z.boolean().optional(),
    displayOrder: z.number().int().min(0).max(10000).optional(),
  })
  .strict()

export const createFulfillmentAreaSchema = z.object({
  params: venueParams,
  query: emptyQuery,
  body: areaBody.extend({
    name: z.string().trim().min(1, 'El nombre del área es requerido').max(80, 'Máximo 80 caracteres'),
  }),
})

export const updateFulfillmentAreaSchema = z.object({
  params: venueParams.extend({ areaId: z.string().min(1, 'El área es requerida') }),
  query: emptyQuery,
  body: areaBody.refine(body => Object.keys(body).length > 0, 'Envía al menos un campo a actualizar'),
})

export const updateAreaTicketTerminalSchema = z.object({
  params: venueParams.extend({ terminalId: z.string().min(1, 'La terminal es requerida') }),
  query: emptyQuery,
  body: z
    .object({
      fulfillmentAreaId: z.string().min(1).nullable().optional(),
      canIssueAreaTickets: z.boolean().optional(),
      canCheckoutAreaTickets: z.boolean().optional(),
      canDeliverAreaTickets: z.boolean().optional(),
      defaultWorkspace: z.enum(WORKSPACES).optional(),
      scaleProfileId: z.string().min(1).nullable().optional(),
    })
    .strict()
    .refine(body => Object.keys(body).length > 0, 'Envía al menos un campo a actualizar'),
})

export const updateScaleSettingsSchema = z.object({
  params: venueParams,
  query: emptyQuery,
  body: z
    .object({
      enabled: z.boolean().optional(),
      variableBarcodeEnabled: z.boolean().optional(),
      variableBarcodePrefix: z.string().regex(/^\d{2}$/, 'El prefijo debe contener exactamente 2 dígitos.').optional(),
    })
    .strict()
    .refine(body => Object.keys(body).length > 0, 'Envía al menos un campo a actualizar'),
})

const scaleProfileBody = z
  .object({
    name: z.string().trim().min(1, 'El nombre de la báscula es requerido').max(80).optional(),
    location: z.string().trim().min(1, 'La ubicación es requerida').max(80).optional(),
    model: z.string().trim().min(1, 'El modelo es requerido').max(120).optional(),
    allowedContexts: z.array(z.enum(SCALE_CONTEXTS)).min(1).max(SCALE_CONTEXTS.length).optional(),
    transport: z.enum(SCALE_TRANSPORTS).optional(),
    vendorId: z.number().int().min(0).max(65535).nullable().optional(),
    productId: z.number().int().min(0).max(65535).nullable().optional(),
    baudRate: z.number().int().min(300).max(3000000).nullable().optional(),
    dataBits: z.number().int().min(5).max(8).nullable().optional(),
    parity: z.enum(['NONE', 'EVEN', 'ODD']).nullable().optional(),
    stopBits: z.number().int().min(1).max(2).nullable().optional(),
    frameParser: z.record(z.string(), z.unknown()).nullable().optional(),
    stableIndicator: z.string().max(40).nullable().optional(),
    unit: z.enum(SCALE_UNITS).optional(),
    active: z.boolean().optional(),
  })
  .strict()

export const createScaleProfileSchema = z.object({
  params: venueParams,
  query: emptyQuery,
  body: scaleProfileBody.extend({
    name: z.string().trim().min(1, 'El nombre de la báscula es requerido').max(80),
    location: z.string().trim().min(1, 'La ubicación es requerida').max(80),
    model: z.string().trim().min(1, 'El modelo es requerido').max(120),
    allowedContexts: z.array(z.enum(SCALE_CONTEXTS)).min(1).max(SCALE_CONTEXTS.length),
  }),
})

export const updateScaleProfileSchema = z.object({
  params: venueParams.extend({ profileId: z.string().min(1, 'La báscula es requerida') }),
  query: emptyQuery,
  body: scaleProfileBody.refine(body => Object.keys(body).length > 0, 'Envía al menos un campo a actualizar'),
})

export type UpdateAreaTicketSettingsInput = z.infer<typeof updateAreaTicketSettingsSchema>['body']
export type CreateFulfillmentAreaInput = z.infer<typeof createFulfillmentAreaSchema>['body']
export type UpdateFulfillmentAreaInput = z.infer<typeof updateFulfillmentAreaSchema>['body']
export type UpdateAreaTicketTerminalInput = z.infer<typeof updateAreaTicketTerminalSchema>['body']
export type UpdateScaleSettingsInput = z.infer<typeof updateScaleSettingsSchema>['body']
export type CreateScaleProfileInput = z.infer<typeof createScaleProfileSchema>['body']
export type UpdateScaleProfileInput = z.infer<typeof updateScaleProfileSchema>['body']
