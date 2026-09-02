import { z } from 'zod'
import { MAX_COMMERCIAL_MONEY_MINOR } from '@/contracts/commercial/commercialContractV2.constants'

const code = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'Usa mayúsculas, números y guion bajo.')
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Usa minúsculas y guiones.')
const exactPesos = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/, 'El importe debe ser una cadena de pesos con máximo dos decimales.')

export const commercialDraftInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable().optional(),
    products: z.array(
      z
        .object({
          code,
          slug,
          kind: z.enum(['PLAN', 'POS', 'MODULE']),
          salesMode: z.enum(['SELF_SERVICE', 'CONTACT']),
          name: z.string().trim().min(1).max(120),
          description: z.string().trim().min(1).max(500),
          active: z.boolean(),
          sortOrder: z.number().int().min(0).max(10000),
          limits: z
            .object({ users: z.literal('UNLIMITED'), devices: z.literal('UNLIMITED') })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    pricebooks: z.array(z.object({ code, name: z.string().trim().min(1).max(120), active: z.boolean() }).strict()),
    prices: z.array(
      z
        .object({
          code,
          pricebookCode: code,
          productCode: code.optional(),
          bundleCode: code.optional(),
          billingUnit: z.enum(['VENUE_MONTH', 'VENUE_YEAR']),
          amount: exactPesos,
          taxBehavior: z.enum(['EXCLUSIVE', 'NOT_APPLICABLE']),
          active: z.boolean(),
        })
        .strict(),
    ),
    bundles: z.array(
      z
        .object({
          code,
          slug,
          name: z.string().trim().min(1).max(120),
          description: z.string().trim().min(1).max(500),
          active: z.boolean(),
          sortOrder: z.number().int().min(0).max(10000),
        })
        .strict(),
    ),
    bundleItems: z.array(
      z
        .object({
          bundleCode: code,
          productCode: code,
          quantity: z.literal(1),
          sortOrder: z.number().int().min(0).max(10000),
        })
        .strict(),
    ),
    featureBindings: z.array(
      z
        .object({
          productCode: code,
          capabilityCode: z.string(),
          capabilityKind: z.enum(['FEATURE', 'MODULE', 'CORE']),
        })
        .strict(),
    ),
  })
  .strict()

export const commercialDraftActorSchema = z
  .object({
    staffId: z.string().min(1),
    reason: z.string().trim().min(3).max(500),
    ipAddress: z.string().max(64).optional(),
    userAgent: z.string().max(1000).optional(),
  })
  .strict()

export const commercialExpectedRevisionSchema = z.number().int().positive().max(2_147_483_647)

const commercialIdParams = z.object({ id: z.string().trim().min(1).max(128) })
const strongRevisionHeader = z
  .object({
    'if-match': z.string().regex(/^W\/"commercial-draft:[^":]+:[1-9]\d*"$/, 'If-Match debe identificar el borrador y una revisión exacta.'),
  })
  .passthrough()
const reason = z.string().trim().min(3).max(500)

export const commercialCreateDraftRequestSchema = z.object({
  body: z.object({ draft: commercialDraftInputSchema, reason }).strict(),
})

export const commercialReplaceDraftRequestSchema = z.object({
  params: commercialIdParams,
  headers: strongRevisionHeader,
  body: z.object({ draft: commercialDraftInputSchema, reason }).strict(),
})

export const commercialIdRequestSchema = z.object({ params: commercialIdParams })

export const commercialPreviewRequestSchema = z.object({
  params: commercialIdParams,
  body: z.object({ expectedRevision: commercialExpectedRevisionSchema }).strict(),
})

export const commercialPublishRequestSchema = z.object({
  params: commercialIdParams,
  body: z
    .object({
      expectedRevision: commercialExpectedRevisionSchema,
      previewToken: z.string().min(10).max(2048),
      checksum: z.string().regex(/^[0-9a-f]{64}$/),
      reason,
      confirm: z.literal(true),
    })
    .strict(),
})

export const commercialActivateRequestSchema = z.object({
  params: commercialIdParams,
  body: z
    .object({
      expectedActivationRevision: z.number().int().min(0).max(2_147_483_647),
      reason,
      confirm: z.literal(true),
    })
    .strict(),
})

export const commercialEmergencyReactivateV1RequestSchema = z.object({
  params: commercialIdParams,
  body: z
    .object({
      expectedActivationRevision: z.number().int().positive().max(2_147_483_647),
      reason,
      confirm: z.literal(true),
    })
    .strict(),
})

const commercialOutboxIdParams = z.object({ id: z.string().trim().min(1).max(128) }).strict()
const commercialOutboxInspectionErrorCode = z.enum([
  'COMMERCIAL_OUTBOX_PAYLOAD_UNSUPPORTED',
  'COMMERCIAL_OUTBOX_SCHEMA_FUTURE',
  'COMMERCIAL_OUTBOX_CONTRACT_FUTURE',
  'COMMERCIAL_OUTBOX_AUTHORITY_UNAVAILABLE',
  'COMMERCIAL_OUTBOX_DELIVERY_FAILED',
  'COMMERCIAL_OUTBOX_LEGACY_ERROR',
])

export const commercialOutboxFailedListRequestSchema = z.object({
  query: z
    .object({
      cursor: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,2048}$/)
        .optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    })
    .strict(),
})

