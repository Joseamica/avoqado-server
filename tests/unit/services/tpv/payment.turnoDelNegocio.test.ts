/**
 * Fase 1 del «turno de caja del negocio» (decisión del founder, 2-sep-2026).
 *
 * Antes, cada cobro buscaba «el turno abierto de QUIEN cobra». El selector «Vendedor»
 * de Cobrar cambia ese `staffId` en cada cobro, así que quien nunca abrió turno cobraba
 * FUERA de todo turno: Testarudo, 1-sep-2026, 78 de 92 cobros ($10,337 de $12,002).
 *
 * Lo que fija esta prueba: dos cajeros distintos cobrando en el MISMO negocio caen en el
 * MISMO `Shift`, y cada cobro conserva quién lo hizo en `processedById`. El andamiaje de
 * mocks se copia de `payment.posting-atomicity.test.ts` (mismo servicio bajo prueba).
 */

import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

const lockAreaTicketCheckoutMock = jest.fn()
const finalizeAreaTicketPaymentMock = jest.fn()
jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  __esModule: true,
  lockAreaTicketCheckoutForPayment: (...a: unknown[]) => lockAreaTicketCheckoutMock(...a),
  finalizeAreaTicketPaymentInTransaction: (...a: unknown[]) => finalizeAreaTicketPaymentMock(...a),
  getAreaTicketLineIdsCoveredByInventoryReservations: jest.fn().mockResolvedValue(new Set()),
}))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn(), update: jest.fn() },
    payment: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    venueTransaction: { create: jest.fn() },
    shift: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    paymentAllocation: { create: jest.fn() },
    review: { create: jest.fn() },
    serializedItem: { updateMany: jest.fn() },
    areaTicketInventoryReservation: { findMany: jest.fn() },
    areaTicketCheckoutSession: { findFirst: jest.fn(), updateMany: jest.fn() },
    areaTicketPaymentAttempt: { findFirst: jest.fn(), updateMany: jest.fn() },
    rawMaterial: { findUnique: jest.fn() },
    orderCustomer: { findMany: jest.fn() },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
    venueSettings: { findUnique: jest.fn() },
    inventoryPosting: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
    inventoryPostingLine: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  deductInventoryForProduct: jest.fn(),
  getProductInventoryStatus: jest.fn(),
  getProductInventoryMethod: jest.fn(),
  getProductInventoryMethods: jest.fn(),
}))

jest.mock('@/services/dashboard/inventoryRestock.service', () => ({
  restockOrderItems: jest.fn(),
  restockItem: jest.fn(),
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn() }))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn() }))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/payments/transactionCost.service', () => ({ createTransactionCost: jest.fn() }))
jest.mock('@/services/dashboard/autoReorder.service', () => ({ runAutoReorderForVenue: jest.fn() }))

// El servicio de posting se mockea para poder observar CON QUÉ cliente de
// transacción se le llama — que es exactamente el invariante bajo prueba.
const createSalePostingInTxMock = jest.fn()
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: (...a: unknown[]) => createSalePostingInTxMock(...a),
  applySalePosting: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import * as productInventoryService from '@/services/dashboard/productInventoryIntegration.service'
const paymentService = require('@/services/tpv/payment.tpv.service')

const VENUE_ID = 'venue-123'
const ORDER_ID = 'order-123'

const makeOrder = (overrides: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  venueId: VENUE_ID,
  orderNumber: 'ORD-001',
  total: new Decimal(100),
  subtotal: new Decimal(100),
  discountAmount: null,
  tipAmount: new Decimal(0),
  paymentStatus: 'PENDING',
  status: 'PENDING',
  splitType: null,
  source: 'TPV',
  externalId: null,
  servedById: 'staff-1',
  createdById: 'staff-1',
  customer: null,
  items: [
    {
      id: 'item-1',
      productId: 'prod-1',
      quantity: 5,
      product: { name: 'Hamburguesa' },
      productName: 'Hamburguesa',
      productSku: null,
      paymentAllocations: [],
      modifiers: [],
      areaTicketLineId: null,
      weightQuantity: null,
    },
  ],
  payments: [],
  ...overrides,
})

