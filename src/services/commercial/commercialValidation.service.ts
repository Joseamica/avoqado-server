import { commercialDraftInputSchema } from '@/schemas/commercial.schema'
import type { CommercialCatalogPriceV1, CommercialCatalogSnapshotV1, CommercialDraftInput } from '@/types/commercial'
import { NotFoundError } from '@/errors/AppError'
import { getCommercialCapabilityKind } from './commercialCapabilityRegistry'
import { validateCommercialContractV1 } from './commercialContract.service'
import { assertCommercialMoneyLimitV2, formatCommercialMoneyV2, parseCommercialMoneyV2 } from './commercialMoneyV2.service'

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/
const FORBIDDEN_BASE_AMOUNTS = new Set([2200, 5000])

export interface CommercialValidationError {
  code: string
  path: string
  message: string
}

export interface CommercialValidationWarning {
  code: string
  path: string
  message: string
}

export interface CommercialValidationResult {
  valid: boolean
  errors: CommercialValidationError[]
  warnings: CommercialValidationWarning[]
  normalizedSnapshot: CommercialCatalogSnapshotV1 | null
}

export interface CommercialDraftV2ValidationResult {
  valid: boolean
  errors: CommercialValidationError[]
  warnings: CommercialValidationWarning[]
}

function error(code: string, path: string, message: string): CommercialValidationError {
  return { code, path, message }
}

function duplicateValues(values: string[]): Set<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return duplicates
}

function pesosToMinor(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)) return null
  const [pesos, decimals = ''] = value.split('.')
  const minor = Number(pesos) * 100 + Number(decimals.padEnd(2, '0'))
  return Number.isSafeInteger(minor) && minor <= 2_147_483_647 ? minor : null
}

export function canonicalizeCommercialDraftMoneyV2(value: unknown): string {
  if (typeof value !== 'string') throw new Error('COMMERCIAL_MONEY_V2_INVALID')
  const matched = /^(0|[1-9]\d{0,9})(?:\.(\d{1,2}))?$/.exec(value)
  if (!matched) throw new Error('COMMERCIAL_MONEY_V2_INVALID')
  const canonical = `${matched[1]}.${(matched[2] ?? '').padEnd(2, '0')}`
  const minor = assertCommercialMoneyLimitV2('UNIT_AMOUNT', parseCommercialMoneyV2(canonical))
  return formatCommercialMoneyV2(minor)
}

export function validateCommercialDraftForCatalogV2(input: CommercialDraftInput): CommercialDraftV2ValidationResult {
  const errors: CommercialValidationError[] = []
  const normalizedAmounts = new Map<number, string>()
  for (const [index, price] of (input.prices ?? []).entries()) {
    try {
      const canonical = canonicalizeCommercialDraftMoneyV2(price.amount)
      normalizedAmounts.set(index, canonical)
      if (canonical === '22.00' || canonical === '50.00') {
        errors.push(
          error(
            'CAMPAIGN_PRICE_IN_BASE_CATALOG',
            `prices.${index}.amount`,
            '$22 y $50 son campañas versionadas; no pueden ser precios base.',
          ),
        )
      }
    } catch {
      errors.push(error('INVALID_MONEY', `prices.${index}.amount`, 'El importe debe ser exacto y tener máximo dos decimales.'))
    }
  }

  const structural = normalizeAndValidateCommercialDraft({
    ...input,
    prices: (input.prices ?? []).map((price, index) => ({
      ...price,
      amount: normalizedAmounts.get(index) === '0.00' ? '0.00' : '1.00',
    })),
  })
  const structuralErrors = structural.errors.filter(item => item.code !== 'CAMPAIGN_PRICE_IN_BASE_CATALOG')
  const capabilityErrors: CommercialValidationError[] = []
  const activePricebookCodes = new Set((input.pricebooks ?? []).filter(pricebook => pricebook.active).map(pricebook => pricebook.code))
  const activePrices = (input.prices ?? []).filter(price => price.active && activePricebookCodes.has(price.pricebookCode))
  const productsWithCapabilities = new Set((input.featureBindings ?? []).map(binding => binding.productCode))

  for (const product of input.products ?? []) {
    if (product.active && activePrices.some(price => price.productCode === product.code) && !productsWithCapabilities.has(product.code)) {
      capabilityErrors.push(
        error(
          'PRICED_PRODUCT_WITHOUT_CAPABILITY',
          `products.${product.code}.featureBindings`,
          'Un producto con precio necesita al menos una capacidad.',
        ),
      )
    }
  }

  for (const bundle of input.bundles ?? []) {
    if (!bundle.active || !activePrices.some(price => price.bundleCode === bundle.code)) continue
    const resolvesCapability = (input.bundleItems ?? []).some(
      item => item.bundleCode === bundle.code && productsWithCapabilities.has(item.productCode),
    )
    if (!resolvesCapability) {
      capabilityErrors.push(
        error(
          'PRICED_BUNDLE_WITHOUT_CAPABILITY',
          `bundles.${bundle.code}.items`,
          'Un paquete con precio necesita al menos una capacidad entre sus productos.',
        ),
      )
    }
  }

  const combined = [...structuralErrors, ...errors, ...capabilityErrors]
  return { valid: structural.valid && combined.length === 0, errors: combined, warnings: structural.warnings }
}

