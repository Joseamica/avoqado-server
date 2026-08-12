import { z } from 'zod'
import { BusinessType, CatalogIepsMode, CatalogItemKind, ProductType, Unit, VenueOperationalRole, type Prisma } from '@prisma/client'
import { catalogImportConfirmRequestSchema, catalogImportPreviewRequestSchema } from './masterCatalogImport.schema'
import { CATALOG_ORGANIZATION_VALUE_MAX_V1 } from '../../services/master-catalog/catalogItemValidation.service'
import { CATALOG_RETAIL_MANAGED_FIELD_MASK_V1 } from '../../types/master-catalog'

const id = z
  .string()
  .min(1)
  .max(256)
  .refine(value => value.trim() === value, 'El identificador no puede tener espacios exteriores.')
const opaque = z
  .string()
  .min(1)
  .max(256)
  .refine(value => value.trim().length > 0, 'El valor es requerido.')

export const catalogPublicationOperationSchema = z.enum([
  'CATALOG_FIELDS_PUBLISH',
  'CATALOG_FIELDS_REVERSION',
  'CATALOG_PRODUCT_ACTIVATION',
])

export const catalogOrganizationParamsSchema = z.object({ orgId: id })
export const catalogPublicationParamsSchema = z.object({ orgId: id, publicationBatchId: id })
export const catalogPublicationLookupParamsSchema = z.object({
  orgId: id,
  operation: catalogPublicationOperationSchema,
  idempotencyKey: opaque,
})

export const catalogPublicationListQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    operation: catalogPublicationOperationSchema.optional(),
    state: z.enum(['NOT_STARTED', 'PREVIEWED', 'APPLYING', 'APPLIED', 'FAILED', 'EXPIRED', 'SUPERSEDED']).optional(),
  })
  .strict()

export const catalogItemListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    status: z.enum(['ACTIVE', 'RETIRED']).optional(),
  })
  .strict()

export const catalogReferenceListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    status: z.enum(['ACTIVE', 'RETIRED']).optional(),
  })
  .strict()

export const catalogVenueChangesQuerySchema = z
  .object({ cursor: z.string().min(1).max(512).optional(), pageSize: z.coerce.number().int().min(1).max(100).optional() })
  .strict()

export const catalogActivityLogQuerySchema = z
  .object({
    venueId: id.optional(),
    staffId: id.optional(),
    action: z.string().min(1).max(128).optional(),
    entity: z.string().min(1).max(128).optional(),
    search: z.string().min(1).max(200).optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    page: z.coerce.number().int().min(1).max(100_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()

const revision = z.number().int().min(1).max(2_147_483_646)
const text = z.string().min(1).max(4096)
const bodyId = z.string().min(1).max(256)
const opaqueKey = z
  .string()
  .min(1)
  .max(256)
  .refine(value => value.trim().length > 0)
const previewToken = z.string().min(1).max(512)
const confirmFields = { previewToken, confirm: z.literal(true), idempotencyKey: opaqueKey }

const organizationValue = z
  .object({
    kind: z.enum(['SALE_PRICE', 'PURCHASE_COST']),
    amount: z.string().min(1).max(128),
    currency: z.string().min(3).max(3),
    expectedRuleRevision: revision.optional(),
  })
  .strict()
const organizationValueDeactivation = z
  .object({ kind: z.enum(['SALE_PRICE', 'PURCHASE_COST']), currency: z.string().length(3), expectedRuleRevision: revision })
  .strict()
const catalogItemBaseBodySchema = z
  .object({
    sku: text,
    kind: z.nativeEnum(CatalogItemKind),
    name: text,
    description: text,
    imageUrl: text,
    brandId: bodyId,
    manufacturerId: bodyId,
    familyId: bodyId,
    presentationLabel: text,
    unit: z.nativeEnum(Unit),
    taxRate: z.string().min(1).max(128),
    satProductKey: text,
    satUnitKey: text,
    objetoImp: text,
    productType: z.nativeEnum(ProductType),
    iepsMode: z.nativeEnum(CatalogIepsMode),
    iepsRate: z.string().max(128).nullable(),
    iepsQuota: z.string().max(128).nullable(),
    iepsQuotaUnit: z.nativeEnum(Unit).nullable(),
    businessTypes: z.array(z.nativeEnum(BusinessType)).min(1).max(64),
    organizationValues: z.array(organizationValue).min(2).max(CATALOG_ORGANIZATION_VALUE_MAX_V1),
  })
  .strict()

const referenceCreate = z.object({ name: text }).strict()
const referenceUpdate = referenceCreate.extend({ expectedRevision: revision }).strict()
const referenceRetire = z.object({ expectedRevision: revision }).strict()
const familyCreate = referenceCreate.extend({ parentId: bodyId.nullish() }).strict()
const familyUpdate = familyCreate.extend({ expectedRevision: revision }).strict()
const profilePreview = z
  .object({
    idempotencyKey: opaqueKey,
    name: z.string().min(1).max(120),
    businessType: z.nativeEnum(BusinessType).nullable().optional(),
    operationalRole: z.nativeEnum(VenueOperationalRole).nullable().optional(),
    requiredFields: z.array(z.string().min(1).max(128)).max(256),
    // Task 6 remains the semantic/bounded JSON authority; this composed edge
    // only closes the command shape while preserving its Prisma JSON type.
    additionalRules: z.record(z.custom<Prisma.InputJsonValue>()).nullable().optional(),
  })
  .strict()
const confirmBody = z.object(confirmFields).strict()

const bindingDecision = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('LINK'), productId: bodyId }).strict(),
  z
    .object({
      decision: z.literal('CREATE'),
      create: z.object({ categoryId: bodyId, localSku: text, initialPrice: z.string().min(1).max(128) }).strict(),
    })
    .strict(),
  z.object({ decision: z.literal('SKIP') }).strict(),
])
const bindingPreview = z
  .object({
    lines: z
      .array(z.object({ catalogItemId: bodyId, venueId: bodyId, decision: bindingDecision.optional() }).strict())
      .min(1)
      .max(100),
  })
  .strict()

