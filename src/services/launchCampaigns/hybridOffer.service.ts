import { createHash } from 'crypto'
import { FEATURE_CATALOG, type FeatureCatalogEntry } from '@/config/featureCatalog'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import { elPlanConcede, FREE_TIER_CODES, type BaseTier } from '@/services/access/basePlan.service'
import { listFeatureCatalog } from './featureCatalog.service'
import { hybridOfferDefinition, hybridOfferPreviewBody } from './hybridOffer.schema'

// Operational dependencies visible in the existing inventory/upsell routes. This is NOT an access resolver.
const dependencies: Readonly<Record<string, readonly string[]>> = {
  AUTO_REORDER: ['INVENTORY_TRACKING'],
  UPSELL_AI: ['UPSELL'],
  AGGREGATOR_PASSES: ['RESERVATIONS'], // R36: los pases de TotalPass/Wellhub sólo sirven sobre clases.
}
const catalogByCode = new Map(FEATURE_CATALOG.filter(entry => entry.featureCode).map(entry => [entry.featureCode!, entry]))

/**
 * What a plan of `tier` brings: the free functions plus the configurable ones its tier concedes. A function sold by quote
 * (CONTACT: white label, master catalog) never comes with a plan — a module or an organization entitlement grants it, even
 * where the legacy tier rule would concede it. ONE rule for a published plan and for the classic plan a venue pays today:
 * with two, a Pro → Premium quote listed «Funciones que dejarás» the venue never had.
 */
export function planIncludes(tier: BaseTier, entry: FeatureCatalogEntry): boolean {
  return (
    entry.minimumTier === 'FREE' || (entry.offering === 'CONFIGURABLE' && !!entry.featureCode && elPlanConcede(tier, entry.featureCode))
  )
}
type SelectionIssue = { code: string; message: string; featureCode?: string; requiredFeatureCode?: string }

function assertDistinct(codes: string[]) {
  if (new Set(codes).size !== codes.length)
    throw new BadRequestError('No repitas funciones en la oferta o selección.', 'HYBRID_OFFER_DUPLICATE')
}

/** Freeze the sale's composition. Presentation catalog updates cannot change an accepted publication. */
export function compileHybridPublication(input: unknown) {
  const parsed = hybridOfferDefinition.safeParse(input)
  if (!parsed.success) throw new BadRequestError('La definición de la oferta no es válida.', 'HYBRID_OFFER_INVALID')
  const definition = parsed.data
  const preview = previewHybridOffer({ offer: definition })
  const includedFeatureCodes =
    definition.kind === 'PLAN'
      ? [...catalogByCode.values()]
          .filter(entry => planIncludes(definition.planTier, entry))
          .map(entry => entry.featureCode!)
          .sort()
      : definition.kind === 'FEATURES'
        ? [...definition.featureCodes].sort()
        : []
  if (definition.kind === 'FEATURES' && !preview.selection.valid) {
    throw new BadRequestError(preview.selection.issues.map(issue => issue.message).join(' '), 'HYBRID_OFFER_COMPOSITION')
  }
  if (definition.kind === 'CHOICE_BUNDLE') {
    for (const code of definition.eligibleFeatureCodes) {
      const required = dependencies[code] ?? []
      if (required.some(dependency => !definition.eligibleFeatureCodes.includes(dependency))) {
        throw new BadRequestError(`${code} requiere una dependencia fuera de la oferta.`, 'HYBRID_OFFER_COMPOSITION')
      }
      if (1 + required.length > definition.choiceCount) {
        throw new BadRequestError('La cantidad a elegir no alcanza para incluir las dependencias.', 'HYBRID_OFFER_COMPOSITION')
      }
    }
  }
  return { definition, definitionHash: preview.definitionHash, includedFeatureCodes }
}

