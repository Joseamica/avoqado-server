/**
 * 🔴 R5-1 (ronda 5 post-QA de sellos tardíos; Codex recheck-9 P2; decisión «A» del founder): el escenario EXACTO de Codex, todo
 * real contra Postgres — el controller del pago manual con el resolvedor de permisos (StaffVenue y `VenueRolePermission` de
 * verdad), el servicio, el reembolso del panel y la lealtad.
 *
 *   venta de $100 sin cliente, PAID (pago manual del dueño)
 *        ↓
 *   reembolso de $20 desde el panel (sigue PAID; el saldo vuelve a ser $20)
 *        ↓
 *   pago manual de $20 + cliente NUEVO, por un ADMIN al que el negocio le quitó `payments:create`
 *        ⇒ 403 y la base queda IGUAL (pagos, ligas, sellos, puntos, turno, estado de la venta)
 *   … el mismo pago por el DUEÑO (con el permiso) ⇒ como hoy: liga primaria y lealtad sobre $100.
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

import type { NextFunction, Request, Response } from 'express'
import * as panel from '@/controllers/dashboard/manualPayment.controller'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { tienePermisoEnVenue } from '@/middlewares/permissionFlag.middleware'
import { CODIGO_CLIENTE_DE_VENTA_COBRADA, MENSAJE_CLIENTE_DE_VENTA_COBRADA } from '@/services/shared/ligaDeClienteEnVenta'

const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
/** Quitarle `payments:create` a un rol desde el editor de roles: también lo que lo IMPLICA, o vuelve. */
const SIN_COBRAR = ['payments:create', 'area-tickets:checkout', 'tpv:create', 'tpv-payments:pay-later']
let orgId: string | undefined
let venueId: string | undefined
let shiftId: string
let n = 0
let dueno: { staffId: string }
let adminSinCobrar: { staffId: string }

async function empleado(nombre: string, role: 'OWNER' | 'ADMIN') {
  const s = await prisma.staff.create({ data: { email: `itest-pagoman-${sello}-${++n}@test.com`, firstName: nombre, lastName: 'Prueba' } })
  await prisma.staffVenue.create({ data: { staffId: s.id, venueId: venueId!, role } })
  return { staffId: s.id }
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `ITEST PagoManual ${sello}`, email: `itest-pagoman-${sello}@test.com`, phone: '5550000000' },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { name: `itest-pagoman-${sello}`, slug: `itest-pagoman-${sello}`, organizationId: orgId, timezone: 'America/Mexico_City' },
    })
  ).id
  await prisma.loyaltyConfig.create({
    data: { venueId, active: true, pointsPerDollar: 1, stampsEnabled: true, stampsRequired: 7, maxStampsPerDay: 0 },
  })
  dueno = await empleado('Dueño', 'OWNER')
  adminSinCobrar = await empleado('Admin', 'ADMIN')
  // El rol personalizado de Codex: el negocio le quitó «cobrar» al ADMIN; conserva «registrar pagos manuales».
  await prisma.venueRolePermission.create({
    data: { venueId, role: 'ADMIN', permissions: [], deniedPermissions: SIN_COBRAR, modifiedBy: dueno.staffId },
  })
  shiftId = (await prisma.shift.create({ data: { venueId, staffId: dueno.staffId, startTime: new Date() } })).id
})

