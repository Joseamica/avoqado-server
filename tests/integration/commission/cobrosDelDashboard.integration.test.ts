// tests/integration/commission/cobrosDelDashboard.integration.test.ts
/**
 * Fase 3 de Pago al personal, FT-GRAVES T2 (regla del founder, 8-oct): **un cobro COMPLETED con una persona atribuida genera
 * comisión según los esquemas; sin persona atribuida, no** (no se inventa a quién). Contra Postgres REAL.
 *
 * Los cobros que se registran desde el dashboard no comisionaban: el pago manual (`createManualPayment`), la venta manual
 * (`createOneManualSale`), saldar una orden (`settleOrder`) y saldar el saldo de un cliente (`settleCustomerBalance`). Ahora usan
 * el MISMO gancho que la terminal (`enqueuePaymentCommissionInTx`), en la transacción del cobro, con su deduplicación por pago.
 * El esquema decide a quién (aquí, «quién atendió»), y la devolución lo revierte por el mecanismo de siempre.
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="<base de prueba>" npx jest --selectProjects=integration \
 *   --runTestsByPath tests/integration/commission/cobrosDelDashboard.integration.test.ts --ci --runInBand
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createManualPayment } from '@/services/dashboard/manualPayment.service'
import { createOneManualSale } from '@/services/dashboard/manualSale.service'
import { settleOrder } from '@/services/dashboard/order.dashboard.service'
import { settleCustomerBalance } from '@/services/dashboard/customer.dashboard.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import {
  asegurarBaseDePrueba,
  borrarMundoComisiones,
  crearMundoComisiones,
  MundoComisiones,
  netoVivo,
  procesarEfectos,
} from './_mundoComisiones'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({ socketManager: { broadcastToVenue: jest.fn() } }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  ...jest.requireActual('@/services/shared/cashDrawerPosting'),
  postCashSaleToDrawer: jest.fn().mockResolvedValue(undefined),
  postCashRefundToDrawer: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(undefined) }))

const D = (n: number) => new Prisma.Decimal(n)
let m: MundoComisiones
beforeAll(asegurarBaseDePrueba)
beforeEach(async () => {
  m = await crearMundoComisiones('cobros-dashboard')
  // El esquema más común en producción: le paga a quien ATENDIÓ (10 %, «con IVA»).
  await prisma.commissionConfig.update({ where: { id: m.configId }, data: { recipient: 'SERVER' } })
})
afterEach(async () => {
  const mundo = m
  m = undefined as unknown as MundoComisiones
  if (mundo) {
    await prisma.saleVerification.deleteMany({ where: { venueId: mundo.venueId } })
    await prisma.serializedItem.deleteMany({ where: { organizationId: mundo.orgId } })
    await prisma.itemCategory.deleteMany({ where: { organizationId: mundo.orgId } })
    await prisma.orderCustomer.deleteMany({ where: { order: { venueId: mundo.venueId } } })
    await prisma.customer.deleteMany({ where: { venueId: mundo.venueId } })
  }
  await borrarMundoComisiones(mundo)
})

/** Las comisiones (vivas) de los cobros de una orden: [persona, neto]. */
async function comisionesDeLaOrden(orderId: string) {
  const filas = await prisma.commissionCalculation.findMany({ where: { venueId: m.venueId, orderId, status: { not: 'VOIDED' } }, take: 10 })
  return filas.map(f => [f.staffId, f.netCommission.toFixed(2)])
}
/** Una cuenta ABIERTA de $100 (fiado), atendida por `servedById` (o por nadie). */
async function cuentaAbierta(servedById: string | null) {
  const o = await prisma.order.create({
    data: {
      venueId: m.venueId,
      orderNumber: `${m.key}-${randomUUID().slice(0, 8)}`,
      subtotal: D(100),
      discountAmount: D(0),
      taxAmount: D(0),
      total: D(100),
      paidAmount: D(0),
      remainingBalance: D(100),
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
      servedById,
      createdById: servedById,
    },
  })
  return o.id
}
/** Devuelve TODO el cobro por el dashboard (centavos) y materializa el reverso. */
async function devolverTodo(paymentId: string, monto = 10_000) {
  await issueRefund({ venueId: m.venueId, paymentId, amount: monto, reason: 'RETURNED_GOODS', staffId: m.owner })
  await procesarEfectos(m)
}

