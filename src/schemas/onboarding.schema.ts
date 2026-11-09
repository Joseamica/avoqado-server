/**
 * Onboarding Validation Schemas
 *
 * Zod schemas for validating onboarding API requests
 */

import { z } from 'zod'
import { OnboardingType, ProductType } from '@prisma/client'
import { zTimezone } from '@/utils/sanitizeTimezone'
import { optionalLaunchCampaignCode, optionalHybridOfferSlug, utmSchema, optionalReferrer } from './acquisition.schema'

/**
 * Validates signup request (creates user + organization)
 */
export const SignupSchema = z.object({
  body: z.object({
    email: z.string().email('Formato de correo inválido'),
    password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
    firstName: z.string().optional().default(''),
    lastName: z.string().optional().default(''),
    organizationName: z.string().optional().default(''),
    wizardVersion: z.number().optional(),
    // Lanzamiento con campañas ligeras (spec 2026-09-17 § 3.5). Los tres son ADITIVOS: un
    // dashboard viejo que no los mande se comporta exactamente igual que antes.
    //
    // 🔴 `legalVersion` presente ⇔ la persona marcó la casilla de consentimiento. Una versión
    // desconocida se IGNORA (el asistente la vuelve a pedir) en vez de tumbar el alta.
    legalVersion: z.string().trim().max(40).optional(),
    launchCampaignCode: optionalLaunchCampaignCode,
    hybridOfferSlug: optionalHybridOfferSlug,
    utm: utmSchema,
    referrer: optionalReferrer,
  }),
})

/**
 * Validates onboarding start request (initializes progress)
 */
export const StartOnboardingSchema = z.object({
  params: z.object({
    organizationId: z.string().cuid('El ID de la organización no es válido'),
  }),
})

/**
 * Validates onboarding progress fetch
 */
export const GetOnboardingProgressSchema = z.object({
  params: z.object({
    organizationId: z.string().cuid('El ID de la organización no es válido'),
  }),
})

/**
 * Validates Step 1: User Info
 */
export const UpdateStep1Schema = z.object({
  params: z.object({
    organizationId: z.string().cuid('El ID de la organización no es válido'),
  }),
  body: z.object({
    email: z.string().email('El correo no es válido'),
    firstName: z.string().min(1, 'El nombre es obligatorio').max(50, 'El nombre admite hasta 50 caracteres'),
    lastName: z.string().min(1, 'El apellido es obligatorio').max(50, 'El apellido admite hasta 50 caracteres'),
    phone: z.string().optional(),
  }),
})

/**
 * Validates Step 2: Onboarding Type (Demo vs Real)
 */
export const UpdateStep2Schema = z.object({
  params: z.object({
    organizationId: z.string().cuid('El ID de la organización no es válido'),
  }),
  body: z.object({
    onboardingType: z.nativeEnum(OnboardingType, {
      errorMap: () => ({ message: 'El tipo de alta debe ser demostración o real' }),
    }),
  }),
})

/**
 * Validates Step 3: Business Info
 */
export const UpdateStep3Schema = z.object({
  params: z.object({
    organizationId: z.string().cuid('El ID de la organización no es válido'),
  }),
  body: z.object({
    name: z.string().min(1, 'El nombre del negocio es obligatorio').max(100, 'El nombre del negocio admite hasta 100 caracteres'),
    type: z.string().optional(),
    venueType: z.string().optional(),
    entityType: z
      .enum(['PERSONA_FISICA', 'PERSONA_MORAL'], {
        errorMap: () => ({ message: 'El tipo de persona debe ser persona física o persona moral' }),
      })
      .optional(),
    timezone: zTimezone,
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().default('MX'),
    zipCode: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().email('El correo no es válido').optional(),
  }),
})

/**
 * Validates Step 4: Menu Data (manual)
 */
export const UpdateStep4Schema = z.object({
  params: z.object({
    organizationId: z.string().cuid('El ID de la organización no es válido'),
  }),
  body: z.object({
    method: z.enum(['manual', 'csv'], {
      errorMap: () => ({ message: 'El método debe ser manual o por archivo CSV' }),
    }),
    categories: z
      .array(
        z.object({
          name: z.string().min(1, 'El nombre de la categoría es obligatorio'),
          slug: z.string().min(1, 'La clave de la categoría es obligatoria'),
          description: z.string().optional(),
        }),
      )
      .optional(),
    products: z
      .array(
        z.object({
          name: z.string().min(1, 'El nombre del producto es obligatorio'),
          sku: z.string().min(1, 'El SKU del producto es obligatorio'),
          gtin: z.string().max(14).optional(),
          description: z.string().optional(),
          price: z.number().positive('El precio debe ser mayor a cero'),
          type: z.nativeEnum(ProductType).optional(),
          categorySlug: z.string().min(1, 'La clave de la categoría es obligatoria'),
        }),
      )
      .optional(),
  }),
})

