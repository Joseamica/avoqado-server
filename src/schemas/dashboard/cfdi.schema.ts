/**
 * CFDI Dashboard Schemas
 *
 * Request validation schemas for facturación CFDI 4.0 endpoints.
 * Shape-only — SAT-registry validity is checked at stamp time by the service layer.
 *
 * @see src/services/fiscal/cfdi.service.ts
 * @see docs/plans/2026-06-03-facturacion-phase1-flowB-route.md
 */

import { z } from 'zod'

// ==========================================
// BODY SCHEMAS (raw, for type inference)
// ==========================================

const issueCfdiBodyShape = z.object({
  rfc: z
    .string({ required_error: 'El RFC es requerido' })
    .trim()
    .regex(/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i, 'El RFC no tiene un formato válido'),
  razonSocial: z.string({ required_error: 'La razón social es requerida' }).trim().min(1, 'La razón social es requerida'),
  regimenFiscal: z.string({ required_error: 'El régimen fiscal es requerido' }).regex(/^\d{3}$/, 'El régimen fiscal no es válido'),
  codigoPostal: z.string({ required_error: 'El código postal es requerido' }).regex(/^\d{5}$/, 'El código postal debe tener 5 dígitos'),
  usoCfdi: z.string({ required_error: 'El uso de CFDI es requerido' }).trim().min(1, 'El uso de CFDI es requerido'),
  email: z.string().email('El correo no es válido').optional(),
})

// ==========================================
// WRAPPED SCHEMAS (for validateRequest middleware)
// validateRequest reads schema.shape.body / .query / .params
// ==========================================

/** Schema passed to validateRequest() for POST /venues/:venueId/orders/:orderId/cfdi */
export const issueCfdiSchema = z.object({
  body: issueCfdiBodyShape,
})

// ==========================================
// CANCEL CFDI SCHEMA
// ==========================================

/** Schema passed to validateRequest() for POST /venues/:venueId/cfdi/:cfdiId/cancel */
export const cancelCfdiSchema = z.object({
  body: z.object({
    motivo: z.enum(['01', '02', '03', '04'], {
      required_error: 'El motivo de cancelación es requerido',
      invalid_type_error: 'El motivo de cancelación no es válido',
    }),
    // Optional — the "motivo 01 requires substituteUuid" cross-field rule lives in the SERVICE (shape-only in Zod per rules)
    substituteUuid: z.string().uuid('El UUID de sustitución no es válido').optional(),
  }),
})

// ==========================================
// FISCAL CONFIG SCHEMAS
// ==========================================

// ── Emisor upsert ──────────────────────────────────────────────────────────────

const upsertEmisorBodyShape = z.object({
  rfc: z
    .string({ required_error: 'El RFC es requerido' })
    .trim()
    .regex(/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i, 'El RFC no tiene un formato válido'),
  legalName: z.string({ required_error: 'La razón social es requerida' }).trim().min(1, 'La razón social es requerida'),
  regimenFiscal: z
    .string({ required_error: 'El régimen fiscal es requerido' })
    .regex(/^\d{3}$/, 'El régimen fiscal debe ser un código de 3 dígitos'),
  lugarExpedicion: z
    .string({ required_error: 'El lugar de expedición es requerido' })
    .regex(/^\d{5}$/, 'El lugar de expedición debe tener 5 dígitos'),
  serie: z.string().trim().optional(),
  defaultUsoCfdi: z.string().trim().optional(),
  globalPeriodicity: z
    .enum(['DIARIO', 'SEMANAL', 'QUINCENAL', 'MENSUAL', 'BIMESTRAL'], {
      invalid_type_error: 'La periodicidad global no es válida',
    })
    .optional(),
  // Opt-in: permitir facturar ventas en efectivo (QR + global). Default false en el servicio.
  invoiceCashSales: z.boolean().optional(),
  // Opt-in: que el efectivo cuente en los libros fiscales (IVA/ISR/pólizas). Default false.
  includeCashInAccounting: z.boolean().optional(),
  // Tasa de ISN (impuesto sobre nómina, estatal), fracción 0-0.10 (0.03 = 3%). Default 0.
  isnRate: z.number().min(0).max(0.1).optional(),
})

