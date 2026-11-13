/**
 * D650 (Codex android r5 #1): el canje de puntos sólo quema los puntos de un cliente que ESTÁ en la cuenta (`Order.customerId` o su
 * liga `OrderCustomer`). Caso: sin red, otra caja cambia la cuenta de Ana a Beto; al volver la red el POS ofrece los puntos de Ana y
 * el canje los quemaba en la cuenta de Beto. La caja (`getCustomerLoyalty`) y la previa del MCP (`previaDelCanjeEnCuenta`) dicen lo
 * mismo que el canje: apagado / rechazado.
 */
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({ getOrCreateLoyaltyConfig: jest.fn() }))
jest.mock('@/services/shared/cuentaCancelada', () => ({ bloquearCuentaParaEditar: jest.fn().mockResolvedValue(true) }))
jest.mock('@/services/online-ordering/card/guards', () => ({ assertCardOrderMoneyFrozenInTx: jest.fn() }))
jest.mock('@/services/giftCards/cuentaDeTarjetas', () => ({ rechazarSiEsCuentaDeTarjetas: jest.fn() }))
jest.mock('@/services/shared/repartoDescuentoTx', () => ({ conservarDescuentoHistorico: jest.fn() }))
jest.mock('@/services/mobile/comp-item.mobile.service', () => ({ recalculateOrderTotals: jest.fn().mockResolvedValue({}) }))

import { getOrCreateLoyaltyConfig } from '@/services/dashboard/loyalty.dashboard.service'
import { getCustomerLoyalty, previaDelCanjeEnCuenta, redeemPointsToOrderInTransaction } from '@/services/mobile/loyalty.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const NO_ESTA = 'Este cliente no está en esta cuenta: agrégalo a la cuenta antes de canjear sus puntos.'
const config = { active: true, pointsPerDollar: 1, redemptionRate: 0.1, minPointsRedeem: 100 }
// Cuenta de $500 abierta; la clienta de la que se piden los puntos es Ana (`c1`).
const cuenta = (customerId: string | null) => ({
  total: 500,
  subtotal: 500,
  discountAmount: 0,
  status: 'PENDING',
  paymentStatus: 'PENDING',
  customerId,
})

function txFalso(orden: object, ligaDeAna: boolean) {
  return {
    order: { findFirst: jest.fn().mockResolvedValue({ id: 'o1', paidAmount: 0, originSystem: null, ...orden }) },
    orderCustomer: { findUnique: jest.fn().mockResolvedValue(ligaDeAna ? { id: 'oc1' } : null) },
    customer: {
      findFirst: jest.fn().mockResolvedValue({ id: 'c1', loyaltyPoints: 500 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ loyaltyPoints: 0 }),
    },
    staffVenue: { findUnique: jest.fn().mockResolvedValue(null) },
    loyaltyTransaction: { create: jest.fn().mockResolvedValue({ id: 'lt' }) },
    orderDiscount: { create: jest.fn().mockResolvedValue({ id: 'od' }) },
  } as any
}

function vista(orden: object | null, ligaDeAna: boolean) {
  ;(getOrCreateLoyaltyConfig as jest.Mock).mockResolvedValue(config)
  prismaMock.customer.findFirst.mockResolvedValue({ id: 'c1', firstName: 'Ana', lastName: null, loyaltyPoints: 500 } as any)
  prismaMock.order.findFirst.mockResolvedValue(orden as any)
  prismaMock.orderCustomer.findUnique.mockResolvedValue((ligaDeAna ? { id: 'oc1' } : null) as any)
}

describe('D650 · el canje sólo usa los puntos de un cliente de la cuenta', () => {
  beforeEach(() => jest.clearAllMocks())

  it('la cuenta es de Beto y Ana no tiene liga: se rechaza sin quemar ni descontar', async () => {
    const tx = txFalso(cuenta('beto'), false)
    await expect(redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 500, undefined, config as any)).rejects.toThrow(NO_ESTA)
    expect(tx.customer.updateMany).not.toHaveBeenCalled()
    expect(tx.loyaltyTransaction.create).not.toHaveBeenCalled()
    expect(tx.orderDiscount.create).not.toHaveBeenCalled()
  })

  it('cuenta sin ningún cliente: también se rechaza (hay que agregarlo primero)', async () => {
    const tx = txFalso(cuenta(null), false)
    await expect(redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 500, undefined, config as any)).rejects.toThrow(NO_ESTA)
  })

  it('Ana es la clienta de la cuenta: canjea como siempre', async () => {
    const tx = txFalso(cuenta('c1'), false)
    await expect(redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 500, undefined, config as any)).resolves.toMatchObject({
      pointsToBurn: 500,
      discountAmount: 50,
    })
  })

  it('Ana está ligada a la cuenta (TPV, varios clientes) aunque la cabecera diga otro: canjea', async () => {
    const tx = txFalso(cuenta('beto'), true)
    await expect(redeemPointsToOrderInTransaction(tx, 'v1', 'o1', 'c1', 500, undefined, config as any)).resolves.toMatchObject({
      pointsToBurn: 500,
    })
    expect(tx.orderCustomer.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId_customerId: { orderId: 'o1', customerId: 'c1' } } }),
    )
  })

  it('la caja: Ana fuera de la cuenta ⇒ «Recompensas» apagado y nada que ofrecer', async () => {
    vista(cuenta('beto'), false)
    const r = await getCustomerLoyalty('v1', 'c1', 'o1')
    expect(r).toMatchObject({ balance: 500, canRedeem: false, maxRedeemablePoints: 0, maxRedeemableValue: 0 })
  })

  it('la caja: Ana ligada a la cuenta ⇒ prendido', async () => {
    vista(cuenta('beto'), true)
    expect(await getCustomerLoyalty('v1', 'c1', 'o1')).toMatchObject({ canRedeem: true, maxRedeemablePoints: 500 })
    vista(cuenta('c1'), false)
    expect(await getCustomerLoyalty('v1', 'c1', 'o1')).toMatchObject({ canRedeem: true, maxRedeemablePoints: 500 })
  })

  it('la previa del MCP dice lo mismo que el canje', async () => {
    vista(cuenta('beto'), false)
    await expect(previaDelCanjeEnCuenta('v1', 'c1', 'o1', 500)).resolves.toEqual({ ok: false, error: NO_ESTA })
    vista(cuenta('c1'), false)
    await expect(previaDelCanjeEnCuenta('v1', 'c1', 'o1', 500)).resolves.toMatchObject({ ok: true, puntos: 500, monto: 50 })
  })
})
