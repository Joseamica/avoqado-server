/**
 * Credit Assessment Validation Schemas (Superadmin)
 *
 * Zod schemas for validating SOFOM credit assessment requests
 */

import { z } from 'zod'

/**
 * Validates list assessments query parameters
 */
export const ListAssessmentsSchema = z.object({
  query: z
    .object({
      page: z
        .string()
        .optional()
        .transform(val => (val ? parseInt(val) : 1)),
      pageSize: z
        .string()
        .optional()
        .transform(val => (val ? parseInt(val) : 20)),
      eligibility: z.string().optional(),
      grade: z.string().optional(),
      minScore: z
        .string()
        .optional()
        .transform(val => (val ? parseInt(val) : undefined)),
      maxScore: z
        .string()
        .optional()
        .transform(val => (val ? parseInt(val) : undefined)),
      sortBy: z.enum(['creditScore', 'annualVolume', 'calculatedAt']).optional(),
      sortOrder: z.enum(['asc', 'desc']).optional(),
    })
    .optional(),
})

/**
 * Validates venue ID parameter
 */
export const VenueIdSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('El ID del negocio no es válido'),
  }),
})

/**
 * Validates offer ID parameter
 */
export const OfferIdSchema = z.object({
  params: z.object({
    offerId: z.string().cuid('El ID de la oferta no es válido'),
  }),
})

/**
 * Validates create credit offer request
 */
export const CreateOfferSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('El ID del negocio no es válido'),
  }),
  body: z.object({
    offerAmount: z
      .number()
      .min(50000, 'El monto mínimo de la oferta es $50,000 MXN')
      .max(2000000, 'El monto máximo de la oferta es $2,000,000 MXN'),
    factorRate: z
      .number()
      .min(1.05, 'El factor debe ser de al menos 1.05 (5 % de comisión)')
      .max(1.3, 'El factor no puede pasar de 1.30 (30 % de comisión)'),
    repaymentPercent: z.number().min(0.05, 'El porcentaje mínimo de pago es 5 %').max(0.2, 'El porcentaje máximo de pago es 20 %'),
    expiresInDays: z
      .number()
      .min(7, 'La oferta debe durar al menos 7 días')
      .max(90, 'La oferta no puede durar más de 90 días')
      .optional()
      .default(30),
    notes: z.string().max(1000, 'Las notas admiten hasta 1000 caracteres').optional(),
  }),
})

/**
 * Validates reject offer request
 */
export const RejectOfferSchema = z.object({
  params: z.object({
    offerId: z.string().cuid('El ID de la oferta no es válido'),
  }),
  body: z.object({
    rejectionReason: z
      .string()
      .min(5, 'El motivo del rechazo debe tener al menos 5 caracteres')
      .max(500, 'El motivo del rechazo admite hasta 500 caracteres')
      .optional(),
  }),
})
