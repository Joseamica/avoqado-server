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
 *
 * 🔴 Ronda 6 (Codex recheck-10, dos P2):
 *   R6-1 — partir el pago: tras el reembolso, un abono de $10 SIN cliente deja la venta PARTIAL y el abono siguiente de $10 + cliente
 *          nuevo pasaba (sólo se miraba PAID/REFUNDED). Por HTTP y por MCP ⇒ 403 / `ok:false` y nada escrito. Y el PUT del panel
 *          sobre esa venta PARTIAL-que-ya-se-cobró, por COCINA ⇒ 403.
 *   R6-2 — el pago manual por HTTP usaba la sucursal del TOKEN para escribir y la de la URL para los permisos: sesión de A, URL de B
 *          (donde el mismo actor sí puede cobrar), venta y cliente de A ⇒ se aceptaba. Ahora una sola sucursal, la de la URL.
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
// La bitácora del MCP no es lo que se prueba aquí (la escritura que importa es la del servicio).
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))

import type { NextFunction, Request, Response } from 'express'
import * as panel from '@/controllers/dashboard/manualPayment.controller'
import * as panelDeVentas from '@/controllers/dashboard/order.dashboard.controller'
import { registerPaymentTools } from '@/mcp/tools/payments'
import { resolveScope } from '@/mcp/scope'
import { createGuard } from '@/mcp/guard'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { tienePermisoEnVenue } from '@/middlewares/permissionFlag.middleware'
import { CODIGO_CLIENTE_DE_VENTA_COBRADA, MENSAJE_CLIENTE_DE_VENTA_COBRADA } from '@/services/shared/ligaDeClienteEnVenta'

const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
/**
 * Quitarle `payments:create` a un rol desde el editor de roles: también lo que lo IMPLICA, o vuelve.
 * R6: + `area-tickets:cancel` y `area-tickets:configure`. Con sólo los cuatro de la ronda 5, el resolvedor de `checkPermission`
 * dice «no» pero el del MCP (`getUserAccess`, que resuelve las dependencias dos veces) dice «sí»: `area-tickets:cancel` →
 * `area-tickets:checkout` → `payments:create`. Con estos dos más, los DOS resolvedores contestan lo mismo (precondición abajo).
 */
const SIN_COBRAR = [
  'payments:create',
  'area-tickets:checkout',
  'tpv:create',
  'tpv-payments:pay-later',
  'area-tickets:cancel',
  'area-tickets:configure',
]
let orgId: string | undefined
let venueId: string | undefined
let shiftId: string
let n = 0
let dueno: { staffId: string }
let adminSinCobrar: { staffId: string }
let cocina: { staffId: string }
/** R6-2: otra sucursal de la MISMA organización donde el mismo ADMIN sí puede cobrar (sin personalizar). */
let venueB: string | undefined
let shiftB: string

async function empleado(nombre: string, role: 'OWNER' | 'ADMIN' | 'KITCHEN') {
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
  cocina = await empleado('Cocina', 'KITCHEN')
  venueB = (
    await prisma.venue.create({
      data: { name: `itest-pagoman-b-${sello}`, slug: `itest-pagoman-b-${sello}`, organizationId: orgId, timezone: 'America/Mexico_City' },
    })
  ).id
  await prisma.staffVenue.create({ data: { staffId: adminSinCobrar.staffId, venueId: venueB, role: 'ADMIN' } })
  shiftB = (await prisma.shift.create({ data: { venueId: venueB, staffId: adminSinCobrar.staffId, startTime: new Date() } })).id
})

