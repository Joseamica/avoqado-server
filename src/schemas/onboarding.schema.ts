/**
 * Onboarding Validation Schemas
 *
 * Zod schemas for validating onboarding API requests
 */

import { z } from 'zod'
import { OnboardingType, ProductType } from '@prisma/client'
import { zTimezone } from '@/utils/sanitizeTimezone'

/**
 * Validates signup request (creates user + organization)
 */
export const SignupSchema = z.object({
  body: z.object({
    email: z.string().email('Formato de correo invalido'),
    password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
    firstName: z.string().optional().default(''),
    lastName: z.string().optional().default(''),
    organizationName: z.string().optional().default(''),
    wizardVersion: z.number().optional(),
  }),
})

/**
 * Validates onboarding start request (initializes progress)
 */
export const StartOnboardingSchema = z.object({
  params: z.object({
    organizationId: z.string().cuid('Invalid organization ID format'),
  }),
})

/**
 * Validates onboarding progress fetch
 */
export const GetOnboardingProgressSchema = z.object({
  params: z.object({
    organizationId: z.string().cuid('Invalid organization ID format'),
  }),
})

/**
 * Validates Step 1: User Info
 */
export const UpdateStep1Schema = z.object({
  params: z.object({
    organizationId: z.string().cuid('Invalid organization ID format'),
  }),
  body: z.object({
    email: z.string().email('Invalid email format'),
    firstName: z.string().min(1, 'First name is required').max(50, 'First name too long'),
    lastName: z.string().min(1, 'Last name is required').max(50, 'Last name too long'),
    phone: z.string().optional(),
  }),
})

/**
 * Validates Step 2: Onboarding Type (Demo vs Real)
 */
export const UpdateStep2Schema = z.object({
  params: z.object({
    organizationId: z.string().cuid('Invalid organization ID format'),
  }),
  body: z.object({
    onboardingType: z.nativeEnum(OnboardingType, {
      errorMap: () => ({ message: 'Invalid onboarding type. Must be DEMO or REAL' }),
    }),
  }),
})

/**
 * Validates Step 3: Business Info
 */
export const UpdateStep3Schema = z.object({
  params: z.object({
    organizationId: z.string().cuid('Invalid organization ID format'),
  }),
  body: z.object({
    name: z.string().min(1, 'Business name is required').max(100, 'Business name too long'),
    type: z.string().optional(),
    venueType: z.string().optional(),
    entityType: z
      .enum(['PERSONA_FISICA', 'PERSONA_MORAL'], {
        errorMap: () => ({ message: 'Entity type must be PERSONA_FISICA or PERSONA_MORAL' }),
      })
      .optional(),
    timezone: zTimezone,
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().default('MX'),
    zipCode: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().email('Invalid email format').optional(),
  }),
})

/**
 * Validates Step 4: Menu Data (manual)
 */
