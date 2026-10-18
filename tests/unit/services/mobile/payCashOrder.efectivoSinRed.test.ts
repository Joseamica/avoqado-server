/**
 * 🔴 S1 y S2 del efectivo cobrado SIN RED (Codex, auditoría de sellos tardíos, recheck 17, hallazgos #2 y #3).
 *
 * El aparato A cobra $100 sin red y lo encola; al volver la red, el servidor ya cambió:
 *   · S1: otra caja YA cerró la venta (PAID o REFUNDED). Antes: 400 «Order is already paid» o 409 tras 3 intentos, el intento queda
 *     en cuarentena ⇒ $200 en el cajón y $100 en la base.
 *   · S2: otra caja abonó $50 antes del reenvío. Antes: Payment de $50 y $50 de «cambio» que nadie entregó.
 *
 * La regla que ya existe (founder 3-oct; ronda 8 de sellos, `estadoDeCobroAlRecibirDinero`): el dinero ya capturado se registra
 * ÍNTEGRO, deduplicado por su llave; la venta cerrada se queda cerrada, sin repetir inventario, lealtad, comanda ni referido, y sale
 * el aviso 🚨 [Sobrepago] + `SOBREPAGO_DETECTADO`, como en la TPV. El cobro NUEVO en vivo sigue rechazándose / recortando como hoy.
 */

jest.mock('@/services/tpv/paymentEffects.service', () => ({
  enqueuePaymentCommissionInTx: jest.fn().mockResolvedValue(undefined),
  enqueuePaymentEffect: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({
  generateAndStoreReceipt: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
}))
jest.mock('@/services/tpv/payment.tpv.service', () => ({
  mapDigitalReceiptResponse: jest.fn(() => null),
  resolveAutofacturaAvailable: jest.fn().mockResolvedValue(false),
}))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue({ id: 'posting-1' }),
  applySalePosting: jest.fn().mockResolvedValue(null),
}))
jest.mock('@/services/dashboard/autoReorder.service', () => ({ runAutoReorderForVenue: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({ awardLoyaltyForPaidOrder: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/shared/cashDrawerPosting', () => ({ postCashSaleToDrawer: jest.fn().mockResolvedValue('POSTED') }))
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  ...jest.requireActual('@/services/kds/kitchenDisplayStations'),
  debeMarcarCocina: jest.fn().mockResolvedValue(true),
}))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  armarComandasTrasCommit: jest.fn().mockResolvedValue(undefined),
}))

import { Decimal } from '@prisma/client/runtime/library'

import logger from '@/config/logger'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { createSalePostingInTx } from '@/services/inventory/inventoryPosting.service'
import { onOrderPaid } from '@/services/referrals/referralQualification.service'
import { awardLoyaltyForPaidOrder } from '@/services/shared/loyaltyOnPaidOrder'
import { postCashSaleToDrawer } from '@/services/shared/cashDrawerPosting'
import { enqueuePaymentEffect } from '@/services/tpv/paymentEffects.service'
import { armarComandasTrasCommit } from '@/services/kds/kitchenTicketAuthoring.service'
import { prismaMock } from '../../../__helpers__/setup'

type Estado = 'PENDING' | 'PARTIAL' | 'PAID' | 'REFUNDED'
interface Pago {
  id: string
  amount: number
  tipAmount: number
  type: 'REGULAR' | 'REFUND'
  method: string
  idempotencyKey: string | null
}

