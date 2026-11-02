/**
 * 🔴 BAJO-3 (full-testing, 15-oct-2026): seis «Agregar cliente» del MISMO cliente a la MISMA venta pagada, a la vez (3 desde el
 * POS y 3 desde la TPV). El dinero cuadró (un sello, unos puntos), pero:
 *   · una respuesta fue 500: dos transacciones leyeron «sin liga», las dos crearon el `OrderCustomer` y la segunda chocó con el
 *     único `(orderId, customerId)` (P2002) — evidencia `C3a-mismo-movil-3.json`;
 *   · quedaron DOS filas `CUSTOMER_ATTACHED_TO_PAID_ORDER` para un solo hecho (`activitylog-trail.txt`).
 *
 * Ahora la liga es idempotente: ese choque quiere decir «ya está ligado» (se reintenta y sigue como éxito), también en la TPV
 * (F3, ronda 1: el MISMO cliente ya ligado es éxito, no 400). Auditoría (F2, ronda 1): la llamada que CREÓ la liga escribe
 * SIEMPRE su fila (`ligaNueva: true`); una re-liga, sólo si ESTA llamada otorgó algo (el sello o los puntos — R3-1, ronda 3: los
 * puntos cuentan aunque la venta ya tuviera sello). En una carrera pueden quedar hasta 3 filas, todas ciertas: exactamente UNA con
 * `ligaNueva: true`, y cada re-liga con `otorgo: true`.
 *
 * Todo real contra Postgres: la liga del POS (`attachCustomerToOrder`), la de la TPV (`addCustomerToOrder`), la lealtad
 * (`earnPoints`/`grantStamp`) y la bitácora. Los cruces se FUERZAN y se OBSERVAN en `pg_stat_activity` (no se suponen por tiempos).
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'
import { customerAttributionActor } from '@/middlewares/customerAttribution.middleware'
import type { CustomerAttributionActor } from '@/services/shared/customerAttributionPolicy'
import type { Request } from 'express'

// La bitácora es lo que se prueba (las filas `CUSTOMER_ATTACHED_TO_PAID_ORDER`): aquí va la DE VERDAD, no el doble del setup.
jest.unmock('@/services/dashboard/activity-log.service')

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
// El aviso al pase y el correo del primer sello salen hacia afuera: aquí no aportan.
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
// El plan del negocio no es lo que se prueba: con LOYALTY_PROGRAM los puntos y los sellos corren de verdad.
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

import { attachCustomerToOrder } from '@/services/mobile/order.mobile.service'
import { addCustomerToOrder } from '@/services/tpv/order.tpv.service'
import * as bitacora from '@/services/dashboard/activity-log.service'
import * as lealtadDelCobro from '@/services/shared/loyaltyOnPaidOrder'
import { aTiempo, aparcarLaSiguienteTransaccion, esperarBloqueado } from '@tests/__helpers__/candadosDePostgres'

const AUDITORIA = 'CUSTOMER_ATTACHED_TO_PAID_ORDER'
const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
let orgId: string | undefined
let venueId: string | undefined
let cajero: string | undefined
let n = 0
let actor: CustomerAttributionActor

/**
 * Las escrituras de la bitácora son fire-and-forget en el código: se espía `logAction` SIN cambiarlo (el espía llama al de
 * verdad) y se esperan sus promesas antes de contar filas.
 */
let espiaBitacora: jest.SpyInstance

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `ITEST LigaConcurrente ${sello}`, email: `itest-liga-${sello}@test.com`, phone: '5550000000' },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { name: `itest-liga-${sello}`, slug: `itest-liga-${sello}`, organizationId: orgId, timezone: 'America/Mexico_City' },
    })
  ).id
  await prisma.loyaltyConfig.create({
    data: { venueId, active: true, pointsPerDollar: 1, stampsEnabled: true, stampsRequired: 7, maxStampsPerDay: 0 },
  })
  const s = await prisma.staff.create({ data: { email: `itest-liga-${sello}-cajero@test.com`, firstName: 'Cajero', lastName: 'Prueba' } })
  await prisma.staffVenue.create({ data: { staffId: s.id, venueId, role: 'CASHIER' } })
  cajero = s.id
  actor = await customerAttributionActor({
    params: { venueId },
    authContext: { userId: cajero, venueId, orgId, role: 'CASHIER' },
  } as unknown as Request)

  espiaBitacora = jest.spyOn(bitacora, 'logAction')
})

