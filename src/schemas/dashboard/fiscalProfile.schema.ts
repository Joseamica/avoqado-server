/**
 * Datos fiscales del venue como RECEPTOR de las facturas de Avoqado — Zod schemas.
 *
 * Shape-only — validación SAT-registry vive en el service (validateBillingTaxProfile).
 * Los validadores de rfc/razonSocial/regimenFiscal/codigoPostal replican el estilo de
 * `src/schemas/dashboard/cfdi.schema.ts` (nada exportado ahí para importar directo).
 *
 * 🔴 A propósito NO se declaran `customerType`, `venueId` ni `organizationId` en el body:
 * esta superficie sólo puede escribir el perfil del venue de la URL (req.params.venueId),
 * nunca uno elegido por el cliente. El controlador tampoco los lee del body.
 *
 * @see src/controllers/dashboard/fiscalProfile.dashboard.controller.ts
 */

import { z } from 'zod'

const rfc = z
  .string({ required_error: 'El RFC es requerido' })
  .trim()
  .regex(/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i, 'El RFC no tiene un formato válido')

const razonSocial = z.string({ required_error: 'La razón social es requerida' }).trim().min(1, 'La razón social es requerida')

const regimenFiscal = z.string({ required_error: 'El régimen fiscal es requerido' }).regex(/^\d{3}$/, 'El régimen fiscal no es válido')

const codigoPostal = z.string({ required_error: 'El código postal es requerido' }).regex(/^\d{5}$/, 'El código postal debe tener 5 dígitos')

// ── PUT /venues/:venueId/fiscal-profile ─────────────────────────────
export const upsertFiscalProfileSchema = z.object({
  body: z.object({
    rfc,
    razonSocial,
    regimenFiscal,
    codigoPostal,
    defaultUsoCfdi: z.string().trim().min(1, 'El uso de CFDI no puede estar vacío').optional(),
    email: z.string().email('El correo no es válido').optional(),
  }),
  params: z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough(),
})

// ── POST /venues/:venueId/fiscal-profile/constancia ─────────────────
export const uploadConstanciaSchema = z.object({
  body: z.object({
    fileBase64: z.string({ required_error: 'El archivo en base64 es requerido' }).min(1, 'El archivo no puede estar vacío'),
    contentType: z.enum(['application/pdf', 'image/png', 'image/jpeg'], { invalid_type_error: 'Tipo de archivo no soportado' }).optional(),
  }),
  params: z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough(),
})

// ── GET /venues/:venueId/fiscal-profile ──────────────────────────────
export const venueParamSchema = z.object({
  params: z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough(),
})

export type UpsertFiscalProfileBody = z.infer<typeof upsertFiscalProfileSchema>['body']
export type UploadConstanciaBody = z.infer<typeof uploadConstanciaSchema>['body']