/**
 * Schema passed to validateRequest() for:
 *   POST /venues/:venueId/fiscal/emisores
 *   PUT  /venues/:venueId/fiscal/emisores/:emisorId
 */
export const upsertEmisorSchema = z.object({
  body: upsertEmisorBodyShape,
})

// ── Merchant fiscal config upsert ──────────────────────────────────────────────
// XOR (exactly one merchant FK required) is enforced in the SERVICE layer.
// Zod is shape-only per critical-warnings rule.

const upsertMerchantConfigBodyShape = z.object({
  merchantAccountId: z.string().min(1, 'El ID de la cuenta de comercio no puede estar vacío').optional(),
  ecommerceMerchantId: z.string().min(1, 'El ID del comercio e-commerce no puede estar vacío').optional(),
  fiscalEmisorId: z.string({ required_error: 'El emisor fiscal es requerido' }).min(1, 'El emisor fiscal es requerido'),
  facturacionEnabled: z.boolean({ required_error: 'El campo facturacionEnabled es requerido' }),
  autofacturaEnabled: z.boolean({ required_error: 'El campo autofacturaEnabled es requerido' }),
  includeInGlobal: z.boolean({ required_error: 'El campo includeInGlobal es requerido' }),
  // Opt-out: excluir este merchant de los libros fiscales. Default true en el servicio.
  includeInAccounting: z.boolean().optional(),
})

/**
 * Schema passed to validateRequest() for:
 *   PUT /venues/:venueId/fiscal/merchant-config
 */
export const upsertMerchantConfigSchema = z.object({
  body: upsertMerchantConfigBodyShape,
})

// ── Emisor onboarding: CSD upload ─────────────────────────────────────────────

/**
 * Schema passed to validateRequest() for:
 *   POST /venues/:venueId/fiscal/emisores/:emisorId/csd
 *
 * cer/key are base64-encoded files; password is the CSD private-key passphrase.
 * Shape-only — the files are forwarded to facturapi and never persisted by us.
 */
export const uploadCsdSchema = z.object({
  body: z.object({
    cerBase64: z.string({ required_error: 'El archivo .cer en base64 es requerido' }).min(1, 'El archivo .cer no puede estar vacío'),
    keyBase64: z.string({ required_error: 'El archivo .key en base64 es requerido' }).min(1, 'El archivo .key no puede estar vacío'),
    password: z.string({ required_error: 'La contraseña del CSD es requerida' }).min(1, 'La contraseña del CSD no puede estar vacía'),
  }),
})

// ==========================================
// LIST CFDIS SCHEMA (paginated query)
// ==========================================

/**
 * Schema passed to validateRequest() for:
 *   GET /venues/:venueId/cfdi
 *
 * All query params are optional. validateRequest() supports `schema.shape.query`
 * and assigns the parsed (coerced) values back to req.query.
 * Coercions: page/pageSize → number, isGlobal → boolean.
 */
export const listCfdisSchema = z.object({
  query: z.object({
    status: z
      .enum(['DRAFT', 'VALIDATING', 'VALIDATION_FAILED', 'STAMPING', 'STAMPED', 'STAMP_FAILED', 'CANCEL_REQUESTED', 'CANCELLED'], {
        invalid_type_error: 'El estado del CFDI no es válido',
      })
      .optional(),
    flow: z
      .enum(['STAFF_B', 'AUTOFACTURA_A', 'GLOBAL_C'], {
        invalid_type_error: 'El flujo del CFDI no es válido',
      })
      .optional(),
    isGlobal: z
      .string()
      .transform(v => v === 'true')
      .pipe(z.boolean())
      .optional(),
    receptorRfc: z.string().trim().optional(),
    from: z.string().trim().optional(),
    to: z.string().trim().optional(),
    page: z.coerce
      .number({ invalid_type_error: 'La página debe ser un número' })
      .int('La página debe ser un entero')
      .min(1, 'La página mínima es 1')
      .default(1),
    pageSize: z.coerce
      .number({ invalid_type_error: 'El tamaño de página debe ser un número' })
      .int('El tamaño de página debe ser un entero')
      .min(1, 'El tamaño de página mínimo es 1')
      .max(100, 'El tamaño de página máximo es 100')
      .default(20),
  }),
})

