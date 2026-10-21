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
  iccid: z.string({ required_error: 'Falta el ID SIM' }).min(5, 'El ICCID es requerido'),
  /** "ID Promotor" (employeeCode). May arrive empty → resolver falls back to promoterName. */
  promoterCode: z.string().optional(),
  /** Promoter's full name, used as a fallback when promoterCode is empty. */
  promoterName: z.string().optional(),
  /** "ID Tienda" — numeric id embedded in the store name, e.g. "(898)". */
  storeId: z.string().optional(),
  /** "Nombre de la Tienda" */
  storeName: z.string({ required_error: 'Falta el nombre de la tienda' }).min(1, 'Falta el nombre de la tienda'),
  /** "Fecha" — venue-local calendar day, AAAA-MM-DD. */
  saleDate: z.string({ required_error: 'Falta la fecha' }).regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (usa AAAA-MM-DD)'),
  /** "Tipo de Venta" — e.g. "Línea nueva" | "Portabilidad". */
  saleType: z.string({ required_error: 'Falta el tipo de venta' }).min(1, 'Falta el tipo de venta'),
  /**
   * "Forma de Pago" — e.g. "Efectivo" | "Tarjeta" | "No aplica". Optional: the sheet
   * routinely leaves this blank for free SIM swaps, and a single blank cell must not
   * fail the whole upload. A blank/missing value is treated as "No aplica" (no money
   * changed hands) by `mapPaymentForm`.
   */
  paymentForm: z.string().optional(),
  /** "Monto de Venta" — a number, a numeric string, or the literal "No aplica". */
  amount: z.union([z.number(), z.string()], { errorMap: () => ({ message: 'Falta el monto de venta' }) }),
  /** "Tipo de SIM" / "Categoría" — optional; falls back to the item's existing category. */
  simType: z.string().optional(),
  /**
   * "Estatus de Venta" — "Aprobada" | "Rechazada". Opcional a propósito: los archivos
   * que el operador ya venía subiendo no traen la columna, y una columna ausente o
   * vacía significa "Aprobada". El valor se INTERPRETA en `mapSaleStatus`
   * (`manualSale.resolvers.ts`), no aquí — Zod valida forma, nunca reglas de negocio.
   */
  saleStatus: z.string().optional(),
  /**
   * "Motivo de Rechazo" — texto libre del operador ("no se pudo vincular; el cliente
   * ya se lo llevó"). Solo se guarda cuando la venta viene rechazada; en una venta
   * aprobada se ignora.
   */
  rejectionNote: z.string().optional(),
})

/**
 * Bulk payload: the parsed sheet rows, plus an optional two-step confirm flag.
 *
 * Sólo FORMA del lote: cada fila se valida con `manualSaleRowSchema` dentro de
 * `bulkManualSales`, y una fila inválida cae en `error` con su motivo. Validarlas aquí
 * hacía que UNA celda vacía devolviera 400 y tumbara el archivo entero (Isaac, 8-oct-2026:
 * 237 ventas rechazadas por un «Nombre de la Tienda» vacío).
 */
export const bulkManualSalesSchema = z.object({
  rows: z
    .array(z.record(z.string(), z.unknown(), { invalid_type_error: 'Cada venta debe ser una fila' }))
    .min(1, 'Sube al menos una venta'),
  confirm: z.boolean().optional(),
})

export type ManualSaleRowInput = z.infer<typeof manualSaleRowSchema>
export type BulkManualSalesInput = z.infer<typeof bulkManualSalesSchema>