/** Base falsa con CAS real (como `payCashOrder.concurrency.test.ts`): cada `await` cede el turno y la llave es única. */
function instalarBase(inicial: { paymentStatus: Estado; status?: string; total: number }, previos: Array<Partial<Pago>> = []) {
  const row = {
    id: 'order-1',
    orderNumber: 'ORD-1',
    venueId: 'venue-1',
    paymentStatus: inicial.paymentStatus as string,
    status: inicial.status ?? (inicial.paymentStatus === 'PAID' || inicial.paymentStatus === 'REFUNDED' ? 'COMPLETED' : 'CONFIRMED'),
    subtotal: new Decimal(inicial.total),
    discountAmount: new Decimal(0),
    serviceChargeAmount: new Decimal(0),
    taxAmount: new Decimal(0),
    contratoDePrecio: 'IVA_INCLUIDO',
    originSystem: 'AVOQADO',
    total: new Decimal(inicial.total),
    paidAmount: new Decimal(0),
    remainingBalance: new Decimal(0),
    version: 1,
    areaTicketCode: null,
    areaTicketCheckoutSession: null,
    tableId: null,
    customerId: null,
    customer: null,
  }
  const pagos: Pago[] = previos.map((p, i) => ({
    id: `previo-${i + 1}`,
    amount: 0,
    tipAmount: 0,
    type: 'REGULAR',
    method: 'CASH',
    idempotencyKey: null,
    ...p,
  }))
  const cas: any[] = []
  const turno = () => new Promise(resolve => setImmediate(resolve))

  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.order.findUnique.mockImplementation(async () => {
    await turno()
    return { ...row }
  })
  prismaMock.order.updateMany.mockImplementation(async ({ where, data }: any) => {
    await turno()
    const version = where.version === undefined || where.version === row.version
    const estado =
      where.paymentStatus === undefined ||
      (typeof where.paymentStatus === 'string'
        ? where.paymentStatus === row.paymentStatus
        : where.paymentStatus.in.includes(row.paymentStatus))
    if (!version || !estado) return { count: 0 }
    cas.push({ where, data })
    row.paymentStatus = data.paymentStatus ?? row.paymentStatus
    row.status = data.status ?? row.status
    row.paidAmount = new Decimal(data.paidAmount ?? row.paidAmount)
    row.remainingBalance = new Decimal(data.remainingBalance ?? row.remainingBalance)
    if (data.version?.increment) row.version += data.version.increment
    return { count: 1 }
  })
  prismaMock.payment.findMany.mockImplementation(async () => {
    await turno()
    return pagos.map(p => ({ amount: new Decimal(p.amount), tipAmount: new Decimal(p.tipAmount), type: p.type }))
  })
  prismaMock.payment.create.mockImplementation(async ({ data }: any) => {
    await turno()
    if (data.idempotencyKey && pagos.some(p => p.idempotencyKey === data.idempotencyKey)) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    }
    const nuevo: Pago = {
      id: `payment-${pagos.length + 1}`,
      amount: Number(data.amount),
      tipAmount: Number(data.tipAmount),
      type: 'REGULAR',
      method: data.method,
      idempotencyKey: data.idempotencyKey ?? null,
    }
    pagos.push(nuevo)
    return { ...nuevo, createdAt: new Date(), receipts: [] }
  })
  prismaMock.payment.findUnique.mockImplementation(async ({ where }: any) => {
    await turno()
    const p = pagos.find(x => x.idempotencyKey && x.idempotencyKey === where?.venueId_idempotencyKey?.idempotencyKey)
    return p ? { ...p, orderId: 'order-1', amount: new Decimal(p.amount), tipAmount: new Decimal(p.tipAmount), receipts: [] } : null
  })
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.cashDrawerSession.findFirst.mockResolvedValue({ id: 'caja-1' })
  prismaMock.activityLog.create.mockResolvedValue({})
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
  return { row, pagos, cas }
}

/** Lo que manda la cola sin red: lo que el aparato aplicó, con su llave y `isOfflineReplay`. */
const cola = (amount: number, idempotencyKey: string) => ({ amount, tip: 0, staffId: 'staff-1', idempotencyKey, isOfflineReplay: true })
const avisos = () => (logger.error as jest.Mock).mock.calls.filter(c => String(c[0]).startsWith('🚨 [Sobrepago] Se cobró MÁS'))
const bitacoras = () =>
  (prismaMock.activityLog.create as jest.Mock).mock.calls.map(c => c[0].data).filter(d => d.action === 'SOBREPAGO_DETECTADO')
const referidos = () => (enqueuePaymentEffect as jest.Mock).mock.calls.filter(c => c[1]?.kind === 'REFERRAL')

