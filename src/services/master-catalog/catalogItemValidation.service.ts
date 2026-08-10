import { BusinessType, CatalogIepsMode, CatalogItemPriceKind, Prisma, Unit } from '@prisma/client'
import AppError, { ConflictError } from '../../errors/AppError'
import type {
  CatalogOrganizationValueDeactivationInput,
  CatalogOrganizationValueInput,
  CreateCatalogItemInput,
  UpdateCatalogItemInput,
  ValidatedCatalogItem,
} from './catalogItem.types'
import { canonicalCatalogDecimal, parseCatalogMoney } from './catalogMoney.service'
import { validateCatalogProductTypeV1 } from './catalogProductType.service'
import { normalizeCatalogCorporateSkuV1 } from './identifierNormalization.service'

// WHY: Freeze H1's ISO-4217 tender codes instead of depending on host ICU;
// previews and confirms must classify the same currency on every runtime.
const ISO_4217_CURRENCY_V1 = new Set(
  `AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUC CUP CVE CZK
   DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF
   KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP
   PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU
   UZS VES VND VUV WST XAF XCD XCG XDR XOF XPF XSU YER ZAR ZMW ZWG ZWL`
    .trim()
    .split(/\s+/u),
)

// WHY: A complete organization-value replacement has at most one SALE and
// one PURCHASE row per frozen currency; durable import parsers use this same
// authority to reject attacker-sized arrays before synchronous Task 5 work.
export const CATALOG_ORGANIZATION_VALUE_MAX_V1 = ISO_4217_CURRENCY_V1.size * 2

function failValidation(code: string, message: string): never {
  throw new AppError(message, 422, true, code)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  // WHY: JSON command rows are dictionaries; rejecting exotic prototypes also
  // prevents inherited fields from satisfying fiscal/value validation.
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function validateCatalogExpectedRevision(value: unknown, field: string, code = 'CATALOG_REVISION_INVALID'): number {
  // WHY: Every mutation increments a PostgreSQL INTEGER; the highest accepted
  // CAS token leaves room for +1 and rejects coercions before Prisma sees them.
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2_147_483_646) {
    failValidation(code, `${field} debe ser un entero positivo vigente.`)
  }
  return value
}

export function validateCatalogCurrencyV1(value: unknown): string {
  // WHY: Import diagnostics call the same frozen ISO-4217 authority as Task 5
  // instead of accepting any three uppercase letters at the workbook edge.
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value) || !ISO_4217_CURRENCY_V1.has(value)) {
    failValidation('CATALOG_CURRENCY_INVALID', 'La moneda debe ser ISO-4217 en mayúsculas.')
  }
  return value
}

function requiredText(value: unknown, field: string): string {
  // WHY: CatalogItem has no incomplete state, so blank baseline text fails at
  // the pure boundary before an authoritative FK-backed row can be inserted.
  if (typeof value !== 'string' || value.trim().length === 0) failValidation('CATALOG_BASELINE_INCOMPLETE', `${field} es requerido.`)
  return value.trim()
}

export function validateCatalogImageUrlV1(value: unknown): string {
  // WHY: Import previews and Task 5 commands must classify the exact same URL
  // contract without copying protocol or required-text rules between layers.
  const imageUrl = requiredText(value, 'imageUrl')
  try {
    const parsed = new URL(imageUrl)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('unsafe protocol')
  } catch {
    return failValidation('CATALOG_IMAGE_URL_INVALID', 'imageUrl debe ser una URL HTTP segura.')
  }
  return imageUrl
}

export function validateCatalogSatProductKeyV1(value: unknown): string {
  // WHY: Reuse the operational CFDI 4.0 wire contract so catalog publication
  // cannot accept a SAT key that existing Product validation rejects.
  const key = requiredText(value, 'satProductKey')
  if (!/^\d{8}$/.test(key)) failValidation('CATALOG_SAT_PRODUCT_KEY_INVALID', 'satProductKey debe tener exactamente 8 dígitos.')
  return key
}

export function validateCatalogSatUnitKeyV1(value: unknown): string {
  // WHY: The existing menu/CFDI boundary accepts trimmed SAT unit codes up to
  // 20 characters; master catalog must not create a stricter/different wire row.
  const key = requiredText(value, 'satUnitKey')
  if (key.length > 20) failValidation('CATALOG_SAT_UNIT_KEY_INVALID', 'satUnitKey no puede exceder 20 caracteres.')
  return key
}