const paymentData = {
  venueId: VENUE_ID,
  amount: 10000, // salda el total
  tip: 0,
  status: 'COMPLETED' as const,
  method: 'CREDIT_CARD' as const,
  source: 'TPV',
  splitType: 'FULLPAYMENT' as const,
  tpvId: 'tpv-1',
  staffId: 'staff-1',
  paidProductsId: [],
  currency: 'MXN',
  isInternational: false,
}

/** Transacciones abiertas durante la corrida, con las operaciones que vieron. */
type TxRecord = { client: any; ops: string[] }
let transacciones: TxRecord[] = []
let durableOrderVenue = VENUE_ID
let onTransactionStart: () => void = () => undefined

function installStatefulP2002Rollback() {
  const committed = {
    shift: { totalSales: 0, totalTips: 0, totalOrders: 0 },
    activityLogs: [] as any[],
    loserPayments: [] as any[],
  }
  const attempted = { claims: 0 }
  const ops: string[] = []

  ;(prisma.$transaction as jest.Mock).mockImplementationOnce(async (callback: any) => {
    // Snapshot aislado: sólo se copia a `committed` cuando el callback resuelve.
    const staged = {
      shift: { ...committed.shift },
      activityLogs: [...committed.activityLogs],
      loserPayments: [...committed.loserPayments],
    }
    const tx: any = {
      payment: {
        create: jest.fn(async () => {
          ops.push('payment.create:P2002')
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['venueId', 'idempotencyKey'] },
          })
        }),
      },
      shift: {
        findFirst: jest.fn(async () => {
          ops.push('shift.findFirst')
          return { id: 'shift-open', status: 'OPEN' }
        }),
        updateMany: jest.fn(async ({ data }: any) => {
          ops.push('shift.updateMany')
          attempted.claims += 1
          staged.shift.totalSales += Number(data.totalSales.increment)
          staged.shift.totalTips += Number(data.totalTips.increment)
          staged.shift.totalOrders += Number(data.totalOrders.increment)
          return { count: 1 }
        }),
      },
      activityLog: {
        create: jest.fn(async ({ data }: any) => {
          ops.push('activityLog.create')
          staged.activityLogs.push(data)
          return data
        }),
      },
      venueSettings: { findUnique: prisma.venueSettings.findUnique },
      order: { update: prisma.order.update },
      paymentAllocation: { create: prisma.paymentAllocation.create },
      venueTransaction: { create: prisma.venueTransaction.create },
      areaTicketCheckoutSession: {
        findFirst: prisma.areaTicketCheckoutSession.findFirst,
        updateMany: prisma.areaTicketCheckoutSession.updateMany,
      },
      areaTicketPaymentAttempt: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: prisma.areaTicketPaymentAttempt.findFirst,
        updateMany: prisma.areaTicketPaymentAttempt.updateMany,
      },
      inventoryPosting: prisma.inventoryPosting,
      $queryRaw: jest.fn().mockResolvedValue([{ id: ORDER_ID }]),
    }

    const result = await callback(tx)
    committed.shift = { ...staged.shift }
    committed.activityLogs = [...staged.activityLogs]
    committed.loserPayments = [...staged.loserPayments]
    return result
  })

  return { committed, attempted, ops }
}

