/**
 * 🔴 Ronda 3 post-QA de sellos tardíos — Codex recheck-7 P2-2 (+ N2) y la «vía vieja» (R3-4), contra Postgres real.
 *
 * Cruce A: la liga del POS toma la VENTA y luego el VÍNCULO; `/fast` (`linkCustomerToExistingOrder`) tomaba el VÍNCULO y luego la
 *   VENTA. Con un acompañante sin primario, los dos se esperaban: interbloqueo (40P01).
 * Cruce B: la liga de la TPV tomaba `Order FOR UPDATE` y al insertar su vínculo pedía `FOR KEY SHARE` sobre `Customer`; las
 *   métricas del COBRO (`updateCustomerMetrics`) toman `Customer FOR UPDATE` y al insertar su registro piden `FOR KEY SHARE` sobre
 *   `Order`: interbloqueo.
 * Arreglo: toda escritura de la atribución (ligas del POS y la TPV, quitar, editar invitado, `/fast`) toma PRIMERO la venta con
 * `FOR NO KEY UPDATE` (`bloquearVentaParaLiga`): serializa contra el cobro (que toma `FOR UPDATE`) y entre ellas, pero NO choca
 * con el `FOR KEY SHARE` de las llaves foráneas. El camino del cobro no se tocó.
 *
 * Los cruces se FUERZAN (una transacción se detiene en el punto exacto) y se OBSERVAN en `pg_stat_activity`.
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
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

import logger from '@/config/logger'
import { addCustomerToOrder, updateGuestInfo } from '@/services/tpv/order.tpv.service'
import { attachCustomerToOrder } from '@/services/mobile/order.mobile.service'
import { linkCustomerToExistingOrder } from '@/services/tpv/fastPaymentCustomer'
import { updateCustomerMetrics } from '@/services/dashboard/customer.dashboard.service'
import { LoyaltyReconciliationJob } from '@/jobs/loyalty-reconciliation.job'
import { aTiempo, esperarBloqueado } from '@tests/__helpers__/candadosDePostgres'

const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
let orgId: string | undefined
let venueId: string | undefined
let cajero: string
let n = 0

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `ITEST Candados ${sello}`, email: `itest-candados-${sello}@test.com`, phone: '5550000000' },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { name: `itest-candados-${sello}`, slug: `itest-candados-${sello}`, organizationId: orgId, timezone: 'America/Mexico_City' },
    })
  ).id
  await prisma.loyaltyConfig.create({
    data: { venueId, active: true, pointsPerDollar: 1, stampsEnabled: true, stampsRequired: 7, maxStampsPerDay: 0 },
  })
  const s = await prisma.staff.create({
    data: { email: `itest-candados-${sello}-cajero@test.com`, firstName: 'Cajero', lastName: 'Prueba' },
  })
  await prisma.staffVenue.create({ data: { staffId: s.id, venueId, role: 'CASHIER' } })
  cajero = s.id
})

afterAll(async () => {
  // 🔴 Sin fixture no se limpia NADA: un filtro con venueId undefined borraría tablas enteras.
  if (!venueId || !orgId) return
  await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
  await prisma.stampReward.deleteMany({ where: { venueId } })
  await prisma.stampEvent.deleteMany({ where: { venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await prisma.customerOrderMetric.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } }) // OrderCustomer cae en cascada
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { email: { startsWith: `itest-candados-${sello}-` } } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

beforeEach(() => (logger.warn as jest.Mock).mockClear())

async function cliente(nombre: string): Promise<string> {
  const i = ++n
  return (await prisma.customer.create({ data: { venueId: venueId!, firstName: nombre, phone: `+52556610${String(i).padStart(4, '0')}` } }))
    .id
}

async function venta(opciones: { pagada?: boolean; procesada?: boolean } = {}): Promise<string> {
  const pagada = opciones.pagada ?? true
  return (
    await prisma.order.create({
      data: {
        venueId: venueId!,
        orderNumber: `ORD-CAND-${sello}-${++n}`,
        subtotal: 20,
        taxAmount: 0,
        total: 20,
        status: pagada ? 'COMPLETED' : 'PENDING',
        paymentStatus: pagada ? 'PAID' : 'PENDING',
        loyaltyEligibleAt: pagada ? new Date(Date.now() - 60_000) : null,
      },
    })
  ).id
}

/**
 * La PRÓXIMA transacción interactiva corre normal hasta que su cuerpo toca `modelo.operacion`; ahí se detiene (con todo lo que
 * ya bloqueó) hasta `soltar()`. `pid` = su backend de Postgres.
 */