export function validateCatalogObjetoImpV1(value: unknown): string {
  // WHY: These are the four ObjetoImp codes accepted by the existing CFDI 4.0
  // product contract, so catalog and venue publication validate the same set.
  const code = requiredText(value, 'objetoImp')
  if (!['01', '02', '03', '04'].includes(code)) failValidation('CATALOG_OBJETO_IMP_INVALID', 'objetoImp no es válido.')
  return code
}

export function parseCatalogUnsignedDecimal(input: unknown, scale: number, maximum: string, field: string): string {
  // WHY: One reusable string-only parser prevents JS-number rounding from
  // changing fiscal values between validation, hashing, and Decimal storage.
  if (typeof input !== 'string') failValidation('CATALOG_DECIMAL_INVALID', `${field} debe enviarse como texto decimal.`)
  let canonical: string
  try {
    canonical = canonicalCatalogDecimal(input, scale)
  } catch {
    return failValidation('CATALOG_DECIMAL_INVALID', `${field} tiene una precisión inválida.`)
  }
  const decimal = new Prisma.Decimal(canonical)
  if (decimal.isNegative() || decimal.greaterThan(maximum)) failValidation('CATALOG_DECIMAL_INVALID', `${field} está fuera de rango.`)
  return canonical
}

export function validateCatalogIepsFieldsV1(input: {
  iepsMode: CatalogIepsMode
  iepsRate: unknown
  iepsQuota: unknown
  iepsQuotaUnit: Unit | null
}): { iepsRate: string | null; iepsQuota: string | null } {
  // WHY: Task 7 needs an independently callable IEPS leaf to accumulate row
  // findings, while this exact matrix remains the sole Task 5 authority.
  if (input.iepsQuotaUnit !== null && !Object.values(Unit).includes(input.iepsQuotaUnit)) {
    failValidation('CATALOG_IEPS_INVALID', 'La unidad de cuota IEPS no es válida.')
  }
  const iepsRate = input.iepsRate === null ? null : parseCatalogUnsignedDecimal(input.iepsRate, 6, '1.000000', 'iepsRate')
  const iepsQuota = input.iepsQuota === null ? null : parseCatalogUnsignedDecimal(input.iepsQuota, 4, '99999999.9999', 'iepsQuota')
  const hasRate = iepsRate !== null
  const hasQuota = iepsQuota !== null && input.iepsQuotaUnit !== null
  const iepsValid =
    (input.iepsMode === CatalogIepsMode.NONE && !hasRate && iepsQuota === null && input.iepsQuotaUnit === null) ||
    (input.iepsMode === CatalogIepsMode.RATE && hasRate && iepsQuota === null && input.iepsQuotaUnit === null) ||
    (input.iepsMode === CatalogIepsMode.QUOTA && !hasRate && hasQuota) ||
    (input.iepsMode === CatalogIepsMode.BOTH && hasRate && hasQuota)
  if (!iepsValid) failValidation('CATALOG_IEPS_INVALID', 'Los campos IEPS no coinciden con el modo elegido.')
  return { iepsRate, iepsQuota }
}

