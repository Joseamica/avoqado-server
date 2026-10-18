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
import socketManager from '@/communication/sockets'
import { logAction } from '@/services/dashboard/activity-log.service'
import { prismaMock } from '../../../__helpers__/setup'

type Estado = 'PENDING' | 'PARTIAL' | 'PAID' | 'REFUNDED'
interface Pago {
  id: string
  amount: number
  tipAmount: number
  type: 'REGULAR' | 'REFUND'
  /** R5-2: el estado REAL de la fila (los retornos idempotentes sólo devuelven un cobro COMPLETED). */
  status: 'COMPLETED' | 'FAILED' | 'PENDING'
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
    status: 'COMPLETED',
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
  // La reapertura de una cancelada (`reabrirSiRecibeDinero`) escribe el estado operativo.
  prismaMock.order.update.mockImplementation(async ({ data }: any) => {
    await turno()
    row.status = data.status ?? row.status
    return { ...row }
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
      status: 'COMPLETED',
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

/**
 * 🔴 Ronda 2 (revisiones de ceba0df1f: opus y Codex, 17/18-oct-2026).
 *   · R2-1: Android/Windows ≤ 2.23 (defecto H1) reenvía el TOTAL de la cuenta en vez de su parte; para esa cola, como antes de S1/S2.
 *   · R2-2: una venta CANCELLED + REFUNDED que recibe dinero capturado no se reabre.
 *   · R2-4: el aviso de sobrepago sólo si de verdad sobra dinero (> $0.01), como la TPV.
 *   · R2-5: el socket emite el estado guardado (REFUNDED), no un PAID que no existe.
 *   · R2-6: dinero capturado en una mesa reasignada: se registra con su autor y queda rastro de la mesa ajena.
 */
describe('R2-1: la cola de Android/Windows ≤ 2.23 (H1) se porta como antes de S1/S2', () => {
  // H1: el aparato manda el TOTAL de la cuenta aunque sólo cobró su parte del split. El controller marca esa cola.
  const colaH1 = (amount: number, idempotencyKey: string) => ({ ...cola(amount, idempotencyKey), colaConDefectoH1: true })

  it('🔴 cuenta $100 en 2×$50: B abonó $50 y la cola ≤ 2.23 de A manda el TOTAL ($100) ⇒ $50 registrados y $50 de cambio, PAID, sin aviso (S2 registraba $100: faltante falso de $50)', async () => {
    const { row, pagos } = instalarBase({ paymentStatus: 'PARTIAL', total: 100 }, [{ amount: 50 }])

    const r = await payCashOrder('venue-1', 'order-1', colaH1(10000, 'h1-split'))

    expect(pagos.map(p => p.amount)).toEqual([50, 50])
    expect(row.paymentStatus).toBe('PAID')
    expect(r).toMatchObject({ amount: 5000, changeCents: 5000, orderPaymentStatus: 'PAID', remainingBalanceCents: 0 })
    expect([avisos().length, bitacoras().length]).toEqual([0, 0])
    expect(postCashSaleToDrawer).toHaveBeenCalledWith(expect.objectContaining({ amount: 50 }))
  })

  it('🔴 orden 2×$50 toda sin red: el primer reenvío ya la dejó PAID ⇒ el segundo (también por el TOTAL) recibe 400 como antes, nada se escribe (S1 registraba $200 por $100)', async () => {
    const { pagos } = instalarBase({ paymentStatus: 'PAID', total: 100 }, [{ amount: 100 }])

    await expect(payCashOrder('venue-1', 'order-1', colaH1(10000, 'h1-paid'))).rejects.toMatchObject({
      statusCode: 400,
      message: 'Order is already paid',
    })
    expect([pagos.length, avisos().length, bitacoras().length]).toEqual([1, 0, 0])
  })

  it('🔴 venta REFUNDED ⇒ 409 tras los intentos, como antes, y nada se escribe', async () => {
    const { pagos } = instalarBase({ paymentStatus: 'REFUNDED', total: 100 }, [{ amount: 100 }, { amount: -100, type: 'REFUND' }])

    await expect(payCashOrder('venue-1', 'order-1', colaH1(10000, 'h1-refunded'))).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_PAYMENT_CONFLICT',
    })
    expect(pagos).toHaveLength(2)
  })

  it('control: la MISMA cola sin la marca (iOS, Android ≥ 2.24) sigue con S2: $100 registrados', async () => {
    const { pagos } = instalarBase({ paymentStatus: 'PARTIAL', total: 100 }, [{ amount: 50 }])
    const r = await payCashOrder('venue-1', 'order-1', cola(10000, 'sin-h1'))
    expect([pagos.map(p => p.amount), r.amount, r.changeCents]).toEqual([[50, 100], 10000, 0])
  })
})

describe('R2-2: recibir dinero nunca reabre una venta cerrada (CANCELLED + REFUNDED)', () => {
  const reaperturas = () =>
    (prismaMock.activityLog.create as jest.Mock).mock.calls
      .map(c => c[0].data)
      .filter(d => d.action === 'ORDER_REOPENED_BY_CAPTURED_PAYMENT')

  it('🔴 venta devuelta y luego cancelada + reenvío de $100 ⇒ el Payment queda, sigue CANCELLED/REFUNDED con saldo 0 y 🚨, sin reabrirse (antes: PENDING/REFUNDED + ORDER_REOPENED_BY_CAPTURED_PAYMENT)', async () => {
    const { row, pagos, cas } = instalarBase({ paymentStatus: 'REFUNDED', status: 'CANCELLED', total: 100 }, [
      { amount: 100 },
      { amount: -100, type: 'REFUND' },
    ])

    const r = await payCashOrder('venue-1', 'order-1', cola(10000, 'cancelada-devuelta'))

    expect(pagos.filter(p => p.type === 'REGULAR').map(p => p.amount)).toEqual([100, 100])
    expect([row.status, row.paymentStatus, Number(row.remainingBalance)]).toEqual(['CANCELLED', 'REFUNDED', 0])
    expect(reaperturas()).toHaveLength(0)
    expect(r).toMatchObject({ amount: 10000, changeCents: 0, orderPaymentStatus: 'PAID', remainingBalanceCents: 0 })
    expect(avisos()).toHaveLength(1)
    sinEfectosDeSaldar(cas)
  })

  it('control: la cancelada que DEBE (PENDING) sigue reabriéndose al recibir el dinero capturado', async () => {
    const { row } = instalarBase({ paymentStatus: 'PENDING', status: 'CANCELLED', total: 100 })

    await payCashOrder('venue-1', 'order-1', cola(10000, 'cancelada-debe'))

    expect(reaperturas()).toHaveLength(1)
    expect([row.paymentStatus, row.status]).toEqual(['PAID', 'COMPLETED'])
  })
})

/**
 * 🔴 R4-2 (Codex r3, P2; la misma raíz que R2-2 en el POS): una venta CERRADA conserva su estado operativo (sigue cancelada), pero su
 * aritmética es la de cuando se cobró: base E IVA aparte. Con la aritmética de cancelada el IVA desaparecía del total: venta de
 * $100 + $16 devuelta y cancelada + propina sola de $50 guardaba $150 contra $166 cobrados y gritaba un sobrepago FALSO de $16.
 */
describe('R4-2: venta cancelada ya cobrada con IVA aparte: lo guardado y el aviso salen del MISMO total', () => {
  const conIvaAparte = (row: any) => Object.assign(row, { taxAmount: new Decimal(16), contratoDePrecio: 'IVA_APARTE' })
  const devueltaYCancelada = () => {
    const base = instalarBase({ paymentStatus: 'REFUNDED', status: 'CANCELLED', total: 100 }, [
      { amount: 116 },
      { amount: -116, type: 'REFUND' },
    ])
    conIvaAparte(base.row)
    return base
  }

  it('🔴 propina sola de $50 ⇒ total guardado $166 (base + IVA + propina), sigue CANCELLED/REFUNDED, sin sobrepago falso', async () => {
    const { row, cas } = devueltaYCancelada()

    await payCashOrder('venue-1', 'order-1', { ...cola(0, 'r4-2-propina'), tip: 5000 })

    expect([row.status, row.paymentStatus, Number(row.remainingBalance)]).toEqual(['CANCELLED', 'REFUNDED', 0])
    expect(Number(cas.at(-1).data.total)).toBe(166)
    expect([avisos().length, bitacoras().length]).toEqual([0, 0])
    sinEfectosDeSaldar(cas)
  })

  it('🔴 $10 de más ⇒ total guardado $116 y el aviso dice el MISMO total y el sobrepago real de $10', async () => {
    const { cas } = devueltaYCancelada()

    await payCashOrder('venue-1', 'order-1', cola(1000, 'r4-2-diez'))

    expect(Number(cas.at(-1).data.total)).toBe(116)
    expect(avisos()).toHaveLength(1)
    expect(avisos()[0][1]).toMatchObject({ orderTotal: 116, totalPaid: 126, overpaidBy: 10 })
  })

  it('control: la cancelada que DEBE con IVA aparte se reabre y cobra su IVA como siempre ($100 de $116 ⇒ PARTIAL, faltan $16)', async () => {
    const { row, cas } = instalarBase({ paymentStatus: 'PENDING', status: 'CANCELLED', total: 100 })
    conIvaAparte(row)

    await payCashOrder('venue-1', 'order-1', cola(10000, 'r4-2-debe'))

    expect([row.status, row.paymentStatus, Number(row.remainingBalance), Number(cas.at(-1).data.total)]).toEqual([
      'PENDING',
      'PARTIAL',
      16,
      116,
    ])
  })
})

describe('R2-4: el aviso de sobrepago sólo si sobra dinero (como la TPV: > $0.01)', () => {
  it('🔴 reenvío de SÓLO propina ($50) sobre una venta PAID ⇒ se registra sin aviso: no sobra nada (antes: 🚨 «Se cobró MÁS» con $0)', async () => {
    const { pagos } = instalarBase({ paymentStatus: 'PAID', total: 100 }, [{ amount: 100 }])

    await payCashOrder('venue-1', 'order-1', { ...cola(0, 'solo-propina'), tip: 5000 })

    expect(pagos.map(p => [p.amount, p.tipAmount])).toEqual([
      [100, 0],
      [0, 50],
    ])
    expect([avisos().length, bitacoras().length]).toEqual([0, 0])
  })

  it('🔴 venta PAID con lo cobrado BAJO el total (el panel corrigió $100 → $80) + reenvío de $10 ⇒ sin aviso (antes: 🚨 con −$10)', async () => {
    instalarBase({ paymentStatus: 'PAID', total: 100 }, [{ amount: 80 }])

    await payCashOrder('venue-1', 'order-1', cola(1000, 'r8-1'))

    expect([avisos().length, bitacoras().length]).toEqual([0, 0])
  })
})

describe('R2-5: el socket emite el estado guardado', () => {
  it('🔴 reenvío sobre una venta REFUNDED ⇒ ORDER_UPDATED dice REFUNDED (antes: PAID, un estado que no existe); la respuesta sigue PAID/0', async () => {
    const broadcastToVenue = jest.fn()
    ;(socketManager.getBroadcastingService as jest.Mock).mockReturnValue({ broadcastToVenue })
    try {
      instalarBase({ paymentStatus: 'REFUNDED', total: 100 }, [{ amount: 100 }, { amount: -100, type: 'REFUND' }])

      const r = await payCashOrder('venue-1', 'order-1', cola(10000, 'socket-R'))

      const actualizadas = broadcastToVenue.mock.calls.filter(c => c[1] === 'order_updated')
      expect(actualizadas.map(c => c[2].paymentStatus)).toEqual(['REFUNDED'])
      expect(r.orderPaymentStatus).toBe('PAID')
    } finally {
      ;(socketManager.getBroadcastingService as jest.Mock).mockReturnValue(null)
    }
  })
})

describe('R2-6: dinero capturado en una mesa que reasignaron', () => {
  // `logAction` (fire-and-forget, fuera de la transacción) está simulado para toda la suite en `tests/__helpers__/setup.ts`.
  const marcas = () => (logAction as jest.Mock).mock.calls.map(c => c[0]).filter(d => d.action === 'CAPTURED_PAYMENT_ON_FOREIGN_TABLE')

  it('🔴 Ana cobró $100 sin red, la mesa pasó a Beto ⇒ el Payment es de Ana y queda rastro de la mesa ajena; el reintento no deja otro', async () => {
    const { pagos } = instalarBase({ paymentStatus: 'PENDING', total: 100 })
    const entrada = { ...cola(10000, 'mesa-ajena'), mesaAjena: { ownerId: 'staff-beto', ownerName: 'Beto Bravo' } }

    await payCashOrder('venue-1', 'order-1', entrada)
    await payCashOrder('venue-1', 'order-1', entrada)

    expect(pagos.map(p => p.amount)).toEqual([100])
    expect(prismaMock.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ processedById: 'staff-1' }) }),
    )
    expect(marcas()).toEqual([
      expect.objectContaining({
        entity: 'Order',
        entityId: 'order-1',
        venueId: 'venue-1',
        staffId: 'staff-1',
        data: expect.objectContaining({ paymentId: 'payment-1', tableOwnerId: 'staff-beto', tableOwnerName: 'Beto Bravo' }),
      }),
    ])
  })

  it('control: sin mesa ajena no hay rastro', async () => {
    instalarBase({ paymentStatus: 'PENDING', total: 100 })
    await payCashOrder('venue-1', 'order-1', cola(10000, 'mesa-propia'))
    expect(marcas()).toHaveLength(0)
  })
})

