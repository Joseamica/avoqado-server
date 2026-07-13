/**
 * Zod schemas del feature PRINT_STATIONS (impresoras, estaciones y ruteo de comandas).
 *
 * Reglas del repo: mensajes SIEMPRE en español; shape/formato aquí, reglas de
 * negocio en el service. Feature GRATIS/core — sin gating de tier.
 */
import { z } from 'zod'

// v1: el service solo acepta NETWORK como impresora ruteable (spec v3 — "rechazar
// rutas no servibles"). El enum completo queda para post-v1 (BT/USB/interna).
const CONNECTION_TYPES = ['NETWORK', 'BLUETOOTH', 'USB_SPOOLER', 'TERMINAL_INTERNAL'] as const

const paperWidth = z.union([z.literal(58), z.literal(80)], { message: 'Ancho de papel inválido (58 o 80 mm)' })

// ── Printers ────────────────────────────────────────────────────────
export const createPrinterSchema = z.object({
  body: z
    .object({
      name: z.string().min(1, 'El nombre de la impresora es requerido').max(80, 'Máximo 80 caracteres'),
      connectionType: z.enum(CONNECTION_TYPES, { message: 'Tipo de conexión inválido' }).optional(),
      address: z.string().min(1, 'La dirección es requerida').max(120, 'Máximo 120 caracteres').optional(),
      stableKey: z.string().max(120, 'Máximo 120 caracteres').optional(),
      paperWidthMm: paperWidth.optional(),
      charset: z.string().min(1).max(20, 'Máximo 20 caracteres').optional(),
    })
    .strict(),
  params: z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough(),
  query: z.object({}).passthrough().optional(),
})

export const updatePrinterSchema = z.object({
  body: z
    .object({
      name: z.string().min(1, 'El nombre no puede estar vacío').max(80, 'Máximo 80 caracteres').optional(),
      connectionType: z.enum(CONNECTION_TYPES, { message: 'Tipo de conexión inválido' }).optional(),
      address: z.string().max(120, 'Máximo 120 caracteres').nullable().optional(),
      stableKey: z.string().max(120, 'Máximo 120 caracteres').nullable().optional(),
      paperWidthMm: paperWidth.optional(),
      charset: z.string().min(1).max(20, 'Máximo 20 caracteres').optional(),
      active: z.boolean().optional(),
    })
    .strict()
    .refine(b => Object.keys(b).length > 0, { message: 'Envía al menos un campo a actualizar' }),
  params: z
    .object({ venueId: z.string().min(1, 'El venue es requerido'), printerId: z.string().min(1, 'La impresora es requerida') })
    .passthrough(),
  query: z.object({}).passthrough().optional(),
})

// ── Print stations ──────────────────────────────────────────────────
export const createStationSchema = z.object({
  body: z
    .object({
      name: z.string().min(1, 'El nombre de la estación es requerido').max(60, 'Máximo 60 caracteres'),
      printerId: z.string().min(1).nullable().optional(),
      copies: z
        .number({ message: 'Copias inválidas' })
        .int('Las copias deben ser un entero')
        .min(1, 'Mínimo 1 copia')
        .max(5, 'Máximo 5 copias')
        .optional(),
      isDefault: z.boolean().optional(),
      displayOrder: z.number().int().min(0).optional(),
    })
    .strict(),
  params: z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough(),
  query: z.object({}).passthrough().optional(),
})

export const updateStationSchema = z.object({
  body: z
    .object({
      name: z.string().min(1, 'El nombre no puede estar vacío').max(60, 'Máximo 60 caracteres').optional(),
      printerId: z.string().min(1).nullable().optional(),
      copies: z
        .number({ message: 'Copias inválidas' })
        .int('Las copias deben ser un entero')
        .min(1, 'Mínimo 1 copia')
        .max(5, 'Máximo 5 copias')
        .optional(),
      isDefault: z.boolean().optional(),
      displayOrder: z.number().int().min(0).optional(),
      active: z.boolean().optional(),
    })
    .strict()
    .refine(b => Object.keys(b).length > 0, { message: 'Envía al menos un campo a actualizar' }),
  params: z
    .object({ venueId: z.string().min(1, 'El venue es requerido'), stationId: z.string().min(1, 'La estación es requerida') })
    .passthrough(),
  query: z.object({}).passthrough().optional(),
})

// ── Gateway (the LAN print broker device) ───────────────────────────
export const upsertGatewaySchema = z.object({
  body: z
    .object({
      terminalId: z.string().min(1, 'El dispositivo (gateway) es requerido').max(120, 'Máximo 120 caracteres'),
      address: z.string().max(120, 'Máximo 120 caracteres').nullable().optional(),
      active: z.boolean().optional(),
    })
    .strict(),
  params: z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough(),
  query: z.object({}).passthrough().optional(),
})

// ── Routing assignment (bulk category/product → station) ────────────
const assignmentEntry = z
  .object({
    id: z.string().min(1, 'Identificador requerido'),
    // null = quitar la ruta explícita (cae a la cascada / default del venue)
    printStationId: z.string().min(1).nullable(),
  })
  .strict()

export const assignRoutingSchema = z.object({
  body: z
    .object({
      categories: z.array(assignmentEntry).max(500, 'Máximo 500 categorías por lote').optional(),
      products: z.array(assignmentEntry).max(2000, 'Máximo 2000 productos por lote').optional(),
    })
    .strict()
    .refine(b => (b.categories?.length ?? 0) > 0 || (b.products?.length ?? 0) > 0, {
      message: 'Envía al menos una asignación (categorías o productos)',
    }),
  params: z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough(),
  query: z.object({}).passthrough().optional(),
})

// ── Routing simulator (preview) ─────────────────────────────────────
export const previewRoutingSchema = z.object({
  body: z
    .object({
      items: z
        .array(
          z
            .object({
              productId: z.string().min(1, 'Producto requerido'),
              quantity: z
                .number({ message: 'Cantidad inválida' })
                .int('La cantidad debe ser un entero')
                .min(1, 'Mínimo 1')
                .max(999, 'Máximo 999'),
            })
            .strict(),
        )
        .min(1, 'Agrega al menos un producto')
        .max(100, 'Máximo 100 productos en la simulación'),
    })
    .strict(),
  params: z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough(),
  query: z.object({}).passthrough().optional(),
})

// ── Param-only schemas ──────────────────────────────────────────────
export const venueParamSchema = z.object({
  params: z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough(),
})
export const printerParamSchema = z.object({
  params: z
    .object({ venueId: z.string().min(1, 'El venue es requerido'), printerId: z.string().min(1, 'La impresora es requerida') })
    .passthrough(),
})
export const stationParamSchema = z.object({
  params: z
    .object({ venueId: z.string().min(1, 'El venue es requerido'), stationId: z.string().min(1, 'La estación es requerida') })
    .passthrough(),
})

export type CreatePrinterInput = z.infer<typeof createPrinterSchema>['body']
export type UpdatePrinterInput = z.infer<typeof updatePrinterSchema>['body']
export type CreateStationInput = z.infer<typeof createStationSchema>['body']
export type UpdateStationInput = z.infer<typeof updateStationSchema>['body']
export type UpsertGatewayInput = z.infer<typeof upsertGatewaySchema>['body']
export type AssignRoutingInput = z.infer<typeof assignRoutingSchema>['body']
export type PreviewRoutingInput = z.infer<typeof previewRoutingSchema>['body']
