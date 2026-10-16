/**
 * 🔴 R5-1 (ronda 5 post-QA de sellos tardíos; Codex recheck-9 P2; decisión «A» del founder): el pago manual (`payment:create-manual`)
 * sobre una venta YA cobrada no liga un cliente nuevo sin `payments:create`.
 *
 * Cómo se llegaba: venta PAID de $100 sin cliente → reembolso de $20 (el saldo vuelve a ser $20: `paidSoFar` resta el reembolso) →
 * pago manual de $20 con `customerId` ⇒ creaba el `OrderCustomer` PRIMARIO y `earnPoints` sobre $100. Y con un primario existente,
 * el `customerId` del pago DESPLAZABA la lealtad al cliente nuevo.
 *
 * Ahora, en el modo «venta existente», bajo el candado que el servicio YA toma (`lockExistingOrderForPayment`) y antes de cualquier
 * escritura: venta PAID/REFUNDED + `customerId` distinto del cliente actual (primario; si no hay, `Order.customerId`) + sin el
 * permiso ⇒ 403 con el código y el mensaje de la regla compartida, sin escribir NADA. Mismo cliente, venta no cobrada o con permiso
 * ⇒ como hoy. Sin decir el permiso, cerrado.
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
import { ForbiddenError } from '@/errors/AppError'
import { CODIGO_CLIENTE_DE_VENTA_COBRADA, MENSAJE_CLIENTE_DE_VENTA_COBRADA } from '@/services/shared/ligaDeClienteEnVenta'

const prismaMock = prisma as jest.Mocked<typeof prisma>
const VENUE = 'venue-r5'
const STAFF = 'staff-r5'
const ORDER = 'order-r5'
const NUEVO = 'cust-nuevo'

type Liga = { customerId: string; isPrimary: boolean }

/**
 * Venta de $100 ($100 cobrados − $20 reembolsados ⇒ saldo $20), con su `paymentStatus`, su cliente heredado y sus ligas. La
 * transacción anota cada ESCRITURA en orden: un 403 debe dejar la lista vacía.
 */
function ventaYTransaccion(opciones: { paymentStatus: string; customerId?: string | null; ligas?: Liga[] }) {
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
      count: jest.fn().mockResolvedValue(1),
      findUnique: jest.fn().mockResolvedValue(null),
      create: escribe('payment.create', {
        id: 'pay-r5',
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
      findFirst: jest.fn().mockResolvedValue({ id: 'shift-r5', status: 'OPEN' }),
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

async function rechazo(promesa: Promise<unknown>): Promise<ForbiddenError> {
  const error = await promesa.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ForbiddenError)
  return error as ForbiddenError
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
  ;(prismaMock.staffVenue.findFirst as jest.Mock).mockResolvedValue({ staffId: STAFF, id: 'sv-r5' })
  ;(prismaMock.venueSettings.findUnique as jest.Mock).mockResolvedValue({ enableShifts: true })
  ;(prismaMock.payment.findUnique as jest.Mock).mockResolvedValue(null)
})

describe('🔴 R5-1: pago manual + cliente sobre una venta YA cobrada, sin payments:create ⇒ 403 sin escribir nada', () => {
  it.each(['PAID', 'REFUNDED'])('%s sin cliente + cliente NUEVO, sin decir el permiso (cerrado por default) ⇒ 403', async estado => {
    const { escrituras } = ventaYTransaccion({ paymentStatus: estado })
    const error = await rechazo(manualPaymentService.createManualPayment(VENUE, STAFF, pagoDe20(NUEVO)))
    expect(error.statusCode).toBe(403)
    expect(error.code).toBe(CODIGO_CLIENTE_DE_VENTA_COBRADA)
    expect(error.message).toBe(MENSAJE_CLIENTE_DE_VENTA_COBRADA)
    nadaSeEscribio(escrituras)
  })

  it('PAID + permiso explícitamente en false ⇒ 403 sin escribir nada', async () => {
    const { escrituras } = ventaYTransaccion({ paymentStatus: 'PAID' })
    await rechazo(manualPaymentService.createManualPayment(VENUE, STAFF, pagoDe20(NUEVO), { puedeCambiarClienteEnVentaCobrada: false }))
    nadaSeEscribio(escrituras)
  })

  it.each(['PAID', 'REFUNDED'])('%s con PRIMARIO Ana + cliente distinto (Beto) ⇒ 403: no desplaza la lealtad', async estado => {
    const { escrituras } = ventaYTransaccion({ paymentStatus: estado, ligas: [{ customerId: 'cust-ana', isPrimary: true }] })
    await rechazo(manualPaymentService.createManualPayment(VENUE, STAFF, pagoDe20('cust-beto')))
    nadaSeEscribio(escrituras)
  })

  it('PAID sin primario pero con el cliente heredado (Order.customerId) Ana + Beto ⇒ 403', async () => {
    const { escrituras } = ventaYTransaccion({ paymentStatus: 'PAID', customerId: 'cust-ana' })
    await rechazo(manualPaymentService.createManualPayment(VENUE, STAFF, pagoDe20('cust-beto')))
    nadaSeEscribio(escrituras)
  })

  it('el cliente actual es el PRIMARIO, no el heredado: primario Ana + heredado Beto + pago con Beto ⇒ 403', async () => {
    const { escrituras } = ventaYTransaccion({
      paymentStatus: 'PAID',
      customerId: 'cust-beto',
      ligas: [{ customerId: 'cust-ana', isPrimary: true }],
    })
    await rechazo(manualPaymentService.createManualPayment(VENUE, STAFF, pagoDe20('cust-beto')))
    nadaSeEscribio(escrituras)
  })

  it('un ACOMPAÑANTE (no primario) no es el cliente actual: acompañante Beto + pago con Beto ⇒ 403', async () => {
    const { escrituras } = ventaYTransaccion({ paymentStatus: 'PAID', ligas: [{ customerId: 'cust-beto', isPrimary: false }] })
    await rechazo(manualPaymentService.createManualPayment(VENUE, STAFF, pagoDe20('cust-beto')))
    nadaSeEscribio(escrituras)
  })

  it('🔴 la decisión se toma BAJO el candado del cobro y antes de la primera escritura (el turno)', async () => {
    const { tx, lecturasDeLaVenta } = ventaYTransaccion({ paymentStatus: 'PAID' })
    await rechazo(manualPaymentService.createManualPayment(VENUE, STAFF, pagoDe20(NUEVO)))
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1) // el candado de siempre; ninguno nuevo
    expect(lecturasDeLaVenta).toHaveLength(1)
    expect(lecturasDeLaVenta[0]).toEqual(expect.objectContaining({ where: { id: ORDER, venueId: VENUE } }))
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.order.findFirst.mock.invocationCallOrder[0])
    expect(tx.shift.findFirst).not.toHaveBeenCalled()
  })
})

