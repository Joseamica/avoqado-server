/**
 * 🔴 H4 (auditoría de Codex del código, 15-oct-2026): la recuperación NO puede acreditar puntos a otro cliente por la MISMA venta.
 *
 * El caso: Ana ya recibió el sello y los puntos de la venta, pero la venta quedó pendiente (otro efecto falló o el proceso murió
 * antes de cerrarla). Desde la TPV se quita a Ana y se agrega a Beto como primario. Después corre el reconciliador: antes,
 * `grantStamp` respondía «ya sellada» (el sello es POR VENTA) y `earnPoints`, cuya deduplicación es por cliente + venta, le daba
 * a Beto los puntos de una compra que ya le había sumado a Ana. Ahora el envoltorio de la recuperación ve el EARN de otro
 * cliente y cierra la venta como OTHER_CUSTOMER sin acreditar a nadie.
 *
 * Todo real contra Postgres: la TPV (quitar y agregar cliente), el reconciliador, el envoltorio, `earnPoints` y `grantStamp`.
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'

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

import { earnPoints } from '@/services/dashboard/loyalty.dashboard.service'
import { addCustomerToOrder, createAndAddCustomerToOrder, removeCustomerFromOrder } from '@/services/tpv/order.tpv.service'
import { LoyaltyReconciliationJob } from '@/jobs/loyalty-reconciliation.job'
import * as tardia from '@/services/shared/loyaltyOnLateCustomer'

/** Texto EXACTO del ruling: la marca de fila que deja la reapertura. */
const MARCA = 'REABIERTA: cliente ligado después del cobro'

const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
let orgId: string | undefined
let venueId: string | undefined
let n = 0

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `ITEST OtroCliente ${sello}`, email: `itest-otro-${sello}@test.com`, phone: '5550000000' },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { name: `itest-otro-${sello}`, slug: `itest-otro-${sello}`, organizationId: orgId, timezone: 'America/Mexico_City' },
    })
  ).id
  await prisma.loyaltyConfig.create({
    data: { venueId, active: true, pointsPerDollar: 1, stampsEnabled: true, stampsRequired: 7, maxStampsPerDay: 0 },
  })
})