export function validateCatalogOrganizationValues(values: unknown, operation: 'CREATE' | 'UPDATE'): CatalogOrganizationValueInput[] {
  // WHY: The active command set is a complete replacement and must itself
  // contain at least one same-currency SALE/PURCHASE pair.
  if (!Array.isArray(values) || values.length < 2) failValidation('CATALOG_VALUE_PAIR_REQUIRED', 'Precio y costo son requeridos.')
  const normalized = values.map(rawValue => {
    // WHY: Worksheet/JSON rows are untrusted; null, arrays, primitives, and
    // custom-prototype instances become stable 422s instead of TypeErrors.
    if (!isPlainRecord(rawValue)) failValidation('CATALOG_VALUE_KIND_INVALID', 'Cada valor organizacional debe ser un objeto.')
    const value = rawValue as Partial<CatalogOrganizationValueInput>
    if (value.kind !== 'SALE_PRICE' && value.kind !== 'PURCHASE_COST') {
      return failValidation('CATALOG_VALUE_KIND_INVALID', 'El tipo de valor organizacional no es válido.')
    }
    const currency = validateCatalogCurrencyV1(value.currency)
    if (value.expectedRuleRevision !== undefined) {
      validateCatalogExpectedRevision(value.expectedRuleRevision, 'expectedRuleRevision', 'CATALOG_VALUE_REVISION_INVALID')
    }
    if (operation === 'CREATE' && value.expectedRuleRevision !== undefined) {
      return failValidation('CATALOG_VALUE_REVISION_INVALID', 'Un valor nuevo no acepta revisión esperada.')
    }
    let amount: string
    try {
      amount = parseCatalogMoney(value.amount)
    } catch {
      return failValidation('CATALOG_MONEY_INVALID', 'El monto organizacional no es válido.')
    }
    return { kind: value.kind, amount, currency, expectedRuleRevision: value.expectedRuleRevision }
  })
  const keys = normalized.map(value => `${value.kind}:${value.currency}`)
  if (new Set(keys).size !== keys.length) failValidation('CATALOG_VALUE_DUPLICATE', 'Cada valor y moneda debe ser único.')
  const currencies = new Set(normalized.map(value => value.currency))
  const hasPair = [...currencies].some(
    currency =>
      normalized.some(value => value.kind === 'SALE_PRICE' && value.currency === currency) &&
      normalized.some(value => value.kind === 'PURCHASE_COST' && value.currency === currency),
  )
  if (!hasPair) failValidation('CATALOG_VALUE_PAIR_REQUIRED', 'Precio y costo deben compartir al menos una moneda.')
  return normalized
}

function validateCatalogOrganizationValueDeactivations(
  values: unknown,
  activeValues: CatalogOrganizationValueInput[],
): CatalogOrganizationValueDeactivationInput[] {
  // WHY: UPDATE omission alone carries no CAS. A required explicit tombstone
  // list closes that gap while CREATE has no persisted rows to deactivate.
  if (!Array.isArray(values)) {
    failValidation('CATALOG_VALUE_DEACTIVATION_INVALID', 'organizationValueDeactivations debe ser un arreglo explícito.')
  }
  const normalized = values.map(rawValue => {
    if (!isPlainRecord(rawValue)) {
      return failValidation('CATALOG_VALUE_DEACTIVATION_INVALID', 'Cada desactivación debe ser un objeto.')
    }
    if (Object.keys(rawValue).some(key => !['kind', 'currency', 'expectedRuleRevision'].includes(key))) {
      return failValidation('CATALOG_VALUE_DEACTIVATION_INVALID', 'La desactivación contiene campos no permitidos.')
    }
    if (rawValue.kind !== 'SALE_PRICE' && rawValue.kind !== 'PURCHASE_COST') {
      return failValidation('CATALOG_VALUE_DEACTIVATION_INVALID', 'El tipo de desactivación no es válido.')
    }
    const kind: CatalogItemPriceKind = rawValue.kind
    const currency = validateCatalogCurrencyV1(rawValue.currency)
    const expectedRuleRevision = validateCatalogExpectedRevision(
      rawValue.expectedRuleRevision,
      'expectedRuleRevision',
      'CATALOG_VALUE_REVISION_INVALID',
    )
    return { kind, currency, expectedRuleRevision }
  })
  const keys = normalized.map(value => `${value.kind}:${value.currency}`)
  const activeKeys = new Set(activeValues.map(value => `${value.kind}:${value.currency}`))
  if (new Set(keys).size !== keys.length || keys.some(key => activeKeys.has(key))) {
    failValidation('CATALOG_VALUE_DEACTIVATION_INVALID', 'Las desactivaciones deben ser únicas y disjuntas de los valores activos.')
  }
  return normalized
}

