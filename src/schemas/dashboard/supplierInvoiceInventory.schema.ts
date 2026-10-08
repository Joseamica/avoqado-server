import { Unit } from '@prisma/client'
import { z } from 'zod'

export const invoiceInventoryConfirmation = z.object({
  confirmationToken: z.string().regex(/^[a-f0-9]{64}$/, 'Revisa la compra antes de confirmar.'),
  includeIeps: z.boolean().optional(),
})
export const invoiceLineIdentification = z
  .object({
    rawMaterialId: z.string().min(1, 'Selecciona un insumo.').nullable().optional(),
    productId: z.string().min(1, 'Selecciona un producto.').nullable().optional(),
    purchaseUnit: z
      .nativeEnum(Unit, { errorMap: () => ({ message: 'Selecciona una unidad de compra válida.' }) })
      .nullable()
      .optional(),
    presentationName: z.string().trim().min(1, 'Selecciona una presentación.').max(100).nullable().optional(),
  })
  .strict()
export const invoiceInventoryPage = z.object({
  page: z.coerce.number().int().min(1, 'Página inválida.').max(100000).default(1),
  limit: z.coerce
    .number()
    .int()
    .positive('Límite inválido.')
    .default(20)
    .transform(n => Math.min(n, 100)),
  search: z.string().trim().max(200).optional(),
})

export const SupplierInvoiceInboxSchema = z.object({ query: invoiceInventoryPage })
export const SupplierInvoiceCatalogSchema = z.object({
  query: invoiceInventoryPage.extend({ kind: z.enum(['RAW', 'PRODUCT'], { errorMap: () => ({ message: 'Elige insumo o producto.' }) }) }),
})
export const SupplierInvoiceConfirmationSchema = z.object({ body: invoiceInventoryConfirmation })
export const SupplierInvoiceIdentificationSchema = z.object({ body: invoiceLineIdentification })
