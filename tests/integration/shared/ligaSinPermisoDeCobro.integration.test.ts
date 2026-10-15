/**
 * 🔴 F1 (ronda 1 post-QA de sellos tardíos, P1 de Codex; decisión «A» del founder) + F2.
 *
 * Una venta PAGADA cuya lealtad sigue PENDIENTE (el cobro no la cerró, o falló y el reconciliador la reintenta) también es «ya
 * cobrada». COCINA (sin `payments:create`) liga a un cliente desde la TPV: antes quedaba PRIMARIO y el cobro en curso o el
 * reconciliador le daban sello y puntos. Ahora:
 *   · la liga SIGUE (visible en `data`), pero como ACOMPAÑANTE; la lealtad sólo acredita al primario y una venta sin primario
 *     cuenta como «sin cliente» ⇒ el resultado es el de la venta sin esa liga;
 *   · la decisión se toma bajo el candado canónico de la venta (el del cobro);
 *   · la liga que CREA audita siempre (sin permiso, `lealtad: 'SIN_PERMISO'`); una re-liga audita sólo si otorgó.
 *
 * Todo real contra Postgres: el controller de la TPV con el resolvedor de permisos (StaffVenue KITCHEN/CASHIER de verdad), el
 * servicio, la lealtad del cobro (`awardLoyaltyForPaidOrder`), el reconciliador, el «Agregar cliente» del POS y la bitácora.
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'

// La bitácora es parte de lo que se prueba: aquí va la DE VERDAD, no el doble del setup.
jest.unmock('@/services/dashboard/activity-log.service')

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

import type { NextFunction, Request, Response } from 'express'
import * as tpv from '@/controllers/tpv/order.tpv.controller'
import { attachCustomerToOrder } from '@/services/mobile/order.mobile.service'
import { awardLoyaltyForPaidOrder } from '@/services/shared/loyaltyOnPaidOrder'
import { LoyaltyReconciliationJob } from '@/jobs/loyalty-reconciliation.job'
import { lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import * as bitacora from '@/services/dashboard/activity-log.service'
import { aTiempo, aparcarLaSiguienteTransaccion, esperarBloqueado } from '@tests/__helpers__/candadosDePostgres'

const AUDITORIA = 'CUSTOMER_ATTACHED_TO_PAID_ORDER'
const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
let orgId: string | undefined
let venueId: string | undefined
let n = 0
let cocina: { staffId: string; staffVenueId: string }
let cajero: { staffId: string; staffVenueId: string }
let espiaBitacora: jest.SpyInstance

async function empleado(nombre: string, role: 'KITCHEN' | 'CASHIER') {
  const s = await prisma.staff.create({ data: { email: `itest-sinperm-${sello}-${++n}@test.com`, firstName: nombre, lastName: 'Prueba' } })
  const sv = await prisma.staffVenue.create({ data: { staffId: s.id, venueId: venueId!, role } })
  return { staffId: s.id, staffVenueId: sv.id }
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `ITEST SinPermiso ${sello}`, email: `itest-sinperm-${sello}@test.com`, phone: '5550000000' },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { name: `itest-sinperm-${sello}`, slug: `itest-sinperm-${sello}`, organizationId: orgId, timezone: 'America/Mexico_City' },
    })
  ).id
  await prisma.loyaltyConfig.create({
    data: { venueId, active: true, pointsPerDollar: 1, stampsEnabled: true, stampsRequired: 7, maxStampsPerDay: 0 },
  })
  cocina = await empleado('Cocina', 'KITCHEN')
  cajero = await empleado('Cajero', 'CASHIER')
  espiaBitacora = jest.spyOn(bitacora, 'logAction') // llama al de verdad; sus promesas se esperan antes de contar filas
})

afterAll(async () => {
  espiaBitacora?.mockRestore()
  // 🔴 Sin fixture no se limpia NADA: un filtro con venueId undefined borraría tablas enteras.
  if (!venueId || !orgId) return
  await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
  await prisma.stampReward.deleteMany({ where: { venueId } })
  await prisma.stampEvent.deleteMany({ where: { venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await prisma.customerOrderMetric.deleteMany({ where: { venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } }) // OrderCustomer cae en cascada
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { email: { startsWith: `itest-sinperm-${sello}-` } } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

async function cliente(nombre: string): Promise<string> {
  const i = ++n
  return (await prisma.customer.create({ data: { venueId: venueId!, firstName: nombre, phone: `+52557710${String(i).padStart(4, '0')}` } }))
    .id
}

/** Venta cobrada SIN cliente hace `haceMs`, con su lealtad PENDIENTE (o ya procesada «sin cliente», si se pide). */
async function venta(opciones: { haceMs?: number; procesada?: boolean; abierta?: boolean } = {}): Promise<string> {
  const cuando = new Date(Date.now() - (opciones.haceMs ?? 60_000))
  return (
    await prisma.order.create({
      data: {
        venueId: venueId!,
        orderNumber: `ORD-SINPERM-${sello}-${++n}`,
        subtotal: 20,
        taxAmount: 0,
        total: 20,
        status: opciones.abierta ? 'PENDING' : 'COMPLETED',
        paymentStatus: opciones.abierta ? 'PENDING' : 'PAID',
        loyaltyEligibleAt: opciones.abierta ? null : cuando,
        loyaltyProcessedAt: opciones.procesada ? cuando : null,
      },
    })
  ).id
}