export function assertCatalogOrganizationValueRevisions(
  input: ValidatedCatalogItem,
  existing: Array<Pick<CatalogOrganizationValueInput, 'kind' | 'currency'> & { revision: number; active: boolean }>,
): void {
  const key = (value: Pick<CatalogOrganizationValueInput, 'kind' | 'currency'>) => `${value.kind}:${value.currency}`
  // WHY: Validate every retained stable rule and the exact ACTIVE omission set
  // before an aggregate or child write can make a stale replacement partial.
  const byKey = new Map(existing.map(value => [key(value), value]))
  const requested = new Set(input.organizationValues.map(key))
  for (const value of input.organizationValues) {
    const persisted = byKey.get(key(value))
    if (persisted && value.expectedRuleRevision !== persisted.revision) {
      throw new ConflictError('La revisión del valor organizacional cambió.', 'CATALOG_VALUE_REVISION_CONFLICT')
    }
    if (!persisted && value.expectedRuleRevision !== undefined) {
      throw new ConflictError(
        'La revisión del valor organizacional no corresponde a una regla existente.',
        'CATALOG_VALUE_REVISION_CONFLICT',
      )
    }
  }
  const omissions = existing.filter(value => value.active && !requested.has(key(value)))
  const tombstones = new Map(input.organizationValueDeactivations.map(value => [key(value), value]))
  if (
    tombstones.size !== omissions.length ||
    omissions.some(value => !tombstones.has(key(value))) ||
    [...tombstones].some(([valueKey]) => !omissions.some(value => key(value) === valueKey))
  ) {
    failValidation('CATALOG_VALUE_DEACTIVATION_SET_INVALID', 'Las desactivaciones deben cubrir exactamente las reglas activas omitidas.')
  }
  if (omissions.some(value => tombstones.get(key(value))?.expectedRuleRevision !== value.revision)) {
    throw new ConflictError('La revisión del valor organizacional cambió.', 'CATALOG_VALUE_REVISION_CONFLICT')
  }
}

export function validateCatalogItemInput(
  input: CreateCatalogItemInput | UpdateCatalogItemInput,
  operation: 'CREATE' | 'UPDATE',
): ValidatedCatalogItem {
  // WHY: SKU and ProductType helpers are shared closed contracts; translating
  // their pure errors here gives API callers one stable validation boundary.
  let normalizedSku: string
  try {
    normalizedSku = normalizeCatalogCorporateSkuV1({ code: input.sku, format: 'SKU' }).normalizedCode
  } catch {
    return failValidation('CATALOG_IDENTIFIER_INVALID', 'El SKU corporativo no es válido.')
  }
  try {
    validateCatalogProductTypeV1({ kind: input.kind, productType: input.productType })
  } catch {
    return failValidation('CATALOG_PRODUCT_TYPE_INVALID', 'El tipo de producto no es compatible con el artículo.')
  }

  const businessTypes = Array.isArray(input.businessTypes) ? input.businessTypes : []
  if (businessTypes.length === 0 || new Set(businessTypes).size !== businessTypes.length) {
    failValidation('CATALOG_BUSINESS_TYPE_INVALID', 'Los giros deben ser únicos y no vacíos.')
  }
  if (businessTypes.some(value => !Object.values(BusinessType).includes(value))) {
    failValidation('CATALOG_BUSINESS_TYPE_INVALID', 'El giro no es válido.')
  }
  if (!Object.values(Unit).includes(input.unit)) failValidation('CATALOG_UNIT_INVALID', 'La unidad no es válida.')
  if (input.iepsQuotaUnit !== null && !Object.values(Unit).includes(input.iepsQuotaUnit)) {
    failValidation('CATALOG_IEPS_INVALID', 'La unidad de cuota IEPS no es válida.')
  }

  const imageUrl = validateCatalogImageUrlV1(input.imageUrl)

  // WHY: This exact IEPS matrix rejects both missing and extra fields; nullable
  // values cannot masquerade as a reviewed NONE declaration.
  const { iepsRate, iepsQuota } = validateCatalogIepsFieldsV1(input)

  const organizationValues = validateCatalogOrganizationValues(input.organizationValues, operation)
  const organizationValueDeactivations =
    operation === 'UPDATE'
      ? validateCatalogOrganizationValueDeactivations((input as UpdateCatalogItemInput).organizationValueDeactivations, organizationValues)
      : []

  return {
    ...input,
    normalizedSku,
    name: requiredText(input.name, 'name'),
    description: requiredText(input.description, 'description'),
    imageUrl,
    brandId: requiredText(input.brandId, 'brandId'),
    manufacturerId: requiredText(input.manufacturerId, 'manufacturerId'),
    familyId: requiredText(input.familyId, 'familyId'),
    presentationLabel: requiredText(input.presentationLabel, 'presentationLabel'),
    satProductKey: validateCatalogSatProductKeyV1(input.satProductKey),
    satUnitKey: validateCatalogSatUnitKeyV1(input.satUnitKey),
    objetoImp: validateCatalogObjetoImpV1(input.objetoImp),
    taxRate: parseCatalogUnsignedDecimal(input.taxRate, 4, '1.0000', 'taxRate'),
    iepsRate,
    iepsQuota,
    businessTypes,
    organizationValues,
    organizationValueDeactivations,
  }
}