export const commercialOutboxFailedIdRequestSchema = z.object({ params: commercialOutboxIdParams })

export const commercialOutboxRequeueRequestSchema = z.object({
  params: commercialOutboxIdParams,
  body: z
    .object({
      observedAttempts: z.number().int().min(0).max(2_147_483_647),
      observedLastErrorCode: commercialOutboxInspectionErrorCode,
      reason,
      confirm: z.literal(true),
    })
    .strict(),
})

const commercialBillingId = z.string().trim().min(1).max(128)
const commercialManualSpeiTenantBody = {
  organizationId: commercialBillingId,
  venueId: commercialBillingId,
}
const commercialManualSpeiCaseParams = z.object({ caseId: commercialBillingId }).strict()
const commercialManualSpeiEvidenceParams = z.object({ evidenceId: commercialBillingId }).strict()
const commercialPositiveMoneyMinor = z
  .string()
  .regex(/^[1-9]\d{0,15}$/u, 'El importe debe ser una cadena entera positiva en centavos.')
  .transform(value => BigInt(value))
  .refine(value => value <= MAX_COMMERCIAL_MONEY_MINOR, 'El importe excede el máximo permitido.')
const commercialManualSpeiStatus = z.enum(['PENDING_REVIEW', 'AWAITING_APPROVAL', 'READY_TO_RECONCILE', 'RECONCILED', 'REJECTED'])

export const commercialManualSpeiListRequestSchema = z.object({
  query: z
    .object({
      organizationId: commercialBillingId.optional(),
      venueId: commercialBillingId.optional(),
      status: commercialManualSpeiStatus.optional(),
      cursor: commercialBillingId.optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    })
    .strict(),
})

export const commercialManualSpeiCaseRequestSchema = z.object({ params: commercialManualSpeiCaseParams })

export const commercialManualSpeiEvidenceAccessRequestSchema = z.object({
  params: commercialManualSpeiEvidenceParams,
  query: z.object(commercialManualSpeiTenantBody).strict(),
})

export const commercialManualSpeiCreateCaseRequestSchema = z.object({
  body: z
    .object({
      ...commercialManualSpeiTenantBody,
      receivableId: commercialBillingId,
      paymentAttemptId: commercialBillingId,
      observedAmountMinor: commercialPositiveMoneyMinor,
      bankReference: z.string().trim().min(1).max(128).nullable(),
      receivingAccountFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
      observedAt: z
        .string()
        .datetime({ offset: true })
        .transform(value => new Date(value)),
      attributedCommercialActorIds: z
        .array(commercialBillingId)
        .max(50)
        .superRefine((actors, ctx) => {
          if (new Set(actors).size !== actors.length) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'No se permiten actores comerciales duplicados.' })
          }
        }),
    })
    .strict(),
})

export const commercialManualSpeiRegisterEvidenceRequestSchema = z.object({
  params: commercialManualSpeiCaseParams,
  body: z
    .object({
      ...commercialManualSpeiTenantBody,
      storageObjectKey: z.string().min(1).max(512),
      contentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
      mimeType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
      sizeBytes: z
        .number()
        .int()
        .min(1)
        .max(10 * 1024 * 1024),
    })
    .strict(),
})

export const commercialManualSpeiReviewEvidenceRequestSchema = z.object({
  params: commercialManualSpeiEvidenceParams,
  body: z
    .object({
      ...commercialManualSpeiTenantBody,
      action: z.enum(['ACCEPT', 'REJECT']),
      reason: z.string().trim().min(1).max(500).nullable(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.action === 'REJECT' && value.reason === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'Se requiere motivo para rechazar.' })
      }
    }),
})

export const commercialManualSpeiSupersedeEvidenceRequestSchema = z.object({
  params: commercialManualSpeiEvidenceParams,
  body: z
    .object({
      ...commercialManualSpeiTenantBody,
      reason: z.string().trim().min(1).max(500),
      confirm: z.literal(true),
    })
    .strict(),
})

export const commercialManualSpeiApproveCaseRequestSchema = z.object({
  params: commercialManualSpeiCaseParams,
  body: z.object({ ...commercialManualSpeiTenantBody, confirm: z.literal(true) }).strict(),
})