function priceV1(price: CommercialDraftInput['prices'][number], amountMinor: number): CommercialCatalogPriceV1 {
  return {
    code: price.code,
    billingUnit: price.billingUnit,
    amountMinor,
    currency: 'MXN',
    taxBehavior: price.taxBehavior,
    taxRateBasisPoints: price.taxBehavior === 'EXCLUSIVE' ? 1600 : 0,
  }
}

export function normalizeAndValidateCommercialDraft(input: CommercialDraftInput): CommercialValidationResult {
  const errors: CommercialValidationError[] = []
  const warnings: CommercialValidationWarning[] = []
  const parsed = commercialDraftInputSchema.safeParse(input)

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.')
      errors.push(error(path.endsWith('.amount') ? 'INVALID_MONEY' : 'INVALID_DRAFT_FIELD', path, issue.message))
    }
  }

  const raw = input as CommercialDraftInput
  const productCodes = new Set((raw.products ?? []).map(product => product.code))
  const bundleCodes = new Set((raw.bundles ?? []).map(bundle => bundle.code))
  const pricebookCodes = new Set((raw.pricebooks ?? []).map(pricebook => pricebook.code))
  const activeProductCodes = new Set((raw.products ?? []).filter(product => product.active).map(product => product.code))
  const activeBundleCodes = new Set((raw.bundles ?? []).filter(bundle => bundle.active).map(bundle => bundle.code))

  for (const code of duplicateValues((raw.products ?? []).map(product => product.code))) {
    errors.push(error('DUPLICATE_PRODUCT_CODE', 'products', `El código de producto ${code} está repetido.`))
  }
  for (const code of duplicateValues((raw.prices ?? []).map(price => price.code))) {
    errors.push(error('DUPLICATE_PRICE_CODE', 'prices', `El código de precio ${code} está repetido.`))
  }
  for (const code of duplicateValues((raw.bundles ?? []).map(bundle => bundle.code))) {
    errors.push(error('DUPLICATE_BUNDLE_CODE', 'bundles', `El código de paquete ${code} está repetido.`))
  }
  for (const code of duplicateValues((raw.pricebooks ?? []).map(pricebook => pricebook.code))) {
    errors.push(error('DUPLICATE_PRICEBOOK_CODE', 'pricebooks', `El pricebook ${code} está repetido.`))
  }

  const amounts = new Map<string, number>()
  for (const [index, price] of (raw.prices ?? []).entries()) {
    const amountMinor = pesosToMinor(price.amount)
    if (amountMinor === null) {
      if (!errors.some(item => item.code === 'INVALID_MONEY' && item.path === `prices.${index}.amount`)) {
        errors.push(error('INVALID_MONEY', `prices.${index}.amount`, 'El importe debe ser exacto y tener máximo dos decimales.'))
      }
    } else {
      amounts.set(price.code, amountMinor)
      if (amountMinor > 0 && price.taxBehavior !== 'EXCLUSIVE') {
        errors.push(
          error(
            'POSITIVE_PRICE_REQUIRES_IVA',
            `prices.${index}.taxBehavior`,
            'Todo precio positivo de esta publicación México debe cobrar IVA al 16%.',
          ),
        )
      }
      if (amountMinor === 0 && price.taxBehavior !== 'NOT_APPLICABLE') {
        errors.push(
          error('FREE_PRICE_MUST_BE_TAX_EXEMPT', `prices.${index}.taxBehavior`, 'Un precio de $0 debe marcarse como no sujeto a IVA.'),
        )
      }
      if (FORBIDDEN_BASE_AMOUNTS.has(amountMinor)) {
        errors.push(
          error(
            'CAMPAIGN_PRICE_IN_BASE_CATALOG',
            `prices.${index}.amount`,
            '$22 y $50 son campañas versionadas; no pueden ser precios base.',
          ),
        )
      }
    }
    if ((price.productCode ? 1 : 0) + (price.bundleCode ? 1 : 0) !== 1) {
      errors.push(error('INVALID_PRICE_TARGET', `prices.${index}`, 'Cada precio debe apuntar a un producto o a un paquete.'))
    }
    if (price.productCode && !productCodes.has(price.productCode)) {
      errors.push(error('UNKNOWN_PRICE_PRODUCT', `prices.${index}.productCode`, 'El producto del precio no existe.'))
    }
    if (price.bundleCode && !bundleCodes.has(price.bundleCode)) {
      errors.push(error('UNKNOWN_PRICE_BUNDLE', `prices.${index}.bundleCode`, 'El paquete del precio no existe.'))
    }
    if (!pricebookCodes.has(price.pricebookCode)) {
      errors.push(error('UNKNOWN_PRICEBOOK', `prices.${index}.pricebookCode`, 'El pricebook del precio no existe.'))
    }
  }

  for (const [index, item] of (raw.bundleItems ?? []).entries()) {
    if (!bundleCodes.has(item.bundleCode)) {
      errors.push(error('UNKNOWN_BUNDLE', `bundleItems.${index}.bundleCode`, 'El paquete no existe.'))
    }
    if (!productCodes.has(item.productCode)) {
      errors.push(error('UNKNOWN_BUNDLE_PRODUCT', `bundleItems.${index}.productCode`, 'El producto del paquete no existe.'))
    } else if (activeBundleCodes.has(item.bundleCode) && !activeProductCodes.has(item.productCode)) {
      errors.push(
        error('INACTIVE_BUNDLE_PRODUCT', `bundleItems.${index}.productCode`, 'Un paquete activo no puede incluir un producto inactivo.'),
      )
    }
  }

  for (const [index, binding] of (raw.featureBindings ?? []).entries()) {
    if (!productCodes.has(binding.productCode)) {
      errors.push(error('UNKNOWN_BINDING_PRODUCT', `featureBindings.${index}.productCode`, 'El producto del binding no existe.'))
    }
    if (!CODE_PATTERN.test(binding.capabilityCode)) {
      errors.push(error('INVALID_CAPABILITY_CODE', `featureBindings.${index}.capabilityCode`, 'La capacidad debe usar un código canónico.'))
      continue
    }
    const canonicalKind = getCommercialCapabilityKind(binding.capabilityCode)
    if (!canonicalKind) {
      errors.push(
        error(
          'UNKNOWN_CAPABILITY_CODE',
          `featureBindings.${index}.capabilityCode`,
          'La capacidad no existe en el registro canónico de gates.',
        ),
      )
    } else if (canonicalKind !== binding.capabilityKind) {
      errors.push(
        error(
          'CAPABILITY_KIND_MISMATCH',
          `featureBindings.${index}.capabilityKind`,
          `${binding.capabilityCode} pertenece al namespace ${canonicalKind}, no ${binding.capabilityKind}.`,
        ),
      )
    }
  }

  const activePricebookCodes = new Set((raw.pricebooks ?? []).filter(pricebook => pricebook.active).map(pricebook => pricebook.code))
  const activeDraftPrices = (raw.prices ?? []).filter(price => price.active && activePricebookCodes.has(price.pricebookCode))
  const activePriceTargets = new Map<string, number>()
  for (const [index, price] of (raw.prices ?? []).entries()) {
    if (!price.active || !activePricebookCodes.has(price.pricebookCode)) continue
    const target = price.productCode ? `product:${price.productCode}` : price.bundleCode ? `bundle:${price.bundleCode}` : null
    if (!target) continue
    const key = `${target}:${price.billingUnit}`
    const prior = activePriceTargets.get(key)
    if (prior !== undefined) {
      errors.push(
        error(
          'AMBIGUOUS_ACTIVE_PRICE',
          `prices.${index}`,
          `Existe más de un precio activo para ${target} y ${price.billingUnit}; desactiva uno antes de publicar.`,
        ),
      )
    } else {
      activePriceTargets.set(key, index)
    }
  }

  for (const product of raw.products ?? []) {
    if (!product.active || product.kind !== 'PLAN' || product.salesMode !== 'SELF_SERVICE') continue
    const unitsByPricebook = new Map<string, Set<string>>()
    for (const price of activeDraftPrices.filter(candidate => candidate.productCode === product.code)) {
      const units = unitsByPricebook.get(price.pricebookCode) ?? new Set<string>()
      units.add(price.billingUnit)
      unitsByPricebook.set(price.pricebookCode, units)
    }
    const hasCompletePair = [...unitsByPricebook.values()].some(units => units.has('VENUE_MONTH') && units.has('VENUE_YEAR'))
    if (!hasCompletePair) {
      errors.push(
        error('MISSING_PLAN_BILLING_PAIR', `products.${product.code}.prices`, `El plan ${product.code} necesita precio mensual y anual.`),
      )
    }
  }

  if (errors.length > 0 || !parsed.success) return { valid: false, errors, warnings, normalizedSnapshot: null }

  const value = parsed.data
  const activePricebooks = new Set(value.pricebooks.filter(pricebook => pricebook.active).map(pricebook => pricebook.code))
  const activePrices = value.prices.filter(price => price.active && activePricebooks.has(price.pricebookCode))
  const normalizedSnapshot: CommercialCatalogSnapshotV1 = {
    schemaVersion: 1,
    publicationId: 'DRAFT_PREVIEW',
    publishedAt: '1970-01-01T00:00:00.000Z',
    market: {
      country: 'MX',
      currency: 'MXN',
      timezone: 'America/Mexico_City',
      taxLabel: 'IVA',
      taxRateBasisPoints: 1600,
    },
    products: value.products
      .filter(product => product.active)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code))
      .map(product => ({
        code: product.code,
        slug: product.slug,
        kind: product.kind,
        name: product.name,
        description: product.description,
        salesMode: product.salesMode,
        capabilityCodes: value.featureBindings
          .filter(binding => binding.productCode === product.code)
          .map(binding => binding.capabilityCode)
          .sort(),
        prices: activePrices
          .filter(price => price.productCode === product.code)
          .sort((left, right) => left.billingUnit.localeCompare(right.billingUnit) || left.code.localeCompare(right.code))
          .map(price => priceV1(price, amounts.get(price.code)!)),
        ...(product.limits ? { limits: product.limits } : {}),
      })),
    bundles: value.bundles
      .filter(bundle => bundle.active)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code))
      .map(bundle => ({
        code: bundle.code,
        slug: bundle.slug,
        name: bundle.name,
        description: bundle.description,
        itemProductCodes: value.bundleItems
          .filter(item => item.bundleCode === bundle.code)
          .sort((left, right) => left.sortOrder - right.sortOrder || left.productCode.localeCompare(right.productCode))
          .map(item => item.productCode),
        prices: activePrices
          .filter(price => price.bundleCode === bundle.code)
          .sort((left, right) => left.billingUnit.localeCompare(right.billingUnit) || left.code.localeCompare(right.code))
          .map(price => priceV1(price, amounts.get(price.code)!)),
      })),
  }

  const contract = validateCommercialContractV1(normalizedSnapshot)
  if (!contract.valid) {
    for (const issue of contract.errors) {
      errors.push(
        error(
          'COMMERCIAL_CONTRACT_INVALID',
          issue.path,
          `El preview normalizado no cumple el contrato público v1 (${issue.keyword}): ${issue.message}.`,
        ),
      )
    }
    return { valid: false, errors, warnings, normalizedSnapshot: null }
  }

  return { valid: true, errors, warnings, normalizedSnapshot }
}

export async function validateCommercialDraft(id: string): Promise<CommercialDraftV2ValidationResult> {
  const { getCommercialDraft } = await import('./commercialDraft.service')
  const draft = await getCommercialDraft(id)
  if (!draft) throw new NotFoundError('Borrador comercial no encontrado.')
  // Persistence metadata is deliberately outside the strict editable-input
  // contract. Keep this allowlist in the API validation path for the same
  // reason the snapshot builder has one: a future internal column must never
  // make an otherwise valid draft fail validation or leak into publication.
  return validateCommercialDraftForCatalogV2({
    name: draft.name,
    description: draft.description,
    products: draft.products,
    pricebooks: draft.pricebooks,
    prices: draft.prices,
    bundles: draft.bundles,
    bundleItems: draft.bundleItems,
    featureBindings: draft.featureBindings,
  })
}
