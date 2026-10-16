/**
 * 🔴 R7-1 (ronda 7 post-QA de sellos tardíos; decisión del founder del 16-oct, «como Square»): una venta cobrada queda CERRADA. El
 * pago manual (panel HTTP y MCP `record_manual_payment`) RECHAZA una venta existente PAID o REFUNDED, para TODOS (con o sin permiso):
 * 400 `ORDER_ALREADY_PAID` en español, decidido bajo el candado que el servicio YA toma (`lockExistingOrderForPayment`) y antes de
 * cualquier escritura (también del reclamo del turno). Lo extra se registra como venta nueva.
 *
 * Cierra de raíz los caminos de Codex r9/r10/r11 (reembolso + abono, partir el pago, corregir/cancelar el cobro + abono): todos
 * empezaban con un pago manual sobre una venta que seguía PAID. Ventas PENDING/PARTIAL ⇒ como hoy (también con un abono devuelto).
 *
 * Historia: R5-1 (ronda 5) pedía `payments:create` para cambiar el cliente con un pago manual sobre una venta cobrada; con R7-1 ese
 * caso ya no llega a esa regla (la venta cobrada se rechaza antes, para todos).
 */
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/services/shared/paymentShiftClaim', () => {
  const actual = jest.requireActual('@/services/shared/paymentShiftClaim')
  return { ...actual, recordPendingPaymentShiftReconciliation: jest.fn().mockResolvedValue(undefined) }
})

import { Prisma } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    order: { findFirst: jest.fn() },
    payment: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), groupBy: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    customer: { findFirst: jest.fn() },
    table: { findFirst: jest.fn() },
    venueSettings: { findUnique: jest.fn() },
  },
}))

const earnPointsMock = jest.fn()
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({
  __esModule: true,
  earnPoints: (...args: any[]) => earnPointsMock(...args),
}))
const updateCustomerMetricsMock = jest.fn()
jest.mock('@/services/dashboard/customer.dashboard.service', () => ({
  __esModule: true,
  updateCustomerMetrics: (...args: any[]) => updateCustomerMetricsMock(...args),
}))
const createSalePostingInTxMock = jest.fn()
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: (...args: any[]) => createSalePostingInTxMock(...args),
  applySalePosting: jest.fn(),
}))
const postCashSaleToDrawerMock = jest.fn()
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  __esModule: true,
  postCashSaleToDrawer: (...args: any[]) => postCashSaleToDrawerMock(...args),
}))
const onOrderPaidMock = jest.fn()
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: (...a: any[]) => onOrderPaidMock(...a) }))

import * as manualPaymentService from '@/services/dashboard/manualPayment.service'
import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'

const prismaMock = prisma as jest.Mocked<typeof prisma>
const VENUE = 'venue-r7'
const STAFF = 'staff-r7'
const ORDER = 'order-r7'
/** El contrato del rechazo (texto y código EXACTOS: los lee el panel y el LLM del MCP). */
const MENSAJE = 'Esta venta ya está cobrada. Para cobrar algo extra, registra una venta nueva.'
const CODIGO = 'ORDER_ALREADY_PAID'
const NUEVO = 'cust-nuevo'

type Liga = { customerId: string; isPrimary: boolean }

/**
 * Venta de $100 ($100 cobrados − $20 reembolsados ⇒ saldo $20), con su `paymentStatus`, su cliente heredado y sus ligas. La
 * transacción anota cada ESCRITURA en orden: un rechazo debe dejar la lista vacía.
 */
function ventaYTransaccion(opciones: { paymentStatus: string; customerId?: string | null; ligas?: Liga[]; reembolsos?: number }) {
  const escrituras: string[] = []
  const lecturasDeLaVenta: unknown[] = []
  const escribe = (nombre: string, valor?: unknown) =>
    jest.fn(async () => {
      escrituras.push(nombre)
      return valor
    })
  const ligas = opciones.ligas ?? []
  const venta = {
    id: ORDER,
    venueId: VENUE,
    status: opciones.paymentStatus === 'PAID' || opciones.paymentStatus === 'REFUNDED' ? 'COMPLETED' : 'PENDING',
    paymentStatus: opciones.paymentStatus,
    customerId: opciones.customerId ?? null,
    subtotal: new Prisma.Decimal(100),
    taxAmount: new Prisma.Decimal(0),
    discountAmount: new Prisma.Decimal(0),
    total: new Prisma.Decimal(100),
    payments: [
      { amount: new Prisma.Decimal(100), tipAmount: new Prisma.Decimal(0) },
      { amount: new Prisma.Decimal(-20), tipAmount: new Prisma.Decimal(0) },
    ],
    orderCustomers: ligas,
    items: [],
  }
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: ORDER }]),
    order: {
      // Honra la proyección de quien pregunta: con `select` sólo el primario (como el `where: { isPrimary: true }` de Prisma).
      findFirst: jest.fn(async (args: any) => {
        lecturasDeLaVenta.push(args)
        if (args?.select) {
          const primarios = ligas.filter(l => l.isPrimary)
          return {
            paymentStatus: venta.paymentStatus,
            customerId: venta.customerId,
            orderCustomers: primarios.map(l => ({ customerId: l.customerId })),
          }
        }
        return venta
      }),
      update: escribe('order.update'),
    },
    payment: {
      // La venta tiene su reembolso de $20 (el escenario de Codex). R7-2: los reembolsos ya NO deciden «cobrada» — las pruebas
      // vigilan que no se pregunten.
      count: jest.fn(async (args: any) => (args?.where?.type === 'REFUND' ? (opciones.reembolsos ?? 1) : 1)),
      findUnique: jest.fn().mockResolvedValue(null),
      create: escribe('payment.create', {
        id: 'pay-r7',
        orderId: ORDER,
        method: 'CASH',
        fundsFlow: 'CASH_DRAWER',
        status: 'COMPLETED',
        type: 'REGULAR',
        amount: new Prisma.Decimal(20),
        tipAmount: new Prisma.Decimal(0),
      }),
    },
    shift: {
      findFirst: jest.fn().mockResolvedValue({ id: 'shift-r7', status: 'OPEN' }),
      updateMany: escribe('shift.updateMany', { count: 1 }),
    },
    orderCustomer: { create: escribe('orderCustomer.create') },
    venueTransaction: { create: escribe('venueTransaction.create') },
    paymentAllocation: { create: escribe('paymentAllocation.create') },
  }
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx))
  return { tx, escrituras, lecturasDeLaVenta }
}

