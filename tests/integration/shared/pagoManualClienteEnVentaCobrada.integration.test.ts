/**
 * 🔴 R7 (ronda 7 post-QA de sellos tardíos; decisión del founder del 16-oct, «como Square»: una venta cobrada queda CERRADA), todo
 * real contra Postgres — el controller del pago manual con el resolvedor de permisos (StaffVenue y `VenueRolePermission` de verdad),
 * la tool MCP `record_manual_payment` (guard y scope reales), el servicio, el reembolso y la corrección de cobros del panel, la liga
 * de la TPV y la lealtad.
 *
 *   R7-1 — el pago manual RECHAZA una venta existente PAID o REFUNDED, para TODOS (también el dueño): 400 `ORDER_ALREADY_PAID` y la
 *          base queda IGUAL. Cierra de raíz los caminos de Codex, que empezaban todos con un pago manual sobre una venta que seguía
 *          PAID:
 *            r9  — venta PAID → reembolso de $20 → pago manual de $20 + cliente nuevo;
 *            r10 — venta PAID → reembolso → abono de $10 SIN cliente (ya no llega a PARTIAL);
 *            r11 — venta PAID → corregir su cobro a $80 en el panel (o cancelarlo) → abono de $10.
 *   R7-2 — «cobrada» vuelve a ser PAID/REFUNDED: una cuenta que NUNCA se saldó (abono de $20 y devolución de $10) recibe un abono
 *          con cliente nuevo como en `8b32aef13` (201, liga primaria), y por la TPV el cliente queda primario.
 *   R6-2 — (se conserva) el pago manual opera en la sucursal de la URL.
 *   R8   — (ronda 8; Codex recheck-12 P2) la cadena exacta de Codex: venta $100 PAID → el panel corrige su cobro a $80 (con y sin
 *          reembolso de $20) → un cobro tardío de la TPV de $10. El recálculo la bajaba a PARTIAL y con eso volvían a pasar el pago
 *          manual con cliente y el cambio de cliente sin `payments:create`. Ahora sigue PAID (R8-1) y los cuatro caminos rechazan.
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
import { updatePayment } from '@/services/dashboard/payment.dashboard.service'
import { addCustomerToOrder } from '@/services/tpv/order.tpv.service'
import { CODIGO_VENTA_YA_COBRADA, MENSAJE_VENTA_YA_COBRADA } from '@/services/dashboard/manualPayment.service'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { updateOrderDetails } from '@/services/mobile/order.mobile.service'

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

/** Venta de $100 sin cliente cobrada por el dueño con un pago manual: PAID. */
async function ventaCobrada(): Promise<{ orderId: string; pagoId: string }> {
  const orderId = await ventaAbierta()
  const cobro = await pagoManual(dueno, 'OWNER', { orderId, amount: '100.00', tipAmount: '0', method: 'CASH', source: 'POS' })
  expect(cobro.status).toBe(201)
  return { orderId, pagoId: cobro.cuerpo.data.id }
}

async function ventaAbierta(): Promise<string> {
  return (
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
}

/** r9/r10: la venta cobrada con $20 reembolsados desde el panel (sigue PAID; el saldo del pago manual se reabría a $20). */
async function ventaCobradaConReembolso(): Promise<string> {
  const { orderId, pagoId } = await ventaCobrada()
  await issueRefund({ venueId: venueId!, paymentId: pagoId, amount: 2000, reason: 'CUSTOMER_REQUEST' as never, staffId: dueno.staffId })
  const venta = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { paymentStatus: true } })
  expect(venta.paymentStatus).toBe('PAID') // el reembolso del panel no cambia el estado de cobro
  return orderId
}

/** r11: la venta cobrada cuyo cobro se corrige en el panel ($80) o se cancela (FAILED). Sigue PAID: el panel no recalcula la venta. */
async function ventaCobradaConCobroCorregido(como: 'corregir' | 'cancelar'): Promise<string> {
  const { orderId, pagoId } = await ventaCobrada()
  await updatePayment(venueId!, pagoId, como === 'corregir' ? { amount: 80 } : { status: 'FAILED' as never })
  const venta = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { paymentStatus: true } })
  expect(venta.paymentStatus).toBe('PAID')
  return orderId
}

