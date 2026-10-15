/**
 * 🔴 BAJO-3 (full-testing, 15-oct-2026): seis «Agregar cliente» del MISMO cliente a la MISMA venta pagada, a la vez (3 desde el
 * POS y 3 desde la TPV). El dinero cuadró (un sello, unos puntos), pero:
 *   · una respuesta fue 500: dos transacciones leyeron «sin liga», las dos crearon el `OrderCustomer` y la segunda chocó con el
 *     único `(orderId, customerId)` (P2002) — evidencia `C3a-mismo-movil-3.json`;
 *   · quedaron DOS filas `CUSTOMER_ATTACHED_TO_PAID_ORDER` para un solo hecho (`activitylog-trail.txt`).
 *
 * Ahora la liga es idempotente: ese choque quiere decir «ya está ligado» (se reintenta y sigue como éxito) y sólo la llamada que
 * CREÓ la liga escribe la fila de auditoría.
 *
 * Todo real contra Postgres: la liga del POS (`attachCustomerToOrder`), la de la TPV (`addCustomerToOrder`), la lealtad
 * (`earnPoints`/`grantStamp`) y la bitácora. Los cruces se FUERZAN y se OBSERVAN en `pg_stat_activity` (no se suponen por tiempos).
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'

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
  }
}

describe('🔴 BAJO-3: el MISMO cliente agregado varias veces a la vez a una venta pagada (Postgres real)', () => {
  it('🔴 la segunda liga choca con la primera en el único (orderId, customerId): espera, ve la liga y responde ÉXITO (antes: 500)', async () => {
    const hugo = await cliente('Hugo')
    const orderId = await ventaCobradaSinCliente()
    const aparcada = aparcarLaSiguienteTransaccion(prisma)
    try {
      // La primera liga crea el OrderCustomer y se queda ANTES del commit, con sus candados.
      const primera = attachCustomerToOrder(venueId!, orderId, hugo, cajero)
      const pidPrimera = await aTiempo(aparcada.pid, 15_000, 'la primera liga aparcada antes del commit')
      // La segunda (doble toque desde otro aparato) lee «sin liga» y su INSERT espera a la primera.
      const segunda = attachCustomerToOrder(venueId!, orderId, hugo, cajero).then(
        ok => ({ ok, error: undefined as unknown }),
        error => ({ ok: undefined, error }),
      )
      const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pidPrimera], consulta: /INSERT[\s\S]*"OrderCustomer"/ })
      expect(espera).not.toBeNull() // el cruce SÍ ocurrió: la segunda esperaba el único que la primera tenía tomado
      aparcada.soltar()

      const r1 = await primera
      const r2 = await segunda
      expect(r2.error).toBeUndefined() // antes: P2002 «Unique constraint failed on the fields: (`orderId`,`customerId`)» ⇒ 500
      expect(r1.loyalty).toMatchObject({ stamped: true })
      expect(r2.ok?.loyalty).toMatchObject({ stamped: true })
      expect(r2.ok?.customerId).toBe(hugo)

      const quedo = await loQueQuedo(orderId, hugo)
      expect(quedo.ligas).toEqual([{ customerId: hugo, isPrimary: true }])
      expect(quedo.sellos).toBe(1)
      expect(quedo.puntos).toBe(1)
      expect(quedo.auditoria).toBe(1)
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
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
      const primera = attachCustomerToOrder(venueId!, orderId, ivan, cajero)
      await aTiempo(primeraLlego, 15_000, 'la primera liga llega a su lealtad')
      // La segunda (otro toque) encuentra la liga ya hecha, lee la venta todavía SIN sello y llega a la barrera.
      const segunda = attachCustomerToOrder(venueId!, orderId, ivan, cajero)
      const [r1, r2] = await Promise.all([primera, segunda])
      expect(llegadas).toBe(2)
      expect(r1.loyalty).toMatchObject({ stamped: true })
      expect(r2.loyalty).toMatchObject({ stamped: true })

      const quedo = await loQueQuedo(orderId, ivan)
      expect(quedo.ligas).toEqual([{ customerId: ivan, isPrimary: true }])
      expect(quedo.sellos).toBe(1)
      expect(quedo.puntos).toBe(1)
      expect(quedo.auditoria).toBe(1)
      const fila = await prisma.activityLog.findFirstOrThrow({
        where: { venueId, action: AUDITORIA, entityId: orderId },
        select: { staffId: true, data: true },
      })
      expect(fila.staffId).toBe(cajero)
      expect(fila.data).toMatchObject({ customerId: ivan, decision: 'ELIGIBLE' })
    } finally {
      barrera.mockRestore()
    }
  })

  it('🔴 seis a la vez, 3 desde el POS y 3 desde la TPV (como en el full-testing): ningún 500, una liga, un sello, unos puntos, UNA fila', async () => {
    const juan = await cliente('Juan')
    const orderId = await ventaCobradaSinCliente()
    const llamadas = [
      ...[1, 2, 3].map(() => attachCustomerToOrder(venueId!, orderId, juan, cajero)),
      ...[1, 2, 3].map(() => addCustomerToOrder(venueId!, orderId, juan, cajero, { otorgarLealtad: true })),
    ]
    const resultados = await Promise.allSettled(llamadas)

    // Ninguna respuesta de servidor roto. La TPV conserva sus 400 de siempre («ya estaba agregado», conflicto persistente),
    // pero nada que no sea un error de negocio con su estado 4xx.
    const rechazos = resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason)
    for (const rechazo of rechazos) {
      expect({ mensaje: rechazo?.message, estado: rechazo?.statusCode }).toEqual({ mensaje: expect.any(String), estado: 400 })
    }
    // Las tres del POS nunca fallan: la liga del POS es idempotente.
    expect(resultados.slice(0, 3).every(r => r.status === 'fulfilled')).toBe(true)

    const quedo = await loQueQuedo(orderId, juan)
    expect(quedo.ligas).toEqual([{ customerId: juan, isPrimary: true }])
    expect(quedo.sellos).toBe(1)
    expect(quedo.puntos).toBe(1)
    expect(quedo.auditoria).toBe(1)
  })
})
