import { z } from 'zod'

/**
 * Bulk upload of SIM sales made outside the TPV ("Subir ventas fuera de TPV").
 *
 * These schemas validate the RAW row values as they arrive from the operator's
 * Excel/CSV sheet — ICCID, promoter, store, etc. are still opaque strings here.
 * Resolution against real records (SerializedItem, Staff, Venue, ItemCategory)
 * happens later in the resolver layer (`manualSale.resolvers.ts`), not in Zod.
 */

/** One row from the sheet ("ID SIM", "ID Promotor", "Nombre de la Tienda", ...). */
export const manualSaleRowSchema = z.object({
  /** "ID SIM" — the ICCID printed/encoded on the SIM. */
  iccid: z.string().min(5, 'El ICCID es requerido'),
  /** "ID Promotor" (employeeCode). May arrive empty → resolver falls back to promoterName. */
  promoterCode: z.string().optional(),
  /** Promoter's full name, used as a fallback when promoterCode is empty. */
  promoterName: z.string().optional(),
  /** "ID Tienda" — numeric id embedded in the store name, e.g. "(898)". */
  storeId: z.string().optional(),
  /** "Nombre de la Tienda" */
  storeName: z.string().min(1, 'El nombre de la tienda es requerido'),
  /** "Fecha" — venue-local calendar day, AAAA-MM-DD. */
  saleDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (usa AAAA-MM-DD)'),
  /** "Tipo de Venta" — e.g. "Línea nueva" | "Portabilidad". */
  saleType: z.string().min(1, 'El tipo de venta es requerido'),
  /** "Forma de Pago" — e.g. "Efectivo" | "Tarjeta" | "No aplica". */
  paymentForm: z.string().min(1, 'La forma de pago es requerida'),
  /** "Monto de Venta" — a number, a numeric string, or the literal "No aplica". */
  amount: z.union([z.number(), z.string()]),
  /** "Tipo de SIM" / "Categoría" — optional; falls back to the item's existing category. */
  simType: z.string().optional(),
})

/** Bulk payload: the parsed sheet rows, plus an optional two-step confirm flag. */
export const bulkManualSalesSchema = z.object({
  rows: z.array(manualSaleRowSchema).min(1, 'Sube al menos una venta'),
  confirm: z.boolean().optional(),
})

export type ManualSaleRowInput = z.infer<typeof manualSaleRowSchema>
export type BulkManualSalesInput = z.infer<typeof bulkManualSalesSchema>