export const UpdateStep4Schema = z.object({
  params: z.object({
    organizationId: z.string().cuid('Invalid organization ID format'),
  }),
  body: z.object({
    method: z.enum(['manual', 'csv'], {
      errorMap: () => ({ message: 'Method must be "manual" or "csv"' }),
    }),
    categories: z
      .array(
        z.object({
          name: z.string().min(1, 'Category name is required'),
          slug: z.string().min(1, 'Category slug is required'),
          description: z.string().optional(),
        }),
      )
      .optional(),
    products: z
      .array(
        z.object({
          name: z.string().min(1, 'Product name is required'),
          sku: z.string().min(1, 'Product SKU is required'),
          gtin: z.string().max(14).optional(),
          description: z.string().optional(),
          price: z.number().positive('Price must be greater than 0'),
          type: z.nativeEnum(ProductType).optional(),
          categorySlug: z.string().min(1, 'Category slug is required'),
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
    organizationId: z.string().cuid('Invalid organization ID format'),
  }),
  body: z.object({
    teamInvites: z
      .array(
        z.object({
          email: z.string().email('Invalid email format'),
          firstName: z.string().min(1, 'First name is required'),
          lastName: z.string().min(1, 'Last name is required'),
          role: z.string().min(1, 'Role is required'),
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
    organizationId: z.string().cuid('Invalid organization ID format'),
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
    organizationId: z.string().cuid('Invalid organization ID format'),
  }),
  body: z.object({
    entityType: z.enum(['PERSONA_FISICA', 'PERSONA_MORAL'], {
      errorMap: () => ({ message: 'Entity type must be PERSONA_FISICA or PERSONA_MORAL' }),
    }),
    documents: z.object({
      ineUrl: z.string().url('Invalid INE document URL').optional(),
      rfcDocumentUrl: z.string().url('Invalid RFC document URL').optional(),
      comprobanteDomicilioUrl: z.string().url('Invalid address proof URL').optional(),
      caratulaBancariaUrl: z.string().url('Invalid bank statement URL').optional(),
      actaDocumentUrl: z.string().url('Invalid Acta Constitutiva URL').optional(),
      poderLegalUrl: z.string().url('Invalid power of attorney URL').optional(),
    }),
  }),
})

/**
 * Validates Step 8: CLABE Payment Info
 */
export const UpdateStep8Schema = z.object({
  params: z.object({
    organizationId: z.string().cuid('Invalid organization ID format'),
  }),
  body: z.object({
    clabe: z
      .string()
      .regex(/^\d{18}$/, 'CLABE must be exactly 18 digits')
      .refine(
        clabe => {
          // Basic CLABE validation (check digit algorithm will be done in service)
          return clabe.length === 18
        },
        { message: 'Invalid CLABE format' },
      ),
    bankName: z.string().optional(),
    accountHolder: z.string().min(1, 'Account holder name is required'),
  }),
})

/**
 * Validates onboarding completion request
 * This finalizes the onboarding and creates the venue
 */
export const CompleteOnboardingSchema = z.object({
  params: z.object({
    organizationId: z.string().cuid('Invalid organization ID format'),
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
    organizationId: z.string().cuid('ID de organizacion invalido'),
    stepNumber: z.string().regex(/^[1-6]$/, 'Numero de paso invalido (1-6)'),
  }),
})

export const V2Step2Schema = z.object({
  params: z.object({
    organizationId: z.string().cuid('ID de organizacion invalido'),
    stepNumber: z.literal('1'),
  }),
  body: z.object({
    businessName: z.string().min(1, 'El nombre del negocio es requerido').max(100, 'El nombre del negocio es muy largo'),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional().default('MX'),
    zipCode: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    noPhysicalAddress: z.boolean().optional().default(false),
  }),
})

export const V2Step3Schema = z.object({
  params: z.object({
    organizationId: z.string().cuid('ID de organizacion invalido'),
    stepNumber: z.literal('2'),
  }),
  body: z.object({
    businessType: z.string().min(1, 'El tipo de negocio es requerido'),
    businessCategory: z.string().optional(),
  }),
})

export const V2Step4Schema = z.object({
  params: z.object({
    organizationId: z.string().cuid('ID de organizacion invalido'),
    stepNumber: z.literal('3'),
  }),
  body: z.object({
    entityType: z.string().min(1, 'El tipo de entidad es requerido'),
    entitySubType: z.string().optional(),
    commercialName: z.string().optional(),
    phone: z.string().optional(),
  }),
})

export const V2Step5Schema = z.object({
  params: z.object({
    organizationId: z.string().cuid('ID de organizacion invalido'),
    stepNumber: z.literal('4'),
  }),
  body: z.object({
    legalFirstName: z.string().min(1, 'El nombre legal es requerido'),
    legalLastName: z.string().min(1, 'El apellido legal es requerido'),
    phone: z.string().optional(),
    birthdate: z.string().optional(),
    rfc: z.string().optional(),
    curp: z.string().optional(),
    legalAddress: z.string().optional(),
    legalCity: z.string().optional(),
    legalState: z.string().optional(),
    legalCountry: z.string().optional(),
    legalZipCode: z.string().optional(),
  }),
})

export const V2AcceptTermsSchema = z.object({
  params: z.object({
    organizationId: z.string().cuid('ID de organizacion invalido'),
  }),
  body: z.object({
    termsAccepted: z.boolean().refine(val => val === true, { message: 'Debes aceptar los terminos de servicio' }),
    privacyAccepted: z.boolean().refine(val => val === true, { message: 'Debes aceptar el aviso de privacidad' }),
    termsVersion: z.string().min(1, 'La version de los terminos es requerida'),
  }),
})

export const V2Step7Schema = z.object({
  params: z.object({
    organizationId: z.string().cuid('ID de organizacion invalido'),
    stepNumber: z.literal('6'),
  }),
  body: z.object({
    clabe: z.string().regex(/^\d{18}$/, 'La CLABE debe tener exactamente 18 digitos'),
    bankName: z.string().optional(),
    accountHolder: z.string().min(1, 'El nombre del titular es requerido'),
    accountType: z.string().optional(),
  }),
})

export const V2CompleteSchema = z.object({
  params: z.object({
    organizationId: z.string().cuid('ID de organizacion invalido'),
  }),
})