beforeEach(() => {
  jest.clearAllMocks()
  transacciones = []
  durableOrderVenue = VENUE_ID
  onTransactionStart = () => undefined

  const order = makeOrder()
  ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
  ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, paymentStatus: 'PAID', status: 'COMPLETED' })
  ;(prisma.shift.findFirst as jest.Mock).mockResolvedValue({ id: 'shift-1', status: 'OPEN' })
  ;(prisma.shift.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: VENUE_ID })
  ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'payment-1', status: 'COMPLETED', feeAmount: 0, netAmount: 100 })
  ;(prisma.payment.findFirst as jest.Mock).mockResolvedValue(null)
  ;(prisma.venueTransaction.create as jest.Mock).mockResolvedValue({})
  ;(prisma.paymentAllocation.create as jest.Mock).mockResolvedValue({})
  ;(prisma.serializedItem.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
  ;(prisma.orderCustomer.findMany as jest.Mock).mockResolvedValue([])
  ;(prisma.areaTicketInventoryReservation.findMany as jest.Mock).mockResolvedValue([])
  ;(prisma.areaTicketCheckoutSession.findFirst as jest.Mock).mockResolvedValue(null)
  ;(prisma.areaTicketPaymentAttempt.findFirst as jest.Mock).mockResolvedValue(null)
  ;(prisma.inventoryPostingLine.findMany as jest.Mock).mockResolvedValue([])
  ;(prisma.inventoryPosting.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue({ enableShifts: true })
  lockAreaTicketCheckoutMock.mockResolvedValue(null)
  finalizeAreaTicketPaymentMock.mockResolvedValue({ areaTicketOrder: false })
  ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockResolvedValue({ inventoryMethod: 'QUANTITY' })
  ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue({
    inventoryMethod: 'QUANTITY',
    available: true,
    currentStock: 100,
  })
  createSalePostingInTxMock.mockResolvedValue({ id: 'posting-1', status: 'PENDING' })
  ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
    onTransactionStart()
    const ops: string[] = []
    const record: TxRecord = { client: null, ops }
    const tx: any = {
      payment: {
        create: jest.fn(async (args: any) => {
          ops.push('payment.create')
          return (prisma.payment.create as jest.Mock)(args)
        }),
      },
      paymentAllocation: { create: prisma.paymentAllocation.create },
      venueTransaction: { create: prisma.venueTransaction.create },
      order: {
        update: jest.fn(async (args: any) => {
          ops.push('order.update')
          return (prisma.order.update as jest.Mock)(args)
        }),
      },
      shift: {
        findFirst: jest.fn(async (args: any) => {
          ops.push('shift.findFirst')
          return (prisma.shift.findFirst as jest.Mock)(args)
        }),
        updateMany: jest.fn(async (args: any) => {
          ops.push('shift.updateMany')
          return (prisma.shift.updateMany as jest.Mock)(args)
        }),
        update: jest.fn(async (args: any) => {
          ops.push('shift.update')
          return (prisma.shift.update as jest.Mock)(args)
        }),
      },
      activityLog: {
        create: jest.fn(async (args: any) => {
          ops.push('activityLog.create')
          return (prisma.activityLog.create as jest.Mock)(args)
        }),
      },
      venueSettings: { findUnique: prisma.venueSettings.findUnique },
      areaTicketCheckoutSession: {
        findFirst: prisma.areaTicketCheckoutSession.findFirst,
        updateMany: prisma.areaTicketCheckoutSession.updateMany,
      },
      areaTicketPaymentAttempt: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: prisma.areaTicketPaymentAttempt.findFirst,
        updateMany: prisma.areaTicketPaymentAttempt.updateMany,
      },
      inventoryPosting: prisma.inventoryPosting,
      $queryRaw: jest.fn().mockImplementation(async () => (durableOrderVenue === VENUE_ID ? [{ id: ORDER_ID }] : [])),
    }
    record.client = tx
    transacciones.push(record)
    return callback(tx)
  })
})

