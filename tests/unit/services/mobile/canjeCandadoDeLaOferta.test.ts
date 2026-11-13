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

import {
  minimoParaCanjear,
  puntosQueCaben,
  puntosQueCubren,
  puntosQueSeCanjean,
  redeemPointsToOrderInTransaction,
} from '@/services/mobile/loyalty.mobile.service'

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

  it('medio centavo por punto: $0.14 = 28 puntos (valen $0.14 de verdad); ⌈28.000000000000004⌉ = 29 quemaba de más', () => {
    expect(puntosQueSeCanjean(1000, 0.005, 0.14)).toEqual({ puntos: 28, monto: 0.14 })
    expect(puntosQueSeCanjean(1000, 0.005, 0.01)).toEqual({ puntos: 2, monto: 0.01 })
  })

  it('lo que se quema al recortar es lo mismo que la caja ofrece con la regla B (Codex candado-r1 #1)', () => {
    // Tasa $0.005, mínimo 100, saldo 1,000 y $0.14 por descontar: la caja ofrece [28, 28]; el canje recortado quema 28.
    expect(puntosQueCaben(0.14, 0.005, 1000)).toBe(28)
    expect(minimoParaCanjear(100, 1000, 0.005, 0.14)).toBe(28)
    expect(puntosQueSeCanjean(1000, 0.005, 0.14).puntos).toBe(28)
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
        // Los puntos quemados valen (de verdad) al menos el descuento, y uno menos ya no alcanza.
        expect(p * tasa).toBeGreaterThanOrEqual(monto - 1e-9)
        expect(p === 0 || (p - 1) * tasa < monto - 1e-9).toBe(true)
        expect(money(p * tasa)).toBeGreaterThanOrEqual(monto)
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
    await expect(
      redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 500, undefined, config as any, { monto: 50, puntos: 500 }),
    ).resolves.toMatchObject({
      pointsToBurn: 500,
      discountAmount: 50,
    })
  })

  it('otra caja descontó $99 de una cuenta de $100: 409 LOYALTY_OFFER_CHANGED con la oferta de ahora y no se quema nada', async () => {
    const tx = txFalso(cuenta(100, 99))
    const rechazo = redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 500, undefined, config as any, { monto: 50, puntos: 500 })
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
    await expect(
      redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 500, undefined, config as any, { monto: 40, puntos: 500 }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'LOYALTY_OFFER_CHANGED',
    })
    nadaSeQuemo(tx)
  })

  it('compara a centavos: 50.004 mostrado es $50.00', async () => {
    const tx = txFalso(cuenta(500))
    await expect(
      redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 500, undefined, config as any, { monto: 50.004, puntos: 500 }),
    ).resolves.toMatchObject({
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

  it('sin lo enseñado, las negativas siguen siendo 400 (apps viejas)', async () => {
    const tx = txFalso(cuenta(500), 400)
    await expect(redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 500, undefined, config as any)).rejects.toMatchObject({
      statusCode: 400,
    })
    nadaSeQuemo(tx)
  })

  describe('con lo enseñado, toda negativa de una oferta que cambió es el 409 del candado (Codex candado-r1 #2)', () => {
    const esperado = { monto: 50, puntos: 500 }
    const casos: Array<[string, () => any, object, string]> = [
      ['otra caja gastó puntos', () => txFalso(cuenta(500), 400), config, 'Puntos insuficientes: el cliente tiene 400'],
      ['apagaron el programa', () => txFalso(cuenta(500)), { ...config, active: false }, 'El programa de lealtad no está activo'],
      ['la clienta ya no está en la cuenta', () => txFalso({ ...cuenta(500), customerId: 'beto' }), config, 'no está en esta cuenta'],
      ['registraron un abono', () => txFalso({ ...cuenta(500), paymentStatus: 'PARTIAL' }), config, 'ya pagada'],
      ['anularon la cuenta', () => txFalso({ ...cuenta(500), status: 'CANCELLED' }), config, 'cancelada'],
      ['ya no queda nada que descontar', () => txFalso(cuenta(100, 100)), config, 'no genera descuento'],
      ['subieron el mínimo', () => txFalso(cuenta(500)), { ...config, minPointsRedeem: 1000 }, 'al menos'],
    ]
    it.each(casos)('%s: 409 LOYALTY_OFFER_CHANGED con el motivo y nada se quema', async (_caso, hazTx, conf, motivo) => {
      const tx = hazTx()
      const rechazo = redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 500, undefined, conf as any, esperado)
      await expect(rechazo).rejects.toMatchObject({ statusCode: 409, code: 'LOYALTY_OFFER_CHANGED' })
      await expect(rechazo).rejects.toThrow('La cuenta cambió')
      await expect(rechazo).rejects.toThrow(motivo)
      nadaSeQuemo(tx)
    })

    it('otro canje ganó la quema al mismo tiempo: también 409, y nada queda (se deshace con la transacción)', async () => {
      const tx = txFalso(cuenta(500))
      tx.customer.updateMany.mockResolvedValue({ count: 0 })
      await expect(redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 500, undefined, config as any, esperado)).rejects.toMatchObject({
        statusCode: 409,
        code: 'LOYALTY_OFFER_CHANGED',
      })
      expect(tx.orderDiscount.create).not.toHaveBeenCalled()
    })
  })

  it('el MCP recorta a propósito: con los puntos de su previa (los que se queman), canjea (Codex candado-r1 #1)', async () => {
    // Pide 500 ($50) en una cuenta con $1 por descontar: su previa dijo 10 puntos por $1.00.
    const tx = txFalso(cuenta(100, 99))
    await expect(
      redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 500, undefined, config as any, { monto: 1, puntos: 10 }),
    ).resolves.toMatchObject({ pointsToBurn: 10, discountAmount: 1 })
    const otra = txFalso(cuenta(100, 99))
    await expect(
      redeemPointsToOrderInTransaction(otra, 'v1', 'o1', 'c1', 500, undefined, config as any, { monto: 1, puntos: 9 }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'LOYALTY_OFFER_CHANGED' })
  })

  it('regla B con medio centavo: lo que la caja ofrece (28 por $0.14) se canjea, también pidiendo 1,000 con la previa del MCP', async () => {
    const conf = { active: true, pointsPerDollar: 1, redemptionRate: 0.005, minPointsRedeem: 100 }
    const tx = txFalso(cuenta(100, 99.86), 1000)
    await expect(
      redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 28, undefined, conf as any, { monto: 0.14, puntos: 28 }),
    ).resolves.toMatchObject({ pointsToBurn: 28, discountAmount: 0.14 })
    const mcp = txFalso(cuenta(100, 99.86), 1000)
    await expect(
      redeemPointsToOrderInTransaction(mcp, 'v1', 'o1', 'c1', 1000, undefined, conf as any, { monto: 0.14, puntos: 28 }),
    ).resolves.toMatchObject({ pointsToBurn: 28, discountAmount: 0.14 })
  })
})