afterAll(async () => {
  // 🔴 Sin fixture no se limpia NADA: un filtro con venueId undefined borraría tablas enteras.
  if (!venueId || !orgId) return
  await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { email: { startsWith: `itest-otro-${sello}-` } } })
  await prisma.stampReward.deleteMany({ where: { venueId } })
  await prisma.stampEvent.deleteMany({ where: { venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await prisma.customerOrderMetric.deleteMany({ where: { venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } }) // OrderCustomer cae en cascada
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

async function cliente(nombre: string): Promise<string> {
  const i = ++n
  return (await prisma.customer.create({ data: { venueId: venueId!, firstName: nombre, phone: `+52556677${String(i).padStart(4, '0')}` } }))
    .id
}

/**
 * El reconciliador REAL (su envoltorio por defecto), acotado a ESTA venta: otras pruebas pueden compartir la base.
 * `trasReclamar` corre justo después de que la vuelta reclamó la venta (antes de su lealtad).
 */
function reconciliadorDe(orderId: string, trasReclamar?: () => Promise<void>) {
  const soloEsta = (args: any) => ({ ...args, where: { AND: [args.where, { id: orderId }] } })
  let reclamada = false
  return new LoyaltyReconciliationJob({
    prisma: {
      order: {
        findMany: (args: any) => prisma.order.findMany(soloEsta(args)),
        updateMany: async (args: any) => {
          const r = await prisma.order.updateMany(soloEsta(args))
          if (trasReclamar && !reclamada && r.count === 1 && args?.data?.loyaltyAttempts) {
            reclamada = true
            await trasReclamar()
          }
          return r
        },
      },
    } as never,
    cron: { start: jest.fn(), stop: jest.fn() },
    now: () => new Date(),
  })
}

/** Un empleado del negocio: devuelve su Staff.id (lo que viaja como actor) y su StaffVenue.id (lo que queda como autor). */
async function empleado(nombre: string): Promise<{ staffId: string; staffVenueId: string }> {
  const s = await prisma.staff.create({ data: { email: `itest-otro-${sello}-${++n}@test.com`, firstName: nombre, lastName: 'Prueba' } })
  const sv = await prisma.staffVenue.create({ data: { staffId: s.id, venueId: venueId!, role: 'CASHIER' } })
  return { staffId: s.id, staffVenueId: sv.id }
}

/** Una venta cobrada hace un minuto, con su lealtad PENDIENTE (no se cerró), y `primero` como primario. */
async function ventaPendienteCon(primero: string): Promise<string> {
  const orderId = (
    await prisma.order.create({
      data: {
        venueId: venueId!,
        orderNumber: `ORD-OTRO-${sello}-${++n}`,
        subtotal: 50,
        taxAmount: 0,
        total: 50,
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        loyaltyEligibleAt: new Date(Date.now() - 60_000),
      },
    })
  ).id
  await prisma.orderCustomer.create({ data: { orderId, customerId: primero, isPrimary: true } })
  return orderId
}

describe('🔴 H4: la recuperación no le acredita a OTRO cliente lo que la venta ya le dio a uno (Postgres real)', () => {
  it('Ana sellada y con puntos → la TPV quita a Ana y pone a Beto → el reconciliador ⇒ Beto no recibe nada', async () => {
    const ana = await cliente('Ana')
    const beto = await cliente('Beto')
    const orderId = (
      await prisma.order.create({
        data: {
          venueId: venueId!,
          orderNumber: `ORD-OTRO-${sello}-${++n}`,
          subtotal: 50,
          taxAmount: 0,
          total: 50,
          status: 'COMPLETED',
          paymentStatus: 'PAID',
          // Cobrada hace un minuto; la lealtad del cobro quedó PENDIENTE (no se cerró).
          loyaltyEligibleAt: new Date(Date.now() - 60_000),
        },
      })
    ).id
    await prisma.orderCustomer.create({ data: { orderId, customerId: ana, isPrimary: true } })

    // Ana recibió su sello y sus puntos; el proceso murió antes de cerrar la venta.
    expect((await earnPoints(venueId!, ana, 50, orderId)).pointsEarned).toBe(50)

    // La TPV quita a Ana y agrega a Beto, que queda como primario.
    await removeCustomerFromOrder(venueId!, orderId, ana)
    const ligada = await addCustomerToOrder(venueId!, orderId, beto)
    expect(ligada.loyalty).toMatchObject({ stamped: false, reason: 'OTHER_CUSTOMER' })

    // El reconciliador de siempre toma la venta pendiente.
    expect(await reconciliadorDe(orderId).runNow()).toMatchObject({ scanned: 1, applied: 1, failed: 0 })

    // Beto: ni puntos ni sello ni saldo por una compra que ya era de Ana.
    expect(await prisma.loyaltyTransaction.count({ where: { orderId, customerId: beto, type: 'EARN' } })).toBe(0)
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: beto }, select: { loyaltyPoints: true } })).loyaltyPoints).toBe(0)
    expect(await prisma.stampEvent.count({ where: { venueId, orderId, type: 'EARN', stampCard: { customerId: beto } } })).toBe(0)
    // Ana conserva lo suyo: un sello y sus puntos.
    expect(await prisma.stampEvent.count({ where: { venueId, orderId, type: 'EARN', stampCard: { customerId: ana } } })).toBe(1)
    expect(await prisma.loyaltyTransaction.count({ where: { orderId, customerId: ana, type: 'EARN' } })).toBe(1)
    // Y la venta queda cerrada: el reconciliador no la vuelve a tomar 15 veces.
    const fila = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { loyaltyProcessedAt: true } })
    expect(fila.loyaltyProcessedAt).toBeInstanceOf(Date)
  })

  // ── Segunda ola (recheck de Codex, 15-oct-2026): el primario cambia ENTRE la comprobación y la lealtad ────────────────────
  it('🔴 el reconciliador valida a Ana y, justo antes de acreditar, la TPV cambia a Beto ⇒ Beto no recibe nada; la vuelta siguiente la cierra', async () => {
    const ana = await cliente('Ana')
    const beto = await cliente('Beto')
    const orderId = await ventaPendienteCon(ana)
    expect((await earnPoints(venueId!, ana, 50, orderId)).pointsEarned).toBe(50) // Ana ya tiene su sello y sus puntos

    // La lealtad lee los clientes de la venta: JUSTO antes, la TPV quita a Ana y pone a Beto (ya pasó la comprobación).
    const leer = prisma.orderCustomer.findMany.bind(prisma.orderCustomer)
    let cambiado = false
    const espia = jest.spyOn(prisma.orderCustomer, 'findMany').mockImplementation((async (args: any) => {
      if (!cambiado && args?.where?.orderId === orderId) {
        cambiado = true
        await prisma.orderCustomer.deleteMany({ where: { orderId, customerId: ana } })
        await prisma.orderCustomer.create({ data: { orderId, customerId: beto, isPrimary: true } })
      }
      return leer(args)
    }) as never)
    let primera: Awaited<ReturnType<LoyaltyReconciliationJob['runNow']>>
    try {
      primera = await reconciliadorDe(orderId).runNow()
    } finally {
      espia.mockRestore()
    }
    expect(cambiado).toBe(true)
    // Antes: Beto recibía otros 50 puntos por la venta de Ana y la venta se cerraba.
    expect(await prisma.loyaltyTransaction.count({ where: { orderId, customerId: beto, type: 'EARN' } })).toBe(0)
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: beto }, select: { loyaltyPoints: true } })).loyaltyPoints).toBe(0)
    expect(primera).toMatchObject({ scanned: 1, applied: 0, failed: 1 }) // no acreditó a nadie: queda para la vuelta siguiente
    const pendiente = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { loyaltyProcessedAt: true } })
    expect(pendiente.loyaltyProcessedAt).toBeNull()

    // La vuelta siguiente ve a Beto como primario y el EARN de Ana: OTHER_CUSTOMER, cerrada, Beto sigue sin nada.
    expect(await reconciliadorDe(orderId).runNow()).toMatchObject({ scanned: 1, applied: 1, failed: 0 })
    expect(await prisma.loyaltyTransaction.count({ where: { orderId, customerId: beto, type: 'EARN' } })).toBe(0)
    expect(await prisma.loyaltyTransaction.count({ where: { orderId, customerId: ana, type: 'EARN' } })).toBe(1)
    const cerrada = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { loyaltyProcessedAt: true } })
    expect(cerrada.loyaltyProcessedAt).toBeInstanceOf(Date)
  })
})

