import { z } from 'zod'

import { assertCommercialMoneyLimitV2, parseCommercialMoneyV2 } from '@/services/commercial/commercialMoneyV2.service'

const code = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/)
const boundedReference = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._:@/+\-=]+$/)
const utcDateTime = z.string().datetime({ offset: true }).regex(/Z$/, 'La fecha debe estar normalizada en UTC (Z).')
const minorMoney = z.number().int().min(0).max(2_147_483_647)
const cycles = z.number().int().min(1).max(120)

const campaignTargetSchema = z
  .object({
    productCodes: z.array(code).min(1).max(100).optional(),
    productKinds: z
      .array(z.enum(['PLAN', 'POS', 'MODULE']))
      .min(1)
      .max(3)
      .optional(),
    bundleCodes: z.array(code).min(1).max(100).optional(),
  })
  .strict()
  .refine(target => Boolean(target.productCodes?.length || target.productKinds?.length || target.bundleCodes?.length), {
    message: 'Cada regla necesita al menos un target explícito.',
  })

const ruleBase = {
  code,
  priority: z.number().int().min(-10_000).max(10_000),
  target: campaignTargetSchema,
  cycles,
}

const fixedPriceRuleSchema = z.object({ ...ruleBase, type: z.literal('FIXED_PRICE'), amountMinor: minorMoney }).strict()
const percentOffRuleSchema = z
  .object({ ...ruleBase, type: z.literal('PERCENT_OFF'), percentBasisPoints: z.number().int().min(1).max(10_000) })
  .strict()
const amountOffRuleSchema = z.object({ ...ruleBase, type: z.literal('AMOUNT_OFF'), amountMinor: minorMoney }).strict()
const freePeriodRuleSchema = z.object({ ...ruleBase, type: z.literal('FREE_PERIOD') }).strict()
const bundlePriceRuleSchema = z.object({ ...ruleBase, type: z.literal('BUNDLE_PRICE'), amountMinor: minorMoney }).strict()

export const commercialCampaignRuleSchema = z.discriminatedUnion('type', [
  fixedPriceRuleSchema,
  percentOffRuleSchema,
  amountOffRuleSchema,
  freePeriodRuleSchema,
  bundlePriceRuleSchema,
])

const canonicalCampaignMoneyIssue = 'El monto debe usar formato decimal canónico con dos decimales.'
const campaignMoneyLimitIssue = 'El monto excede el máximo unitario permitido.'

export const commercialCampaignMoneyV2Schema = z.unknown().superRefine((value, context) => {
  try {
    assertCommercialMoneyLimitV2('UNIT_AMOUNT', parseCommercialMoneyV2(value))
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error
    }
    if (error.message === 'COMMERCIAL_MONEY_V2_INVALID') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: canonicalCampaignMoneyIssue })
      return
    }
    if (error.message === 'COMMERCIAL_MONEY_V2_LIMIT_EXCEEDED') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: campaignMoneyLimitIssue })
      return
    }
    throw error
  }
}) as z.ZodType<string>

const campaignRuleBaseV2 = {
  code,
  priority: z.number().int().min(-10_000).max(10_000),
  target: campaignTargetSchema,
  cycles,
}

const fixedPriceRuleV2Schema = z
  .object({ ...campaignRuleBaseV2, type: z.literal('FIXED_PRICE'), amount: commercialCampaignMoneyV2Schema })
  .strict()
const percentOffRuleV2Schema = z
  .object({
    ...campaignRuleBaseV2,
    type: z.literal('PERCENT_OFF'),
    percentBasisPoints: z.number().int().min(1).max(10_000),
  })
  .strict()
const amountOffRuleV2Schema = z
  .object({ ...campaignRuleBaseV2, type: z.literal('AMOUNT_OFF'), amount: commercialCampaignMoneyV2Schema })
  .strict()
const freePeriodRuleV2Schema = z.object({ ...campaignRuleBaseV2, type: z.literal('FREE_PERIOD') }).strict()
const bundlePriceRuleV2Schema = z
  .object({ ...campaignRuleBaseV2, type: z.literal('BUNDLE_PRICE'), amount: commercialCampaignMoneyV2Schema })
  .strict()

export const commercialCampaignRuleV2Schema = z.discriminatedUnion('type', [
  fixedPriceRuleV2Schema,
  percentOffRuleV2Schema,
  amountOffRuleV2Schema,
  freePeriodRuleV2Schema,
  bundlePriceRuleV2Schema,
])