const managedField = z.enum(CATALOG_RETAIL_MANAGED_FIELD_MASK_V1)
const publicationDecision = z.discriminatedUnion('decision', [
  z.object({ field: managedField, decision: z.literal('PUBLISH_CORPORATE') }).strict(),
  z.object({ field: managedField, decision: z.literal('APPROVE_LOCAL_OVERRIDE'), overrideId: bodyId }).strict(),
  z.object({ field: managedField, decision: z.literal('UNDECIDED') }).strict(),
])
const publicationTarget = z
  .object({ catalogItemId: bodyId, venueId: bodyId, productId: bodyId, decisions: z.array(publicationDecision).max(32).optional() })
  .strict()
const activationTarget = z.object({ catalogItemId: bodyId, venueId: bodyId, productId: bodyId }).strict()
const reversionTarget = activationTarget.extend({ sourceLineId: bodyId }).strict()
const publicationPreview = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('CATALOG_FIELDS_PUBLISH'),
      idempotencyKey: opaqueKey,
      targets: z.array(publicationTarget).min(1).max(10_000),
    })
    .strict(),
  z
    .object({ operation: z.literal('CATALOG_PRODUCT_ACTIVATION'), idempotencyKey: opaqueKey, targets: z.array(activationTarget).length(1) })
    .strict(),
  z
    .object({
      operation: z.literal('CATALOG_FIELDS_REVERSION'),
      idempotencyKey: opaqueKey,
      targets: z.array(reversionTarget).min(1).max(10_000),
    })
    .strict(),
])
const publicationReversal = z.object({ idempotencyKey: opaqueKey, targets: z.array(reversionTarget).min(1).max(10_000) }).strict()
const overridePreview = z
  .object({
    bindingId: bodyId,
    idempotencyKey: z.string().min(1).max(200),
    requests: z
      .array(z.object({ field: managedField, reason: z.string().min(1).max(2_000) }).strict())
      .min(1)
      .max(25),
  })
  .strict()

export const catalogCommandBodySchemas = {
  createItem: catalogItemBaseBodySchema,
  updateItem: catalogItemBaseBodySchema
    .extend({
      expectedRevision: revision,
      organizationValueDeactivations: z.array(organizationValueDeactivation).max(CATALOG_ORGANIZATION_VALUE_MAX_V1),
    })
    .strict(),
  retireItem: referenceRetire,
  previewValidationProfile: profilePreview,
  confirmValidationProfile: confirmBody,
  createBrand: referenceCreate,
  updateBrand: referenceUpdate,
  retireBrand: referenceRetire,
  createManufacturer: referenceCreate,
  updateManufacturer: referenceUpdate,
  retireManufacturer: referenceRetire,
  createFamily: familyCreate,
  updateFamily: familyUpdate,
  retireFamily: referenceRetire,
  confirmImport: catalogImportConfirmRequestSchema.shape.body.strict(),
  previewBindings: bindingPreview,
  confirmBindings: confirmBody.extend({ bindingBatchId: bodyId }).strict(),
  previewPublication: publicationPreview,
  confirmPublication: confirmBody,
  previewPublicationReversal: publicationReversal,
  previewVenueOverride: overridePreview,
  confirmVenueOverride: confirmBody,
} as const

export const catalogCommandRequestSchemas = {
  previewImport: catalogImportPreviewRequestSchema,
  confirmImport: catalogImportConfirmRequestSchema.extend({ body: catalogCommandBodySchemas.confirmImport }).strict(),
} as const

// Task 7 owns the multipart/token schemas; this facade reexports those exact
// authorities instead of recreating bearer or confirm validation.
export { catalogImportConfirmRequestSchema, catalogImportPreviewRequestSchema }