const pagoDe20 = (customerId?: string) => ({
  orderId: ORDER,
  amount: '20.00',
  tipAmount: '0',
  method: 'CASH' as const,
  source: 'OTHER' as const,
  externalSource: 'BBVA',
  ...(customerId ? { customerId } : {}),
})

/** El rechazo de R7-1, con su contrato completo. */
async function rechazoVentaCobrada(promesa: Promise<unknown>): Promise<void> {
  const error = await promesa.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(BadRequestError)
  expect(error).toMatchObject({ statusCode: 400, code: CODIGO, message: MENSAJE })
}

function nadaSeEscribio(escrituras: string[]) {
  expect(escrituras).toEqual([])
  expect(earnPointsMock).not.toHaveBeenCalled()
  expect(updateCustomerMetricsMock).not.toHaveBeenCalled()
  expect(postCashSaleToDrawerMock).not.toHaveBeenCalled()
  expect(createSalePostingInTxMock).not.toHaveBeenCalled()
  expect(onOrderPaidMock).not.toHaveBeenCalled()
}

beforeEach(() => {
  jest.clearAllMocks()
  earnPointsMock.mockResolvedValue({ pointsEarned: 100, newBalance: 100 })
  updateCustomerMetricsMock.mockResolvedValue(undefined)
  createSalePostingInTxMock.mockResolvedValue(null)
  postCashSaleToDrawerMock.mockResolvedValue(undefined)
  ;(prismaMock.customer.findFirst as jest.Mock).mockImplementation(async (args: any) => ({ id: args.where.id }))
  ;(prismaMock.staffVenue.findFirst as jest.Mock).mockResolvedValue({ staffId: STAFF, id: 'sv-r7' })
  ;(prismaMock.venueSettings.findUnique as jest.Mock).mockResolvedValue({ enableShifts: true })
  ;(prismaMock.payment.findUnique as jest.Mock).mockResolvedValue(null)
})

const CON_PERMISO = { puedeCambiarClienteEnVentaCobrada: true }