describe('fase 1 — el cobro cae en el turno abierto del NEGOCIO', () => {
  it.each(['FAILED', 'PENDING'] as const)(
    'un Payment %s no es dinero capturado: queda sin turno, claim ni anomalía post-cierre',
    async status => {
      ;(prisma.payment.create as jest.Mock).mockImplementationOnce(async ({ data }: any) => ({
        id: `payment-${status.toLowerCase()}`,
        feeAmount: 0,
        netAmount: 100,
        receipts: [],
        ...data,
      }))

      await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, status }, 'user-1')

      expect((prisma.payment.create as jest.Mock).mock.calls.at(-1)![0].data).toMatchObject({ status, shiftId: null })
      expect(prisma.shift.findFirst).not.toHaveBeenCalled()
      expect(prisma.shift.updateMany).not.toHaveBeenCalled()
      expect(prisma.activityLog.create).not.toHaveBeenCalled()
    },
  )

  it('usa un snapshot primitivo de status para claim y Payment aunque el body mutable cambie durante el claim', async () => {
    const mutablePaymentData: any = { ...paymentData, status: 'COMPLETED' }
    ;(prisma.shift.updateMany as jest.Mock).mockImplementationOnce(async () => {
      // Simula una mutación observable entre evaluar el argumento del wrapper y crear Payment.
      mutablePaymentData.status = 'PENDING'
      return { count: 1 }
    })

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, mutablePaymentData, 'user-1')

    expect((prisma.payment.create as jest.Mock).mock.calls.at(-1)![0].data).toMatchObject({
      status: 'COMPLETED',
      shiftId: 'shift-1',
    })
  })

  it('si la Order pasa de A a B antes del lock aborta sin Payment, Shift ni mutación de B y deja conciliación en A', async () => {
    // La lectura exterior ya devolvió la foto de A. Al abrir la tx, el job gana y la
    // fila durable queda en B; el SELECT id+venue de A debe volver cero filas.
    onTransactionStart = () => {
      durableOrderVenue = 'venue-b'
    }

    await expect(
      (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData }, 'user-autenticado'),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_ORDER_AUTHORITY_UNAVAILABLE' })

    expect(prisma.payment.create).not.toHaveBeenCalled()
    expect(prisma.shift.findFirst).not.toHaveBeenCalled()
    expect(prisma.shift.updateMany).not.toHaveBeenCalled()
    expect(prisma.order.update).not.toHaveBeenCalled()
    expect(prisma.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'PAYMENT_WITHOUT_SHIFT',
        entity: 'Order',
        entityId: ORDER_ID,
        staffId: 'user-autenticado',
        venueId: VENUE_ID,
        data: expect.objectContaining({
          status: 'PENDING',
          reason: 'ORDER_AUTHORITY_UNAVAILABLE',
          channel: 'recordOrderPayment',
          orderId: ORDER_ID,
          amountPesos: '100.00',
          tipPesos: '0.00',
        }),
      }),
    })
  })

  it('dos cobros resuelven y reclaman dentro de tx; conservan el mismo turno y quién cobró', async () => {
    ;(prisma.shift.findFirst as jest.Mock).mockResolvedValue({ id: 'shift-negocio', status: 'OPEN' })
    ;(prisma.staffVenue.findFirst as jest.Mock).mockImplementation(async ({ where }: any) => ({
      id: `sv-${where.staffId}`,
      staffId: where.staffId,
      venueId: VENUE_ID,
    }))

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, amount: 4000, staffId: 'viridiana' }, 'user-1')
    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, amount: 6000, staffId: 'hector' }, 'user-1')

    const creados = (prisma.payment.create as jest.Mock).mock.calls.map(c => c[0].data)
    expect(creados).toHaveLength(2)
    expect(creados.map(d => d.shiftId)).toEqual(['shift-negocio', 'shift-negocio'])
    expect(creados.map(d => d.processedById)).toEqual(['viridiana', 'hector'])

    // El candidato se resuelve dentro de la misma tx que crea el Payment, por negocio.
    for (const call of (prisma.shift.findFirst as jest.Mock).mock.calls) {
      expect(call[0].where).toEqual({ venueId: VENUE_ID, endTime: null })
      expect(call[0].where).not.toHaveProperty('staffId')
    }
    for (const call of (prisma.shift.updateMany as jest.Mock).mock.calls) {
      expect(call[0].where).toEqual({ id: 'shift-negocio', venueId: VENUE_ID, status: 'OPEN', endTime: null })
    }
    for (const call of (prisma.order.update as jest.Mock).mock.calls) {
      expect(call[0].where).toEqual({ id: ORDER_ID, venueId: VENUE_ID })
    }
    expect(prisma.shift.update).not.toHaveBeenCalled()
    const txsDelCobro = transacciones.filter(tx => tx.ops.includes('payment.create'))
    expect(txsDelCobro).toHaveLength(2)
    for (const tx of txsDelCobro) {
      expect(tx.ops.indexOf('shift.findFirst')).toBeLessThan(tx.ops.indexOf('shift.updateMany'))
      expect(tx.ops.indexOf('shift.updateMany')).toBeLessThan(tx.ops.indexOf('payment.create'))
    }
  })

  it('si el cierre gana el CAS, captura sin shiftId y deja una conciliación atómica con candidato/canal/pesos', async () => {
    ;(prisma.shift.findFirst as jest.Mock).mockResolvedValue({ id: 'shift-que-cerro', status: 'OPEN' })
    ;(prisma.shift.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

    await (paymentService as any).recordOrderPayment(
      VENUE_ID,
      ORDER_ID,
      { ...paymentData, amount: 10000, tip: 1234, idempotencyKey: 'claim-race-order' },
      'user-1',
    )

    const creado = (prisma.payment.create as jest.Mock).mock.calls.at(-1)![0].data
    expect(creado.shiftId ?? null).toBeNull()
    expect(prisma.shift.update).not.toHaveBeenCalled()
    expect(prisma.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'PAYMENT_WITHOUT_SHIFT',
        entity: 'Payment',
        entityId: 'payment-1',
        staffId: 'staff-1',
        venueId: VENUE_ID,
        data: expect.objectContaining({
          reason: 'CLAIM_LOST',
          candidateShiftId: 'shift-que-cerro',
          paymentId: 'payment-1',
          orderId: ORDER_ID,
          channel: 'recordOrderPayment',
          amountPesos: '100.00',
          tipPesos: '12.34',
        }),
      }),
    })
    const tx = transacciones.find(tx => tx.ops.includes('payment.create'))!
    expect(tx.ops.indexOf('shift.updateMany')).toBeLessThan(tx.ops.indexOf('payment.create'))
    expect(tx.ops.indexOf('payment.create')).toBeLessThan(tx.ops.indexOf('activityLog.create'))
  })

  it('P2002 después del claim revierte el incremento y devuelve al ganador sin conciliación del perdedor', async () => {
    const winner = {
      id: 'payment-winner',
      orderId: ORDER_ID,
      status: 'COMPLETED',
      receipts: [],
      idempotencyKey: 'claim-race-p2002',
    }
    ;(prisma.payment.findUnique as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(winner)
    const rollback = installStatefulP2002Rollback()

    const result = await (paymentService as any).recordOrderPayment(
      VENUE_ID,
      ORDER_ID,
      { ...paymentData, idempotencyKey: 'claim-race-p2002' },
      'user-1',
    )

    expect(result.id).toBe('payment-winner')
    expect(rollback.attempted.claims).toBe(1)
    expect(rollback.ops).toEqual(['shift.findFirst', 'shift.updateMany', 'payment.create:P2002'])
    expect(rollback.committed.shift).toEqual({ totalSales: 0, totalTips: 0, totalOrders: 0 })
    expect(rollback.committed.loserPayments).toEqual([])
    expect(rollback.committed.activityLogs).toEqual([])
    expect(prisma.activityLog.create).not.toHaveBeenCalled()
  })
})
