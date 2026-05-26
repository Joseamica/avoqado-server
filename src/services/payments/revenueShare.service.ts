/**
 * Revenue-share — reparte el fee de una transacción entre provider, agregador y
 * Avoqado según la config (`MerchantRevenueShare`) del merchant.
 *
 * Función PURA, sin I/O. La llaman los reportes / liquidación, NUNCA el proceso
 * de pago (`transactionCost.service` queda intacto).
 *
 * Spec: docs/superpowers/specs/2026-05-22-revenue-share-fee-model-design.md
 */

export type CardType = 'DEBIT' | 'CREDIT' | 'AMEX' | 'INTERNATIONAL'

export interface MerchantRevenueShareConfig {
  /** Precio que Avoqado le cobra al agregador, por tipo de tarjeta (decimales 0..1).
   *  `null` = venta directa (sin agregador). */
  aggregatorPrice: Record<CardType, number> | null
  aggregatorPriceIncludesTax: boolean
  /** Fracción 0..1 del margen procesador→Avoqado que se queda Avoqado. */
  avoqadoShareOfProviderMargin: number
  /** Fracción 0..1 del margen agregador→venue que se queda Avoqado. `null` si directo. */
  avoqadoShareOfAggregatorMargin: number | null
  taxRate: number
}

export interface RevenueSplitInput {
  amount: number
  cardType: CardType
  providerCostRate: number
  providerCostIncludesTax: boolean
  venueChargeRate: number
  venueChargeIncludesTax: boolean
  /** `null` = sin config: todo el grossProfit se atribuye a Avoqado (comportamiento histórico). */
  share: MerchantRevenueShareConfig | null
}

export interface RevenueSplit {
  /** Costo del procesador + la parte del margen que le toca. */
  providerNet: number
  /** Suma de las partes de Avoqado en cada margen. */
  avoqadoNet: number
  /** 0 si es venta directa. */
  aggregatorNet: number
  /** IVA por capa, pass-through (no se reparte — cada parte lo entera a SAT). */
  ivaByLayer: { provider: number; aggregator: number; venue: number }
  /** Avoqado's share of the provider→aggregator margin (tramo 1). */
  avoqadoFromProviderMargin: number
  /** Avoqado's share of the aggregator→venue margin (tramo 2). 0 when direct/no-config. */
  avoqadoFromAggregatorMargin: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Si un fee "incluye IVA", lo devolvemos pre-IVA dividiendo por `(1 + taxRate)`.
 *  Si no, ya es pre-IVA y pasa tal cual. El revenue-share se reparte SIEMPRE
 *  sobre montos pre-IVA. */
const preIva = (fee: number, includesTax: boolean, taxRate: number) => (includesTax ? fee / (1 + taxRate) : fee)

export function computeRevenueSplit(input: RevenueSplitInput): RevenueSplit {
  const { amount, cardType, providerCostRate, venueChargeRate, share } = input
  const taxRate = share?.taxRate ?? 0.16

  const providerCost = round2(preIva(amount * providerCostRate, input.providerCostIncludesTax, taxRate))
  const venueCharge = round2(preIva(amount * venueChargeRate, input.venueChargeIncludesTax, taxRate))

  let providerNet: number
  let avoqadoNet: number
  let aggregatorNet = 0
  let aggregatorPrice = 0
  let avoqadoFromProviderMargin: number
  let avoqadoFromAggregatorMargin: number

  if (!share) {
    // Sin config — comportamiento histórico: todo el margen a Avoqado.
    providerNet = providerCost
    avoqadoNet = round2(venueCharge - providerCost)
    avoqadoFromProviderMargin = avoqadoNet
    avoqadoFromAggregatorMargin = 0
  } else if (!share.aggregatorPrice) {
    // Directo: 1 margen, split provider↔Avoqado.
    const margin = venueCharge - providerCost
    avoqadoNet = round2(margin * share.avoqadoShareOfProviderMargin)
    providerNet = round2(venueCharge - avoqadoNet)
    avoqadoFromProviderMargin = avoqadoNet
    avoqadoFromAggregatorMargin = 0
  } else {
    // Con agregador: 2 márgenes, 2 splits.
    aggregatorPrice = round2(preIva(amount * share.aggregatorPrice[cardType], share.aggregatorPriceIncludesTax, taxRate))
    const m1 = aggregatorPrice - providerCost
    const m2 = venueCharge - aggregatorPrice
    const aggShare = share.avoqadoShareOfAggregatorMargin ?? 0
    const avoFromM1 = round2(m1 * share.avoqadoShareOfProviderMargin)
    const avoFromM2 = round2(m2 * aggShare)
    avoqadoNet = round2(avoFromM1 + avoFromM2)
    providerNet = round2(providerCost + (m1 - avoFromM1))
    aggregatorNet = round2(m2 - avoFromM2)
    avoqadoFromProviderMargin = avoFromM1
    avoqadoFromAggregatorMargin = avoFromM2
  }

  const iva = (fee: number, includesTax: boolean) => (includesTax ? 0 : round2(fee * taxRate))

  return {
    providerNet,
    avoqadoNet,
    aggregatorNet,
    ivaByLayer: {
      provider: iva(providerCost, input.providerCostIncludesTax),
      aggregator: share?.aggregatorPrice ? iva(aggregatorPrice, share.aggregatorPriceIncludesTax) : 0,
      venue: iva(venueCharge, input.venueChargeIncludesTax),
    },
    avoqadoFromProviderMargin,
    avoqadoFromAggregatorMargin,
  }
}
