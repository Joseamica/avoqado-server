import { BusinessType, CatalogIepsMode, CatalogItemKind, CatalogItemPriceKind, Prisma, ProductType, Unit } from '@prisma/client'
import {
  parseCatalogUnsignedDecimal,
  validateCatalogCurrencyV1,
  validateCatalogIepsFieldsV1,
  validateCatalogImageUrlV1,
  validateCatalogObjetoImpV1,
  validateCatalogSatProductKeyV1,
  validateCatalogSatUnitKeyV1,
} from './catalogItemValidation.service'
import { parseCatalogMoney } from './catalogMoney.service'
import { validateCatalogProductTypeV1 } from './catalogProductType.service'
import { normalizeCatalogCorporateSkuV1 } from './identifierNormalization.service'

const CREATE_INPUT_KEYS = [
  'brandId',
  'businessTypes',
  'description',
  'familyId',
  'iepsMode',
  'iepsQuota',
  'iepsQuotaUnit',
  'iepsRate',
  'imageUrl',
  'kind',
  'manufacturerId',
  'name',
  'objetoImp',
  'organizationValues',
  'presentationLabel',
  'productType',
  'satProductKey',
  'satUnitKey',
  'sku',
  'taxRate',
  'unit',
] as const

function sqlValues(values: readonly string[]): Prisma.Sql[] {
  return values.map(value => Prisma.sql`${value}`)
}

function jsonText(path: Prisma.Sql, maximum: number): Prisma.Sql {
  return Prisma.sql`(jsonb_typeof(${path}) = 'string' AND length((${path}) #>> '{}') BETWEEN 1 AND ${maximum})`
}

function jsonInteger(path: Prisma.Sql, maximum: number): Prisma.Sql {
  // WHY: A guarded spelling makes the cast total for corrupted durable JSON.
  return Prisma.sql`CASE WHEN jsonb_typeof(${path}) = 'number' AND (${path}) #>> '{}' ~ '^[1-9][0-9]{0,9}$'
    THEN ((${path}) #>> '{}')::bigint BETWEEN 1 AND ${maximum} ELSE false END`
}

function jsonArrayCap(path: Prisma.Sql, minimum: number, maximum: number): Prisma.Sql {
  // WHY: CASE is the evaluation barrier. No set-returning function is reached
  // here, and callers may expand only arrays whose cardinality already passed.
  return Prisma.sql`CASE WHEN jsonb_typeof(${path}) = 'array'
    THEN jsonb_array_length(${path}) BETWEEN ${minimum} AND ${maximum} ELSE false END`
}

export function catalogImportExactObjectShapeSql(
  path: Prisma.Sql,
  required: readonly string[],
  allowed: readonly string[] = required,
): Prisma.Sql {
  const requiredValues = sqlValues(required)
  const allowedValues = sqlValues(allowed)
  // WHY: PG14 has no jsonb_object_length, and CASE prevents jsonb subtraction
  // from running on a scalar where it would raise instead of returning 409.
  return Prisma.sql`CASE WHEN jsonb_typeof(${path}) = 'object' THEN
    ((${path}) ?& ARRAY[${Prisma.join(requiredValues)}]
    AND (${path}) - ARRAY[${Prisma.join(allowedValues)}] = '{}'::jsonb) ELSE false END`
}

