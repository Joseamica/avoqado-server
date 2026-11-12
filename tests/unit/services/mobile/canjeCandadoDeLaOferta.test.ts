/**
 * D18 (12-nov, founder «quiero que quede perfecto»): la tablet sólo canjea exactamente lo que mostró. Si manda el monto de su diálogo
 * (`expectedDiscountAmount`) y la cuenta cambió (otra caja la descontó, se gastaron los puntos, cambió la tasa…), el canje no quema
 * nada y contesta 409 `LOYALTY_OFFER_CHANGED` con la oferta de ahora. Sin el campo (apps viejas, la tienda, el panel) recorta como
 * siempre.
 *
 * D2 (mismo día): al recortar, se queman los MENOS puntos cuyo valor a centavos cubre el descuento. `⌈monto / valor⌉` en flotante se
 * pasaba: $0.14 a $0.01 por punto = ⌈14.000000000000002⌉ = 15 y la clienta perdía un punto.
 */
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({ getOrCreateLoyaltyConfig: jest.fn() }))
jest.mock('@/services/shared/cuentaCancelada', () => ({ bloquearCuentaParaEditar: jest.fn().mockResolvedValue(true) }))
jest.mock('@/services/online-ordering/card/guards', () => ({ assertCardOrderMoneyFrozenInTx: jest.fn() }))
jest.mock('@/services/giftCards/cuentaDeTarjetas', () => ({ rechazarSiEsCuentaDeTarjetas: jest.fn() }))
jest.mock('@/services/shared/repartoDescuentoTx', () => ({ conservarDescuentoHistorico: jest.fn() }))
jest.mock('@/services/mobile/comp-item.mobile.service', () => ({ recalculateOrderTotals: jest.fn().mockResolvedValue({}) }))

import { puntosQueCubren, puntosQueSeCanjean, redeemPointsToOrderInTransaction } from '@/services/mobile/loyalty.mobile.service'

const money = (v: number) => Math.round(v * 100) / 100
const config = { active: true, pointsPerDollar: 1, redemptionRate: 0.1, minPointsRedeem: 100 }
// Cuenta abierta de Ana (`c1`), sin pagos; Ana tiene 500 puntos a $0.10 = $50.
const cuenta = (subtotal: number, discountAmount = 0) => ({
  total: subtotal,
  subtotal,
  discountAmount,
  status: 'PENDING',
  paymentStatus: 'PENDING',
  customerId: 'c1',
})

function txFalso(orden: object, puntos = 500) {
  return {
    order: { findFirst: jest.fn().mockResolvedValue({ id: 'o1', paidAmount: 0, originSystem: null, ...orden }) },
    orderCustomer: { findUnique: jest.fn().mockResolvedValue(null) },
    customer: {
      findFirst: jest.fn().mockResolvedValue({ id: 'c1', loyaltyPoints: puntos }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ loyaltyPoints: 0 }),
    },
    staffVenue: { findUnique: jest.fn().mockResolvedValue(null) },
    loyaltyTransaction: { create: jest.fn().mockResolvedValue({ id: 'lt' }) },
    orderDiscount: { create: jest.fn().mockResolvedValue({ id: 'od' }) },
  } as any
}

const nadaSeQuemo = (tx: any) => {
  expect(tx.customer.updateMany).not.toHaveBeenCalled()
  expect(tx.loyaltyTransaction.create).not.toHaveBeenCalled()
  expect(tx.orderDiscount.create).not.toHaveBeenCalled()
}