/**
 * 🔴 R5-1 (Codex r4, P2 R): la propiedad de mesa deja pasar a Ana SÓLO a recuperar el pago de su llave K (mesa ya de Beto). Si un
 * administrador borra ese pago entre la consulta del middleware y la del servicio, antes se creaba un pago NUEVO en la mesa ajena.
 * Ahora `soloRecuperarPago` se comprueba antes de cualquier creación: sin el cobro, el mismo 403 de mesa ajena.
 */
describe('R5-1: autorizada sólo a recuperar el pago de su llave', () => {
  const BETO = { ownerId: 'staff-beto', ownerName: 'Beto Bravo' }
  const enVivo = (amount: number, idempotencyKey: string) => ({
    amount,
    tip: 0,
    staffId: 'staff-1',
    idempotencyKey,
    soloRecuperarPago: BETO,
  })

  it.each([
    ['$0 (cuenta cortesiada)', 0, { paymentStatus: 'PAID' as const, total: 0 }],
    ['$50 en vivo sobre una cuenta que debe', 5000, { paymentStatus: 'PARTIAL' as const, total: 100 }],
  ])('🔴 el pago de K se borró antes de releerlo ⇒ %s: 403 TABLE_OWNED_BY_OTHER y ningún pago nuevo', async (_caso, amount, base) => {
    const { pagos, cas } = instalarBase(base) // K ya no existe: lo borraron entre las dos consultas.

    const error = await payCashOrder('venue-1', 'order-1', enVivo(amount, 'llave-K')).catch(e => e)

    expect(error).toMatchObject({ statusCode: 403, code: 'TABLE_OWNED_BY_OTHER', dueno: BETO })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect([pagos.length, cas.length]).toEqual([0, 0])
  })

  it('🔴 la llave K es de OTRA orden ⇒ el mismo 403 (no el 409 de llave ajena), sin escribir nada', async () => {
    instalarBase({ paymentStatus: 'PARTIAL', total: 100 }, [{ amount: 20, idempotencyKey: 'llave-K' }])
    prismaMock.payment.findUnique.mockResolvedValueOnce({ id: 'otro', orderId: 'order-otra', status: 'COMPLETED', type: 'REGULAR' } as any)

    await expect(payCashOrder('venue-1', 'order-1', enVivo(5000, 'llave-K'))).rejects.toMatchObject({
      statusCode: 403,
      code: 'TABLE_OWNED_BY_OTHER',
    })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('control: el pago de K sigue ahí ⇒ se devuelve ESE pago ($20), sin crear otro ni rastro de mesa ajena', async () => {
    const { pagos } = instalarBase({ paymentStatus: 'PARTIAL', total: 100 }, [{ amount: 20, idempotencyKey: 'llave-K' }])

    const r = await payCashOrder('venue-1', 'order-1', enVivo(5000, 'llave-K'))

    expect([r.paymentId, r.amount, r.status]).toEqual(['previo-1', 2000, 'COMPLETED'])
    expect(pagos).toHaveLength(1)
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('control: sin la marca, la misma llave borrada es un cobro nuevo como siempre (mesa propia)', async () => {
    const { pagos } = instalarBase({ paymentStatus: 'PENDING', total: 100 })
    await payCashOrder('venue-1', 'order-1', { amount: 5000, tip: 0, staffId: 'staff-1', idempotencyKey: 'llave-K' })
    expect(pagos.map(p => p.amount)).toEqual([50])
  })
})

/**
 * 🔴 R5-2 (Codex r4, P2 E): el retorno idempotente respondía `status: 'COMPLETED'` fijo con lo que encontrara la llave. Un intento
 * FAILED de $100 se presentaba como cobro de $100 (la cuenta seguía debiendo $100) y una devolución de −$100 como cobro con $100 de
 * cambio. Sólo un cobro completado de esta orden es «la misma operación»; lo demás ⇒ 409 sin escribir nada.
 */
describe('R5-2: la llave de un intento fallido o de una devolución no es «el mismo cobro»', () => {
  it.each([
    ['un intento FAILED de $100', { amount: 100, status: 'FAILED' as const, idempotencyKey: 'llave-F' }, 10000, 'llave-F'],
    ['una devolución (REFUND) de −$100', { amount: -100, type: 'REFUND' as const, idempotencyKey: 'llave-R' }, 0, 'llave-R'],
  ])('🔴 %s ⇒ 409 IDEMPOTENCY_KEY_REUSED, ni COMPLETED ni cambio ni pago nuevo', async (_caso, previo, amount, llave) => {
    const { pagos, cas } = instalarBase({ paymentStatus: 'PARTIAL', total: 100 }, [previo])

    await expect(payCashOrder('venue-1', 'order-1', { amount, tip: 0, staffId: 'staff-1', idempotencyKey: llave })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect([pagos.length, cas.length]).toEqual([1, 0])
  })

  it('🔴 la cola sin red (isOfflineReplay) con la llave de un intento FAILED ⇒ el mismo 409: no se afirma un cobro que no ocurrió', async () => {
    instalarBase({ paymentStatus: 'PENDING', total: 100 }, [{ amount: 100, status: 'FAILED', idempotencyKey: 'cola-F' }])
    await expect(payCashOrder('venue-1', 'order-1', cola(10000, 'cola-F'))).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('🔴 carrera: bajo el candado la llave resulta ser de un intento FAILED ⇒ 409 por la red de la carrera, sin crear', async () => {
    instalarBase({ paymentStatus: 'PENDING', total: 100 })
    // La consulta rápida no ve la llave; al crear choca con el índice único (P2002) y el «ganador» es un intento FAILED.
    prismaMock.payment.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'f-1',
      orderId: 'order-1',
      status: 'FAILED',
      type: 'REGULAR',
      amount: new Decimal(100),
      tipAmount: new Decimal(0),
      receipts: [],
    } as any)
    prismaMock.payment.create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }))

    await expect(
      payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1', idempotencyKey: 'llave-c' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    })
  })
})

/**
 * 🔴 R6-2 (Codex r5 #2, P2): A y B mandan la MISMA llave; B consultó la llave antes de que A confirmara. Bajo el candado veía la venta
 * cerrada (o el saldo) y rechazaba con 400 en vez de devolver el cobro de A. Ahora, antes de esos rechazos, la llave se busca otra vez
 * bajo el candado y sale por la red de la carrera, con las reglas de R5-2 (un intento FAILED o una devolución ⇒ 409).
 */
describe('R6-2: el reintento simultáneo con la misma llave', () => {
  it.each([
    ['en vivo, $100', 10000, {}, 100],
    ['cola Android/Windows ≤ 2.23 (H1), $100', 10000, { isOfflineReplay: true, colaConDefectoH1: true }, 100],
    ['cortesía de $0', 0, {}, 0],
  ])(
    '🔴 %s: la consulta rápida no vio a A y bajo el candado la venta ya está PAID ⇒ el MISMO cobro de A, sin 400 ni pago nuevo',
    async (_caso, amount, extra, total) => {
      const { pagos, cas } = instalarBase({ paymentStatus: 'PAID', total }, [{ amount: total, idempotencyKey: 'llave-K' }])
      prismaMock.payment.findUnique.mockResolvedValueOnce(null) // la consulta rápida de B, antes de que A confirmara

      const r = await payCashOrder('venue-1', 'order-1', { amount, tip: 0, staffId: 'staff-1', idempotencyKey: 'llave-K', ...extra })

      expect([r.paymentId, r.status, r.amount]).toEqual(['previo-1', 'COMPLETED', total * 100])
      expect([pagos.length, cas.length]).toEqual([1, 0])
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
    },
  )

  it('🔴 por saldo: un $0 con la llave que bajo el candado ya tiene su cobro ⇒ ese cobro, no «Esta cuenta debe…»', async () => {
    const { pagos } = instalarBase({ paymentStatus: 'PENDING', total: 100 }, [{ amount: 0, idempotencyKey: 'llave-0' }])
    prismaMock.payment.findUnique.mockResolvedValueOnce(null)

    const r = await payCashOrder('venue-1', 'order-1', { amount: 0, tip: 0, staffId: 'staff-1', idempotencyKey: 'llave-0' })

    expect([r.paymentId, r.status]).toEqual(['previo-1', 'COMPLETED'])
    expect(pagos).toHaveLength(1)
  })

  it('🔴 bajo el candado la llave es de un intento FAILED ⇒ 409 IDEMPOTENCY_KEY_REUSED (R5-2), no el 400 de «ya pagada»', async () => {
    instalarBase({ paymentStatus: 'PAID', total: 100 }, [{ amount: 100 }, { amount: 100, status: 'FAILED', idempotencyKey: 'llave-F' }])
    prismaMock.payment.findUnique.mockResolvedValueOnce(null)

    await expect(
      payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1', idempotencyKey: 'llave-F' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('control: sin pago con esa llave, la venta cerrada sigue rechazando el cobro nuevo con 400 «ya pagada»', async () => {
    instalarBase({ paymentStatus: 'PAID', total: 100 }, [{ amount: 100 }])
    await expect(
      payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1', idempotencyKey: 'llave-nueva' }),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Order is already paid' })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })
})

/**
 * 🔴 R6-3 (Codex r5 #3, P2): la propiedad de mesa se revisaba antes del candado. Si la cuenta pasa a Beto en esa ventana, el cobro NUEVO
 * de Ana (un $0 que cierra la cortesía, o efectivo en vivo) se creaba sobre la mesa de Beto. Ahora se vuelve a revisar bajo el candado
 * con la MISMA regla (`propiedadDeMesa`, marca interna del middleware o del reducer). El dinero capturado sigue y deja su rastro.
 */
describe('R6-3: la propiedad de mesa otra vez, bajo el candado', () => {
  const marcas = () => (logAction as jest.Mock).mock.calls.map(c => c[0]).filter(d => d.action === 'CAPTURED_PAYMENT_ON_FOREIGN_TABLE')
  const propiedad = (puede = false) => ({ userId: 'staff-1', puedeCobrarAjena: jest.fn().mockResolvedValue(puede) })
  const deMesa = (row: Record<string, unknown>, servedById: string | null) =>
    Object.assign(row, {
      tableId: 'mesa-1',
      servedById,
      servedBy: servedById === 'staff-beto' ? { firstName: 'Beto', lastName: 'Bravo' } : null,
    })

  it.each([
    ['$0 que cierra la cortesía', 0, 0],
    ['$50 en vivo', 5000, 100],
  ])(
    '🔴 %s de Ana; bajo el candado la cuenta ya es de Beto ⇒ 403 TABLE_OWNED_BY_OTHER con Beto y ningún pago',
    async (_caso, amount, total) => {
      const { row, pagos, cas } = instalarBase({ paymentStatus: 'PENDING', total })
      deMesa(row, 'staff-beto')

      const error = await payCashOrder('venue-1', 'order-1', {
        amount,
        tip: 0,
        staffId: 'staff-1',
        idempotencyKey: 'llave-nueva',
        propiedadDeMesa: propiedad(false),
      }).catch(e => e)

      expect(error).toMatchObject({
        statusCode: 403,
        code: 'TABLE_OWNED_BY_OTHER',
        dueno: { ownerId: 'staff-beto', ownerName: 'Beto Bravo' },
      })
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
      expect([pagos.length, cas.length]).toEqual([0, 0])
    },
  )

  it('control: con `tables:pay-any` o `tables:manage-all` (la misma regla del middleware) ⇒ cobra la mesa de Beto', async () => {
    const { row, pagos } = instalarBase({ paymentStatus: 'PENDING', total: 100 })
    deMesa(row, 'staff-beto')
    const p = propiedad(true)

    await payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1', idempotencyKey: 'k', propiedadDeMesa: p })

    expect(pagos.map(x => x.amount)).toEqual([100])
    expect(p.puedeCobrarAjena).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['sigue siendo de Ana', 'staff-1', 'mesa-1'],
    ['sin dueño', null, 'mesa-1'],
    ['mostrador (sin mesa)', 'staff-beto', null],
  ])('control: %s ⇒ cobra sin preguntar permisos', async (_caso, servedById, tableId) => {
    const { row, pagos } = instalarBase({ paymentStatus: 'PENDING', total: 100 })
    Object.assign(deMesa(row, servedById), { tableId })
    const p = propiedad(false)

    await payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1', idempotencyKey: 'k', propiedadDeMesa: p })

    expect(pagos.map(x => x.amount)).toEqual([100])
    expect(p.puedeCobrarAjena).not.toHaveBeenCalled()
  })

  it('🔴 dinero CAPTURADO (la cola, $100) sobre la cuenta que pasó a Beto en esa ventana ⇒ se registra a nombre de Ana y deja el rastro de la mesa ajena', async () => {
    const { row, pagos } = instalarBase({ paymentStatus: 'PENDING', total: 100 })
    deMesa(row, 'staff-beto')

    await payCashOrder('venue-1', 'order-1', { ...cola(10000, 'cola-K'), propiedadDeMesa: propiedad(false) })

    expect(pagos.map(x => x.amount)).toEqual([100])
    expect(marcas()).toEqual([
      expect.objectContaining({
        staffId: 'staff-1',
        data: expect.objectContaining({ paymentId: 'payment-1', tableOwnerId: 'staff-beto', tableOwnerName: 'Beto Bravo' }),
      }),
    ])
  })

  it('control: sin la marca (propiedad de mesa apagada) nada cambia: cobra la mesa ajena como siempre', async () => {
    const { row, pagos } = instalarBase({ paymentStatus: 'PENDING', total: 100 })
    deMesa(row, 'staff-beto')
    await payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1', idempotencyKey: 'k' })
    expect(pagos.map(x => x.amount)).toEqual([100])
  })
})