describe('R5-1: lo que sigue igual que hoy', () => {
  it('PAID + mismo cliente que el primario ⇒ pasa; la lealtad va a ese cliente', async () => {
    const { escrituras } = ventaYTransaccion({ paymentStatus: 'PAID', ligas: [{ customerId: 'cust-ana', isPrimary: true }] })
    await manualPaymentService.createManualPayment(VENUE, STAFF, pagoDe20('cust-ana'))
    expect(escrituras).toContain('payment.create')
    expect(escrituras).not.toContain('orderCustomer.create')
    expect(earnPointsMock).toHaveBeenCalledWith(VENUE, 'cust-ana', 100, ORDER, 'sv-r5')
  })

  it('PAID + mismo cliente que el heredado (sin primario) ⇒ pasa', async () => {
    const { escrituras } = ventaYTransaccion({ paymentStatus: 'PAID', customerId: 'cust-ana' })
    await manualPaymentService.createManualPayment(VENUE, STAFF, pagoDe20('cust-ana'))
    expect(escrituras).toContain('payment.create')
    expect(earnPointsMock).toHaveBeenCalledWith(VENUE, 'cust-ana', 100, ORDER, 'sv-r5')
  })

  it.each(['PAID', 'REFUNDED'])('%s + cliente nuevo CON payments:create ⇒ como hoy: liga primaria y lealtad', async estado => {
    const { escrituras } = ventaYTransaccion({ paymentStatus: estado })
    await manualPaymentService.createManualPayment(VENUE, STAFF, pagoDe20(NUEVO), { puedeCambiarClienteEnVentaCobrada: true })
    expect(escrituras).toEqual(expect.arrayContaining(['shift.updateMany', 'payment.create', 'orderCustomer.create', 'order.update']))
    expect(earnPointsMock).toHaveBeenCalledWith(VENUE, NUEVO, 100, ORDER, 'sv-r5')
  })

  it('con el permiso no se hace la lectura extra de la venta', async () => {
    const { lecturasDeLaVenta } = ventaYTransaccion({ paymentStatus: 'PAID' })
    await manualPaymentService.createManualPayment(VENUE, STAFF, pagoDe20(NUEVO), { puedeCambiarClienteEnVentaCobrada: true })
    expect(lecturasDeLaVenta).toHaveLength(1) // sólo la de siempre (con `include`)
    expect(lecturasDeLaVenta[0]).toEqual(expect.objectContaining({ include: expect.anything() }))
  })

  it.each(['PARTIAL', 'PENDING'])('venta %s (abono normal con cliente) sin el permiso ⇒ como hoy', async estado => {
    const { escrituras } = ventaYTransaccion({ paymentStatus: estado })
    await manualPaymentService.createManualPayment(VENUE, STAFF, pagoDe20(NUEVO))
    expect(escrituras).toEqual(expect.arrayContaining(['payment.create', 'orderCustomer.create']))
  })

  it('PAID sin customerId en la petición, sin el permiso ⇒ como hoy (no hay cambio de cliente)', async () => {
    const { escrituras, lecturasDeLaVenta } = ventaYTransaccion({ paymentStatus: 'PAID', customerId: 'cust-ana' })
    await manualPaymentService.createManualPayment(VENUE, STAFF, pagoDe20())
    expect(escrituras).toContain('payment.create')
    expect(lecturasDeLaVenta).toHaveLength(1)
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
