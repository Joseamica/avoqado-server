/**
 * KYC Review Validation Schemas (Superadmin)
 *
 * Zod schemas for validating Superadmin KYC review requests
 */

import { z } from 'zod'
import { confirmacionDePosicionesSchema } from '../../services/shared/candadoDePosiciones'

/**
 * Validates list pending KYC venues request
 */
export const ListPendingKycSchema = z.object({
  // No params or body needed
})

/**
 * Validates get KYC details request
 */
export const GetKycDetailsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('El ID del negocio no es válido'),
  }),
})

/**
 * Validates assign processor and approve KYC request
 */
export const AssignProcessorSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('El ID del negocio no es válido'),
  }),
  body: z.object({
    // Payment provider assignment
    providerId: z.string().cuid('El ID del proveedor no es válido'),
    ecommerceMerchantId: z.string().min(1, 'El ID externo del comercio es obligatorio'),
    displayName: z.string().min(1, 'El nombre para mostrar es obligatorio'),
    credentials: z.record(z.any()).refine(obj => Object.keys(obj).length > 0, {
      message: 'Las credenciales no pueden estar vacías',
    }),
    providerConfig: z.record(z.any()).optional(),
    // Candado de posiciones (tarifa al comercio, paso 1).
    positionConfirmations: confirmacionDePosicionesSchema,

    // CLABE information (from onboarding)
    clabeNumber: z
      .string()
      .regex(/^\d{18}$/, 'La CLABE debe tener exactamente 18 dígitos')
      .refine(
        clabe => {
          // Basic CLABE validation
          return clabe.length === 18
        },
        { message: 'La CLABE no es válida' },
      ),
    bankName: z.string().min(1, 'El nombre del banco es obligatorio'),
    accountHolder: z.string().min(1, 'El nombre del titular de la cuenta es obligatorio'),

    // Provider costs (what processor charges Avoqado)
    providerCosts: z.object({
      debitRate: z.number().min(0).max(1, 'La tasa de débito debe estar entre 0 y 1'),
      creditRate: z.number().min(0).max(1, 'La tasa de crédito debe estar entre 0 y 1'),
      amexRate: z.number().min(0).max(1, 'La tasa de American Express debe estar entre 0 y 1'),
      internationalRate: z.number().min(0).max(1, 'La tasa internacional debe estar entre 0 y 1'),
      // Mismo flag/taxRate del modelo. false = "tasa + IVA" en contrato.
      includesTax: z.boolean().nullable().optional(),
      taxRate: z.number().min(0).max(1).optional(),
      fixedCostPerTransaction: z.number().min(0, 'El costo fijo no puede ser negativo'),
    }),

    // Venue pricing (what venue pays)
    venuePricing: z.object({
      debitRate: z.number().min(0).max(1, 'La tasa de débito debe estar entre 0 y 1'),
      creditRate: z.number().min(0).max(1, 'La tasa de crédito debe estar entre 0 y 1'),
      amexRate: z.number().min(0).max(1, 'La tasa de American Express debe estar entre 0 y 1'),
      internationalRate: z.number().min(0).max(1, 'La tasa internacional debe estar entre 0 y 1'),
      includesTax: z.boolean().nullable().optional(),
      taxRate: z.number().min(0).max(1).optional(),
      fixedFeePerTransaction: z.number().min(0, 'La comisión fija no puede ser negativa'),
    }),
  }),
})

/**
 * Validates reject KYC request
 */
export const RejectKycSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('El ID del negocio no es válido'),
  }),
  body: z.object({
    rejectionReason: z
      .string()
      .min(10, 'El motivo del rechazo debe tener al menos 10 caracteres')
      .max(500, 'El motivo del rechazo admite hasta 500 caracteres'),
    rejectedDocuments: z.array(z.string()).optional(),
  }),
})

/**
 * Validates mark KYC in review request
 */
export const MarkKycInReviewSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('El ID del negocio no es válido'),
  }),
})