function detenerLaSiguienteTransaccionEn(modelo: string, operacion: string) {
  const original = prisma.$transaction.bind(prisma) as (...a: unknown[]) => Promise<unknown>
  let avisar: (pid: number) => void = () => undefined
  const pid = new Promise<number>(r => (avisar = r))
  let soltar: () => void = () => undefined
  const puede = new Promise<void>(r => (soltar = r))
  const espia = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((cuerpo: (tx: any) => Promise<unknown>, opciones?: object) =>
    original(
      async (tx: any) => {
        const [{ pid: propio }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`
        const detenido = new Proxy(tx, {
          get(objetivo, propiedad) {
            const valor = Reflect.get(objetivo, propiedad)
            if (propiedad !== modelo) return valor
            return new Proxy(valor, {
              get(delegado, op) {
                const real = Reflect.get(delegado, op)
                if (op !== operacion) return real
                return async (...args: unknown[]) => {
                  avisar(Number(propio))
                  await puede
                  return real.apply(delegado, args)
                }
              },
            })
          },
        })
        return cuerpo(detenido)
      },
      { ...(opciones ?? {}), timeout: 30_000 },
    )) as never)
  return { pid, soltar: () => soltar(), restaurar: () => espia.mockRestore() }
}

/** ¿Algún camino reintentó por interbloqueo (40P01)? Los reintentos lo dicen en el log. */
const huboInterbloqueo = () =>
  (logger.warn as jest.Mock).mock.calls.some(([m]) => typeof m === 'string' && /interbloqueo|deadlock/i.test(m))

describe('🔴 R3-2: sin ciclos de candados en la atribución de la venta (Postgres real)', () => {
  it('🔴 cruce B: las MÉTRICAS del cobro (Customer FOR UPDATE) y la liga TPV (venta primero) no se interbloquean; las métricas no esperan a la liga', async () => {
    const c = await cliente('Carla')
    const orderId = await venta()
    // Las métricas del cobro se detienen con `Customer FOR UPDATE` tomado, justo antes de registrar la visita (que referencia la venta).
    const metricas = detenerLaSiguienteTransaccionEn('customerOrderMetric', 'findUnique')
    let m: Promise<unknown> | undefined
    let liga: Promise<unknown> | undefined
    try {
      m = updateCustomerMetrics(c, 20, orderId, venueId!)
      const pidMetricas = await aTiempo(metricas.pid, 15_000, 'las métricas detenidas con el candado del cliente')
      // La liga toma la venta y, al insertar su vínculo, espera al cliente (lo tienen las métricas).
      liga = addCustomerToOrder(venueId!, orderId, c, cajero, { otorgarLealtad: true })
      const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pidMetricas], consulta: /INSERT[\s\S]*"OrderCustomer"/ })
      expect(espera).not.toBeNull() // el cruce SÍ ocurrió: la liga, con la venta tomada, espera al cliente
      const pidLiga = espera!.pid
      // Se sueltan las métricas: registran la visita (referencia a la venta) SIN esperar a la liga. Se OBSERVA en
      // `pg_stat_activity`, no por tiempos (la Mac compartida puede ir muy lenta): mientras terminan, su backend nunca espera a la
      // liga. Una espera circular duraría al menos `deadlock_timeout` (1 s) antes de que Postgres la cortara: el vigía la ve.
      let esperoALaLiga = false
      let terminaron = false
      const vigia = (async () => {
        while (!terminaron) {
          const filas = await prisma.$queryRaw<Array<{ bloqueadores: number[] }>>`
            SELECT pg_blocking_pids(pid) AS bloqueadores FROM pg_stat_activity WHERE pid = ${pidMetricas} AND wait_event_type = 'Lock'`
          if (filas.some(f => f.bloqueadores.map(Number).includes(pidLiga))) esperoALaLiga = true
          await new Promise(r => setTimeout(r, 25))
        }
      })()
      metricas.soltar()
      try {
        await aTiempo(m, 15_000, 'las métricas terminan')
      } finally {
        terminaron = true
        await vigia
      }
      expect(esperoALaLiga).toBe(false) // las métricas nunca esperaron a la liga: no hubo espera circular
      await aTiempo(liga, 15_000, 'la liga termina')
    } finally {
      metricas.soltar()
      metricas.restaurar()
      await Promise.allSettled([m, liga].filter(Boolean) as Promise<unknown>[])
    }
    expect(huboInterbloqueo()).toBe(false)
    expect(await prisma.customerOrderMetric.count({ where: { orderId, customerId: c } })).toBe(1)
    expect(await prisma.orderCustomer.findMany({ where: { orderId }, select: { customerId: true, isPrimary: true }, take: 5 })).toEqual([
      { customerId: c, isPrimary: true },
    ])
  })

  it('🔴 cruce A: el POS y `/fast` sobre un acompañante sin primario: `/fast` toma la venta PRIMERO, el POS espera la venta (no el vínculo) y los dos terminan', async () => {
    const c = await cliente('Kev')
    const orderId = await venta()
    await prisma.orderCustomer.create({ data: { orderId, customerId: c, isPrimary: false } })
    // `/fast` se detiene justo antes de escribir la venta (ya promovió el vínculo).
    const fast = detenerLaSiguienteTransaccionEn('order', 'update')
    let f: Promise<{ status: string }> | undefined
    let pos: Promise<unknown> | undefined
    try {
      f = linkCustomerToExistingOrder(venueId!, orderId, c)
      const pidFast = await aTiempo(fast.pid, 15_000, '`/fast` detenido antes de escribir la venta')
      pos = attachCustomerToOrder(venueId!, orderId, c, cajero)
      // Con el arreglo, el POS espera el candado de la VENTA que `/fast` ya tiene (antes: esperaba el vínculo, y `/fast` la venta).
      const espera = await esperarBloqueado(prisma, { bloqueadoPor: [pidFast], consulta: /FOR NO KEY UPDATE/ })
      expect(espera).not.toBeNull()
      fast.soltar()
      expect((await aTiempo(f, 15_000, '`/fast` termina')).status).toBe('LINKED')
      await expect(aTiempo(pos, 15_000, 'el POS termina')).resolves.toMatchObject({ customerId: c })
    } finally {
      fast.soltar()
      fast.restaurar()
      await Promise.allSettled([f, pos].filter(Boolean) as Promise<unknown>[])
    }
    expect(huboInterbloqueo()).toBe(false)
    expect(await prisma.orderCustomer.findMany({ where: { orderId }, select: { customerId: true, isPrimary: true }, take: 5 })).toEqual([
      { customerId: c, isPrimary: true },
    ])
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { customerId: true } })).toEqual({ customerId: c })
  })
})

/** El reconciliador REAL, acotado a ESTA venta. */
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

describe('🔴 R3-4: editar los datos del invitado no se salta la decisión «A»', () => {
  it('🔴 sin payments:create en una venta PAGADA con la lealtad pendiente: se guarda el nombre, Order.customerId queda intacto y el reconciliador no premia a nadie', async () => {
    const c = await cliente('Kev')
    const orderId = await venta()
    await updateGuestInfo(venueId!, orderId, { customerName: 'Kev', customerId: c }, { otorgarLealtad: false })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { customerId: true, customerName: true } })).toEqual({
      customerId: null,
      customerName: 'Kev',
    })
    expect(await reconciliadorDe(orderId).runNow()).toMatchObject({ scanned: 1, applied: 1 })
    expect(await prisma.stampEvent.count({ where: { venueId, orderId } })).toBe(0)
    expect(await prisma.loyaltyTransaction.count({ where: { orderId, customerId: c } })).toBe(0)
  })

  it('con payments:create: como hoy, fija Order.customerId (y el respaldo heredado lo acredita)', async () => {
    const c = await cliente('Kev')
    const orderId = await venta()
    await updateGuestInfo(venueId!, orderId, { customerName: 'Kev', customerId: c }, { otorgarLealtad: true })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { customerId: true } })).toEqual({ customerId: c })
    await reconciliadorDe(orderId).runNow()
    expect(await prisma.stampEvent.count({ where: { venueId, orderId, stampCard: { customerId: c } } })).toBe(1)
  })

  it('regresión: cuenta ABIERTA y sin permiso: como hoy, fija Order.customerId', async () => {
    const c = await cliente('Kev')
    const orderId = await venta({ pagada: false })
    await updateGuestInfo(venueId!, orderId, { customerId: c }, { otorgarLealtad: false })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { customerId: true } })).toEqual({ customerId: c })
  })
})