const commercialCampaignStackingGroupV2Schema = z
  .object({
    code,
    steps: z
      .array(
        z
          .object({
            position: z.number().int().min(1).max(10),
            ruleCode: code,
          })
          .strict(),
      )
      .min(2)
      .max(10),
  })
  .strict()

export const commercialCampaignVersionSchema = z
  .object({
    schemaVersion: z.literal(1),
    campaignVersionId: z.string().trim().min(1).max(128),
    campaignCode: code,
    version: z.number().int().min(1),
    status: z.enum(['ACTIVE', 'INACTIVE']),
    startsAt: utcDateTime,
    endsAt: utcDateTime,
    allowedRuleCodeGroups: z.array(z.array(code).min(2).max(10)).max(50),
    rules: z.array(commercialCampaignRuleSchema).min(1).max(100),
  })
  .strict()
  .superRefine((campaign, context) => {
    if (Date.parse(campaign.startsAt) >= Date.parse(campaign.endsAt)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['endsAt'], message: 'La campaña debe terminar después de iniciar.' })
    }
    const ruleCodes = campaign.rules.map(rule => rule.code)
    if (new Set(ruleCodes).size !== ruleCodes.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['rules'], message: 'Los códigos de regla no pueden repetirse.' })
    }
    const knownRuleCodes = new Set(ruleCodes)
    for (const [index, group] of campaign.allowedRuleCodeGroups.entries()) {
      if (new Set(group).size !== group.length || group.some(ruleCode => !knownRuleCodes.has(ruleCode))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['allowedRuleCodeGroups', index],
          message: 'El grupo de stacking debe referenciar reglas únicas de esta versión.',
        })
      }
    }
  })

export const commercialCampaignDraftInputSchema = z
  .object({
    code,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable().optional(),
    startsAt: utcDateTime,
    endsAt: utcDateTime,
    stackingGroups: z.array(commercialCampaignStackingGroupV2Schema).max(50),
    rules: z.array(commercialCampaignRuleV2Schema).min(1).max(100),
  })
  .strict()
  .superRefine((campaign, context) => {
    if (Date.parse(campaign.startsAt) >= Date.parse(campaign.endsAt)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['endsAt'], message: 'La campaña debe terminar después de iniciar.' })
    }
    const ruleCodes = campaign.rules.map(rule => rule.code)
    if (new Set(ruleCodes).size !== ruleCodes.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['rules'], message: 'Los códigos de regla no pueden repetirse.' })
    }
    const knownRuleCodes = new Set(ruleCodes)
    const stackingGroupCodes = campaign.stackingGroups.map(group => group.code)
    if (new Set(stackingGroupCodes).size !== stackingGroupCodes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stackingGroups'],
        message: 'Los códigos de grupo de stacking no pueden repetirse.',
      })
    }
    const rulesByCode = new Map(campaign.rules.map(rule => [rule.code, rule]))
    for (const [index, group] of campaign.stackingGroups.entries()) {
      const ruleCodesInGroup = group.steps.map(step => step.ruleCode)
      const hasInvalidReferences =
        new Set(ruleCodesInGroup).size !== ruleCodesInGroup.length || ruleCodesInGroup.some(ruleCode => !knownRuleCodes.has(ruleCode))
      if (hasInvalidReferences) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stackingGroups', index],
          message: 'El grupo de stacking debe referenciar reglas únicas del borrador.',
        })
        continue
      }

      const sortedPositions = group.steps.map(step => step.position).sort((left, right) => left - right)
      if (sortedPositions.some((position, positionIndex) => position !== positionIndex + 1)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stackingGroups', index, 'steps'],
          message: 'Las posiciones del grupo de stacking deben ser consecutivas desde 1.',
        })
      }

      const orderedRules = [...group.steps]
        .sort((left, right) => left.position - right.position)
        .map(step => rulesByCode.get(step.ruleCode)!)
      const stackingClass = (type: (typeof orderedRules)[number]['type']): number => {
        if (type === 'FIXED_PRICE' || type === 'BUNDLE_PRICE') return 0
        if (type === 'PERCENT_OFF') return 1
        if (type === 'AMOUNT_OFF') return 2
        return 3
      }
      const classes = orderedRules.map(rule => stackingClass(rule.type))
      const baseRuleCount = orderedRules.filter(rule => rule.type === 'FIXED_PRICE' || rule.type === 'BUNDLE_PRICE').length
      if (
        orderedRules.some(rule => rule.type === 'FREE_PERIOD') ||
        baseRuleCount > 1 ||
        classes.some((currentClass, classIndex) => classIndex > 0 && currentClass < classes[classIndex - 1])
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stackingGroups', index, 'steps'],
          message: 'El grupo debe respetar el orden base, porcentaje y monto; FREE_PERIOD no se puede apilar.',
        })
      }

      if (new Set(orderedRules.map(rule => rule.cycles)).size !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stackingGroups', index, 'steps'],
          message: 'Todas las reglas de un grupo de stacking deben tener los mismos ciclos.',
        })
      }
    }
  })