export function catalogImportErrorsShapeSql(): Prisma.Sql {
  const keys = ['source_sheet', 'source_row', 'column', 'error_code', 'message', 'suggestion']
  // WHY: Persistence canonicalizes no findings as JSON null. INVALID alone
  // carries a bounded nonempty closed array, guarded before its SRF traversal.
  return Prisma.sql`CASE l."status"::text
    WHEN 'READY' THEN (l."errors" IS NULL OR jsonb_typeof(l."errors") = 'null' OR l."errors" = '[]'::jsonb)
    WHEN 'APPLIED' THEN (l."errors" IS NULL OR jsonb_typeof(l."errors") = 'null' OR l."errors" = '[]'::jsonb)
    WHEN 'INVALID' THEN CASE WHEN jsonb_typeof(l."errors") = 'array' THEN
      CASE WHEN jsonb_array_length(l."errors") BETWEEN 1 AND 128 THEN
        NOT EXISTS (SELECT 1 FROM jsonb_array_elements(l."errors") finding(value) WHERE NOT (
          ${catalogImportExactObjectShapeSql(Prisma.sql`finding.value`, keys, [...keys, 'rejected_value'])}
          AND ${jsonText(Prisma.sql`finding.value -> 'source_sheet'`, 64)}
          AND ${jsonInteger(Prisma.sql`finding.value -> 'source_row'`, 2_147_483_647)}
          AND ${jsonText(Prisma.sql`finding.value -> 'column'`, 128)}
          AND ${jsonText(Prisma.sql`finding.value -> 'error_code'`, 128)}
          AND ${jsonText(Prisma.sql`finding.value -> 'message'`, 512)}
          AND ${jsonText(Prisma.sql`finding.value -> 'suggestion'`, 512)}
          AND (NOT (finding.value ? 'rejected_value') OR ${jsonText(Prisma.sql`finding.value -> 'rejected_value'`, 256)})))
        ELSE false END ELSE false END
    ELSE false END`
}

function minimalInvalidPayloadShapeSql(): Prisma.Sql {
  return Prisma.sql`(l."status"::text = 'INVALID'
    AND ${catalogImportExactObjectShapeSql(Prisma.sql`l."payload"`, ['schemaVersion'])}
    AND l."payload" -> 'schemaVersion' = '1'::jsonb)`
}