/**
 * 🔴 H5, segunda ola (recheck de Codex): una liga DESPUÉS del reclamo del reconciliador cambia `loyaltyStaffId` y agrega al
 * cliente; la vuelta seguía con el actor que había leído antes (quien cobró) y encontraba al cliente nuevo.
 */
describe('🔴 H5: el sello lleva a quien ligó al cliente aunque la liga llegue después del reclamo (Postgres real)', () => {
  it('cobra el cajero (venta pendiente) → el reconciliador la reclama → el barista liga a Dany → el sello y los puntos son del barista', async () => {
    const cajero = await empleado('Cajero')
    const barista = await empleado('Barista')
    const dany = await cliente('Dany')
    const orderId = (
      await prisma.order.create({
        data: {
          venueId: venueId!,
          orderNumber: `ORD-OTRO-${sello}-${++n}`,
          subtotal: 50,
          taxAmount: 0,
          total: 50,
          status: 'COMPLETED',
          paymentStatus: 'PAID',
          loyaltyEligibleAt: new Date(Date.now() - 60_000),
          loyaltyStaffId: cajero.staffId, // la lealtad del cobro quedó pendiente; la cobró el cajero
        },
      })
    ).id
    // El intento inmediato de la liga no llega (el proceso muere tras el commit): sólo queda el reconciliador.
    const intento = jest.spyOn(tardia, 'awardLoyaltyForLateCustomer').mockResolvedValue(null)
    try {
      await reconciliadorDe(orderId, async () => {
        await addCustomerToOrder(venueId!, orderId, dany, barista.staffId)
      }).runNow()
    } finally {
      intento.mockRestore()
    }
    const selloDeLaVenta = await prisma.stampEvent.findFirstOrThrow({
      where: { venueId, orderId, type: 'EARN' },
      select: { createdById: true, stampCard: { select: { customerId: true } } },
    })
    expect(selloDeLaVenta).toEqual({ createdById: barista.staffVenueId, stampCard: { customerId: dany } })
    const puntos = await prisma.loyaltyTransaction.findFirstOrThrow({
      where: { orderId, customerId: dany, type: 'EARN' },
      select: { createdById: true },
    })
    expect(puntos.createdById).toBe(barista.staffVenueId)
    const fila = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { loyaltyStaffId: true, loyaltyProcessedAt: true },
    })
    expect(fila.loyaltyStaffId).toBe(barista.staffId)
    expect(fila.loyaltyProcessedAt).toBeInstanceOf(Date)
  })
})