afterAll(async () => {
  // 🔴 Sin fixture no se limpia NADA: un filtro con venueId undefined borraría tablas enteras.
  if (!venueId || !orgId) return
  if (venueB) {
    const deB = { venueId: venueB }
    await prisma.venueTransaction.deleteMany({ where: deB })
    await prisma.paymentAllocation.deleteMany({ where: { order: deB } })
    await prisma.payment.deleteMany({ where: deB })
    await prisma.order.deleteMany({ where: deB })
    await prisma.shift.deleteMany({ where: deB })
    await prisma.staffVenue.deleteMany({ where: deB })
    await prisma.venue.deleteMany({ where: { id: venueB } })
  }
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

/** `sucursales.url` = la de la ruta (`/venues/:venueId/…`); `sucursales.token` = la de la sesión. Por defecto, las dos son A. */
function peticion(
  quien: { staffId: string },
  role: string,
  body: Record<string, unknown>,
  sucursales: { url?: string; token?: string } = {},
) {
  const url = sucursales.url ?? venueId!
  return {
    params: { venueId: url },
    body,
    headers: {},
    query: {},
    method: 'POST',
    originalUrl: `/api/v1/dashboard/venues/${url}/payments/manual`,
    authContext: { userId: quien.staffId, venueId: sucursales.token ?? venueId!, orgId: orgId!, role },
  } as unknown as Request
}

/** El pago manual del panel de verdad: el controller resuelve `payments:create` contra el StaffVenue real de quien registra. */
async function pagoManual(
  quien: { staffId: string },
  role: string,
  body: Record<string, unknown>,
  sucursales: { url?: string; token?: string } = {},
) {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  const next = jest.fn()
  await panel.createManualPayment(peticion(quien, role, body, sucursales), r as Response, next as unknown as NextFunction)
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

/** La venta del escenario de Codex en recheck-10: cobrada, reembolso de $20 y un abono de $10 SIN cliente ⇒ PARTIAL. */
async function ventaCobradaReembolsadaYAbonada(): Promise<string> {
  const orderId = await ventaCobradaConReembolso()
  const abono = await pagoManual(adminSinCobrar, 'ADMIN', { orderId, amount: '10.00', tipAmount: '0', method: 'CASH', source: 'POS' })
  expect(abono.status).toBe(201)
  const venta = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { paymentStatus: true } })
  expect(venta.paymentStatus).toBe('PARTIAL') // el abono sin cliente la dejó PARTIAL: el estado ya no dice «cobrada»
  return orderId
}

const pagoDe10 = (orderId: string, customerId: string) => ({ ...pagoDe20(orderId, customerId), amount: '10.00' })

/** El scope REAL del actor en el MCP (StaffVenue y personalizaciones de la base), con permiso de escritura. */
async function scopeDe(quien: { staffId: string }) {
  return { ...(await resolveScope(quien.staffId, orgId!)), scopes: ['mcp:read', 'mcp:write'] }
}

/** `record_manual_payment` de verdad (guard, servicio y base reales), confirmado. */
async function pagoManualPorMcp(quien: { staffId: string }, args: Record<string, unknown>) {
  const herramientas = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
  registerPaymentTools(
    { tool: (...a: unknown[]) => herramientas.set(a[0] as string, a[a.length - 1] as never) } as never,
    await scopeDe(quien),
  )
  const r = await herramientas.get('record_manual_payment')!({ idempotencyKey: `r6-mcp-${sello}-${++n}`, confirm: true, ...args }, {})
  return JSON.parse(r.content[0].text)
}

describe('🔴 R6-1: partir el pago no esquiva la regla (Codex recheck-10 P2)', () => {
  it('🔴 HTTP: $10 sin cliente (PARTIAL) y luego $10 + cliente nuevo, por el ADMIN sin payments:create ⇒ 403 y la base queda IGUAL', async () => {
    const orderId = await ventaCobradaReembolsadaYAbonada()
    const nuevo = await cliente('Nuevo')
    const antes = await foto(orderId, nuevo)
    const r = await pagoManual(adminSinCobrar, 'ADMIN', pagoDe10(orderId, nuevo))
    expect(r).toEqual({ status: 403, code: CODIGO_CLIENTE_DE_VENTA_COBRADA, mensaje: MENSAJE_CLIENTE_DE_VENTA_COBRADA })
    expect(await foto(orderId, nuevo)).toEqual(antes)
    expect(antes.venta.paymentStatus).toBe('PARTIAL')
    expect(antes.ligas).toEqual([])
  })

  it('🔴 MCP (record_manual_payment): la misma secuencia ⇒ ok:false con el mensaje y la base queda IGUAL', async () => {
    const orderId = await ventaCobradaReembolsadaYAbonada()
    const nuevo = await cliente('Nuevo')
    // Precondición: el mismo actor, visto por el guard del MCP — registra pagos manuales y NO puede cobrar.
    const guard = createGuard(await scopeDe(adminSinCobrar))
    expect(guard.tienePermiso('payment:create-manual', venueId!)).toBe(true)
    expect(guard.tienePermiso('payments:create', venueId!)).toBe(false)
    const antes = await foto(orderId, nuevo)
    const salida = await pagoManualPorMcp(adminSinCobrar, { venueId: venueId!, orderId, customerId: nuevo, amount: 10, method: 'cash' })
    expect(salida).toEqual({ ok: false, error: MENSAJE_CLIENTE_DE_VENTA_COBRADA })
    expect(await foto(orderId, nuevo)).toEqual(antes)
  })

  it('regresión: el MCP del ADMIN sin payments:create sí registra el abono SIN cliente (no es cambio de cliente)', async () => {
    const orderId = await ventaCobradaConReembolso()
    const salida = await pagoManualPorMcp(adminSinCobrar, { venueId: venueId!, orderId, amount: 10, method: 'cash' })
    expect(salida).toMatchObject({ ok: true, payment: { orderId } })
  })

  it('con payments:create (el dueño) ⇒ como hoy: el abono con cliente liga al primario y salda la venta', async () => {
    const orderId = await ventaCobradaReembolsadaYAbonada()
    const nuevo = await cliente('Nuevo')
    const r = await pagoManual(dueno, 'OWNER', pagoDe10(orderId, nuevo))
    expect(r.status).toBe(201)
    const despues = await foto(orderId, nuevo)
    expect(despues.ligas).toEqual([{ customerId: nuevo, isPrimary: true }])
    expect(despues.venta.paymentStatus).toBe('PAID')
  })

  it('regresión: una venta que NUNCA se cobró (abono normal de $10 sin reembolso) + cliente nuevo, sin el permiso ⇒ como hoy', async () => {
    const orderId = (
      await prisma.order.create({
        data: { venueId: venueId!, orderNumber: `ORD-PAGOMAN-${sello}-${++n}`, subtotal: 100, taxAmount: 0, total: 100, status: 'PENDING' },
      })
    ).id
    const nuevo = await cliente('Nuevo')
    const r = await pagoManual(adminSinCobrar, 'ADMIN', pagoDe10(orderId, nuevo))
    expect(r.status).toBe(201)
    const despues = await foto(orderId, nuevo)
    expect(despues.venta.paymentStatus).toBe('PARTIAL')
    expect(despues.ligas).toEqual([{ customerId: nuevo, isPrimary: true }])
  })
})

/** El PUT del panel de verdad (`orders:update`, que COCINA trae por default). */
async function editarPorPanel(quien: { staffId: string }, role: string, orderId: string, body: Record<string, unknown>) {
  const req = {
    params: { venueId: venueId!, orderId },
    body,
    headers: {},
    query: {},
    method: 'PUT',
    originalUrl: `/api/v1/dashboard/venues/${venueId}/orders/${orderId}`,
    authContext: { userId: quien.staffId, venueId: venueId!, orgId: orgId!, role },
  } as unknown as Request<{ venueId: string; orderId: string }>
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  const next = jest.fn()
  await panelDeVentas.updateOrder(req, r as Response, next as unknown as NextFunction)
  const error = next.mock.calls[0]?.[0] as { statusCode?: number; message?: string } | undefined
  if (error) return { status: error.statusCode, mensaje: error.message }
  return { status: r.status.mock.calls[0]?.[0] ?? 200 }
}

describe('🔴 R6-1: el PUT del panel sobre una venta PARTIAL que YA se cobró', () => {
  it('🔴 COCINA le pone cliente ⇒ 403 y la venta no cambia', async () => {
    const orderId = await ventaCobradaReembolsadaYAbonada()
    const nuevo = await cliente('Nuevo')
    const antes = await foto(orderId, nuevo)
    const r = await editarPorPanel(cocina, 'KITCHEN', orderId, { customerId: nuevo, customerName: 'Nuevo' })
    expect(r).toEqual({ status: 403, mensaje: MENSAJE_CLIENTE_DE_VENTA_COBRADA })
    expect(await foto(orderId, nuevo)).toEqual(antes)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { customerName: true } })).toEqual({ customerName: null })
  })

  it('regresión: COCINA en una cuenta que nunca se cobró (abono normal) ⇒ como hoy, fija el cliente', async () => {
    const orderId = (
      await prisma.order.create({
        data: { venueId: venueId!, orderNumber: `ORD-PAGOMAN-${sello}-${++n}`, subtotal: 100, taxAmount: 0, total: 100, status: 'PENDING' },
      })
    ).id
    expect((await pagoManual(dueno, 'OWNER', { orderId, amount: '10.00', tipAmount: '0', method: 'CASH', source: 'POS' })).status).toBe(201)
    const nuevo = await cliente('Nuevo')
    const r = await editarPorPanel(cocina, 'KITCHEN', orderId, { customerId: nuevo })
    expect(r.status).toBe(200)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { customerId: true } })).toEqual({ customerId: nuevo })
  })
})