/** R7-2: cuenta de $100 que NUNCA se saldó — abono de $20 del dueño y devolución de $10 de ese abono. */
async function cuentaNuncaSaldadaConDevolucion(): Promise<string> {
  const orderId = await ventaAbierta()
  const abono = await pagoManual(dueno, 'OWNER', { orderId, amount: '20.00', tipAmount: '0', method: 'CASH', source: 'POS' })
  expect(abono.status).toBe(201)
  await issueRefund({
    venueId: venueId!,
    paymentId: abono.cuerpo.data.id,
    amount: 1000,
    reason: 'CUSTOMER_REQUEST' as never,
    staffId: dueno.staffId,
  })
  expect(await prisma.payment.count({ where: { orderId, type: 'REFUND', status: 'COMPLETED' } })).toBe(1)
  const venta = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { paymentStatus: true } })
  expect(venta.paymentStatus).toBe('PARTIAL')
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

const pagoDe20 = (orderId: string, customerId?: string) => ({
  orderId,
  ...(customerId ? { customerId } : {}),
  amount: '20.00',
  tipAmount: '0',
  method: 'CASH',
  source: 'POS',
})
const pagoDe10 = (orderId: string, customerId?: string) => ({ ...pagoDe20(orderId, customerId), amount: '10.00' })

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
  const r = await herramientas.get('record_manual_payment')!({ idempotencyKey: `r7-mcp-${sello}-${++n}`, confirm: true, ...args }, {})
  return JSON.parse(r.content[0].text)
}

const RECHAZO_HTTP = { status: 400, code: CODIGO_VENTA_YA_COBRADA, mensaje: MENSAJE_VENTA_YA_COBRADA }
const RECHAZO_MCP = { ok: false, error: MENSAJE_VENTA_YA_COBRADA }

describe('precondiciones: los actores son los de Codex', () => {
  it('el ADMIN registra pagos manuales y NO puede cobrar, por HTTP y por el MCP; el dueño puede todo', async () => {
    const req = peticion(adminSinCobrar, 'ADMIN', {})
    expect(await tienePermisoEnVenue(req, 'payment:create-manual')).toBe(true)
    expect(await tienePermisoEnVenue(req, 'payments:create')).toBe(false)
    const guard = createGuard(await scopeDe(adminSinCobrar))
    expect(guard.tienePermiso('payment:create-manual', venueId!)).toBe(true)
    expect(guard.tienePermiso('payments:create', venueId!)).toBe(false)
    const delDueno = createGuard(await scopeDe(dueno))
    expect(delDueno.tienePermiso('payments:create', venueId!)).toBe(true)
  })
})