function itemPayloadShapeSql(): Prisma.Sql {
  const updateKeys = [...CREATE_INPUT_KEYS, 'catalogItemId', 'expectedRevision', 'organizationValueDeactivations']
  const proposals = Prisma.sql`l."payload" -> 'referenceProposals'`
  const bindings = Prisma.sql`l."payload" -> 'venueBindingRequests'`
  const values = Prisma.sql`l."payload" #> '{command,input,organizationValues}'`
  const businessTypes = Prisma.sql`l."payload" #> '{command,input,businessTypes}'`
  const deactivations = Prisma.sql`l."payload" #> '{command,input,organizationValueDeactivations}'`
  // WHY: Read SQL certifies only closed containers and cardinality. The shared
  // JS projector checks visible semantics, while confirmation reparses all
  // hash-bound payloads with Task 5 immediately before any mutation.
  return Prisma.sql`(${catalogImportExactObjectShapeSql(Prisma.sql`l."payload"`, [
    'schemaVersion',
    'command',
    'referenceProposals',
    'venueBindingRequests',
  ])}
    AND l."payload" -> 'schemaVersion' = '1'::jsonb
    AND ${catalogImportExactObjectShapeSql(Prisma.sql`l."payload" -> 'command'`, ['operation', 'input'])}
    AND ${jsonArrayCap(proposals, 0, 4)} AND ${jsonArrayCap(bindings, 0, 20_000)}
    AND CASE l."payload" #>> '{command,operation}'
      WHEN 'CREATE' THEN ${catalogImportExactObjectShapeSql(Prisma.sql`l."payload" #> '{command,input}'`, CREATE_INPUT_KEYS)}
        AND ${jsonArrayCap(values, 0, 20_000)} AND ${jsonArrayCap(businessTypes, 0, 100)}
      WHEN 'UPDATE' THEN ${catalogImportExactObjectShapeSql(Prisma.sql`l."payload" #> '{command,input}'`, updateKeys)}
        AND ${jsonArrayCap(values, 0, 20_000)} AND ${jsonArrayCap(businessTypes, 0, 100)}
        AND ${jsonArrayCap(deactivations, 0, 20_000)}
      WHEN 'RETIRE' THEN ${catalogImportExactObjectShapeSql(Prisma.sql`l."payload" #> '{command,input}'`, [
        'catalogItemId',
        'expectedRevision',
      ])} AND ${proposals} = '[]'::jsonb AND ${bindings} = '[]'::jsonb
      ELSE false END
    AND ${catalogImportErrorsShapeSql()})`
}

export function catalogImportItemLineShapeSql(): Prisma.Sql {
  return Prisma.sql`(${itemPayloadShapeSql()} OR (${minimalInvalidPayloadShapeSql()} AND ${catalogImportErrorsShapeSql()}))`
}

function reviewPayloadShapeSql(section: string, keys: readonly string[]): Prisma.Sql {
  return Prisma.sql`(${catalogImportExactObjectShapeSql(Prisma.sql`l."payload"`, keys)}
    AND l."payload" -> 'schemaVersion' = '1'::jsonb AND l."payload" ->> 'section' = ${section})`
}

export function catalogImportReviewLineShapeSql(section: string, keys: readonly string[]): Prisma.Sql {
  return Prisma.sql`((${reviewPayloadShapeSql(section, keys)} OR ${minimalInvalidPayloadShapeSql()})
    AND ${catalogImportErrorsShapeSql()})`
}

export function catalogImportPayloadIntegritySql(): Prisma.Sql {
  const orgKeys = ['schemaVersion', 'section', 'corporateSku', 'kind', 'amount', 'currency', 'expectedRuleRevision']
  const businessKeys = ['schemaVersion', 'section', 'corporateSku', 'businessType']
  const bindingKeys = [
    'schemaVersion',
    'section',
    'corporateSku',
    'venueId',
    'requestedAction',
    'productId',
    'localSku',
    'categoryId',
    'initialPrice',
    'currency',
  ]
  return Prisma.sql`CASE l."sourceSheet"
    WHEN 'Items' THEN ${catalogImportItemLineShapeSql()}
    WHEN 'OrganizationValues' THEN ${catalogImportReviewLineShapeSql('ORGANIZATION_VALUES', orgKeys)}
    WHEN 'BusinessTypes' THEN ${catalogImportReviewLineShapeSql('BUSINESS_TYPES', businessKeys)}
    WHEN 'VenueBindingRequests' THEN ${catalogImportReviewLineShapeSql('VENUE_BINDING_REQUESTS', bindingKeys)}
    WHEN 'Metadata' THEN (${minimalInvalidPayloadShapeSql()} AND ${catalogImportErrorsShapeSql()})
    ELSE false END`
}

export function catalogImportLineIdentitySql(): Prisma.Sql {
  // WHY: FK identity is structural staging authority even though Task 5 leaf
  // canonicality remains confirmation's responsibility.
  return Prisma.sql`CASE WHEN l."sourceSheet" <> 'Items' THEN l."catalogItemId" IS NULL
    WHEN l."status"::text = 'INVALID' THEN l."catalogItemId" IS NULL OR length(l."catalogItemId") BETWEEN 1 AND 256
    WHEN l."payload" #>> '{command,operation}' = 'CREATE' THEN CASE l."status"::text
      WHEN 'APPLIED' THEN length(l."catalogItemId") BETWEEN 1 AND 256 ELSE l."catalogItemId" IS NULL END
    WHEN l."payload" #>> '{command,operation}' IN ('UPDATE','RETIRE') THEN
      l."catalogItemId" = l."payload" #>> '{command,input,catalogItemId}'
    ELSE false END`
}

export function catalogImportProjectedItemSemanticsValid(status: string, operation: string | null, kind: string | null): boolean {
  return (
    (operation !== null || status === 'INVALID') &&
    (operation === null || ['CREATE', 'UPDATE', 'RETIRE'].includes(operation)) &&
    (kind === null || Object.values(CatalogItemKind).includes(kind as CatalogItemKind))
  )
}

interface ProjectedItemIdentity {
  status: string
  operation: string | null
  catalogItemId: string | null
  corporateSku: string | null
  name: string | null
  itemKind: string | null
}

function nonblank(value: string | null): value is string {
  return value !== null && value.trim().length > 0
}

export function catalogImportProjectedItemIdentityValid(input: ProjectedItemIdentity): boolean {
  if (!catalogImportProjectedItemSemanticsValid(input.status, input.operation, input.itemKind)) return false
  // WHY: Minimal INVALID rows intentionally have no command leaves; their
  // diagnostics, not a fabricated item identity, are the review authority.
  if (input.status === 'INVALID') return true
  if (input.operation === 'RETIRE') {
    return nonblank(input.catalogItemId) && input.corporateSku === null && input.name === null && input.itemKind === null
  }
  if (input.operation !== 'CREATE' && input.operation !== 'UPDATE') return false
  if (!nonblank(input.corporateSku) || !nonblank(input.name) || input.itemKind === null) return false
  try {
    normalizeCatalogCorporateSkuV1({ code: input.corporateSku, format: 'SKU' })
  } catch {
    return false
  }
  return input.operation === 'CREATE' && input.status === 'READY' ? input.catalogItemId === null : nonblank(input.catalogItemId)
}

export interface ProjectedItemDetailSemantics extends ProjectedItemIdentity {
  description: string | null
  imageUrl: string | null
  brandId: string | null
  manufacturerId: string | null
  familyId: string | null
  presentationLabel: string | null
  unit: string | null
  productType: string | null
  taxRate: string | null
  satProductKey: string | null
  satUnitKey: string | null
  objetoImp: string | null
  iepsMode: string | null
  iepsRate: string | null
  iepsQuota: string | null
  iepsQuotaUnit: string | null
}

export function catalogImportProjectedItemDetailSemanticsValid(input: ProjectedItemDetailSemantics): boolean {
  if (!catalogImportProjectedItemIdentityValid(input) || input.status === 'INVALID') return input.status === 'INVALID'
  const requiredDetail = [
    input.description,
    input.imageUrl,
    input.brandId,
    input.manufacturerId,
    input.familyId,
    input.presentationLabel,
    input.unit,
    input.productType,
    input.taxRate,
    input.satProductKey,
    input.satUnitKey,
    input.objetoImp,
    input.iepsMode,
  ]
  if (input.operation === 'RETIRE') {
    return [...requiredDetail, input.iepsRate, input.iepsQuota, input.iepsQuotaUnit].every(value => value === null)
  }
  if (requiredDetail.some(value => !nonblank(value))) return false
  if (
    !Object.values(Unit).includes(input.unit as Unit) ||
    !Object.values(ProductType).includes(input.productType as ProductType) ||
    !Object.values(CatalogIepsMode).includes(input.iepsMode as CatalogIepsMode)
  ) {
    return false
  }
  try {
    validateCatalogProductTypeV1({ kind: input.itemKind as CatalogItemKind, productType: input.productType as ProductType })
    if (validateCatalogImageUrlV1(input.imageUrl) !== input.imageUrl) return false
    if (parseCatalogUnsignedDecimal(input.taxRate, 4, '1.0000', 'taxRate') !== input.taxRate) return false
    if (validateCatalogSatProductKeyV1(input.satProductKey) !== input.satProductKey) return false
    if (validateCatalogSatUnitKeyV1(input.satUnitKey) !== input.satUnitKey) return false
    if (validateCatalogObjetoImpV1(input.objetoImp) !== input.objetoImp) return false
    const ieps = validateCatalogIepsFieldsV1({
      iepsMode: input.iepsMode as CatalogIepsMode,
      iepsRate: input.iepsRate,
      iepsQuota: input.iepsQuota,
      iepsQuotaUnit: input.iepsQuotaUnit as Unit | null,
    })
    return ieps.iepsRate === input.iepsRate && ieps.iepsQuota === input.iepsQuota
  } catch {
    return false
  }
}

export function catalogImportProjectedValueSemanticsValid(kind: string | null, currency: string | null, amount: string | null): boolean {
  if (kind !== null && !Object.values(CatalogItemPriceKind).includes(kind as CatalogItemPriceKind)) return false
  try {
    if (currency !== null && validateCatalogCurrencyV1(currency) !== currency) return false
    if (amount !== null && parseCatalogMoney(amount) !== amount) return false
    return true
  } catch {
    return false
  }
}

export function catalogImportProjectedBusinessTypeValid(value: string | null): boolean {
  return value === null || Object.values(BusinessType).includes(value as BusinessType)
}

export function catalogImportProjectedBindingSemanticsValid(input: {
  action: string | null
  productId: string | null
  localSku: string | null
  categoryId: string | null
  price: string | null
  currency: string | null
}): boolean {
  if (input.action !== null && !['LINK', 'CREATE', 'SKIP'].includes(input.action)) return false
  if (!catalogImportProjectedValueSemanticsValid(null, input.currency, input.price)) return false
  const optional = [input.productId, input.localSku, input.categoryId, input.price, input.currency]
  return (
    (input.action === 'LINK' && input.productId !== null && optional.slice(1).every(value => value === null)) ||
    (input.action === 'CREATE' && input.productId === null && optional.slice(1).every(value => value !== null)) ||
    (input.action === 'SKIP' && optional.every(value => value === null))
  )
}