afterAll(async () => {
  // 🔴 Sin fixture no se limpia NADA: un filtro con venueId undefined borraría tablas enteras.
  if (!venueId || !orgId) return
  const ventas = { order: { venueId } }
  await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
  await prisma.stampReward.deleteMany({ where: { venueId } })
  await prisma.stampEvent.deleteMany({ where: { venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await prisma.customerOrderMetric.deleteMany({ where: { venueId } })
  await prisma.paymentEffect.deleteMany({ where: { venueId } })
  await prisma.venueTransaction.deleteMany({ where: { venueId } })
  await prisma.paymentAllocation.deleteMany({ where: ventas })
  await prisma.payment.deleteMany({ where: { venueId, type: 'REFUND' } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } }) // OrderCustomer cae en cascada
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.shift.deleteMany({ where: { venueId } })
  await prisma.venueRolePermission.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { email: { startsWith: `itest-pagoman-${sello}-` } } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

function peticion(quien: { staffId: string }, role: string, body: Record<string, unknown>) {
  return {
    params: { venueId: venueId! },
    body,
    headers: {},
    query: {},
    method: 'POST',
    originalUrl: `/api/v1/dashboard/venues/${venueId}/payments/manual`,
    authContext: { userId: quien.staffId, venueId: venueId!, orgId: orgId!, role },
  } as unknown as Request
}

/** El pago manual del panel de verdad: el controller resuelve `payments:create` contra el StaffVenue real de quien registra. */
async function pagoManual(quien: { staffId: string }, role: string, body: Record<string, unknown>) {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  const next = jest.fn()
  await panel.createManualPayment(peticion(quien, role, body), r as Response, next as unknown as NextFunction)
  const error = next.mock.calls[0]?.[0] as { statusCode?: number; code?: string; message?: string } | undefined
  if (error) return { status: error.statusCode, code: error.code, mensaje: error.message }
  return { status: r.status.mock.calls[0]?.[0], cuerpo: r.json.mock.calls[0]?.[0] }
}

/** Venta de $100 sin cliente, cobrada por el dueño (PAID) y con $20 reembolsados desde el panel: el saldo vuelve a ser $20. */
async function ventaCobradaConReembolso(): Promise<string> {
  const orderId = (
    await prisma.order.create({
      data: {
        venueId: venueId!,
        orderNumber: `ORD-PAGOMAN-${sello}-${++n}`,
        subtotal: 100,
        taxAmount: 0,
        total: 100,
        status: 'PENDING',
        paymentStatus: 'PENDING',
      },
    })
  ).id
  const cobro = await pagoManual(dueno, 'OWNER', { orderId, amount: '100.00', tipAmount: '0', method: 'CASH', source: 'POS' })
  expect(cobro.status).toBe(201)
  await issueRefund({
    venueId: venueId!,
    paymentId: cobro.cuerpo.data.id,
    amount: 2000,
    reason: 'CUSTOMER_REQUEST' as never,
    staffId: dueno.staffId,
  })
  const venta = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { paymentStatus: true } })
  expect(venta.paymentStatus).toBe('PAID') // el reembolso del panel no cambia el estado de cobro
  return orderId
}

async function cliente(nombre: string): Promise<string> {
  return (
    await prisma.customer.create({ data: { venueId: venueId!, firstName: nombre, phone: `+52557720${String(++n).padStart(4, '0')}` } })
  ).id
}

/** Todo lo que un pago manual con cliente puede escribir, para comparar antes/después. */
async function foto(orderId: string, customerId: string) {
  const [pagos, ligas, sellos, movimientos, venta, turno, transacciones, asignaciones, persona] = await Promise.all([
    prisma.payment.count({ where: { venueId, orderId } }),
    prisma.orderCustomer.findMany({ where: { orderId }, select: { customerId: true, isPrimary: true }, take: 10 }),
    prisma.stampEvent.count({ where: { venueId } }),
    prisma.loyaltyTransaction.count({ where: { customer: { venueId } } }),
    prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { paymentStatus: true, status: true, paidAmount: true, remainingBalance: true, customerId: true },
    }),
    prisma.shift.findUniqueOrThrow({ where: { id: shiftId }, select: { totalSales: true, totalOrders: true, totalTips: true } }),
    prisma.venueTransaction.count({ where: { venueId } }),
    prisma.paymentAllocation.count({ where: { orderId } }),
    prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { loyaltyPoints: true, totalVisits: true, totalSpent: true } }),
  ])
  return JSON.parse(JSON.stringify({ pagos, ligas, sellos, movimientos, venta, turno, transacciones, asignaciones, persona }))
}

const pagoDe20 = (orderId: string, customerId: string) => ({
  orderId,
  customerId,
  amount: '20.00',
  tipAmount: '0',
  method: 'CASH',
  source: 'POS',
})

describe('🔴 R5-1: pago manual + cliente nuevo sobre una venta pagada con reembolso (Codex recheck-9 P2)', () => {
  it('🔴 ADMIN con payment:create-manual y SIN payments:create ⇒ 403 en español y la base queda IGUAL', async () => {
    const orderId = await ventaCobradaConReembolso()
    const nuevo = await cliente('Nuevo')
    // Precondición: es justo el actor de Codex.
    const req = peticion(adminSinCobrar, 'ADMIN', {})
    expect(await tienePermisoEnVenue(req, 'payment:create-manual')).toBe(true)
    expect(await tienePermisoEnVenue(req, 'payments:create')).toBe(false)

    const antes = await foto(orderId, nuevo)
    const r = await pagoManual(adminSinCobrar, 'ADMIN', pagoDe20(orderId, nuevo))
    expect(r).toEqual({ status: 403, code: CODIGO_CLIENTE_DE_VENTA_COBRADA, mensaje: MENSAJE_CLIENTE_DE_VENTA_COBRADA })
    expect(await foto(orderId, nuevo)).toEqual(antes)
    expect(antes.ligas).toEqual([])
  })

  it('el MISMO pago por el dueño (con payments:create) ⇒ como hoy: liga primaria, sello y puntos sobre $100', async () => {
    const orderId = await ventaCobradaConReembolso()
    const nuevo = await cliente('Nuevo')
    const antes = await foto(orderId, nuevo)
    const r = await pagoManual(dueno, 'OWNER', pagoDe20(orderId, nuevo))
    expect(r.status).toBe(201)
    const despues = await foto(orderId, nuevo)
    expect(despues.pagos).toBe(antes.pagos + 1)
    expect(despues.ligas).toEqual([{ customerId: nuevo, isPrimary: true }])
    expect(despues.venta.paymentStatus).toBe('PAID')
    expect(await prisma.stampEvent.count({ where: { venueId, orderId, stampCard: { customerId: nuevo } } })).toBe(1)
    expect(despues.persona.loyaltyPoints).toBe(100)
  })
})