describe('🔴 R7-1: el pago manual rechaza una venta ya cobrada — HTTP', () => {
  it('🔴 r9: PAID → reembolso $20 → $20 + cliente nuevo (ADMIN sin cobrar) ⇒ 400 y la base queda IGUAL', async () => {
    const orderId = await ventaCobradaConReembolso()
    const nuevo = await cliente('Nuevo')
    const antes = await foto(orderId, nuevo)
    expect(await pagoManual(adminSinCobrar, 'ADMIN', pagoDe20(orderId, nuevo))).toEqual(RECHAZO_HTTP)
    expect(await foto(orderId, nuevo)).toEqual(antes)
    expect(antes.ligas).toEqual([])
  })

  it('🔴 r10: PAID → reembolso → $10 SIN cliente ⇒ 400 (ya no llega a PARTIAL) y la base queda IGUAL', async () => {
    const orderId = await ventaCobradaConReembolso()
    const testigo = await cliente('Testigo')
    const antes = await foto(orderId, testigo)
    expect(await pagoManual(adminSinCobrar, 'ADMIN', pagoDe10(orderId))).toEqual(RECHAZO_HTTP)
    expect(await foto(orderId, testigo)).toEqual(antes)
    expect(antes.venta.paymentStatus).toBe('PAID')
  })

  it.each(['corregir', 'cancelar'] as const)(
    '🔴 r11: PAID → %s el cobro en el panel → $10 (sin y con cliente) ⇒ 400 y la base queda IGUAL',
    async como => {
      const orderId = await ventaCobradaConCobroCorregido(como)
      const nuevo = await cliente('Nuevo')
      const antes = await foto(orderId, nuevo)
      expect(await pagoManual(adminSinCobrar, 'ADMIN', pagoDe10(orderId))).toEqual(RECHAZO_HTTP)
      expect(await pagoManual(adminSinCobrar, 'ADMIN', pagoDe10(orderId, nuevo))).toEqual(RECHAZO_HTTP)
      expect(await foto(orderId, nuevo)).toEqual(antes)
    },
  )

  it('🔴 f: el DUEÑO (todos los permisos) sobre una venta PAID ⇒ también 400, con y sin cliente', async () => {
    const orderId = await ventaCobradaConReembolso()
    const nuevo = await cliente('Nuevo')
    const antes = await foto(orderId, nuevo)
    expect(await pagoManual(dueno, 'OWNER', pagoDe20(orderId, nuevo))).toEqual(RECHAZO_HTTP)
    expect(await pagoManual(dueno, 'OWNER', pagoDe20(orderId))).toEqual(RECHAZO_HTTP)
    expect(await foto(orderId, nuevo)).toEqual(antes)
  })

  it('regresión: el reintento con la MISMA llave del pago que saldó la venta devuelve ese pago (no es un cobro nuevo)', async () => {
    const orderId = await ventaAbierta()
    const cuerpo = { orderId, amount: '100.00', tipAmount: '0', method: 'CASH', source: 'POS', idempotencyKey: `r7-llave-${sello}` }
    const primero = await pagoManual(dueno, 'OWNER', cuerpo)
    expect(primero.status).toBe(201)
    const repetido = await pagoManual(dueno, 'OWNER', cuerpo)
    expect(repetido.status).toBe(201)
    expect(repetido.cuerpo.data.id).toBe(primero.cuerpo.data.id)
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1)
  })
})

describe('🔴 R7-1: el pago manual rechaza una venta ya cobrada — MCP (record_manual_payment)', () => {
  it('🔴 r9: $20 + cliente nuevo por el ADMIN sin cobrar ⇒ ok:false con el mensaje y la base queda IGUAL', async () => {
    const orderId = await ventaCobradaConReembolso()
    const nuevo = await cliente('Nuevo')
    const antes = await foto(orderId, nuevo)
    const salida = await pagoManualPorMcp(adminSinCobrar, { venueId: venueId!, orderId, customerId: nuevo, amount: 20, method: 'cash' })
    expect(salida).toEqual(RECHAZO_MCP)
    expect(await foto(orderId, nuevo)).toEqual(antes)
  })

  it('🔴 r10: $10 SIN cliente ⇒ ok:false y la base queda IGUAL', async () => {
    const orderId = await ventaCobradaConReembolso()
    const testigo = await cliente('Testigo')
    const antes = await foto(orderId, testigo)
    expect(await pagoManualPorMcp(adminSinCobrar, { venueId: venueId!, orderId, amount: 10, method: 'cash' })).toEqual(RECHAZO_MCP)
    expect(await foto(orderId, testigo)).toEqual(antes)
  })

  it('🔴 r11: cobro cancelado en el panel → $10 ⇒ ok:false y la base queda IGUAL', async () => {
    const orderId = await ventaCobradaConCobroCorregido('cancelar')
    const testigo = await cliente('Testigo')
    const antes = await foto(orderId, testigo)
    expect(await pagoManualPorMcp(adminSinCobrar, { venueId: venueId!, orderId, amount: 10, method: 'cash' })).toEqual(RECHAZO_MCP)
    expect(await foto(orderId, testigo)).toEqual(antes)
  })

  it('🔴 f: el DUEÑO por el MCP sobre una venta PAID ⇒ también ok:false', async () => {
    const orderId = await ventaCobradaConReembolso()
    const nuevo = await cliente('Nuevo')
    const antes = await foto(orderId, nuevo)
    const salida = await pagoManualPorMcp(dueno, { venueId: venueId!, orderId, customerId: nuevo, amount: 20, method: 'cash' })
    expect(salida).toEqual(RECHAZO_MCP)
    expect(await foto(orderId, nuevo)).toEqual(antes)
  })
})