/** A reviewable draft contract, not a published offer, accepted quote, or authorization to charge/grant access. */
export function previewHybridOffer(input: unknown) {
  const parsed = hybridOfferPreviewBody.safeParse(input)
  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('. '),
      'HYBRID_OFFER_INVALID',
    )
  }
  const { offer, selectedFeatureCodes, scenario, catalog, expectedDefinitionHash } = parsed.data
  if (offer.terms.promotionCycles === null && offer.terms.renewal.kind !== 'SAME_PRICE') {
    throw new BadRequestError(
      'Indica cuántos ciclos dura la promoción antes de cambiar el precio o terminar.',
      'HYBRID_OFFER_RENEWAL_REQUIRED',
    )
  }
  const offeredCodes = offer.kind === 'CHOICE_BUNDLE' ? offer.eligibleFeatureCodes : offer.kind === 'FEATURES' ? offer.featureCodes : []
  assertDistinct(offeredCodes)
  assertDistinct(selectedFeatureCodes)
  assertDistinct(scenario.grantedFeatureCodes)
  for (const code of offeredCodes) {
    const entry = catalogByCode.get(code)
    if (!entry || entry.offering !== 'CONFIGURABLE') {
      throw new BadRequestError(
        `La función ${code} no admite esta oferta: es base, asistida o no existe en el catálogo.`,
        'HYBRID_OFFER_FEATURE_UNAVAILABLE',
      )
    }
  }
  for (const code of scenario.grantedFeatureCodes) {
    if (!catalogByCode.has(code))
      throw new BadRequestError(`Función desconocida en el escenario: ${code}.`, 'HYBRID_OFFER_INVALID_SCENARIO')
  }
  if (offer.kind === 'CHOICE_BUNDLE' && offer.choiceCount > offeredCodes.length) {
    throw new BadRequestError('La cantidad a elegir supera las funciones de la oferta.', 'HYBRID_OFFER_CHOICE_COUNT')
  }
  if (offer.kind !== 'CHOICE_BUNDLE' && selectedFeatureCodes.length > 0) {
    throw new BadRequestError(
      'Esta oferta tiene una composición fija y no permite seleccionar otras funciones.',
      'HYBRID_OFFER_FIXED_SELECTION',
    )
  }
  if (selectedFeatureCodes.some(code => !offeredCodes.includes(code))) {
    throw new BadRequestError('La selección contiene funciones ajenas a esta oferta.', 'HYBRID_OFFER_SELECTION_OUTSIDE')
  }

  const canonicalOffer =
    offer.kind === 'CHOICE_BUNDLE'
      ? { ...offer, eligibleFeatureCodes: [...offeredCodes].sort() }
      : offer.kind === 'FEATURES'
        ? { ...offer, featureCodes: [...offeredCodes].sort() }
        : offer
  const definitionHash = createHash('sha256')
    .update(JSON.stringify({ offer: canonicalOffer, catalog: FEATURE_CATALOG, dependencies }))
    .digest('hex')
  if (expectedDefinitionHash && expectedDefinitionHash !== definitionHash) {
    throw new ConflictError('La definición cambió. Revisa de nuevo las funciones, el precio y la renovación.', 'HYBRID_OFFER_STALE')
  }

  const alreadyIncluded = (code: string) =>
    (FREE_TIER_CODES as readonly string[]).includes(code) ||
    scenario.grantedFeatureCodes.includes(code) ||
    (scenario.planTier !== 'FREE' && elPlanConcede(scenario.planTier, code))
  const selected = (offer.kind === 'CHOICE_BUNDLE' ? selectedFeatureCodes : offeredCodes).slice().sort()
  const eligibleCount = offeredCodes.filter(code => !alreadyIncluded(code)).length
  const eligibleSelectedCount = selected.filter(code => !alreadyIncluded(code)).length
  const issues: SelectionIssue[] = []
  if (offer.kind === 'CHOICE_BUNDLE') {
    if (selected.length !== offer.choiceCount)
      issues.push({ code: 'CHOICE_COUNT', message: `Elige exactamente ${offer.choiceCount} funciones distintas.` })
    if (eligibleCount < offer.choiceCount)
      issues.push({
        code: 'INSUFFICIENT_ELIGIBLE_FEATURES',
        message: `Quedan ${eligibleCount} funciones disponibles; esta oferta requiere ${offer.choiceCount}.`,
      })
  }
  for (const code of selected) {
    if (alreadyIncluded(code))
      issues.push({
        code: 'ALREADY_INCLUDED',
        featureCode: code,
        message: `${catalogByCode.get(code)!.name} ya está incluida y no consume un lugar.`,
      })
    for (const requiredCode of dependencies[code] ?? []) {
      if (!selected.includes(requiredCode) && !alreadyIncluded(requiredCode)) {
        issues.push({
          code: 'MISSING_DEPENDENCY',
          featureCode: code,
          requiredFeatureCode: requiredCode,
          message: `${catalogByCode.get(code)!.name} requiere ${catalogByCode.get(requiredCode)!.name}. Inclúyela en tu selección o contrátala previamente.`,
        })
      }
    }
  }
  const catalogIds =
    offer.kind === 'PLAN' ? FEATURE_CATALOG.filter(entry => planIncludes(offer.planTier, entry)).map(entry => entry.id) : offeredCodes
  const page = listFeatureCatalog(catalog, catalogIds)
  return {
    mode: 'PREVIEW_ONLY' as const,
    purchaseAvailable: false as const,
    definitionHash,
    kind: offer.kind,
    terms: offer.terms,
    selection: {
      featureCodes: selected,
      requiredCount: offer.kind === 'CHOICE_BUNDLE' ? offer.choiceCount : null,
      eligibleCount,
      eligibleSelectedCount,
      valid: issues.length === 0,
      issues,
    },
    catalog: {
      ...page,
      items: page.items.map(entry => ({
        ...entry,
        alreadyIncluded: entry.featureCode ? alreadyIncluded(entry.featureCode) : true,
        requiredFeatureCodes: entry.featureCode ? (dependencies[entry.featureCode] ?? []) : [],
      })),
    },
    requirements: selected.flatMap(code => {
      const entry = catalogByCode.get(code)!
      return entry.requirement ? [{ featureCode: code, message: entry.requirement }] : []
    }),
  }
}
