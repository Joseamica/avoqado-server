/**
 * Onboarding Validation Schemas
 *
 * Zod schemas for validating onboarding API requests
 */

import { z } from 'zod'
import { OnboardingType, ProductType } from '@prisma/client'

/**
 * Validates signup request (creates user + organization)
 */
export const SignupSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email format'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    firstName: z.string().min(1, 'First name is required'),
    lastName: z.string().min(1, 'Last name is required'),
    organizationName: z.string().min(1, 'Organization name is required'),
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
    timezone: z.string().default('America/Mexico_City'),
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
    teamInvites: z.array(
      z.object({
        email: z.string().email('Invalid email format'),
        role: z.string().min(1, 'Role is required'),
      }),
    ),
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
 * Validates Step 7: CLABE Payment Info & KYC Documents
 */
export const UpdateStep7Schema = z.object({
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
    accountHolder: z.string().optional(),
    // KYC Document URLs (uploaded to storage before submitting this step)
    ineUrl: z.string().url('Invalid INE document URL').optional(),
    rfcDocumentUrl: z.string().url('Invalid RFC document URL').optional(),
    comprobanteDomicilioUrl: z.string().url('Invalid address proof URL').optional(),
    caratulaBancariaUrl: z.string().url('Invalid bank statement URL').optional(),
    actaConstitutivaUrl: z.string().url('Invalid Acta Constitutiva URL').optional(),
    poderLegalUrl: z.string().url('Invalid power of attorney URL').optional(),
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