afterAll(async () => {
  espiaBitacora?.mockRestore()
  // 🔴 Sin fixture no se limpia NADA: un filtro con venueId undefined borraría tablas enteras.
  if (!venueId || !orgId) return
  await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.stampReward.deleteMany({ where: { venueId } })
  await prisma.stampEvent.deleteMany({ where: { venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await prisma.customerOrderMetric.deleteMany({ where: { venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } }) // OrderCustomer cae en cascada
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.staff.deleteMany({ where: { email: { startsWith: `itest-liga-${sello}-` } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

async function cliente(nombre: string): Promise<string> {
  const i = ++n
  return (await prisma.customer.create({ data: { venueId: venueId!, firstName: nombre, phone: `+52559910${String(i).padStart(4, '0')}` } }))
    .id
}

/** Venta cobrada en efectivo SIN cliente hace un minuto: su lealtad ya corrió «sin cliente» y quedó cerrada (el caso real). */
async function ventaCobradaSinCliente(): Promise<string> {
  return (
    await prisma.order.create({
      data: {
        venueId: venueId!,
        orderNumber: `ORD-LIGA-${sello}-${++n}`,
        subtotal: 20,
        taxAmount: 0,
        total: 20,
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        payments: {
          create: {
            venueId: venueId!,
            amount: 20,
            feePercentage: 0,
            feeAmount: 0,
            netAmount: 20,
            method: 'CASH',
            status: 'COMPLETED',
            type: 'REGULAR',
            processedById: cajero,
            createdAt: new Date(Date.now() - 60_000),
          },
        },
        loyaltyEligibleAt: new Date(Date.now() - 60_000),
        loyaltyProcessedAt: new Date(Date.now() - 60_000),
      },
    })
  ).id
}

/** Lo que quedó en la base para esa venta y ese cliente, después de esperar las escrituras de la bitácora. */
async function loQueQuedo(orderId: string, customerId: string) {
  await Promise.all(espiaBitacora.mock.results.map(r => r.value))
  const ligas = await prisma.orderCustomer.findMany({ where: { orderId }, select: { customerId: true, isPrimary: true }, take: 10 })
  return {
    ligas,
    sellos: await prisma.stampEvent.count({ where: { venueId, orderId, type: 'EARN' } }),
    puntos: await prisma.loyaltyTransaction.count({ where: { orderId, customerId, type: 'EARN' } }),
    auditoria: await prisma.activityLog.count({ where: { venueId, action: AUDITORIA, entityId: orderId } }),
    filas: await prisma.activityLog.findMany({
      where: { venueId, action: AUDITORIA, entityId: orderId },
      select: { staffId: true, data: true },
      take: 10,
    }),
  }
}

/**
 * F2 + R3-1: exactamente UNA fila de la llamada que creó la liga; las demás, sólo de re-ligas que otorgaron algo (el sello o los
 * puntos: a lo más una por pieza ⇒ ≤ 3 filas, todas ciertas).
 */
function auditoriaDeUnaLiga(quedo: Awaited<ReturnType<typeof loQueQuedo>>) {
  const nuevas = quedo.filas.filter(f => (f.data as { ligaNueva?: boolean }).ligaNueva === true)
  expect(nuevas).toHaveLength(1)
  expect(quedo.auditoria).toBeLessThanOrEqual(3)
  for (const f of quedo.filas) {
    const d = f.data as { ligaNueva?: boolean; otorgo?: boolean }
    // Una re-liga sólo escribe si otorgó.
    if (d.ligaNueva === false) expect(d.otorgo).toBe(true)
  }
  return nuevas[0]
}

describe('🔴 BAJO-3: el MISMO cliente agregado varias veces a la vez a una venta pagada (Postgres real)', () => {
  it('🔴 la segunda liga del MISMO cliente espera a la primera (candado de la venta), ve su liga y responde ÉXITO (antes: P2002 ⇒ 500)', async () => {
    const hugo = await cliente('Hugo')
    const orderId = await ventaCobradaSinCliente()
    const aparcada = aparcarLaSiguienteTransaccion(prisma)
    // Fuera del try: si una aserción truena, se esperan igual (no se cuelan a la prueba siguiente).
    let primera: ReturnType<typeof attachCustomerToOrder> | undefined
    let segunda: Promise<{ ok: Awaited<ReturnType<typeof attachCustomerToOrder>> | undefined; error: unknown }> | undefined
    try {
      // La primera liga crea el OrderCustomer y se queda ANTES del commit, con sus candados.
      primera = attachCustomerToOrder(venueId!, orderId, hugo, cajero, { actor })
      const pidPrimera = await aTiempo(aparcada.pid, 15_000, 'la primera liga aparcada antes del commit')
      // La segunda (doble toque desde otro aparato). Ronda 1: las dos ligas toman PRIMERO el candado de la venta (el mismo que
      // la TPV y el cobro), así que la segunda espera ahí —antes esperaba el INSERT y chocaba con el único—; al soltarse, la
      // relectura ve la liga de la primera.
      segunda = attachCustomerToOrder(venueId!, orderId, hugo, cajero, { actor }).then(
        ok => ({ ok, error: undefined as unknown }),
        error => ({ ok: undefined, error }),
      )
      const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pidPrimera], consulta: /FOR NO KEY UPDATE/ })
      expect(espera).not.toBeNull() // el cruce SÍ ocurrió: la segunda esperaba el candado que la primera tenía tomado
      aparcada.soltar()

      const r1 = await primera!
      const r2 = await segunda!
      expect(r2.error).toBeUndefined() // antes: P2002 «Unique constraint failed on the fields: (`orderId`,`customerId`)» ⇒ 500
      expect(r1.loyalty).toMatchObject({ stamped: true })
      expect(r2.ok?.loyalty).toMatchObject({ stamped: true })
      expect(r2.ok?.customerId).toBe(hugo)

      const quedo = await loQueQuedo(orderId, hugo)
      expect(quedo.ligas).toEqual([{ customerId: hugo, isPrimary: true }])
      expect(quedo.sellos).toBe(1)
      expect(quedo.puntos).toBe(1)
      auditoriaDeUnaLiga(quedo)
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
      await Promise.allSettled([primera, segunda].filter(Boolean) as Promise<unknown>[])
    }
  })

  it('🔴 dos ligas cuyas lealtades leen la venta SIN sello a la vez: UNA fila de auditoría (antes: dos), un sello, unos puntos', async () => {
    const ivan = await cliente('Iván')
    const orderId = await ventaCobradaSinCliente()
    // Barrera en la lealtad del cobro: cuando las dos llegan a otorgar, las dos ya leyeron la venta («ELIGIBLE», sin sello).
    const original = lealtadDelCobro.awardLoyaltyForPaidOrder
    let llegadas = 0
    let avisarPrimera: () => void = () => undefined
    const primeraLlego = new Promise<void>(r => (avisarPrimera = r))
    let abrir: () => void = () => undefined
    const lasDos = new Promise<void>(r => (abrir = r))
    const barrera = jest.spyOn(lealtadDelCobro, 'awardLoyaltyForPaidOrder').mockImplementation((async (
      ...a: Parameters<typeof original>
    ) => {
      llegadas++
      if (llegadas === 1) avisarPrimera()
      if (llegadas === 2) abrir()
      // Nunca se cuelga: si la segunda no llega, sigue a los 15 s y la prueba falla por lo que haya quedado.
      await Promise.race([lasDos, new Promise(r => setTimeout(r, 15_000).unref())])
      return original(...a)
    }) as never)
    try {
      // La primera CREA la liga (y hace commit) y llega a su lealtad; ahí espera.
      const primera = attachCustomerToOrder(venueId!, orderId, ivan, cajero, { actor })
      await aTiempo(primeraLlego, 15_000, 'la primera liga llega a su lealtad')
      // La segunda (otro toque) encuentra la liga ya hecha, lee la venta todavía SIN sello y llega a la barrera.
      const segunda = attachCustomerToOrder(venueId!, orderId, ivan, cajero, { actor })
      const [r1, r2] = await Promise.all([primera, segunda])
      expect(llegadas).toBe(2)
      expect(r1.loyalty).toMatchObject({ stamped: true })
      expect(r2.loyalty).toMatchObject({ stamped: true })

      const quedo = await loQueQuedo(orderId, ivan)
      expect(quedo.ligas).toEqual([{ customerId: ivan, isPrimary: true }])
      expect(quedo.sellos).toBe(1)
      expect(quedo.puntos).toBe(1)
      const fila = auditoriaDeUnaLiga(quedo)
      expect(fila.staffId).toBe(cajero)
      expect(fila.data).toMatchObject({ customerId: ivan, decision: 'ELIGIBLE', ligaNueva: true })
    } finally {
      barrera.mockRestore()
    }
  })

  it('🔴 seis a la vez, 3 desde el POS y 3 desde la TPV (como en el full-testing): TODAS con éxito, una liga, un sello, unos puntos, UNA fila de la liga nueva', async () => {
    const juan = await cliente('Juan')
    const orderId = await ventaCobradaSinCliente()
    const llamadas = [
      ...[1, 2, 3].map(() => attachCustomerToOrder(venueId!, orderId, juan, cajero, { actor })),
      ...[1, 2, 3].map(() => addCustomerToOrder(venueId!, orderId, juan, cajero, { otorgarLealtad: true, customerAttribution: actor })),
    ]
    const resultados = await Promise.allSettled(llamadas)

    // 🔴 F3 (ronda 1): TODAS con éxito, TPV incluida (antes la TPV respondía 400 «Customer already added to this order»).
    const rechazos = resultados
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map(r => ({ message: r.reason?.message, code: r.reason?.code, stack: r.reason?.stack }))
    expect(rechazos).toEqual([])

    const quedo = await loQueQuedo(orderId, juan)
    expect(quedo.ligas).toEqual([{ customerId: juan, isPrimary: true }])
    expect(quedo.sellos).toBe(1)
    expect(quedo.puntos).toBe(1)
    auditoriaDeUnaLiga(quedo)
  })
})