export type ListCfdisQuery = z.infer<typeof listCfdisSchema.shape.query>

// ==========================================
// PUBLIC AUTOFACTURA SCHEMA
// ==========================================

/**
 * Schema for POST /api/v1/public/receipt/:accessKey/cfdi
 *
 * Customer self-service autofactura (Flow A). Mirrors issueCfdiBodyShape
 * field names so the same receptor object passes to issueCfdiForOrder.
 * `email` is REQUIRED here — the customer must receive the CFDI.
 */
const autofacturaBodyShape = z.object({
  rfc: z
    .string({ required_error: 'El RFC es requerido' })
    .trim()
    .min(12, 'El RFC debe tener al menos 12 caracteres')
    .max(13, 'El RFC no puede tener más de 13 caracteres')
    .toUpperCase(),
  razonSocial: z.string({ required_error: 'La razón social es requerida' }).trim().min(1, 'La razón social es requerida'),
  regimenFiscal: z
    .string({ required_error: 'El régimen fiscal es requerido' })
    .regex(/^\d{3}$/, 'El régimen fiscal debe ser un código de 3 dígitos'),
  codigoPostal: z.string({ required_error: 'El código postal es requerido' }).regex(/^\d{5}$/, 'El código postal debe tener 5 dígitos'),
  usoCfdi: z.string({ required_error: 'El uso de CFDI es requerido' }).trim().min(1, 'El uso de CFDI es requerido'),
  email: z.string({ required_error: 'El correo es requerido' }).email('Correo inválido'),
})

/** Schema passed to validateRequest() for POST /public/receipt/:accessKey/cfdi */
export const autofacturaSchema = z.object({
  body: autofacturaBodyShape,
})

// ==========================================
// TYPE EXPORTS
// ==========================================

export type IssueCfdiBody = z.infer<typeof issueCfdiSchema.shape.body>
export type CancelCfdiBody = z.infer<typeof cancelCfdiSchema.shape.body>
export type UpsertEmisorBody = z.infer<typeof upsertEmisorSchema.shape.body>
export type UpsertMerchantConfigBody = z.infer<typeof upsertMerchantConfigSchema.shape.body>
export type UploadCsdBody = z.infer<typeof uploadCsdSchema.shape.body>
export type AutofacturaBody = z.infer<typeof autofacturaSchema.shape.body>

// ==========================================
// SAT CATALOG LOOKUP SCHEMA
// ==========================================

/**
 * Schema passed to validateRequest() for:
 *   GET /venues/:venueId/fiscal/sat-catalog?type=product|unit&q=<texto>
 *
 * Uses `query` envelope — validateRequest() writes the parsed values back to req.query.
 * Spanish error messages per critical-warnings rule.
 *
 * `q` is optional: the dashboard picker omits it when the search box is empty
 * (dropdown just opened) and the catalog returns its first page as defaults.
 */
export const satCatalogSchema = z.object({
  query: z.object({
    type: z.enum(['product', 'unit'], {
      errorMap: () => ({ message: 'Tipo inválido (product|unit)' }),
    }),
    q: z.string().trim().min(1, 'La búsqueda no puede estar vacía').optional(),
  }),
})

export type SatCatalogQuery = z.infer<typeof satCatalogSchema.shape.query>
