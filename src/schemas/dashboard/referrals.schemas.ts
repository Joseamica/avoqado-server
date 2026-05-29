import { z } from 'zod'

// ==========================================
// REFERRAL PROGRAM CONFIG SCHEMAS
// ==========================================

export const ActivateReferralProgramSchema = z.object({
  params: z.object({
    venueId: z.string().min(1),
  }),
  body: z.object({
    newCustomerDiscountPercent: z.number().min(0).max(100),
    tier1ReferralsRequired: z.number().int().min(1),
    tier1RewardPercent: z.number().min(0).max(100),
    tier2ReferralsRequired: z.number().int().min(2),
    tier2RewardPercent: z.number().min(0).max(100),
    tier3ReferralsRequired: z.number().int().min(3),
    tier3RewardPercent: z.number().min(0).max(100),
    rewardCouponExpiryDays: z.number().int().min(1),
    codePrefix: z.string().min(1).max(8).optional(),
    welcomeMessageTemplate: z.string().optional(),
    tierUpMessageTemplate: z.string().optional(),
  }),
})

export const UpdateReferralConfigSchema = z.object({
  params: z.object({
    venueId: z.string().min(1),
  }),
  body: z
    .object({
      newCustomerDiscountPercent: z.number().min(0).max(100).optional(),
      tier1ReferralsRequired: z.number().int().min(1).optional(),
      tier1RewardPercent: z.number().min(0).max(100).optional(),
      tier2ReferralsRequired: z.number().int().min(2).optional(),
      tier2RewardPercent: z.number().min(0).max(100).optional(),
      tier3ReferralsRequired: z.number().int().min(3).optional(),
      tier3RewardPercent: z.number().min(0).max(100).optional(),
      rewardCouponExpiryDays: z.number().int().min(1).optional(),
      codePrefix: z.string().min(1).max(8).optional(),
      welcomeMessageTemplate: z.string().optional(),
      tierUpMessageTemplate: z.string().optional(),
    })
    .refine(data => Object.keys(data).length > 0, {
      message: 'Al menos un campo debe ser proporcionado',
    }),
})

export const DeactivateReferralProgramSchema = z.object({
  params: z.object({
    venueId: z.string().min(1),
  }),
  body: z.object({
    reason: z.string().min(1, 'Razón obligatoria'),
  }),
})

// ==========================================
// REFERRAL CAPTURE SCHEMAS
// ==========================================

export const ValidateReferralCodeSchema = z.object({
  params: z.object({
    venueId: z.string().min(1),
  }),
  body: z.object({
    referralCode: z.string().min(3).max(64),
    newCustomerId: z.string().min(1),
  }),
})

export const CaptureReferralSchema = z.object({
  params: z.object({
    venueId: z.string().min(1),
  }),
  body: z.object({
    referralCode: z.string().min(3).max(64),
    newCustomerId: z.string().min(1),
    capturedByStaffVenueId: z.string().min(1),
    intendedOrderId: z.string().optional(),
  }),
})

export const ForceOverrideReferralSchema = z.object({
  params: z.object({
    venueId: z.string().min(1),
  }),
  body: z.object({
    referralCode: z.string().min(3).max(64),
    existingCustomerId: z.string().min(1),
    capturedByStaffVenueId: z.string().min(1),
    reason: z.string().min(10, 'Razón mínimo 10 caracteres'),
  }),
})

export const ManualVoidReferralSchema = z.object({
  params: z.object({
    venueId: z.string().min(1),
    referralId: z.string().min(1),
  }),
  body: z.object({
    reason: z.string().min(1, 'Razón obligatoria'),
  }),
})

// ==========================================
// REFERRAL READS SCHEMAS
// ==========================================

export const ListReferralsQuerySchema = z.object({
  params: z.object({
    venueId: z.string().min(1),
  }),
  query: z.object({
    status: z.enum(['PENDING', 'QUALIFIED', 'VOID']).optional(),
    tier: z.enum(['TIER_1', 'TIER_2', 'TIER_3']).optional(),
    dateFrom: z.string().datetime().optional(),
    dateTo: z.string().datetime().optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  }),
})