/** Lo que NO se repite sobre una venta que ya estaba cerrada: inventario, lealtad, comanda, referido, cierre y marca de cocina. */
function sinEfectosDeSaldar(cas: any[]) {
  expect(createSalePostingInTx).not.toHaveBeenCalled()
  expect(awardLoyaltyForPaidOrder).not.toHaveBeenCalled()
  expect(onOrderPaid).not.toHaveBeenCalled()
  expect(armarComandasTrasCommit).not.toHaveBeenCalled()
  expect(referidos()).toHaveLength(0)
  for (const { data } of cas) {
    expect([data.status, data.loyaltyEligibleAt, data.kitchenPendingAt]).toEqual([undefined, undefined, undefined])
  }
}

describe('S1: el reenvío del efectivo sobre una venta que otra caja YA cerró', () => {
  it('🔴 U1 PAID: A cobró $100 sin red, B cobró $100 en vivo ⇒ el reenvío se registra ÍNTEGRO, la venta sigue PAID con saldo 0, 🚨 + bitácora, cajón +$100 (hoy: 400 y $100 fuera)', async () => {
    const { row, pagos, cas } = instalarBase({ paymentStatus: 'PAID', total: 100 }, [{ amount: 100 }])

    const r = await payCashOrder('venue-1', 'order-1', cola(10000, 'cola-A'))

    expect(pagos.map(p => p.amount)).toEqual([100, 100])
    expect([row.paymentStatus, row.status, Number(row.remainingBalance), Number(row.paidAmount)]).toEqual(['PAID', 'COMPLETED', 0, 200])
    expect(cas[0].where.paymentStatus).toBe('PAID')
    expect(r).toMatchObject({ amount: 10000, changeCents: 0, orderPaymentStatus: 'PAID', remainingBalanceCents: 0, totalPaidCents: 20000 })
    expect(avisos()).toHaveLength(1)
    expect(avisos()[0][1]).toMatchObject({
      orderId: 'order-1',
      venueId: 'venue-1',
      overpaidBy: 100,
      wasAlreadyPaid: true,
      paymentId: 'payment-2',
    })
    expect(bitacoras()).toEqual([
      expect.objectContaining({
        entity: 'Order',
        entityId: 'order-1',
        venueId: 'venue-1',
        staffId: 'staff-1',
        data: expect.objectContaining({ overpaidBy: 100, wasAlreadyPaid: true, paymentId: 'payment-2' }),
      }),
    ])
    expect(postCashSaleToDrawer).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'payment-2', amount: 100, targetSessionId: 'caja-1' }),
    )
    sinEfectosDeSaldar(cas)
  })

  it('🔴 U2 REFUNDED: la venta se cobró y se devolvió; el reenvío de $100 se registra y la venta SIGUE REFUNDED (hoy: 409 tras 3 intentos)', async () => {
    const { row, pagos, cas } = instalarBase({ paymentStatus: 'REFUNDED', total: 100 }, [{ amount: 100 }, { amount: -100, type: 'REFUND' }])

    const r = await payCashOrder('venue-1', 'order-1', cola(10000, 'cola-R'))

    expect(pagos.filter(p => p.type === 'REGULAR').map(p => p.amount)).toEqual([100, 100])
    expect([row.paymentStatus, Number(row.remainingBalance)]).toEqual(['REFUNDED', 0])
    expect(cas[0].where.paymentStatus).toBe('REFUNDED')
    expect(r).toMatchObject({ amount: 10000, changeCents: 0, orderPaymentStatus: 'PAID', remainingBalanceCents: 0 })
    expect(avisos()).toHaveLength(1)
    expect(avisos()[0][1]).toMatchObject({ wasAlreadyPaid: true })
    expect(bitacoras()).toHaveLength(1)
    sinEfectosDeSaldar(cas)
  })

  it('U3 control: el efectivo NUEVO en vivo sobre una venta PAID sigue respondiendo 400 sin escribir nada', async () => {
    const { pagos } = instalarBase({ paymentStatus: 'PAID', total: 100 }, [{ amount: 100 }])
    await expect(payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1' })).rejects.toThrow('Order is already paid')
    expect([pagos.length, avisos().length, bitacoras().length]).toEqual([1, 0, 0])
  })

  it('U3 control: el efectivo NUEVO en vivo sobre una venta REFUNDED se rechaza con 400 antes de tomar el dinero (hoy: 409 tras 3 intentos)', async () => {
    const { pagos } = instalarBase({ paymentStatus: 'REFUNDED', total: 100 }, [{ amount: 100 }, { amount: -100, type: 'REFUND' }])
    await expect(
      payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1', idempotencyKey: 'vivo-R' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'Order is already paid',
    })
    expect(pagos).toHaveLength(2)
  })

  it('U3 control: un reenvío de $0 sobre una venta cerrada no registra nada (400 como hoy)', async () => {
    const { pagos } = instalarBase({ paymentStatus: 'PAID', total: 100 }, [{ amount: 100 }])
    await expect(payCashOrder('venue-1', 'order-1', cola(0, 'cola-cero'))).rejects.toThrow('Order is already paid')
    expect(pagos).toHaveLength(1)
  })

  it('🔴 U4: una tarjeta de una terminal ajena registrada EN VIVO sobre una venta PAID ya se cobró: se registra con 🚨 (hoy: 400 y el cobro fuera)', async () => {
    const { row, pagos, cas } = instalarBase({ paymentStatus: 'PAID', total: 100 }, [{ amount: 100 }])

    const r = await payCashOrder('venue-1', 'order-1', {
      amount: 10000,
      tip: 0,
      method: 'CREDIT_CARD',
      externalSource: 'Terminal BBVA',
      staffId: 'staff-1',
      idempotencyKey: 'vivo-tarjeta',
    })

    expect(pagos.map(p => [p.amount, p.method])).toEqual([
      [100, 'CASH'],
      [100, 'CREDIT_CARD'],
    ])
    expect([row.paymentStatus, r.changeCents, r.orderPaymentStatus]).toEqual(['PAID', 0, 'PAID'])
    expect([avisos().length, bitacoras().length]).toEqual([1, 1])
    sinEfectosDeSaldar(cas)
  })
})