/**
 * Validates Step 5: Team Invites (optional)
 */
export const UpdateStep5Schema = z.object({
  params: z.object({
    organizationId: z.string().cuid('El ID de la organización no es válido'),
  }),
  body: z.object({
    teamInvites: z
      .array(
        z.object({
          email: z.string().email('El correo no es válido'),
          firstName: z.string().min(1, 'El nombre es obligatorio'),
          lastName: z.string().min(1, 'El apellido es obligatorio'),
          role: z.string().min(1, 'El rol es obligatorio'),
        }),
      )
      .optional()
      .default([]), // Default to empty array if not provided
  }),
})

/**
 * Validates Step 6: Selected Features
 */
export const UpdateStep6Schema = z.object({
  params: z.object({
    organizationId: z.string().cuid('El ID de la organización no es válido'),
  }),
  body: z.object({
    selectedFeatures: z.array(z.string()).default([]),
  }),
})

/**
 * Validates Step 7: KYC Documents
 */
export const UpdateStep7Schema = z.object({
  params: z.object({
    organizationId: z.string().cuid('El ID de la organización no es válido'),
  }),
  body: z.object({
    entityType: z.enum(['PERSONA_FISICA', 'PERSONA_MORAL'], {
      errorMap: () => ({ message: 'El tipo de persona debe ser persona física o persona moral' }),
    }),
    documents: z.object({
      ineUrl: z.string().url('La dirección web del documento del INE no es válida').optional(),
      rfcDocumentUrl: z.string().url('La dirección web del documento del RFC no es válida').optional(),
      comprobanteDomicilioUrl: z.string().url('La dirección web del comprobante de domicilio no es válida').optional(),
      caratulaBancariaUrl: z.string().url('La dirección web de la carátula bancaria no es válida').optional(),
      actaDocumentUrl: z.string().url('La dirección web del acta constitutiva no es válida').optional(),
      poderLegalUrl: z.string().url('La dirección web del poder legal no es válida').optional(),
    }),
  }),
})

/**
 * Validates Step 8: CLABE Payment Info
 */
export const UpdateStep8Schema = z.object({
  params: z.object({
    organizationId: z.string().cuid('El ID de la organización no es válido'),
  }),
  body: z.object({
    clabe: z
      .string()
      .regex(/^\d{18}$/, 'La CLABE debe tener exactamente 18 dígitos')
      .refine(
        clabe => {
          // Basic CLABE validation (check digit algorithm will be done in service)
          return clabe.length === 18
        },
        { message: 'La CLABE no es válida' },
      ),
    bankName: z.string().optional(),
    accountHolder: z.string().min(1, 'El nombre del titular de la cuenta es obligatorio'),
  }),
})

/**
 * Validates onboarding completion request
 * This finalizes the onboarding and creates the venue
 */
export const CompleteOnboardingSchema = z.object({
  params: z.object({
    organizationId: z.string().cuid('El ID de la organización no es válido'),
  }),
})

/**
 * Validates CSV template download request
 */
export const GetMenuTemplateSchema = z.object({
  query: z.object({
    format: z.enum(['csv']).default('csv'),
  }),
})

// =============================================
// V2 Setup Wizard Schemas (Square-style)
// =============================================

export const V2StepParamsSchema = z.object({
  params: z.object({
    organizationId: z.string().cuid('ID de organización inválido'),
    // Steps 8 (payment providers), 9 (buy TPV) and 10 (plan) are optional/env-gated
    // wizard steps. They must be inside the regex so the wizard can save their
    // skip / connected / plan-selected state. Bumping this cap is required whenever
    // a new trailing wizard step is added (see ENABLE_ONBOARDING_* / ENABLE_VENUE_BASE_SUBSCRIPTION flags).
    stepNumber: z.string().regex(/^([1-9]|10)$/, 'Número de paso inválido (1-10)'),
  }),
})

// NOTE: Per-step body validation is handled in the controller (saveV2Step)
// since the route uses a single generic endpoint for all steps.
// The controller validates critical fields per step number.

export const V2AcceptTermsSchema = z.object({
  params: z.object({
    organizationId: z.string().cuid('ID de organización inválido'),
  }),
  body: z.object({
    termsAccepted: z.boolean().refine(val => val === true, { message: 'Debes aceptar los términos de servicio' }),
    privacyAccepted: z.boolean().refine(val => val === true, { message: 'Debes aceptar el aviso de privacidad' }),
    termsVersion: z.string().min(1, 'La versión de los términos es requerida'),
  }),
})

export const V2CompleteSchema = z.object({
  params: z.object({
    organizationId: z.string().cuid('ID de organización inválido'),
  }),
  body: z.object({
    // Locale captured from the wizard's active i18n language, used for the plan
    // confirmation email. Optional — defaults to 'es' in the controller.
    language: z.enum(['es', 'en']).optional(),
  }),
})