describe('T2 · pago manual del dashboard (createManualPayment)', () => {
  it('🔴 con el mesero elegido: comisión del 10 % para él, y la devolución la revierte', async () => {
    const pago = await createManualPayment(m.venueId, m.owner, {
      amount: '100.00',
      tipAmount: '0',
      method: 'CASH',
      source: 'POS',
      waiterId: m.bea,
    } as Parameters<typeof createManualPayment>[2])
    await procesarEfectos(m)
    expect(await comisionesDeLaOrden(pago.orderId!)).toEqual([[m.bea, '10.00']])

    await devolverTodo(pago.id)
    expect(await netoVivo({ venueId: m.venueId, orderId: pago.orderId! })).toBe('0.00')
  })
})

describe('T2 · saldar una orden desde el dashboard (settleOrder)', () => {
  it('🔴 con quien atendió la cuenta: su comisión, y la devolución la revierte', async () => {
    const orderId = await cuentaAbierta(m.ana)
    await settleOrder(m.venueId, orderId, 'Liquidó en caja', m.owner)
    await procesarEfectos(m)
    expect(await comisionesDeLaOrden(orderId)).toEqual([[m.ana, '10.00']])

    const pago = await prisma.payment.findFirstOrThrow({ where: { venueId: m.venueId, orderId, type: 'REGULAR' } })
    await devolverTodo(pago.id)
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('0.00')
  })

  it('sin nadie atribuido (la cuenta no tiene quién la atendió ni quién la creó, y el saldo no lleva cobrador): ninguna comisión', async () => {
    const orderId = await cuentaAbierta(null)
    await settleOrder(m.venueId, orderId, undefined, m.owner)
    await procesarEfectos(m)
    expect(await comisionesDeLaOrden(orderId)).toEqual([])
    expect(await prisma.paymentEffect.count({ where: { venueId: m.venueId, orderId, kind: 'COMMISSION' } })).toBe(0)
  })
})

describe('T2 · saldar el saldo de un cliente (settleCustomerBalance)', () => {
  it('🔴 cada cuenta saldada comisiona para quien la atendió, y la devolución la revierte', async () => {
    const cliente = await prisma.customer.create({ data: { venueId: m.venueId, firstName: 'Cliente', lastName: 'QA' } })
    const orderId = await cuentaAbierta(m.bea)
    await prisma.orderCustomer.create({ data: { orderId, customerId: cliente.id, isPrimary: true } })

    await settleCustomerBalance(m.venueId, cliente.id, 'Pagó su cuenta', m.owner)
    await procesarEfectos(m)
    expect(await comisionesDeLaOrden(orderId)).toEqual([[m.bea, '10.00']])

    const pago = await prisma.payment.findFirstOrThrow({ where: { venueId: m.venueId, orderId, type: 'REGULAR' } })
    await devolverTodo(pago.id)
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('0.00')
  })

  it('sin nadie atribuido en la cuenta: ninguna comisión', async () => {
    const cliente = await prisma.customer.create({ data: { venueId: m.venueId, firstName: 'Cliente', lastName: 'Sin' } })
    const orderId = await cuentaAbierta(null)
    await prisma.orderCustomer.create({ data: { orderId, customerId: cliente.id, isPrimary: true } })
    await settleCustomerBalance(m.venueId, cliente.id, undefined, m.owner)
    await procesarEfectos(m)
    expect(await comisionesDeLaOrden(orderId)).toEqual([])
  })
})

describe('T2 · venta manual de SIM fuera de la TPV (createOneManualSale)', () => {
  it('🔴 la venta del promotor comisiona para él (quién atendió), y la devolución la revierte', async () => {
    await prisma.staff.update({ where: { id: m.ana }, data: { employeeCode: `${m.key}-ANA` } })
    await prisma.venue.update({ where: { id: m.venueId }, data: { name: `Tienda QA ${m.key}` } })
    const categoria = await prisma.itemCategory.create({ data: { organizationId: m.orgId, name: 'SIM QA' } })
    const iccid = `8952${Date.now()}`
    await prisma.serializedItem.create({
      data: { organizationId: m.orgId, categoryId: categoria.id, serialNumber: iccid, createdBy: m.owner },
    })

    const r = await createOneManualSale(m.orgId, m.owner, {
      iccid,
      promoterCode: `${m.key}-ANA`,
      storeName: `Tienda QA ${m.key}`,
      saleDate: new Date().toISOString().slice(0, 10),
      saleType: 'Línea nueva',
      paymentForm: 'Efectivo',
      amount: 100,
      saleStatus: 'Aprobada',
    } as Parameters<typeof createOneManualSale>[2])
    expect(r.ok).toBe(true)
    const orderId = (r as { orderId: string }).orderId
    await procesarEfectos(m)
    expect(await comisionesDeLaOrden(orderId)).toEqual([[m.ana, '10.00']])

    const pago = await prisma.payment.findFirstOrThrow({ where: { venueId: m.venueId, orderId } })
    await devolverTodo(pago.id)
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('0.00')
  })
})
