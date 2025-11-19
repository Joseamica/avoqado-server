/**
 * KYC Review Validation Schemas (Superadmin)
 *
 * Zod schemas for validating Superadmin KYC review requests
 */

import { z } from 'zod'

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
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
})

/**
 * Validates assign processor and approve KYC request
 */
export const AssignProcessorSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
  body: z.object({
    // Payment provider assignment
    providerId: z.string().cuid('Invalid provider ID format'),
    ecommerceMerchantId: z.string().min(1, 'External merchant ID is required'),
    displayName: z.string().min(1, 'Display name is required'),
    credentials: z.record(z.any()).refine(obj => Object.keys(obj).length > 0, {
      message: 'Credentials object cannot be empty',
    }),
    providerConfig: z.record(z.any()).optional(),

    // CLABE information (from onboarding)
    clabeNumber: z
      .string()
      .regex(/^\d{18}$/, 'CLABE must be exactly 18 digits')
      .refine(
        clabe => {
          // Basic CLABE validation
          return clabe.length === 18
        },
        { message: 'Invalid CLABE format' },
      ),
    bankName: z.string().min(1, 'Bank name is required'),
    accountHolder: z.string().min(1, 'Account holder name is required'),

    // Provider costs (what processor charges Avoqado)
    providerCosts: z.object({
      debitRate: z.number().min(0).max(1, 'Rate must be between 0 and 1'),
      creditRate: z.number().min(0).max(1, 'Rate must be between 0 and 1'),
      amexRate: z.number().min(0).max(1, 'Rate must be between 0 and 1'),
      internationalRate: z.number().min(0).max(1, 'Rate must be between 0 and 1'),
      fixedCostPerTransaction: z.number().min(0, 'Fixed cost must be positive'),
    }),

    // Venue pricing (what venue pays)
    venuePricing: z.object({
      debitRate: z.number().min(0).max(1, 'Rate must be between 0 and 1'),
      creditRate: z.number().min(0).max(1, 'Rate must be between 0 and 1'),
      amexRate: z.number().min(0).max(1, 'Rate must be between 0 and 1'),
      internationalRate: z.number().min(0).max(1, 'Rate must be between 0 and 1'),
      fixedFeePerTransaction: z.number().min(0, 'Fixed fee must be positive'),
    }),
  }),
})

/**
 * Validates reject KYC request
 */
export const RejectKycSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
  body: z.object({
    rejectionReason: z.string().min(10, 'Rejection reason must be at least 10 characters').max(500, 'Rejection reason too long'),
    rejectedDocuments: z.array(z.string()).optional(),
  }),
})

/**
 * Validates mark KYC in review request
 */
export const MarkKycInReviewSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
})