describe('D2 · al recortar se queman los MENOS puntos que cubren el descuento', () => {
  it('$0.14 a $0.01 por punto: 14 puntos, no 15', () => {
    expect(puntosQueSeCanjean(20, 0.01, 0.14)).toEqual({ puntos: 14, monto: 0.14 })
    expect(puntosQueSeCanjean(100, 0.01, 0.07)).toEqual({ puntos: 7, monto: 0.07 })
  })

  it('empates de 0.0201 por punto: $1.00 = 50 y $0.98 = 49 (lo que el canje valora a centavos)', () => {
    expect(puntosQueSeCanjean(1000, 0.0201, 1)).toEqual({ puntos: 50, monto: 1 })
    expect(puntosQueSeCanjean(1000, 0.0201, 0.98)).toEqual({ puntos: 49, monto: 0.98 })
  })

  it('medio centavo por punto: el valor a centavos de los puntos quemados cubre el descuento y uno menos ya no', () => {
    const r = puntosQueSeCanjean(1000, 0.005, 0.14)
    expect(r.monto).toBe(0.14)
    expect(money(r.puntos * 0.005)).toBeGreaterThanOrEqual(0.14)
    expect(money((r.puntos - 1) * 0.005)).toBeLessThan(0.14)
    expect(r.puntos).toBeLessThan(Math.ceil(0.14 / 0.005)) // ⌈28.000000000000004⌉ = 29 quemaba de más
  })

  it('sin recorte se queman los puntos pedidos, igual que siempre', () => {
    expect(puntosQueSeCanjean(500, 0.1, 500)).toEqual({ puntos: 500, monto: 50 })
    expect(puntosQueSeCanjean(29, 0.005, 10)).toEqual({ puntos: 29, monto: 0.14 }) // el empate de medio centavo: 0.145 → $0.14
  })

  it('en toda una rejilla de tasas y montos: lo mínimo que cubre, nunca de más ni de menos', () => {
    for (const tasa of [0.005, 0.0059, 0.01, 0.0149, 0.015, 0.0201, 0.05, 0.1, 0.25]) {
      for (let centavos = 1; centavos <= 300; centavos++) {
        const monto = centavos / 100
        const p = puntosQueCubren(monto, tasa, 1_000_000)
        expect(money(p * tasa)).toBeGreaterThanOrEqual(monto)
        expect(p === 0 || money((p - 1) * tasa) < monto).toBe(true)
      }
    }
  })

  it('nunca pasa del máximo ni inventa puntos con valores raros', () => {
    expect(puntosQueCubren(0.14, 0.01, 10)).toBe(10)
    expect(puntosQueCubren(0, 0.01, 10)).toBe(0)
    expect(puntosQueCubren(1, 0, 10)).toBe(0)
  })
})

describe('Candado de la oferta · la tablet sólo canjea exactamente lo que mostró', () => {
  beforeEach(() => jest.clearAllMocks())

  it('mostró 500 puntos por $50 y la cuenta sigue igual: canjea eso', async () => {
    const tx = txFalso(cuenta(500))
    await expect(redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 500, undefined, config as any, 50)).resolves.toMatchObject({
      pointsToBurn: 500,
      discountAmount: 50,
    })
  })

  it('otra caja descontó $99 de una cuenta de $100: 409 LOYALTY_OFFER_CHANGED con la oferta de ahora y no se quema nada', async () => {
    const tx = txFalso(cuenta(100, 99))
    const rechazo = redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 500, undefined, config as any, 50)
    await expect(rechazo).rejects.toMatchObject({
      statusCode: 409,
      code: 'LOYALTY_OFFER_CHANGED',
      details: { pointsRedeemable: 10, discountAmount: 1 },
    })
    await expect(rechazo).rejects.toThrow('La cuenta cambió: ahora se canjearían 10 puntos por $1.00.')
    nadaSeQuemo(tx)
  })

  it('mismos puntos pero otro monto (cambió la tasa o lo que mostró): 409 y no se quema nada', async () => {
    const tx = txFalso(cuenta(500))
    await expect(redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 500, undefined, config as any, 40)).rejects.toMatchObject({
      statusCode: 409,
      code: 'LOYALTY_OFFER_CHANGED',
    })
    nadaSeQuemo(tx)
  })

  it('compara a centavos: 50.004 mostrado es $50.00', async () => {
    const tx = txFalso(cuenta(500))
    await expect(redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 500, undefined, config as any, 50.004)).resolves.toMatchObject({
      pointsToBurn: 500,
    })
  })

  it('sin el monto (apps viejas, tienda, panel): recorta como siempre', async () => {
    const tx = txFalso(cuenta(100, 99))
    await expect(redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 500, undefined, config as any)).resolves.toMatchObject({
      pointsToBurn: 10,
      discountAmount: 1,
    })
  })

  it('las negativas de siempre siguen antes del candado (puntos insuficientes = 400)', async () => {
    const tx = txFalso(cuenta(500), 400)
    await expect(redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 500, undefined, config as any, 50)).rejects.toMatchObject({
      statusCode: 400,
    })
    nadaSeQuemo(tx)
  })
})
