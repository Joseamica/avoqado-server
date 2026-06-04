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
// TYPE EXPORTS
// ==========================================

export type IssueCfdiBody = z.infer<typeof issueCfdiSchema.shape.body>