describe('🔴 R7-2: una cuenta que NUNCA se saldó (abono $20, devolución $10) sigue abierta, como en 8b32aef13', () => {
  it('🔴 d HTTP: abono con cliente nuevo por el ADMIN sin payments:create ⇒ 201 y liga PRIMARIA', async () => {
    const orderId = await cuentaNuncaSaldadaConDevolucion()
    const nuevo = await cliente('Nuevo')
    const r = await pagoManual(adminSinCobrar, 'ADMIN', pagoDe20(orderId, nuevo))
    expect(r.status).toBe(201)
    expect((await foto(orderId, nuevo)).ligas).toEqual([{ customerId: nuevo, isPrimary: true }])
  })

  it('🔴 d MCP: el mismo abono por el MCP ⇒ ok:true y liga PRIMARIA', async () => {
    const orderId = await cuentaNuncaSaldadaConDevolucion()
    const nuevo = await cliente('Nuevo')
    const salida = await pagoManualPorMcp(adminSinCobrar, { venueId: venueId!, orderId, customerId: nuevo, amount: 20, method: 'cash' })
    expect(salida).toMatchObject({ ok: true, payment: { orderId } })
    expect((await foto(orderId, nuevo)).ligas).toEqual([{ customerId: nuevo, isPrimary: true }])
  })

  it('🔴 d TPV: «agregar cliente» sin payments:create ⇒ el cliente queda PRIMARIO (como antes de la ronda 6)', async () => {
    const orderId = await cuentaNuncaSaldadaConDevolucion()
    const nuevo = await cliente('Nuevo')
    const r = await addCustomerToOrder(venueId!, orderId, nuevo, adminSinCobrar.staffId, { otorgarLealtad: false })
    expect(r.loyalty).toBeNull()
    expect((await foto(orderId, nuevo)).ligas).toEqual([{ customerId: nuevo, isPrimary: true }])
  })

  it('d panel: COCINA le pone cliente con el PUT ⇒ 200 y fija el cliente', async () => {
    const orderId = await cuentaNuncaSaldadaConDevolucion()
    const nuevo = await cliente('Nuevo')
    expect((await editarPorPanel(cocina, 'KITCHEN', orderId, { customerId: nuevo })).status).toBe(200)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { customerId: true } })).toEqual({ customerId: nuevo })
  })
})

describe('e: ventas abiertas normales ⇒ como hoy', () => {
  it('abono de $10 + cliente nuevo por el ADMIN sin payments:create ⇒ 201, PARTIAL, liga primaria', async () => {
    const orderId = await ventaAbierta()
    const nuevo = await cliente('Nuevo')
    const r = await pagoManual(adminSinCobrar, 'ADMIN', pagoDe10(orderId, nuevo))
    expect(r.status).toBe(201)
    const despues = await foto(orderId, nuevo)
    expect(despues.venta.paymentStatus).toBe('PARTIAL')
    expect(despues.ligas).toEqual([{ customerId: nuevo, isPrimary: true }])
  })

  it('el saldo exacto con cliente por el dueño ⇒ PAID, liga primaria, sello y puntos sobre $100', async () => {
    const orderId = await ventaAbierta()
    const nuevo = await cliente('Nuevo')
    const r = await pagoManual(dueno, 'OWNER', { ...pagoDe20(orderId, nuevo), amount: '100.00' })
    expect(r.status).toBe(201)
    const despues = await foto(orderId, nuevo)
    expect(despues.venta.paymentStatus).toBe('PAID')
    expect(despues.ligas).toEqual([{ customerId: nuevo, isPrimary: true }])
    expect(await prisma.stampEvent.count({ where: { venueId, orderId, stampCard: { customerId: nuevo } } })).toBe(1)
    expect(despues.persona.loyaltyPoints).toBe(100)
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
    const orderId = await ventaAbierta()
    const nuevo = await cliente('Nuevo')
    // Precondición: el actor de Codex — en B tiene los dos permisos; en A le quitaron «cobrar».
    const enB = peticion(adminSinCobrar, 'ADMIN', {}, { url: venueB!, token: venueId! })
    expect(await tienePermisoEnVenue(enB, 'payment:create-manual')).toBe(true)
    expect(await tienePermisoEnVenue(enB, 'payments:create')).toBe(true)

    const antes = { a: await foto(orderId, nuevo), b: await fotoDeB() }
    const conCliente = await pagoManual(adminSinCobrar, 'ADMIN', pagoDe20(orderId, nuevo), { url: venueB!, token: venueId! })
    // El servicio opera en B: el cliente de A no es de B ⇒ 400, antes de abrir la transacción.
    expect(conCliente).toMatchObject({ status: 400, mensaje: 'El cliente seleccionado no pertenece a este venue' })
    const sinCliente = await pagoManual(adminSinCobrar, 'ADMIN', pagoDe20(orderId), { url: venueB!, token: venueId! })
    // Sin cliente: la venta de A no existe en B ⇒ 404 y la transacción entera se revierte (también el turno de B).
    expect(sinCliente).toMatchObject({ status: 404, mensaje: 'Orden no encontrada' })
    expect({ a: await foto(orderId, nuevo), b: await fotoDeB() }).toEqual(antes)
  })

  it('regresión: sesión y URL de A sobre una venta cobrada ⇒ el 400 de R7-1', async () => {
    const orderId = await ventaCobradaConReembolso()
    const nuevo = await cliente('Nuevo')
    expect(await pagoManual(adminSinCobrar, 'ADMIN', pagoDe20(orderId, nuevo), { url: venueId!, token: venueId! })).toEqual(RECHAZO_HTTP)
  })
})

