/**
 * hz:ce654971:D18 — la vista de lealtad que usa el POS (`getCustomerLoyalty`) topa con la MISMA regla y la MISMA base que el canje
 * (`redeemPointsToOrderInTransaction`): subtotal − descuentos, nunca `order.total` (que trae cargos por servicio e IVA aparte).
 */
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({
  getOrCreateLoyaltyConfig: jest.fn(),
}))

import { getOrCreateLoyaltyConfig } from '@/services/dashboard/loyalty.dashboard.service'
import { getCustomerLoyalty, puntosQueSeCanjean } from '@/services/mobile/loyalty.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const config = (o: Partial<{ redemptionRate: number; minPointsRedeem: number; active: boolean }> = {}) => ({
  active: true,
  pointsPerDollar: 1,
  redemptionRate: 1,
  minPointsRedeem: 10,
  ...o,
})

function preparar({
  saldo,
  orden,
  cfg = {},
}: {
  saldo: number
  orden?: { total: number; subtotal: number; discountAmount: number } | null // `total` va para mostrar que ya no se lee
  cfg?: Parameters<typeof config>[0]
}) {
  ;(getOrCreateLoyaltyConfig as jest.Mock).mockResolvedValue(config(cfg))
  prismaMock.customer.findFirst.mockResolvedValue({ id: 'c1', firstName: 'Ana', lastName: null, loyaltyPoints: saldo })
  prismaMock.order.findFirst.mockResolvedValue(orden ?? null)
}

describe('getCustomerLoyalty — tope igual al canje (D18)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('con cargo por servicio, topa contra subtotal − descuentos y no contra el total', async () => {
    // $100 de productos, $10 de descuento, $9 de cargo por servicio ⇒ total $99; el canje sólo puede bajar $90.
    preparar({ saldo: 500, orden: { total: 99, subtotal: 100, discountAmount: 10 } })
    const r = await getCustomerLoyalty('v1', 'c1', 'o1')
    expect(r.maxRedeemableValue).toBe(90)
    expect(r.maxRedeemablePoints).toBe(90)
    // Lo que ofrece la caja es exactamente lo que el canje aplicaría con esos puntos.
    expect(puntosQueSeCanjean(r.maxRedeemablePoints, r.redemptionRate, 100 - 10)).toEqual({ puntos: 90, monto: 90 })
  })

  it('con IVA aparte, el IVA no entra al tope', async () => {
    preparar({ saldo: 500, orden: { total: 116, subtotal: 100, discountAmount: 0 } })
    const r = await getCustomerLoyalty('v1', 'c1', 'o1')
    expect(r.maxRedeemableValue).toBe(100)
    expect(r.maxRedeemablePoints).toBe(100)
  })

  it('los puntos ofrecidos nunca valen más de lo que el canje descuenta (tasa con decimales)', async () => {
    preparar({ saldo: 5000, orden: { total: 0.3, subtotal: 0.3, discountAmount: 0 }, cfg: { redemptionRate: 0.1, minPointsRedeem: 1 } })
    const r = await getCustomerLoyalty('v1', 'c1', 'o1')
    expect(r.maxRedeemableValue).toBe(0.3)
    expect(r.maxRedeemablePoints).toBe(3)
    expect(puntosQueSeCanjean(r.maxRedeemablePoints, 0.1, 0.3)).toEqual({ puntos: 3, monto: 0.3 })
  })

  it('base de centavos: los puntos ofrecidos caben sin que el canje los tope', async () => {
    preparar({ saldo: 500, orden: { total: 105.5, subtotal: 95.5, discountAmount: 0 } })
    const r = await getCustomerLoyalty('v1', 'c1', 'o1')
    expect(r.maxRedeemableValue).toBe(95.5)
    expect(r.maxRedeemablePoints).toBe(95)
    const canje = puntosQueSeCanjean(r.maxRedeemablePoints, 1, 95.5)
    expect(canje.monto).toBe(r.maxRedeemablePoints * r.redemptionRate)
  })

  it('cuenta ya descontada por completo ⇒ no se puede canjear', async () => {
    preparar({ saldo: 500, orden: { total: 9, subtotal: 100, discountAmount: 100 } })
    const r = await getCustomerLoyalty('v1', 'c1', 'o1')
    expect(r.maxRedeemablePoints).toBe(0)
    expect(r.canRedeem).toBe(false)
  })

  // ── Regresión: lo que ya hacía ──
  it('sin orden, el tope es el saldo', async () => {
    preparar({ saldo: 250 })
    const r = await getCustomerLoyalty('v1', 'c1')
    expect(r.maxRedeemableValue).toBe(250)
    expect(r.maxRedeemablePoints).toBe(250)
    expect(r.canRedeem).toBe(true)
    expect(prismaMock.order.findFirst).not.toHaveBeenCalled()
  })

  it('saldo menor que la cuenta: se ofrece todo el saldo', async () => {
    preparar({ saldo: 40, orden: { total: 200, subtotal: 200, discountAmount: 0 } })
    const r = await getCustomerLoyalty('v1', 'c1', 'o1')
    expect(r.maxRedeemablePoints).toBe(40)
    expect(r.maxRedeemableValue).toBe(40)
  })

  it('orden que no existe en el negocio: sin tope de cuenta', async () => {
    preparar({ saldo: 60, orden: null })
    const r = await getCustomerLoyalty('v1', 'c1', 'o-ajena')
    expect(r.maxRedeemablePoints).toBe(60)
    expect(prismaMock.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'o-ajena', venueId: 'v1' } }))
  })

  it('por debajo del mínimo no se puede canjear', async () => {
    preparar({ saldo: 5, orden: { total: 100, subtotal: 100, discountAmount: 0 } })
    const r = await getCustomerLoyalty('v1', 'c1', 'o1')
    expect(r.canRedeem).toBe(false)
  })
})