/**
 * 🔴 F1, segunda ola (recheck de Codex): la TPV decidía si reabrir con el `paymentStatus` leído ANTES de su transacción. Si la
 * cuenta se cobraba (y su lealtad cerraba «sin cliente») entre esa lectura y la transacción, la liga no reabría y, si el intento
 * inmediato fallaba, el sello se perdía.
 */
describe('🔴 F1: la TPV decide reabrir con el estado de la venta leído DENTRO de su transacción (Postgres real)', () => {
  /** Cuenta ABIERTA; al leerla la TPV antes de su transacción, se cobra y su lealtad se cierra sin cliente. */
  async function cuentaQueSeCobraEnMedio(): Promise<{ orderId: string; restaurar: () => void }> {
    const orderId = (
      await prisma.order.create({
        data: {
          venueId: venueId!,
          orderNumber: `ORD-OTRO-${sello}-${++n}`,
          subtotal: 50,
          taxAmount: 0,
          total: 50,
          status: 'PENDING',
          paymentStatus: 'PENDING',
        },
      })
    ).id
    const leer = prisma.order.findUnique.bind(prisma.order)
    let cobrada = false
    const espia = jest.spyOn(prisma.order, 'findUnique').mockImplementation((async (args: any) => {
      const r = await leer(args)
      if (!cobrada && args?.where?.id === orderId) {
        cobrada = true
        await prisma.order.update({
          where: { id: orderId },
          data: {
            status: 'COMPLETED',
            paymentStatus: 'PAID',
            loyaltyEligibleAt: new Date(Date.now() - 1_000),
            loyaltyProcessedAt: new Date(), // la lealtad del cobro ya corrió y cerró «sin cliente»
          },
        })
      }
      return r
    }) as never)
    return { orderId, restaurar: () => espia.mockRestore() }
  }

  async function quedoReabierta(orderId: string, staffId: string) {
    const fila = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { loyaltyProcessedAt: true, loyaltyLastError: true, loyaltyStaffId: true },
    })
    expect(fila).toEqual({ loyaltyProcessedAt: null, loyaltyLastError: MARCA, loyaltyStaffId: staffId })
  }

  it('addCustomerToOrder: PENDIENTE antes de la transacción → PAGADA dentro ⇒ reabre (el reconciliador la verá)', async () => {
    const barista = await empleado('Barista')
    const dany = await cliente('Dany')
    const { orderId, restaurar } = await cuentaQueSeCobraEnMedio()
    const intento = jest.spyOn(tardia, 'awardLoyaltyForLateCustomer').mockResolvedValue(null)
    try {
      await addCustomerToOrder(venueId!, orderId, dany, barista.staffId)
    } finally {
      restaurar()
      intento.mockRestore()
    }
    await quedoReabierta(orderId, barista.staffId)
  })

  it('createAndAddCustomerToOrder: lo mismo con el cliente NUEVO', async () => {
    const barista = await empleado('Barista')
    const { orderId, restaurar } = await cuentaQueSeCobraEnMedio()
    const intento = jest.spyOn(tardia, 'awardLoyaltyForLateCustomer').mockResolvedValue(null)
    try {
      await createAndAddCustomerToOrder(venueId!, orderId, { firstName: 'Nueva' }, barista.staffId)
    } finally {
      restaurar()
      intento.mockRestore()
    }
    await quedoReabierta(orderId, barista.staffId)
  })

  it('regresión: la cuenta sigue ABIERTA dentro de la transacción ⇒ no reabre nada (la lealtad corre al cobrar)', async () => {
    const dany = await cliente('Dany')
    const orderId = (
      await prisma.order.create({
        data: {
          venueId: venueId!,
          orderNumber: `ORD-OTRO-${sello}-${++n}`,
          subtotal: 50,
          taxAmount: 0,
          total: 50,
          status: 'PENDING',
          paymentStatus: 'PENDING',
        },
      })
    ).id
    await addCustomerToOrder(venueId!, orderId, dany)
    const fila = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { loyaltyLastError: true, loyaltyEligibleAt: true },
    })
    expect(fila).toEqual({ loyaltyLastError: null, loyaltyEligibleAt: null })
  })
})