function respuesta() {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r as Response & { status: jest.Mock; json: jest.Mock }
}

/** La TPV de verdad: el controller resuelve `payments:create` contra el StaffVenue real de quien liga. */
async function ligarPorTpv(quien: { staffId: string }, role: string, orderId: string, body: Record<string, unknown>, crear = false) {
  const req = {
    params: { venueId: venueId!, orderId },
    body,
    headers: {},
    query: {},
    method: 'POST',
    originalUrl: `/api/v1/tpv/venues/${venueId}/orders/${orderId}/customers${crear ? '/create' : ''}`,
    authContext: { userId: quien.staffId, venueId: venueId!, orgId: orgId!, role },
  } as unknown as Request<any, any, any>
  const res = respuesta()
  const next = jest.fn()
  await (crear ? tpv.createAndAddCustomerToOrder : tpv.addCustomerToOrder)(req, res, next as unknown as NextFunction)
  if (next.mock.calls.length) throw next.mock.calls[0][0]
  return { status: res.status.mock.calls[0]?.[0], cuerpo: res.json.mock.calls[0]?.[0] }
}

/** El reconciliador REAL, acotado a ESTA venta (otras pruebas comparten la base). */
function reconciliadorDe(orderId: string) {
  const soloEsta = (args: any) => ({ ...args, where: { AND: [args.where, { id: orderId }] } })
  return new LoyaltyReconciliationJob({
    prisma: {
      order: {
        findMany: (args: any) => prisma.order.findMany(soloEsta(args)),
        updateMany: (args: any) => prisma.order.updateMany(soloEsta(args)),
      },
    } as never,
    cron: { start: jest.fn(), stop: jest.fn() },
    now: () => new Date(),
  })
}

/** Lo que la venta le dio a ESE cliente, y su lealtad, después de esperar las escrituras de la bitácora. */
async function loQueRecibio(orderId: string, customerId: string) {
  await Promise.all(espiaBitacora.mock.results.map(r => r.value))
  const [sellos, puntos, visitas, filaCliente, orden, filas] = await Promise.all([
    prisma.stampEvent.count({ where: { venueId, orderId, type: 'EARN', stampCard: { customerId } } }),
    prisma.loyaltyTransaction.count({ where: { orderId, customerId } }),
    prisma.customerOrderMetric.count({ where: { orderId, customerId } }),
    prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { loyaltyPoints: true, totalVisits: true } }),
    prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { loyaltyProcessedAt: true, loyaltyLastError: true } }),
    prisma.activityLog.findMany({
      where: { venueId, action: AUDITORIA, entityId: orderId },
      select: { staffId: true, data: true },
      orderBy: { createdAt: 'asc' },
      take: 10,
    }),
  ])
  return { sellos, puntos, visitas, saldo: filaCliente.loyaltyPoints, totalVisits: filaCliente.totalVisits, orden, filas }
}

