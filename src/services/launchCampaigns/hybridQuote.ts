import { Decimal } from '@prisma/client/runtime/library'
import { BadRequestError } from '@/errors/AppError'
import { FREE_TIER_CODES } from '@/services/access/basePlan.service'
import { HybridOfferDefinition } from './hybridOffer.schema'
import { previewHybridOffer } from './hybridOffer.service'

export type QuotePublication = {
  id: string
  name: string
  definitionHash: string
  definition: HybridOfferDefinition
  includedFeatureCodes: string[]
}
export type QuoteLine = {
  publicationId: string
  name: string
  definitionHash: string
  kind: HybridOfferDefinition['kind']
  planTier: 'PRO' | 'PREMIUM' | null
  featureCodes: string[]
  terms: HybridOfferDefinition['terms']
}

/** Provider-free: callers supply published terms and server-observed coverage, never browser prices. */
export function buildHybridQuote(input: {
  lines: Array<{ publication: QuotePublication; selectedFeatureCodes?: string[] }>
  retainedFeatureCodes: string[]
  existing: Array<{ subscriptionId: string; featureCodes: string[] }>
  dropFeatureCodes: string[]
}) {
  // Eight products permit at most nine promotion transitions, within Stripe's ten-phase schedule ceiling.
  if (input.lines.length < 1 || input.lines.length > 8) throw new BadRequestError('Elige entre una y ocho ofertas por compra.')
  if (new Set(input.lines.map(line => line.publication.id)).size !== input.lines.length)
    throw new BadRequestError('No repitas ofertas en la compra.')
  const plans = input.lines.filter(line => line.publication.definition.kind === 'PLAN')
  if (plans.length > 1) throw new BadRequestError('Sólo puedes contratar un plan base.')
  const planCodes = plans[0]?.publication.includedFeatureCodes ?? []
  const retained = [...new Set([...input.retainedFeatureCodes, ...FREE_TIER_CODES])]
  const seen = new Set(retained)
  const lines: QuoteLine[] = input.lines.map(({ publication, selectedFeatureCodes = [] }) => {
    const definition = publication.definition
    let featureCodes: string[]
    if (definition.kind === 'PLAN') {
      if (selectedFeatureCodes.length) throw new BadRequestError('El plan tiene una composición fija.')
      featureCodes = [...publication.includedFeatureCodes].sort()
    } else {
      const preview = previewHybridOffer({
        offer: definition,
        selectedFeatureCodes,
        scenario: { planTier: 'FREE', grantedFeatureCodes: [...new Set([...retained, ...planCodes])] },
      })
      if (!preview.selection.valid) throw new BadRequestError(preview.selection.issues.map(issue => issue.message).join(' '))
      featureCodes = preview.selection.featureCodes
    }
    for (const code of featureCodes) {
      if (!(FREE_TIER_CODES as readonly string[]).includes(code) && seen.has(code))
        throw new BadRequestError(`${code} ya está incluida; no se cobra otra vez.`)
      seen.add(code)
    }
    return {
      publicationId: publication.id,
      name: publication.name,
      definitionHash: publication.definitionHash,
      kind: definition.kind,
      planTier: definition.kind === 'PLAN' ? definition.planTier : null,
      featureCodes,
      terms: definition.terms,
    }
  })
  const oldCodes = new Set(input.existing.flatMap(source => source.featureCodes))
  const dropped = [...new Set(input.dropFeatureCodes)].sort()
  if (dropped.some(code => !oldCodes.has(code) || seen.has(code)))
    throw new BadRequestError('La lista de funciones que dejarás no coincide con el cambio.')
  const missing = [...oldCodes].filter(code => !seen.has(code) && !dropped.includes(code))
  if (missing.length)
    throw new BadRequestError(
      `El paquete se reemplaza completo. Conserva estas funciones en otra oferta o confirma que las dejas: ${missing.join(', ')}.`,
      'HYBRID_PARTIAL_ABSORPTION',
    )
  return {
    schemaVersion: 1 as const,
    currency: 'MXN' as const,
    interval: 'MONTHLY' as const,
    taxIncluded: true as const,
    total: lines.reduce((sum, line) => sum.add(line.terms.price), new Decimal(0)).toFixed(2),
    lines,
    featureCodes: [...new Set(lines.flatMap(line => line.featureCodes))].sort(),
    replaces: [...new Set(input.existing.map(source => source.subscriptionId))].sort(),
    droppedFeatureCodes: dropped,
  }
}

/** A bundle remains one paid unit. Never invent an equal per-capability price to compute its credit. */
export function unusedPaidCredit(input: {
  paid: string
  refunded: string
  alreadyCredited: string
  start: number
  end: number
  effectiveAt: number
}): string {
  const amounts = [input.paid, input.refunded, input.alreadyCredited].map(amount => new Decimal(amount))
  if (
    amounts.some(amount => !amount.isFinite() || amount.isNegative()) ||
    ![input.start, input.end, input.effectiveAt].every(Number.isSafeInteger) ||
    input.end <= input.start
  )
    throw new BadRequestError('La cobertura pagada no permite calcular un crédito seguro.')
  const [paid, refunded, credited] = amounts
  const remaining = Math.max(0, input.end - Math.max(input.start, input.effectiveAt))
  return Decimal.max(
    0,
    Decimal.max(0, paid.sub(refunded))
      .mul(remaining)
      .div(input.end - input.start)
      .sub(credited),
  )
    .toDecimalPlaces(2, Decimal.ROUND_DOWN)
    .toFixed(2)
}
