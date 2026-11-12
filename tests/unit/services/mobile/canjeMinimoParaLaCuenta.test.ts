/**
 * hz:ce654971:D18 · regla «B · todo lo que queda» (founder, 12-nov): si el saldo llega al mínimo del negocio pero la cuenta vale
 * menos que ese mínimo, la clienta paga con puntos TODA la cuenta. Una sola regla (`minimoParaCanjear`) para lo que ofrece la caja
 * (`getCustomerLoyalty`, en el mismo campo `minPointsRedeem` para que las apps viejas muestren [max, max]), el canje
 * (`redeemPointsToOrderInTransaction`) y la vista previa del MCP (`previaDelCanje`).
 */
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({ getOrCreateLoyaltyConfig: jest.fn() }))
jest.mock('@/services/shared/cuentaCancelada', () => ({ bloquearCuentaParaEditar: jest.fn().mockResolvedValue(true) }))
jest.mock('@/services/online-ordering/card/guards', () => ({ assertCardOrderMoneyFrozenInTx: jest.fn() }))
jest.mock('@/services/giftCards/cuentaDeTarjetas', () => ({ rechazarSiEsCuentaDeTarjetas: jest.fn() }))
jest.mock('@/services/shared/repartoDescuentoTx', () => ({ conservarDescuentoHistorico: jest.fn() }))
jest.mock('@/services/mobile/comp-item.mobile.service', () => ({ recalculateOrderTotals: jest.fn().mockResolvedValue({}) }))

import { getOrCreateLoyaltyConfig } from '@/services/dashboard/loyalty.dashboard.service'
import {
  getCustomerLoyalty,
  minimoParaCanjear,
  previaDelCanje,
  redeemPointsToOrderInTransaction,
} from '@/services/mobile/loyalty.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const cfg = (o: Partial<{ redemptionRate: number; minPointsRedeem: number; active: boolean }> = {}) => ({
  active: true,
  pointsPerDollar: 1,
  redemptionRate: 0.1,
  minPointsRedeem: 1000,
  ...o,
})
// El caso del hallazgo 2 (apps viejas r2): $95 de productos + $9.50 de servicio, saldo 2,000, mínimo 1,000, $0.10 por punto.
const CUENTA_95 = { total: 104.5, subtotal: 95, discountAmount: 0, status: 'PENDING', paymentStatus: 'PENDING' }

function vista(saldo: number, orden: object | null, c = cfg()) {
  ;(getOrCreateLoyaltyConfig as jest.Mock).mockResolvedValue(c)
  prismaMock.customer.findFirst.mockResolvedValue({ id: 'c1', firstName: 'Ana', lastName: null, loyaltyPoints: saldo })
  prismaMock.order.findFirst.mockResolvedValue(orden)
  return getCustomerLoyalty('v1', 'c1', 'o1')
}

/** Un `tx` falso con lo que lee y escribe el canje. */
function txFalso(saldo: number, orden: object) {
  return {
    order: { findFirst: jest.fn().mockResolvedValue({ id: 'o1', paidAmount: 0, originSystem: null, ...orden }) },
    customer: {
      findFirst: jest.fn().mockResolvedValue({ id: 'c1', loyaltyPoints: saldo }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ loyaltyPoints: 0 }),
    },
    staffVenue: { findUnique: jest.fn().mockResolvedValue(null) },
    loyaltyTransaction: { create: jest.fn().mockResolvedValue({ id: 'lt' }) },
    orderDiscount: { create: jest.fn().mockResolvedValue({ id: 'od' }) },
  } as any
}

describe('minimoParaCanjear — regla B', () => {
  it('cuenta más chica que el mínimo y saldo suficiente ⇒ el mínimo es lo que llena la cuenta', () => {
    expect(minimoParaCanjear(1000, 2000, 0.1, 95)).toBe(950)
  })
  it('saldo abajo del mínimo del negocio ⇒ el mínimo del negocio (no se canjea)', () => {
    expect(minimoParaCanjear(1000, 999, 0.1, 95)).toBe(1000)
  })
  it('cuenta que da para más que el mínimo ⇒ el mínimo del negocio', () => {
    expect(minimoParaCanjear(1000, 2000, 0.1, 500)).toBe(1000)
  })
  it('cuenta sin nada que descontar ⇒ el mínimo del negocio', () => {
    expect(minimoParaCanjear(1000, 2000, 0.1, 0)).toBe(1000)
  })
})

