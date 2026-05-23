/**
 * Revenue-share report — agrupa pagos del periodo por merchant, aplica
 * `computeRevenueSplit` con la config (`MerchantRevenueShare`) de cada uno, y
 * devuelve el reparto neto (Avoqado / agregador / provider).
 *
 * Report-time, NO toca el cobro. Es seguro re-correrlo. La función puramente
 * matemática (`computeRevenueSplit`) ya tiene cobertura unitaria propia.
 *
 * Spec: docs/superpowers/specs/2026-05-22-revenue-share-fee-model-design.md
 */
import prisma from '../../utils/prismaClient'
import { computeRevenueSplit, type CardType, type MerchantRevenueShareConfig } from './revenueShare.service'

export interface MerchantRevenueRow {
  merchantAccountId: string
  /** Etiqueta amigable (displayName, alias, o externalMerchantId como fallback). */
  merchantLabel: string
  providerCode: string
  /** `true` si el merchant tiene `MerchantRevenueShare.aggregatorPrice` configurado. */
  hasAggregator: boolean
  /** `true` si el merchant tiene una fila `MerchantRevenueShare` (configurado). */
  hasShareConfig: boolean
  txCount: number
  /** Σ amount (volumen procesado, pre-IVA). */
  volume: number
  providerNet: number
  avoqadoNet: number
  aggregatorNet: number
}

interface ReportFilters {
  from: Date
  to: Date
  /** Si se da, filtra a transacciones de un venue específico. */
  venueId?: string
}

/** `TransactionCost.transactionType` puede ser OTHER; lo tratamos como CREDIT
 *  para que el cálculo funcione (rate ya snapshotteado, el tipo solo importa
 *  para resolver `aggregatorPrice[cardType]`). */
function toCardType(t: string): CardType {
  if (t === 'DEBIT' || t === 'CREDIT' || t === 'AMEX' || t === 'INTERNATIONAL') return t
  return 'CREDIT'
}

export async function computeRevenueReport(filters: ReportFilters): Promise<MerchantRevenueRow[]> {
  const txs = await prisma.transactionCost.findMany({
    where: {
      createdAt: { gte: filters.from, lte: filters.to },
      ...(filters.venueId && { payment: { venueId: filters.venueId } }),
    },
    include: {
      merchantAccount: {
        select: {
          id: true,
          alias: true,
          displayName: true,
          externalMerchantId: true,
          provider: { select: { code: true } },
          merchantRevenueShare: true,
        },
      },
    },
  })

  const byMerchant = new Map<string, MerchantRevenueRow>()

  for (const tc of txs) {
    const m = tc.merchantAccount
    const mid = m.id
    const cardType = toCardType(tc.transactionType)

    // Si el merchant tiene config, la convertimos al shape que espera la función
    // pura. Decimal de Prisma llega como objeto; usamos Number() para extraer.
    const ms = m.merchantRevenueShare
    const share: MerchantRevenueShareConfig | null = ms
      ? {
          aggregatorPrice:
            ms.aggregatorPrice && typeof ms.aggregatorPrice === 'object' && !Array.isArray(ms.aggregatorPrice)
              ? (ms.aggregatorPrice as Record<CardType, number>)
              : null,
          aggregatorPriceIncludesTax: ms.aggregatorPriceIncludesTax,
          avoqadoShareOfProviderMargin: Number(ms.avoqadoShareOfProviderMargin),
          avoqadoShareOfAggregatorMargin: ms.avoqadoShareOfAggregatorMargin == null ? null : Number(ms.avoqadoShareOfAggregatorMargin),
          taxRate: Number(ms.taxRate),
        }
      : null

    // Las tasas en TransactionCost son SNAPSHOTS post-`applyTaxIfNeeded`: ya
    // tienen el IVA aplicado si la estructura era "+ IVA". Por eso pasamos
    // `includesTax: true` — la función pura las trata como tasas finales y
    // extrae el monto pre-IVA para el reparto.
    const split = computeRevenueSplit({
      amount: Number(tc.amount),
      cardType,
      providerCostRate: Number(tc.providerRate),
      providerCostIncludesTax: true,
      venueChargeRate: Number(tc.venueRate),
      venueChargeIncludesTax: true,
      share,
    })

    let row = byMerchant.get(mid)
    if (!row) {
      row = {
        merchantAccountId: mid,
        merchantLabel: m.displayName || m.alias || m.externalMerchantId,
        providerCode: m.provider.code,
        hasAggregator: !!share?.aggregatorPrice,
        hasShareConfig: !!share,
        txCount: 0,
        volume: 0,
        providerNet: 0,
        avoqadoNet: 0,
        aggregatorNet: 0,
      }
      byMerchant.set(mid, row)
    }
    row.txCount += 1
    row.volume += Number(tc.amount)
    row.providerNet += split.providerNet
    row.avoqadoNet += split.avoqadoNet
    row.aggregatorNet += split.aggregatorNet
  }

  // Redondea cada fila al final para minimizar drift acumulado.
  const round2 = (n: number) => Math.round(n * 100) / 100
  return Array.from(byMerchant.values())
    .map(r => ({
      ...r,
      volume: round2(r.volume),
      providerNet: round2(r.providerNet),
      avoqadoNet: round2(r.avoqadoNet),
      aggregatorNet: round2(r.aggregatorNet),
    }))
    .sort((a, b) => b.volume - a.volume)
}