describe('S2: el reenvío registra lo que el aparato aplicó, no lo recalcula contra el saldo de hoy', () => {
  it('🔴 U5: otra caja abonó $50 antes del reenvío de $100 ⇒ Payment de $100, PAID, efectos UNA vez, 🚨 sobrepago $50 y cambio 0 (hoy: $50 y $50 de «cambio» que nadie entregó)', async () => {
    const { row, pagos } = instalarBase({ paymentStatus: 'PARTIAL', total: 100 }, [{ amount: 50 }])

    const r = await payCashOrder('venue-1', 'order-1', cola(10000, 'cola-S2'))

    expect(pagos.map(p => p.amount)).toEqual([50, 100])
    expect([row.paymentStatus, row.status]).toEqual(['PAID', 'COMPLETED'])
    expect(r).toMatchObject({ amount: 10000, changeCents: 0, orderPaymentStatus: 'PAID', remainingBalanceCents: 0, totalPaidCents: 15000 })
    expect(avisos()).toHaveLength(1)
    expect(avisos()[0][1]).toMatchObject({ overpaidBy: 50, wasAlreadyPaid: false })
    expect(bitacoras()).toHaveLength(1)
    // Esta venta la saldó ESTE cobro: sus efectos corren una vez.
    expect([
      (createSalePostingInTx as jest.Mock).mock.calls.length,
      (awardLoyaltyForPaidOrder as jest.Mock).mock.calls.length,
      referidos().length,
    ]).toEqual([1, 1, 1])
    expect(postCashSaleToDrawer).toHaveBeenCalledWith(expect.objectContaining({ amount: 100 }))
  })

  it('U5: cuenta de $120 y reenvío de $100 ⇒ $100 registrados, PARTIAL, faltan $20, sin aviso', async () => {
    const { row, pagos } = instalarBase({ paymentStatus: 'PENDING', total: 120 })

    const r = await payCashOrder('venue-1', 'order-1', cola(10000, 'cola-120'))

    expect(pagos.map(p => p.amount)).toEqual([100])
    expect(row.paymentStatus).toBe('PARTIAL')
    expect(r).toMatchObject({ amount: 10000, changeCents: 0, orderPaymentStatus: 'PARTIAL', remainingBalanceCents: 2000 })
    expect([avisos().length, bitacoras().length]).toEqual([0, 0])
  })

  it('U3 control: el efectivo en vivo de $100 con $50 ya abonados sigue registrando $50 y devolviendo $50 de cambio', async () => {
    const { pagos } = instalarBase({ paymentStatus: 'PARTIAL', total: 100 }, [{ amount: 50 }])

    const r = await payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1', idempotencyKey: 'vivo-50' })

    expect(pagos.map(p => p.amount)).toEqual([50, 50])
    expect([r.amount, r.changeCents, r.orderPaymentStatus]).toEqual([5000, 5000, 'PAID'])
    expect(avisos()).toHaveLength(0)
  })
})

