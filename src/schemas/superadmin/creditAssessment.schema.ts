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
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
})

/**
 * Validates offer ID parameter
 */
export const OfferIdSchema = z.object({
  params: z.object({
    offerId: z.string().cuid('Invalid offer ID format'),
  }),
})

/**
 * Validates create credit offer request
 */
export const CreateOfferSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
  body: z.object({
    offerAmount: z.number().min(50000, 'Minimum offer amount is $50,000 MXN').max(2000000, 'Maximum offer amount is $2,000,000 MXN'),
    factorRate: z.number().min(1.05, 'Factor rate must be at least 1.05 (5% fee)').max(1.3, 'Factor rate cannot exceed 1.30 (30% fee)'),
    repaymentPercent: z.number().min(0.05, 'Minimum repayment percent is 5%').max(0.2, 'Maximum repayment percent is 20%'),
    expiresInDays: z
      .number()
      .min(7, 'Offer must be valid for at least 7 days')
      .max(90, 'Offer cannot exceed 90 days validity')
      .optional()
      .default(30),
    notes: z.string().max(1000, 'Notes cannot exceed 1000 characters').optional(),
  }),
})

/**
 * Validates reject offer request
 */
export const RejectOfferSchema = z.object({
  params: z.object({
    offerId: z.string().cuid('Invalid offer ID format'),
  }),
  body: z.object({
    rejectionReason: z
      .string()
      .min(5, 'Rejection reason must be at least 5 characters')
      .max(500, 'Rejection reason cannot exceed 500 characters')
      .optional(),
  }),
})