const acquisitionAnalytics = {
  utmSource: boundedReference.optional(),
  utmMedium: boundedReference.optional(),
  utmCampaign: boundedReference.optional(),
  utmContent: boundedReference.optional(),
  utmTerm: boundedReference.optional(),
  gclid: boundedReference.optional(),
  fbclid: boundedReference.optional(),
}

const claimedAcquisitionRequestSchema = z
  .object({ campaignClaim: z.string().regex(/^[A-Za-z0-9_-]{43}$/), ...acquisitionAnalytics })
  .strict()
const unclaimedAcquisitionRequestSchema = z.object({ channel: z.enum(['ORGANIC', 'DIRECT']), ...acquisitionAnalytics }).strict()

export const commercialAcquisitionRequestSchema = z.union([claimedAcquisitionRequestSchema, unclaimedAcquisitionRequestSchema])

const quoteSelectionSchema = z
  .object({
    targetType: z.enum(['PRODUCT', 'BUNDLE']),
    targetCode: code,
    priceCode: code,
    quantity: z.number().int().min(1).max(1_000),
  })
  .strict()

export const commercialQuoteRequestSchema = z
  .object({
    market: z.literal('MX'),
    currency: z.literal('MXN'),
    acquisitionToken: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43,128}$/)
      .optional(),
    lines: z.array(quoteSelectionSchema).min(1).max(50),
  })
  .strict()

export const commercialAcquisitionContextRequestSchema = z.object({ body: commercialAcquisitionRequestSchema })
export const commercialQuotePreviewRequestSchema = z.object({ body: commercialQuoteRequestSchema })

const campaignIdParams = z.object({ id: z.string().trim().min(1).max(128) })
const campaignActivationParams = z.object({
  campaignCode: code,
  versionId: z.string().trim().min(1).max(128),
})
const campaignRevisionHeader = z
  .object({
    'if-match': z.string().regex(/^W\/"commercial-campaign:[^":]+:[1-9]\d*"$/),
  })
  .passthrough()
const campaignReason = z.string().trim().min(3).max(500)

export const commercialCampaignCreateDraftRequestSchema = z.object({
  body: z.object({ draft: commercialCampaignDraftInputSchema, reason: campaignReason }).strict(),
})
export const commercialCampaignReplaceDraftRequestSchema = z.object({
  params: campaignIdParams,
  headers: campaignRevisionHeader,
  body: z.object({ draft: commercialCampaignDraftInputSchema, reason: campaignReason }).strict(),
})
export const commercialCampaignIdRequestSchema = z.object({ params: campaignIdParams })
export const commercialCampaignPublishRequestSchema = z.object({
  params: campaignIdParams,
  body: z
    .object({
      expectedDraftRevision: z.number().int().positive(),
      expectedActivationRevision: z.number().int().positive().nullable(),
      reason: campaignReason,
      confirm: z.literal(true),
    })
    .strict(),
})
export const commercialCampaignActivateRequestSchema = z.object({
  params: campaignActivationParams,
  body: z
    .object({
      expectedActivationRevision: z.number().int().positive(),
      reason: campaignReason,
      confirm: z.literal(true),
    })
    .strict(),
})

export const commercialCampaignClaimRequestSchema = z.object({
  params: campaignActivationParams,
  body: z
    .object({
      channel: z.enum(['PAID_META', 'PAID_GOOGLE', 'SELLER', 'DISTRIBUTOR', 'PARTNER']),
      sourceRef: boundedReference,
      expiresAt: utcDateTime,
      reason: campaignReason,
      confirm: z.literal(true),
    })
    .strict(),
})