describe('U6: el reenvío repetido no duplica nada', () => {
  it('🔴 la MISMA llave dos veces sobre la venta cerrada ⇒ un Payment, un aviso, un movimiento de cajón; la repetición responde lo mismo', async () => {
    const { pagos } = instalarBase({ paymentStatus: 'PAID', total: 100 }, [{ amount: 100 }])

    const primero = await payCashOrder('venue-1', 'order-1', cola(10000, 'cola-rep'))
    const repeticion = await payCashOrder('venue-1', 'order-1', cola(10000, 'cola-rep'))

    expect(pagos).toHaveLength(2)
    expect([avisos().length, bitacoras().length, (postCashSaleToDrawer as jest.Mock).mock.calls.length]).toEqual([1, 1, 1])
    expect([
      repeticion.paymentId,
      repeticion.amount,
      repeticion.changeCents,
      repeticion.orderPaymentStatus,
      repeticion.remainingBalanceCents,
    ]).toEqual([primero.paymentId, 10000, 0, 'PAID', 0])
  })

  it('🔴 la repetición sobre una venta REFUNDED responde PAID con saldo 0, igual que el primer envío (no «PARTIAL con 0»)', async () => {
    instalarBase({ paymentStatus: 'REFUNDED', total: 100 }, [{ amount: 100 }, { amount: -100, type: 'REFUND' }])

    const primero = await payCashOrder('venue-1', 'order-1', cola(10000, 'cola-rep-R'))
    const repeticion = await payCashOrder('venue-1', 'order-1', cola(10000, 'cola-rep-R'))

    expect([repeticion.paymentId, repeticion.orderPaymentStatus, repeticion.remainingBalanceCents]).toEqual([primero.paymentId, 'PAID', 0])
    expect(avisos()).toHaveLength(1)
  })

  it('🔴 carrera: la MISMA llave en dos peticiones simultáneas ⇒ un Payment y un aviso', async () => {
    const { pagos } = instalarBase({ paymentStatus: 'PAID', total: 100 }, [{ amount: 100 }])

    const resultados = await Promise.all([
      payCashOrder('venue-1', 'order-1', cola(10000, 'cola-carrera')),
      payCashOrder('venue-1', 'order-1', cola(10000, 'cola-carrera')),
    ])

    expect(pagos).toHaveLength(2)
    expect(resultados[0].paymentId).toBe(resultados[1].paymentId)
    expect([avisos().length, bitacoras().length, (postCashSaleToDrawer as jest.Mock).mock.calls.length]).toEqual([1, 1, 1])
  })

  it('dos reenvíos DISTINTOS (dos entregas de dinero) sobre la venta cerrada ⇒ dos Payments y dos avisos', async () => {
    const { pagos, row } = instalarBase({ paymentStatus: 'PAID', total: 100 }, [{ amount: 100 }])

    await Promise.all([
      payCashOrder('venue-1', 'order-1', cola(10000, 'cola-A1')),
      payCashOrder('venue-1', 'order-1', cola(10000, 'cola-A2')),
    ])

    expect(pagos.map(p => p.amount)).toEqual([100, 100, 100])
    expect([row.paymentStatus, Number(row.paidAmount)]).toEqual(['PAID', 300])
    expect(avisos()).toHaveLength(2)
  })
})