const NADA = { sellos: 0, puntos: 0, visitas: 0, saldo: 0, totalVisits: 0 }

describe('🔴 F1: COCINA (sin payments:create) liga a una venta PAGADA con su lealtad PENDIENTE: nunca es beneficiaria', () => {
  it('🔴 (1) liga por la TPV → la lealtad del cobro en curso y el reconciliador ⇒ nada para el cliente; la venta cierra «sin cliente»; UNA fila SIN_PERMISO', async () => {
    const kev = await cliente('Kev')
    const orderId = await venta()
    const { status, cuerpo } = await ligarPorTpv(cocina, 'KITCHEN', orderId, { customerId: kev })
    expect(status).toBe(201)
    expect(cuerpo.loyalty).toBeNull()
    // La liga sigue y se ve, como acompañante.
    expect(cuerpo.data).toEqual([expect.objectContaining({ customerId: kev, isPrimary: false })])

    // El cobro continúa (su lealtad post-commit) y después el reconciliador.
    expect(
      await awardLoyaltyForPaidOrder({ venueId: venueId!, orderId, orderTotal: 20, staffId: cajero.staffId, legacyCustomer: null }),
    ).toMatchObject({ complete: true })
    expect(await reconciliadorDe(orderId).runNow()).toMatchObject({ scanned: 0 })

    const r = await loQueRecibio(orderId, kev)
    expect(r).toMatchObject(NADA)
    expect(r.orden.loyaltyProcessedAt).toBeInstanceOf(Date) // cerrada como «sin cliente»
    expect(r.filas).toEqual([
      {
        staffId: cocina.staffId,
        data: expect.objectContaining({ customerId: kev, ligaNueva: true, lealtad: 'SIN_PERMISO', stamped: false }),
      },
    ])
  })

  it('(1b) el cobro murió antes de su lealtad: sólo el reconciliador ⇒ tampoco recibe nada y la venta queda cerrada', async () => {
    const kev = await cliente('Kev')
    const orderId = await venta()
    await ligarPorTpv(cocina, 'KITCHEN', orderId, { customerId: kev })
    expect(await reconciliadorDe(orderId).runNow()).toMatchObject({ scanned: 1, applied: 1, failed: 0 })
    const r = await loQueRecibio(orderId, kev)
    expect(r).toMatchObject(NADA)
    expect(r.orden.loyaltyProcessedAt).toBeInstanceOf(Date)
  })

  it('🔴 (2) venta pendiente de hace 48 h (sin tope de 24 h en el reconciliador) ⇒ nada para el cliente', async () => {
    const kev = await cliente('Kev')
    const orderId = await venta({ haceMs: 48 * 60 * 60 * 1000 })
    await ligarPorTpv(cocina, 'KITCHEN', orderId, { customerId: kev })
    expect(await reconciliadorDe(orderId).runNow()).toMatchObject({ scanned: 1, applied: 1 })
    const r = await loQueRecibio(orderId, kev)
    expect(r).toMatchObject(NADA)
    expect(r.orden.loyaltyProcessedAt).toBeInstanceOf(Date)
  })

  it('🔴 (3) «crear cliente y agregarlo» de la TPV ⇒ el cliente NUEVO es acompañante y no recibe nada; UNA fila SIN_PERMISO', async () => {
    const orderId = await venta()
    const { status, cuerpo } = await ligarPorTpv(cocina, 'KITCHEN', orderId, { firstName: 'Nueva' }, true)
    expect(status).toBe(201)
    expect(cuerpo.loyalty).toBeNull()
    const nueva = cuerpo.data[0].customerId as string
    expect(cuerpo.data).toEqual([expect.objectContaining({ customerId: nueva, isPrimary: false })])
    await awardLoyaltyForPaidOrder({ venueId: venueId!, orderId, orderTotal: 20, staffId: cajero.staffId, legacyCustomer: null })
    await reconciliadorDe(orderId).runNow()
    const r = await loQueRecibio(orderId, nueva)
    expect(r).toMatchObject(NADA)
    expect(r.filas).toEqual([{ staffId: cocina.staffId, data: expect.objectContaining({ ligaNueva: true, lealtad: 'SIN_PERMISO' }) }])
  })

  it('🔴 (4a) tras (1), el CAJERO re-liga al mismo cliente desde el POS ⇒ se promueve, UN sello con su autor y su fila; la TPV después no duplica', async () => {
    const kev = await cliente('Kev')
    const orderId = await venta()
    await ligarPorTpv(cocina, 'KITCHEN', orderId, { customerId: kev })
    await awardLoyaltyForPaidOrder({ venueId: venueId!, orderId, orderTotal: 20, staffId: cajero.staffId, legacyCustomer: null })

    const pos = await attachCustomerToOrder(venueId!, orderId, kev, cajero.staffId)
    expect(pos.loyalty).toMatchObject({ stamped: true })
    // Y la TPV, con permiso, es éxito idempotente: ni otra liga, ni otro sello, ni otra fila.
    const otra = await ligarPorTpv(cajero, 'CASHIER', orderId, { customerId: kev })
    expect(otra.status).toBe(201)
    expect(otra.cuerpo.loyalty).toMatchObject({ stamped: true })

    const r = await loQueRecibio(orderId, kev)
    expect(r.sellos).toBe(1)
    expect(r.puntos).toBe(1)
    expect(await prisma.stampEvent.findFirstOrThrow({ where: { venueId, orderId, type: 'EARN' }, select: { createdById: true } })).toEqual({
      createdById: cajero.staffVenueId,
    })
    expect(await prisma.orderCustomer.findMany({ where: { orderId }, select: { customerId: true, isPrimary: true }, take: 5 })).toEqual([
      { customerId: kev, isPrimary: true },
    ])
    expect(r.filas).toEqual([
      { staffId: cocina.staffId, data: expect.objectContaining({ ligaNueva: true, lealtad: 'SIN_PERMISO' }) },
      { staffId: cajero.staffId, data: expect.objectContaining({ ligaNueva: true, otorgo: true, stamped: true }) },
    ])
  })

  it('(4b) la re-liga del cajero va por la TPV ⇒ también se promueve: UN sello con su autor y su fila', async () => {
    const kev = await cliente('Kev')
    const orderId = await venta()
    await ligarPorTpv(cocina, 'KITCHEN', orderId, { customerId: kev })
    await reconciliadorDe(orderId).runNow()

    const { status, cuerpo } = await ligarPorTpv(cajero, 'CASHIER', orderId, { customerId: kev })
    expect(status).toBe(201)
    expect(cuerpo.loyalty).toMatchObject({ stamped: true })
    expect(cuerpo.data).toEqual([expect.objectContaining({ customerId: kev, isPrimary: true })])
    const r = await loQueRecibio(orderId, kev)
    expect(r.sellos).toBe(1)
    expect(await prisma.stampEvent.findFirstOrThrow({ where: { venueId, orderId, type: 'EARN' }, select: { createdById: true } })).toEqual({
      createdById: cajero.staffVenueId,
    })
    expect(r.filas.map(f => [f.staffId, (f.data as any).lealtad ?? null, (f.data as any).ligaNueva])).toEqual([
      [cocina.staffId, 'SIN_PERMISO', true],
      [cajero.staffId, null, true],
    ])
  })

  it('(5) cuenta ABIERTA: COCINA liga ⇒ primario (por diseño) y el cobro SÍ le acredita', async () => {
    const ana = await cliente('Ana')
    const orderId = await venta({ abierta: true })
    const { cuerpo } = await ligarPorTpv(cocina, 'KITCHEN', orderId, { customerId: ana })
    expect(cuerpo.data).toEqual([expect.objectContaining({ customerId: ana, isPrimary: true })])
    // Se cobra (lo que hace el cobro: PAID + elegible) y corre su lealtad.
    await prisma.order.update({
      where: { id: orderId },
      data: { status: 'COMPLETED', paymentStatus: 'PAID', loyaltyEligibleAt: new Date() },
    })
    await awardLoyaltyForPaidOrder({ venueId: venueId!, orderId, orderTotal: 20, staffId: cajero.staffId, legacyCustomer: null })
    const r = await loQueRecibio(orderId, ana)
    expect(r.sellos).toBe(1)
    expect(r.puntos).toBe(1)
    expect(r.filas).toEqual([]) // no era una venta cobrada al ligar
  })

  it('(6) venta YA procesada «sin cliente»: sin permiso no reabre (ni marca), y el cliente no recibe nada', async () => {
    const kev = await cliente('Kev')
    const orderId = await venta({ procesada: true })
    const antes = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { loyaltyProcessedAt: true } })
    await ligarPorTpv(cocina, 'KITCHEN', orderId, { customerId: kev })
    await reconciliadorDe(orderId).runNow()
    const r = await loQueRecibio(orderId, kev)
    expect(r).toMatchObject(NADA)
    expect(r.orden).toEqual({ loyaltyProcessedAt: antes.loyaltyProcessedAt, loyaltyLastError: null })
  })

  it('🔴 la decisión se toma bajo el candado de la venta: un cobro EN CURSO (con el candado tomado) la deja esperando; al soltarse la ve PAGADA ⇒ acompañante', async () => {
    const kev = await cliente('Kev')
    const orderId = await venta({ abierta: true })
    const aparcada = aparcarLaSiguienteTransaccion(prisma)
    // Fuera del try: si una aserción truena, se esperan igual (no siguen vivas cuando el afterAll limpia la base).
    let cobro: Promise<unknown> | undefined
    let liga: ReturnType<typeof ligarPorTpv> | undefined
    try {
      // El «cobro»: toma el candado canónico y deja la venta PAGADA, sin commit todavía.
      cobro = prisma.$transaction(async tx => {
        await lockExistingOrderForPayment(tx, { venueId: venueId!, orderId })
        await tx.order.update({
          where: { id: orderId },
          data: { status: 'COMPLETED', paymentStatus: 'PAID', loyaltyEligibleAt: new Date() },
        })
      })
      const pidCobro = await aTiempo(aparcada.pid, 15_000, 'el cobro aparcado con el candado de la venta')
      liga = ligarPorTpv(cocina, 'KITCHEN', orderId, { customerId: kev })
      const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pidCobro], consulta: /FOR UPDATE/ })
      expect(espera).not.toBeNull() // la liga ESPERA el candado del cobro: no decide con la venta «abierta» de antes
      aparcada.soltar()
      await cobro
      const { status, cuerpo } = await liga
      expect(status).toBe(201)
      expect(cuerpo.data).toEqual([expect.objectContaining({ customerId: kev, isPrimary: false })])
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
      await Promise.allSettled([cobro, liga].filter(Boolean) as Promise<unknown>[])
    }
    await awardLoyaltyForPaidOrder({ venueId: venueId!, orderId, orderTotal: 20, staffId: cajero.staffId, legacyCustomer: null })
    expect(await loQueRecibio(orderId, kev)).toMatchObject(NADA)
  })
})
