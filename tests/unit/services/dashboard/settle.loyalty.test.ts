/**
 * Liquidar desde el dashboard TAMBIÉN da lealtad (revisión del 5-sep-2026).
 *
 * `settleOrder` y `settleCustomerBalance` marcaban PAID, creaban el Payment y posteaban al cajón
 * sin llamar a `awardLoyaltyForPaidOrder` ni escribir `loyaltyEligibleAt`: el cliente no recibía
 * sello ni puntos, y con la columna en NULL el reconciliador (`loyalty-reconciliation.job`) nunca
 * lo reparaba. Es el mismo defecto que se cerró el 1-sep en el efectivo móvil, en dos caminos que
 * aquel arreglo no miró — y el fiado liquidado es justo el cliente más probable de la tarjeta.
 *
 * Dos invariantes, iguales que en los demás canales:
 *   · la elegibilidad se marca DENTRO del CAS que liquida (queda commiteada con el dinero);
 *   · la acreditación va DESPUÉS del commit y nunca tumba la liquidación.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue(null),
  applySalePosting: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn() }))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  postCashSaleToDrawer: jest.fn().mockResolvedValue('POSTED'),
  cashSaleDrawerLocalId: (id: string) => `pay:${id}`,
}))
jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({
  awardLoyaltyForPaidOrder: jest.fn().mockResolvedValue({ complete: true, errors: [] }),
}))

import { Prisma } from '@prisma/client'
import { awardLoyaltyForPaidOrder } from '@/services/shared/loyaltyOnPaidOrder'
import { settleOrder } from '@/services/dashboard/order.dashboard.service'
import { settleCustomerBalance } from '@/services/dashboard/customer.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const CLIENTE = { id: 'cust-1', firstName: 'Ana', lastName: 'Ríos' }
const award = awardLoyaltyForPaidOrder as jest.Mock

function armarOrden(over: Record<string, unknown> = {}) {
  const order = {
    id: 'order-1',
    venueId: VENUE,
    orderNumber: 'A-1',
    total: 560,
    tipAmount: 60,
    paidAmount: 0,
    remainingBalance: 500,
    paymentStatus: 'PENDING',
    version: 1,
    customer: CLIENTE,
    ...over,
  }
  const updates: any[] = []
  ;(prismaMock as any).order = {
    findFirst: jest.fn().mockResolvedValue(order),
    updateMany: jest.fn().mockImplementation(async (args: any) => {
      updates.push(args)
      return { count: 1 }
    }),
  }
  ;(prismaMock as any).payment = {
    aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0, tipAmount: 0 } }),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn().mockImplementation(async (args: any) => ({ id: 'pay-1', ...args.data })),
  }
  ;(prismaMock as any).orderItem = { findMany: jest.fn().mockResolvedValue([]) }
  ;(prismaMock as any).$transaction = jest.fn().mockImplementation(async (fn: any) => fn(prismaMock))
  return { order, updates }
}

beforeEach(() => jest.clearAllMocks())

describe('settleOrder — la lealtad del cliente', () => {
  it('🔴 marca `loyaltyEligibleAt` DENTRO del CAS que liquida, con quien liquidó', async () => {
    const { updates } = armarOrden()

    await settleOrder(VENUE, 'order-1', undefined, 'staff-7')

    const transicion = updates.find(u => u.data?.paymentStatus === 'PAID')
    expect(transicion).toBeDefined()
    expect(transicion.data.loyaltyEligibleAt).toBeInstanceOf(Date)
    expect(transicion.data.loyaltyStaffId).toBe('staff-7')
  })

  it('🔴 acredita la lealtad con la base SIN propina y el cliente de la orden como respaldo', async () => {
    armarOrden()

    await settleOrder(VENUE, 'order-1', 'pagó en efectivo', 'staff-7')

    expect(award).toHaveBeenCalledTimes(1)
    expect(award).toHaveBeenCalledWith({
      venueId: VENUE,
      orderId: 'order-1',
      // total 560 − propina 60: la propina es del mesero y no genera puntos.
      orderTotal: 500,
      staffId: 'staff-7',
      legacyCustomer: CLIENTE,
    })
  })

  it('la acreditación va DESPUÉS del commit: el `$transaction` termina antes de llamarla', async () => {
    armarOrden()

    await settleOrder(VENUE, 'order-1')

    const tx = (prismaMock as any).$transaction as jest.Mock
    expect(award.mock.invocationCallOrder[0]).toBeGreaterThan(tx.mock.invocationCallOrder[0])
  })

  it('🔴 un fallo de lealtad NO tumba la liquidación (el dinero ya está firmado)', async () => {
    armarOrden()
    award.mockRejectedValueOnce(new Error('loyalty caída'))

    const r = await settleOrder(VENUE, 'order-1')

    expect(r.settledAmount).toBe(500)
  })

  it('sin saldo que liquidar no se acredita nada', async () => {
    armarOrden({ remainingBalance: 0, paymentStatus: 'PAID' })

    await settleOrder(VENUE, 'order-1')

    expect(award).not.toHaveBeenCalled()
  })

  it('regresión: el Payment sigue naciendo CASH / CASH_DRAWER y el cajón se sigue publicando', async () => {
    armarOrden()

    await settleOrder(VENUE, 'order-1')

    const creado = (prismaMock as any).payment.create.mock.calls[0][0].data
    expect(creado).toMatchObject({ method: 'CASH', fundsFlow: 'CASH_DRAWER', amount: 500 })
  })
})

describe('settleCustomerBalance — la lealtad del cliente', () => {
  function armarCliente() {
    const orders = [
      { id: 'o-1', orderNumber: 'A-1', remainingBalance: new Prisma.Decimal(300), total: new Prisma.Decimal(330) },
      { id: 'o-2', orderNumber: 'A-2', remainingBalance: new Prisma.Decimal(200), total: new Prisma.Decimal(200) },
    ]
    ;(prismaMock as any).customer = {
      findFirst: jest.fn().mockResolvedValue({ ...CLIENTE, venueId: VENUE, orderAssociations: orders.map(order => ({ order })) }),
    }
    const frescas: Record<string, any> = {
      'o-1': {
        total: new Prisma.Decimal(330),
        tipAmount: new Prisma.Decimal(30),
        remainingBalance: new Prisma.Decimal(300),
        paymentStatus: 'PENDING',
        version: 1,
      },
      'o-2': {
        total: new Prisma.Decimal(200),
        tipAmount: new Prisma.Decimal(0),
        remainingBalance: new Prisma.Decimal(200),
        paymentStatus: 'PENDING',
        version: 1,
      },
    }
    const updates: any[] = []
    ;(prismaMock as any).order = {
      findFirst: jest.fn().mockImplementation(async (args: any) => frescas[args.where.id]),
      updateMany: jest.fn().mockImplementation(async (args: any) => {
        updates.push(args)
        return { count: 1 }
      }),
    }
    ;(prismaMock as any).payment = {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0, tipAmount: 0 } }),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(async (args: any) => ({ id: `pay-${args.data.orderId}`, ...args.data })),
    }
    ;(prismaMock as any).orderItem = { findMany: jest.fn().mockResolvedValue([]) }
    ;(prismaMock as any).$transaction = jest.fn().mockImplementation(async (fn: any) => fn(prismaMock))
    return { updates }
  }

  it('🔴 marca `loyaltyEligibleAt` en cada orden liquidada, dentro de su CAS', async () => {
    const { updates } = armarCliente()

    await settleCustomerBalance(VENUE, CLIENTE.id, undefined, 'staff-7')

    const transiciones = updates.filter(u => u.data?.paymentStatus === 'PAID')
    expect(transiciones).toHaveLength(2)
    for (const t of transiciones) {
      expect(t.data.loyaltyEligibleAt).toBeInstanceOf(Date)
      expect(t.data.loyaltyStaffId).toBe('staff-7')
    }
  })

  it('🔴 acredita la lealtad de CADA orden liquidada, con su base sin propina y el cliente de la liquidación', async () => {
    armarCliente()

    await settleCustomerBalance(VENUE, CLIENTE.id, undefined, 'staff-7')

    expect(award).toHaveBeenCalledTimes(2)
    expect(award).toHaveBeenCalledWith({ venueId: VENUE, orderId: 'o-1', orderTotal: 300, staffId: 'staff-7', legacyCustomer: CLIENTE })
    expect(award).toHaveBeenCalledWith({ venueId: VENUE, orderId: 'o-2', orderTotal: 200, staffId: 'staff-7', legacyCustomer: CLIENTE })
  })

  it('🔴 sólo se acredita lo que ESTA llamada liquidó: una orden que perdió el CAS no da puntos', async () => {
    armarCliente()
    ;(prismaMock as any).order.updateMany.mockImplementation(async (args: any) => ({ count: args.where.id === 'o-2' ? 0 : 1 }))

    await settleCustomerBalance(VENUE, CLIENTE.id)

    expect(award).toHaveBeenCalledTimes(1)
    expect(award).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'o-1' }))
  })

  it('un fallo de lealtad en una orden NO tumba la liquidación ni la lealtad de la siguiente', async () => {
    armarCliente()
    award.mockRejectedValueOnce(new Error('loyalty caída'))

    const r = await settleCustomerBalance(VENUE, CLIENTE.id)

    expect(r.settledOrderCount).toBe(2)
    expect(award).toHaveBeenCalledTimes(2)
  })
})