describe('getCustomerLoyalty con la regla B', () => {
  beforeEach(() => jest.clearAllMocks())

  it('$95 + servicio, mínimo 1,000: se prende con 950 puntos por $95 y manda 950 como mínimo (apps viejas: [950, 950])', async () => {
    const r = await vista(2000, CUENTA_95)
    expect(r).toMatchObject({ maxRedeemablePoints: 950, maxRedeemableValue: 95, minPointsRedeem: 950, canRedeem: true })
  })

  it('saldo abajo del mínimo del negocio: apagado y el mínimo de siempre', async () => {
    expect(await vista(999, CUENTA_95)).toMatchObject({ minPointsRedeem: 1000, canRedeem: false })
  })

  it('cuenta grande: el mínimo normal', async () => {
    const r = await vista(2000, { ...CUENTA_95, total: 550, subtotal: 500 })
    expect(r).toMatchObject({ maxRedeemablePoints: 2000, minPointsRedeem: 1000, canRedeem: true })
  })

  it('cuenta con abono: apagado', async () => {
    expect(await vista(2000, { ...CUENTA_95, paymentStatus: 'PARTIAL' })).toMatchObject({ minPointsRedeem: 1000, canRedeem: false })
  })

  it('Codex r3 #1: cuenta de $100 con saldo justo de 50 (mínimo 50, tasa 0.0201): la cuenta da para el mínimo ⇒ no baja; apagado', async () => {
    const r = await vista(
      50,
      { total: 100, subtotal: 100, discountAmount: 0, status: 'PENDING', paymentStatus: 'PENDING' },
      cfg({ redemptionRate: 0.0201, minPointsRedeem: 50 }),
    )
    expect(r).toMatchObject({ maxRedeemablePoints: 49, minPointsRedeem: 50, canRedeem: false })
    expect(minimoParaCanjear(50, 50, 0.0201, 100)).toBe(50)
  })

  it('empate de centavo ($1, tasa 0.0201, mínimo 50): 50 puntos valen $1.00 y caben en la cuenta ⇒ el mínimo no baja; apagado como antes (pintaría «$1.01»)', async () => {
    const r = await vista(
      500,
      { total: 1, subtotal: 1, discountAmount: 0, status: 'PENDING', paymentStatus: 'PENDING' },
      cfg({ redemptionRate: 0.0201, minPointsRedeem: 50 }),
    )
    expect(r).toMatchObject({ maxRedeemablePoints: 49, minPointsRedeem: 50, canRedeem: false })
  })

  it('cuenta de $0.50 (mínimo 50, tasa 0.0201): la cuenta vale menos que el mínimo ⇒ se prende con lo que la llena', async () => {
    const r = await vista(
      500,
      { total: 0.5, subtotal: 0.5, discountAmount: 0, status: 'PENDING', paymentStatus: 'PENDING' },
      cfg({ redemptionRate: 0.0201, minPointsRedeem: 50 }),
    )
    expect(r.canRedeem).toBe(true)
    expect(r.minPointsRedeem).toBe(r.maxRedeemablePoints)
    expect(previaDelCanje(r.maxRedeemablePoints, r)).toMatchObject({ ok: true, puntos: r.maxRedeemablePoints })
  })

  it('la vista previa del MCP usa el mismo mínimo: 950 sí, 949 no', async () => {
    const r = await vista(2000, CUENTA_95)
    expect(previaDelCanje(950, r)).toEqual({ ok: true, puntos: 950, monto: 95 })
    expect(previaDelCanje(949, r)).toEqual({ ok: false, error: 'Se requieren al menos 950 puntos para canjear' })
  })
})

describe('redeemPointsToOrderInTransaction con la regla B', () => {
  beforeEach(() => jest.clearAllMocks())
  const config = cfg()

  it('acepta 950 (abajo del mínimo del negocio) cuando llenan la cuenta: quema 950 y descuenta $95', async () => {
    const tx = txFalso(2000, CUENTA_95)
    const r = await redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 950, undefined, config as any)
    expect(r).toMatchObject({ pointsToBurn: 950, discountAmount: 95 })
  })

  it('Codex r3 #2: abajo del mínimo, la quema exige que el saldo SIGA llegando al mínimo del negocio (dos cajas a la vez)', async () => {
    const tx = txFalso(2000, CUENTA_95)
    await redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 950, undefined, config as any)
    expect(tx.customer.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1', loyaltyPoints: { gte: 1000 } } }))
    // Si otra caja ya gastó parte del saldo, la quema no encuentra la fila y el canje se rechaza sin escribir el descuento.
    const tx2 = txFalso(2000, CUENTA_95)
    tx2.customer.updateMany.mockResolvedValue({ count: 0 })
    await expect(redeemPointsToOrderInTransaction(tx2, 'v1', 'o1', 'c1', 950, undefined, config as any)).rejects.toThrow(
      'Puntos insuficientes',
    )
    expect(tx2.orderDiscount.create).not.toHaveBeenCalled()
  })

  it('canje normal (sobre el mínimo): la quema sólo exige los puntos que quema, como siempre', async () => {
    const tx = txFalso(2000, { ...CUENTA_95, subtotal: 500, total: 550 })
    await redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 1200, undefined, config as any)
    expect(tx.customer.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1', loyaltyPoints: { gte: 1200 } } }))
  })

  it('abajo del mínimo para la cuenta sigue el 400 de siempre', async () => {
    const tx = txFalso(2000, CUENTA_95)
    await expect(redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 949, undefined, config as any)).rejects.toThrow(
      'Se requieren al menos 950 puntos para canjear',
    )
    expect(tx.loyaltyTransaction.create).not.toHaveBeenCalled()
  })

  it('cuenta grande: abajo del mínimo del negocio se rechaza como siempre', async () => {
    const tx = txFalso(2000, { ...CUENTA_95, subtotal: 500, total: 550 })
    await expect(redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 950, undefined, config as any)).rejects.toThrow(
      'Se requieren al menos 1000 puntos para canjear',
    )
  })

  it('saldo abajo del mínimo del negocio: se rechaza con el mínimo del negocio', async () => {
    const tx = txFalso(999, CUENTA_95)
    await expect(redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 950, undefined, config as any)).rejects.toThrow(
      'Se requieren al menos 1000 puntos para canjear',
    )
  })

  it('la petición vieja de 1,045 (antes se ofrecían con el servicio) sigue igual: quema 950 por $95', async () => {
    const tx = txFalso(2000, CUENTA_95)
    const r = await redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 1045, undefined, config as any)
    expect(r).toMatchObject({ pointsToBurn: 950, discountAmount: 95 })
  })
})