/**
 * 🔴 H4, tercera ola (recheck 2 de Codex, 15-oct-2026): DOS intentos validan a dos clientes distintos ANTES del primer EARN.
 * El intento 1 valida a Ana y lee sus clientes; la TPV cambia a Ana por Beto; el intento 2 valida a Beto y lee los suyos.
 * Los dos se detienen ahí (barrera en la lectura de clientes de la lealtad) y se sueltan a la vez. Antes: Ana recibía el sello
 * y 50 puntos y Beto, con «ya sellada», otros 50 (la deduplicación de puntos es por cliente + venta y el candado de
 * `grantStamp`, por cliente). Ahora el candado por VENTA en `earnPoints` y en `grantStamp` deja a UN solo cliente.
 */
describe('🔴 H4: dos intentos validados para clientes distintos antes del primer EARN (Postgres real)', () => {
  it('exactamente UN cliente recibe sello y puntos; el otro intento termina como otroCliente', async () => {
    const ana = await cliente('Ana')
    const beto = await cliente('Beto')
    const orderId = await ventaPendienteCon(ana)

    // Barrera determinista: cada lectura de clientes de la lealtad de ESTA venta avisa y espera a que la prueba la suelte.
    const leer = prisma.orderCustomer.findMany.bind(prisma.orderCustomer)
    const avisos: Array<(v: void) => void> = []
    const llego = [0, 1].map(i => new Promise<void>(r => (avisos[i] = r)))
    let soltar: () => void = () => undefined
    const suelta = new Promise<void>(r => (soltar = r))
    let vistas = 0
    const espia = jest.spyOn(prisma.orderCustomer, 'findMany').mockImplementation((async (args: any) => {
      const r = await leer(args)
      if (args?.where?.orderId === orderId && vistas < 2) {
        const i = vistas++
        avisos[i]()
        await suelta
      }
      return r
    }) as never)

    const argumentos = { venueId: venueId!, orderId, orderTotal: 50, staffId: null, legacyCustomer: null }
    let resultados: Array<Awaited<ReturnType<typeof tardia.otorgarLealtadRespetandoReembolsos>>>
    try {
      // 1) Intento 1: valida a Ana y lee sus clientes (Ana) — se queda en la barrera, sin ningún EARN todavía.
      const intento1 = tardia.otorgarLealtadRespetandoReembolsos(argumentos)
      await aTiempoLocal(llego[0], 'el intento 1 no llegó a la barrera')
      // 2) La TPV cambia a Ana por Beto.
      await prisma.orderCustomer.deleteMany({ where: { orderId, customerId: ana } })
      await prisma.orderCustomer.create({ data: { orderId, customerId: beto, isPrimary: true } })
      // 3) Intento 2: valida a Beto (aún nadie tiene EARN) y lee sus clientes (Beto) — también se queda en la barrera.
      const intento2 = tardia.otorgarLealtadRespetandoReembolsos(argumentos)
      await aTiempoLocal(llego[1], 'el intento 2 no llegó a la barrera')
      expect(await prisma.loyaltyTransaction.count({ where: { orderId } })).toBe(0)
      expect(await prisma.stampEvent.count({ where: { venueId, orderId } })).toBe(0)
      // 4) Se sueltan a la vez.
      soltar()
      resultados = await Promise.all([intento1, intento2])
    } finally {
      soltar()
      espia.mockRestore()
    }

    const puntos = await prisma.loyaltyTransaction.findMany({
      where: { orderId, type: 'EARN' },
      select: { customerId: true, points: true },
      take: 5,
    })
    const sellos = await prisma.stampEvent.findMany({
      where: { venueId, orderId, type: 'EARN' },
      select: { stampCard: { select: { customerId: true } } },
      take: 5,
    })
    // UN solo cliente con puntos, y el sello es de ESE mismo cliente.
    expect(puntos).toHaveLength(1)
    expect(sellos).toHaveLength(1)
    const ganador = puntos[0].customerId
    expect([ana, beto]).toContain(ganador)
    expect(sellos[0].stampCard.customerId).toBe(ganador)
    const perdedor = ganador === ana ? beto : ana
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: perdedor }, select: { loyaltyPoints: true } })).loyaltyPoints).toBe(0)
    expect(await prisma.customerOrderMetric.count({ where: { orderId, customerId: perdedor } })).toBe(0)
    // Uno de los dos intentos terminó diciendo que la venta era de otro cliente; ninguno quedó a medias.
    expect(resultados!.filter(r => r.otroCliente)).toHaveLength(1)
    expect(resultados!.every(r => r.complete)).toBe(true)
  })
})

function aTiempoLocal<T>(p: Promise<T>, que: string, ms = 8_000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${que}`)), ms).unref())])
}