/** El cobro de la TERMINAL de verdad (`recordOrderPayment`), en efectivo y como lo manda la TPV: el importe en centavos. */
async function cobroDeLaTerminal(orderId: string, pesos: number) {
  return recordOrderPayment(
    venueId!,
    orderId,
    {
      venueId: venueId!,
      amount: pesos * 100,
      tip: 0,
      status: 'COMPLETED',
      method: 'CASH',
      source: 'TPV',
      splitType: 'FULLPAYMENT',
      tpvId: `tpv-${sello}`,
      staffId: dueno.staffId,
      paidProductsId: [],
      idempotencyKey: `r8-tpv-${sello}-${++n}`,
      currency: 'MXN',
      isInternational: false,
    } as never,
    dueno.staffId,
  )
}

/** `record_manual_payment` SIN `confirm`: la vista previa (R8-3b). */
async function vistaPreviaPorMcp(quien: { staffId: string }, args: Record<string, unknown>) {
  const herramientas = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
  registerPaymentTools(
    { tool: (...a: unknown[]) => herramientas.set(a[0] as string, a[a.length - 1] as never) } as never,
    await scopeDe(quien),
  )
  const r = await herramientas.get('record_manual_payment')!({ idempotencyKey: `r8-vista-${sello}-${++n}`, ...args }, {})
  return JSON.parse(r.content[0].text)
}

/** Lo que la venta dice de su cierre (estado, fecha, lealtad) y sus vales de inventario. */
async function cierreDe(orderId: string) {
  const [venta, vales] = await Promise.all([
    prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { paymentStatus: true, status: true, completedAt: true, loyaltyEligibleAt: true, paidAmount: true, remainingBalance: true },
    }),
    prisma.inventoryPosting.count({ where: { venueId, orderId } }),
  ])
  return JSON.parse(JSON.stringify({ ...venta, vales }))
}

