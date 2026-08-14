/**
 * Tests: el umbral de restock del refund TPV debe comparar contra la MERCANCÍA,
 * no contra Order.total (que incluye propina).
 *
 * Contexto (auditoría de inventario 2026-08-12, hallazgo D-18, confirmado por
 * Codex): `crossedToFullyRefunded` comparaba la suma de refunds de VENTA
 * (Payment.amount, sin propina) contra `Order.total` (CON propina acumulada).
 * Con propina > 0 el umbral jamás se cruzaba → reembolsar el 100% de una orden
 * con propina nunca reponía stock, en silencio. Síntoma de la doble semántica
 * de Order.total.
 *
 * La regla correcta: mercancía = max(0, total − tipAmount). El refund que cruza
 * ESE umbral repone; los siguientes ya no (idempotencia por cruce).
 */

import { crossedFullRefundThreshold } from '@/services/tpv/refund.tpv.service'

describe('crossedFullRefundThreshold — umbral de restock por mercancía', () => {
  it('CON propina: reembolsar toda la venta cruza aunque total incluya la propina (el bug)', () => {
    expect(
      crossedFullRefundThreshold({
        orderTotal: 115, // 100 mercancía + 15 propina
        orderTipAmount: 15,
        totalRefundedSale: 100,
        salesRefundThisTime: 100,
      }),
    ).toBe(true)
  })

  it('SIN propina: comportamiento original intacto (regresión)', () => {
    expect(crossedFullRefundThreshold({ orderTotal: 100, orderTipAmount: 0, totalRefundedSale: 100, salesRefundThisTime: 100 })).toBe(true)
  })

  it('refund parcial NO cruza', () => {
    expect(crossedFullRefundThreshold({ orderTotal: 100, orderTipAmount: 0, totalRefundedSale: 50, salesRefundThisTime: 50 })).toBe(false)
  })

  it('cruza EXACTAMENTE una vez: el refund que completa el total sí, el siguiente ya no', () => {
    // Segundo parcial que completa 100: before = 50 → cruza
    expect(crossedFullRefundThreshold({ orderTotal: 100, orderTipAmount: 0, totalRefundedSale: 100, salesRefundThisTime: 50 })).toBe(true)
    // Un refund posterior (sobre-reembolso): before = 100, ya estaba cruzado → no repone doble
    expect(crossedFullRefundThreshold({ orderTotal: 100, orderTipAmount: 0, totalRefundedSale: 120, salesRefundThisTime: 20 })).toBe(false)
  })

  it('cuenta 100% propina (mercancía 0) jamás repone', () => {
    expect(crossedFullRefundThreshold({ orderTotal: 15, orderTipAmount: 15, totalRefundedSale: 15, salesRefundThisTime: 15 })).toBe(false)
  })

  it('tolerancia de centavo: 99.995 de 100 cuenta como completo', () => {
    expect(crossedFullRefundThreshold({ orderTotal: 100, orderTipAmount: 0, totalRefundedSale: 99.995, salesRefundThisTime: 99.995 })).toBe(
      true,
    )
  })
})