describe('🔴 R6-2: una sola sucursal por operación — la de la URL (Codex recheck-10 P2)', () => {
  /** Todo lo de la sucursal B que un pago manual podría tocar. */
  async function fotoDeB() {
    const [pagos, ventas, turno] = await Promise.all([
      prisma.payment.count({ where: { venueId: venueB } }),
      prisma.order.count({ where: { venueId: venueB } }),
      prisma.shift.findUniqueOrThrow({ where: { id: shiftB }, select: { totalSales: true, totalOrders: true } }),
    ])
    return JSON.parse(JSON.stringify({ pagos, ventas, turno }))
  }

  it('🔴 sesión de A, URL de B (donde el actor SÍ puede cobrar), venta y cliente de A ⇒ rechazado y NADA se escribe en A ni en B', async () => {
    const orderId = await ventaCobradaConReembolso()
    const nuevo = await cliente('Nuevo')
    // Precondición: el actor de Codex — en B tiene los dos permisos; en A le quitaron «cobrar».
    const enB = peticion(adminSinCobrar, 'ADMIN', {}, { url: venueB!, token: venueId! })
    expect(await tienePermisoEnVenue(enB, 'payment:create-manual')).toBe(true)
    expect(await tienePermisoEnVenue(enB, 'payments:create')).toBe(true)

    const antes = { a: await foto(orderId, nuevo), b: await fotoDeB() }
    const conCliente = await pagoManual(adminSinCobrar, 'ADMIN', pagoDe20(orderId, nuevo), { url: venueB!, token: venueId! })
    // El servicio opera en B: el cliente de A no es de B ⇒ 400, antes de abrir la transacción.
    expect(conCliente).toMatchObject({ status: 400, mensaje: 'El cliente seleccionado no pertenece a este venue' })
    const sinCliente = await pagoManual(
      adminSinCobrar,
      'ADMIN',
      { ...pagoDe20(orderId, nuevo), customerId: undefined },
      { url: venueB!, token: venueId! },
    )
    // Sin cliente: la venta de A no existe en B ⇒ 404 y la transacción entera se revierte (también el turno de B).
    expect(sinCliente).toMatchObject({ status: 404, mensaje: 'Orden no encontrada' })
    expect({ a: await foto(orderId, nuevo), b: await fotoDeB() }).toEqual(antes)
  })

  it('regresión: sesión y URL de A ⇒ como hoy (el ADMIN sin payments:create recibe el 403 de la decisión «A»)', async () => {
    const orderId = await ventaCobradaConReembolso()
    const nuevo = await cliente('Nuevo')
    const r = await pagoManual(adminSinCobrar, 'ADMIN', pagoDe20(orderId, nuevo), { url: venueId!, token: venueId! })
    expect(r).toEqual({ status: 403, code: CODIGO_CLIENTE_DE_VENTA_COBRADA, mensaje: MENSAJE_CLIENTE_DE_VENTA_COBRADA })
  })
})