describe('🔴 R8: la cadena exacta de Codex r12 — un cobro tardío de la TPV no reabre la venta cerrada', () => {
  // El recálculo :1831 (cuentas con vales por área sin sesión) se prueba en `payment.refund-balance.test.ts`: armarlo aquí pide toda
  // la cadena de vales. Una integrada de SoftRestaurant no llega a ninguno de los dos: la TPV le manda el cobro a SoftRestaurant.
  it.each([
    ['sin reembolso', false],
    ['con reembolso de $20', true],
  ])(
    '🔴 %s: PAID → corregir a $80 → TPV $10 ⇒ sigue PAID, y el pago manual (HTTP y MCP), el PUT de COCINA y el detalle del POS rechazan sin escribir',
    async (_caso, conReembolso) => {
      const { orderId, pagoId } = await ventaCobrada()
      if (conReembolso) {
        await issueRefund({
          venueId: venueId!,
          paymentId: pagoId,
          amount: 2000,
          reason: 'CUSTOMER_REQUEST' as never,
          staffId: dueno.staffId,
        })
      }
      await updatePayment(venueId!, pagoId, { amount: 80 })
      const cerrada = await cierreDe(orderId)
      expect(cerrada.paymentStatus).toBe('PAID')

      await cobroDeLaTerminal(orderId, 10)

      // R8-1: el dinero se registra (2 cobros, $90 pagados) y la venta sigue CERRADA: PAID, saldo 0, sin otro cierre, lealtad ni vale.
      expect(await prisma.payment.count({ where: { orderId, status: 'COMPLETED', type: { not: 'REFUND' } } })).toBe(2)
      expect(await cierreDe(orderId)).toEqual({ ...cerrada, paidAmount: '90', remainingBalance: '0' })

      const nuevo = await cliente('Nuevo')
      const antes = await foto(orderId, nuevo)
      expect(await pagoManual(adminSinCobrar, 'ADMIN', pagoDe10(orderId, nuevo))).toEqual(RECHAZO_HTTP)
      const porMcp = { venueId: venueId!, orderId, customerId: nuevo, amount: 10, method: 'cash' }
      expect(await pagoManualPorMcp(adminSinCobrar, porMcp)).toEqual(RECHAZO_MCP)
      expect(await vistaPreviaPorMcp(adminSinCobrar, porMcp)).toEqual(RECHAZO_MCP) // R8-3b: ni siquiera ofrece confirmar
      expect(await editarPorPanel(cocina, 'KITCHEN', orderId, { customerId: nuevo })).toMatchObject({ status: 403 })
      await expect(
        updateOrderDetails(venueId!, orderId, { customerId: nuevo }, { puedeCambiarClienteEnVentaCobrada: false }),
      ).rejects.toMatchObject({
        statusCode: 400,
      })
      expect(await foto(orderId, nuevo)).toEqual(antes)
      expect(antes.ligas).toEqual([])
    },
  )

  it('🔴 aunque el panel le regrese el estado operativo a PENDING, el detalle del POS sin payments:create da 403: la venta sigue PAID', async () => {
    const { orderId, pagoId } = await ventaCobrada()
    await updatePayment(venueId!, pagoId, { amount: 80 })
    await cobroDeLaTerminal(orderId, 10)
    expect((await editarPorPanel(dueno, 'OWNER', orderId, { status: 'PENDING' })).status).toBe(200)
    const nuevo = await cliente('Nuevo')
    const antes = await foto(orderId, nuevo)
    expect(antes.venta).toMatchObject({ status: 'PENDING', paymentStatus: 'PAID' })
    await expect(
      updateOrderDetails(venueId!, orderId, { customerId: nuevo }, { puedeCambiarClienteEnVentaCobrada: false }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'CUSTOMER_CHANGE_REQUIRES_PAYMENTS_CREATE',
    })
    expect(await foto(orderId, nuevo)).toEqual(antes)
  })

  it('regresión: una venta PENDING que recibe $10 de la TPV ⇒ PARTIAL con $90 por cobrar', async () => {
    const orderId = await ventaAbierta()
    await cobroDeLaTerminal(orderId, 10)
    expect(await cierreDe(orderId)).toMatchObject({
      paymentStatus: 'PARTIAL',
      paidAmount: '10',
      remainingBalance: '90',
      loyaltyEligibleAt: null,
    })
  })

  it('regresión: el cobro completo de la TPV ⇒ PAID y COMPLETED, con su lealtad pendiente y su vale', async () => {
    const orderId = await ventaAbierta()
    await cobroDeLaTerminal(orderId, 100)
    const venta = await cierreDe(orderId)
    expect(venta).toMatchObject({ paymentStatus: 'PAID', status: 'COMPLETED', remainingBalance: '0', vales: 1 })
    expect(venta.loyaltyEligibleAt).not.toBeNull()
    expect(venta.completedAt).not.toBeNull()
  })
})