describe('🔴 R7-1: el pago manual rechaza una venta YA cobrada (PAID/REFUNDED), para todos y sin escribir nada', () => {
  it.each([
    ['PAID', 'sin cliente', undefined, {}],
    ['REFUNDED', 'sin cliente', undefined, {}],
    ['PAID', 'cliente nuevo, sin el permiso', NUEVO, {}],
    ['REFUNDED', 'cliente nuevo, sin el permiso', NUEVO, {}],
    ['PAID', 'cliente nuevo, CON payments:create (dueño)', NUEVO, CON_PERMISO],
    ['REFUNDED', 'cliente nuevo, CON payments:create (dueño)', NUEVO, CON_PERMISO],
  ])('%s, %s ⇒ 400 ORDER_ALREADY_PAID', async (estado, _caso, cliente, opciones) => {
    const { escrituras } = ventaYTransaccion({ paymentStatus: estado })
    await rechazoVentaCobrada(manualPaymentService.createManualPayment(VENUE, STAFF, pagoDe20(cliente), opciones))
    nadaSeEscribio(escrituras)
  })

  it('PAID + el MISMO cliente que el primario ⇒ también 400 (no es asunto del cliente: la venta está cerrada)', async () => {
    const { escrituras } = ventaYTransaccion({ paymentStatus: 'PAID', ligas: [{ customerId: 'cust-ana', isPrimary: true }] })
    await rechazoVentaCobrada(manualPaymentService.createManualPayment(VENUE, STAFF, pagoDe20('cust-ana'), CON_PERMISO))
    nadaSeEscribio(escrituras)
  })

  it('🔴 la decisión se toma BAJO el candado del cobro (ninguno nuevo) y antes de la primera escritura (el turno)', async () => {
    const { tx, lecturasDeLaVenta } = ventaYTransaccion({ paymentStatus: 'PAID' })
    await rechazoVentaCobrada(manualPaymentService.createManualPayment(VENUE, STAFF, pagoDe20(NUEVO), CON_PERMISO))
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1) // el candado de siempre
    expect(lecturasDeLaVenta).toHaveLength(1)
    expect(lecturasDeLaVenta[0]).toEqual(expect.objectContaining({ where: { id: ORDER, venueId: VENUE } }))
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.order.findFirst.mock.invocationCallOrder[0])
    expect(tx.shift.findFirst).not.toHaveBeenCalled()
    expect(tx.payment.count).not.toHaveBeenCalled() // ni los cobros previos del turno ni reembolsos
  })

  it('🔴 el reintento por serialización vuelve a evaluar la regla: en el 2.º intento la venta ya está PAID ⇒ 400', async () => {
    const abierta = ventaYTransaccion({ paymentStatus: 'PARTIAL' })
    const cobrada = ventaYTransaccion({ paymentStatus: 'PAID' })
    let intento = 0
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
      intento += 1
      if (intento === 1) {
        await cb(abierta.tx).catch(() => undefined)
        throw Object.assign(new Error('could not serialize access'), { code: 'P2034' })
      }
      return cb(cobrada.tx)
    })
    await rechazoVentaCobrada(
      manualPaymentService.createManualPayment(VENUE, STAFF, { ...pagoDe20(NUEVO), idempotencyKey: 'r7-reintento-0001' }),
    )
    expect(intento).toBe(2)
    expect(cobrada.escrituras).toEqual([])
    expect(earnPointsMock).not.toHaveBeenCalled()
  })
})

describe('R7-1: lo que sigue igual que hoy', () => {
  it.each(['PARTIAL', 'PENDING'])(
    '🔴 R7-2: cuenta %s con un abono devuelto (nunca se saldó) + cliente nuevo, sin el permiso ⇒ como en 8b32aef13: liga primaria',
    async estado => {
      const { escrituras, tx } = ventaYTransaccion({ paymentStatus: estado, reembolsos: 1 })
      await manualPaymentService.createManualPayment(VENUE, STAFF, pagoDe20(NUEVO))
      expect(escrituras).toEqual(expect.arrayContaining(['payment.create', 'orderCustomer.create']))
      expect(tx.payment.count).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ type: 'REFUND' }) }))
    },
  )

  it.each(['PARTIAL', 'PENDING'])('venta %s (abono normal) sin cliente ⇒ como hoy', async estado => {
    const { escrituras } = ventaYTransaccion({ paymentStatus: estado, reembolsos: 0 })
    await manualPaymentService.createManualPayment(VENUE, STAFF, pagoDe20())
    expect(escrituras).toEqual(expect.arrayContaining(['shift.updateMany', 'payment.create', 'order.update']))
  })

  it('cuenta PARTIAL con primario Ana + pago con Ana ⇒ como hoy (no crea otra liga)', async () => {
    const { escrituras } = ventaYTransaccion({
      paymentStatus: 'PARTIAL',
      reembolsos: 0,
      ligas: [{ customerId: 'cust-ana', isPrimary: true }],
    })
    await manualPaymentService.createManualPayment(VENUE, STAFF, pagoDe20('cust-ana'))
    expect(escrituras).toContain('payment.create')
    expect(escrituras).not.toContain('orderCustomer.create')
  })

  it('modo «sin venta» (orden sombra) con cliente, sin el permiso ⇒ como hoy: es una venta nueva', async () => {
    const escrituras: string[] = []
    const escribe = (nombre: string, valor?: unknown) =>
      jest.fn(async () => {
        escrituras.push(nombre)
        return valor
      })
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
      cb({
        $queryRaw: jest.fn(),
        order: { findFirst: jest.fn(), create: escribe('order.create', { id: 'sombra' }), update: escribe('order.update') },
        payment: {
          count: jest.fn().mockResolvedValue(0),
          findUnique: jest.fn().mockResolvedValue(null),
          create: escribe('payment.create', {
            id: 'pay-s',
            orderId: 'sombra',
            amount: new Prisma.Decimal(20),
            tipAmount: new Prisma.Decimal(0),
          }),
        },
        shift: { findFirst: jest.fn().mockResolvedValue(null), updateMany: escribe('shift.updateMany', { count: 1 }) },
        orderCustomer: { create: escribe('orderCustomer.create') },
        venueTransaction: { create: escribe('venueTransaction.create') },
        paymentAllocation: { create: escribe('paymentAllocation.create') },
      }),
    )
    const sombra = { ...pagoDe20(NUEVO), orderId: undefined }
    await manualPaymentService.createManualPayment(VENUE, STAFF, sombra)
    expect(escrituras).toEqual(expect.arrayContaining(['order.create', 'payment.create', 'orderCustomer.create']))
  })
})
