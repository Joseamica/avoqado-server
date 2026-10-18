/**
 * 🔴 Cruce EXACTO de B1 contra Postgres real (S4 del plan de sellos tardíos; ruling del coordinador tras la medición de S3b,
 * 14-oct-2026).
 *
 * El caso: el cobro corre su lealtad en el instante (`awardLoyaltyForPaidOrder`) y lee la venta «sin cliente». Justo entonces
 * el barista toca «Agregar cliente»: la transacción de la liga crea el `OrderCustomer`, escribe la orden y REABRE la lealtad
 * (`reabrirLealtadSiAplica`), con lo que tiene tomado el candado de la fila de la orden. El cierre de la corrida
 * (`UPDATE "Order" … WHERE loyaltyProcessedAt IS NULL AND NOT EXISTS (OrderCustomer…)`) llega en ese momento y ESPERA.
 *
 * Medido por S3b: al soltarse el candado, Postgres (READ COMMITTED) vuelve a evaluar sólo las columnas de la fila nueva; la
 * subconsulta conserva su foto vieja («sin clientes») y el cierre PASABA, con o sin `Order.customerId` escrito por la liga.
 * La venta quedaba «procesada» sin sello: si además el intento inmediato de la liga fallaba (o el proceso moría), el
 * reconciliador nunca la volvía a ver y el sello se perdía en silencio — el defecto de Testarudo, otra vez.
 *
 * El arreglo: la reapertura deja una MARCA de fila (`loyaltyLastError = 'REABIERTA: cliente ligado después del cobro'`) como
 * ÚLTIMA escritura de la liga, y el cierre «sin cliente» exige que esa marca no esté. Una columna de la fila sí la relee
 * Postgres al soltarse el candado. Sirve igual para el móvil (escribe `Order.customerId`) y para la TPV (no lo escribe).
 *
 * Cómo se fuerza el cruce, sin depender del reloj: una espía sobre `orderCustomer.findMany` (lo lee la corrida) arranca la
 * liga en cuanto la corrida leyó «sin clientes» y espera a que la liga llegue a su barrera (después de su última escritura,
 * antes del commit). Luego la prueba OBSERVA en `pg_stat_activity` el cierre esperando el candado y suelta la liga.
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

import * as tardia from '@/services/shared/loyaltyOnLateCustomer'
import { awardLoyaltyForPaidOrder } from '@/services/shared/loyaltyOnPaidOrder'
import { attachCustomerToOrder } from '@/services/mobile/order.mobile.service'
import { LoyaltyReconciliationJob } from '@/jobs/loyalty-reconciliation.job'
import { esperarBloqueado } from '@tests/__helpers__/candadosDePostgres'

/** Texto EXACTO del ruling: la marca de fila que deja la reapertura. */
const MARCA = 'REABIERTA: cliente ligado después del cobro'

const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
let orgId: string | undefined
let venueId: string | undefined
let n = 0

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `ITEST Cruce ${sello}`, email: `itest-cruce-${sello}@test.com`, phone: '5550000000' },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { name: `itest-cruce-${sello}`, slug: `itest-cruce-${sello}`, organizationId: orgId, timezone: 'America/Mexico_City' },
    })
  ).id
})

afterAll(async () => {
  // 🔴 Sin fixture no se limpia NADA: un filtro con venueId undefined borraría tablas enteras.
  if (!venueId || !orgId) return
  await prisma.order.deleteMany({ where: { venueId } }) // OrderCustomer cae en cascada
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

async function cliente(): Promise<string> {
  // Teléfono distinto por cliente: (venueId, phone) es único.
  const i = ++n
  return (
    await prisma.customer.create({ data: { venueId: venueId!, firstName: `Cruce ${i}`, phone: `+52554345${String(i).padStart(4, '0')}` } })
  ).id
}

/** Venta cobrada SIN cliente hace un minuto, con la lealtad del cobro todavía en curso (`loyaltyProcessedAt` null). */
async function ventaCobradaSinCliente(): Promise<string> {
  const o = await prisma.order.create({
    data: {
      venueId: venueId!,
      orderNumber: `ORD-CRUCE-${sello}-${++n}`,
      subtotal: 50,
      taxAmount: 0,
      total: 50,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      loyaltyEligibleAt: new Date(Date.now() - 60_000),
    },
  })
  return o.id
}

/** Rechaza a los `ms` con un mensaje claro: la prueba nunca se cuelga si la liga no llega a su barrera. */
function aTiempo<T>(p: Promise<T>, ms: number, que: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${que}`)), ms).unref())])
}

/** ¿El cierre de la lealtad está ESPERANDO un candado? (el `UPDATE "Order"` que escribe `loyaltyProcessedAt`). */
async function cierreBloqueadoObservado(ms = 10_000): Promise<boolean> {
  const limite = Date.now() + ms
  while (Date.now() < limite) {
    const filas = await prisma.$queryRawUnsafe<Array<{ pid: number }>>(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query ILIKE '%UPDATE%"Order"%' AND query ILIKE '%loyaltyProcessedAt%'`,
    )
    if (filas.length > 0) return true
    await new Promise(r => setTimeout(r, 20))
  }
  return false
}

/**
 * Corre la lealtad del cobro y, justo después de que lea «sin clientes», arranca `ligar`. `ligar` recibe `pararAntesDelCommit`
 * y debe llamarla DENTRO de su transacción, después de su última escritura: ahí se queda con el candado de la fila hasta que
 * la prueba vea el cierre esperándolo.
 */
async function cruzarCierreConLiga<T>(orderId: string, ligar: (pararAntesDelCommit: () => Promise<void>) => Promise<T>) {
  let soltarLiga: () => void = () => undefined
  const ligaPuedeTerminar = new Promise<void>(r => (soltarLiga = r))
  let ligaLlego: () => void = () => undefined
  const ligaEnSuBarrera = new Promise<void>(r => (ligaLlego = r))
  const pararAntesDelCommit = async () => {
    ligaLlego()
    await ligaPuedeTerminar
  }

  let liga: Promise<T> | undefined
  const leerClientes = prisma.orderCustomer.findMany.bind(prisma.orderCustomer)
  const espia = jest.spyOn(prisma.orderCustomer, 'findMany').mockImplementation((async (args: any) => {
    const leidos = await leerClientes(args) // la corrida del cobro: «sin clientes»
    if (!liga) {
      liga = ligar(pararAntesDelCommit)
      liga.catch(() => undefined) // se espera (y se revisa) abajo
      await aTiempo(ligaEnSuBarrera, 8_000, 'la liga no llegó a su última escritura antes del commit')
    }
    return leidos
  }) as never)

  try {
    const corrida = awardLoyaltyForPaidOrder({ venueId: venueId!, orderId, orderTotal: 50 })
    const bloqueado = await cierreBloqueadoObservado()
    soltarLiga()
    const resultado = await corrida
    const ligada = await liga
    return { bloqueado, resultado, ligada }
  } finally {
    soltarLiga()
    espia.mockRestore()
  }
}

/** Lo que importa: la venta quedó para el reconciliador de SIEMPRE, y él la encuentra y la termina. */
async function elReconciliadorLaTermina(orderId: string) {
  const fila = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { loyaltyProcessedAt: true, loyaltyEligibleAt: true, loyaltyProcessingAt: true, loyaltyLastError: true },
  })
  // Si el cierre viejo hubiera pasado, aquí habría una fecha y el reconciliador jamás volvería a ver la venta.
  expect(fila.loyaltyProcessedAt).toBeNull()
  expect(fila.loyaltyEligibleAt).not.toBeNull()
  expect(fila.loyaltyProcessingAt).toBeNull()
  expect(fila.loyaltyLastError).toBe(MARCA)

  // El reconciliador real (su consulta y su reclamo), acotado a ESTA venta: otras pruebas pueden compartir la base.
  const soloEsta = (args: any) => ({ ...args, where: { AND: [args.where, { id: orderId }] } })
  const award = jest.fn().mockResolvedValue({ complete: true, errors: [] })
  const job = new LoyaltyReconciliationJob({
    prisma: {
      order: {
        findMany: (args: any) => prisma.order.findMany(soloEsta(args)),
        updateMany: (args: any) => prisma.order.updateMany(soloEsta(args)),
      },
    } as never,
    cron: { start: jest.fn(), stop: jest.fn() },
    award,
    now: () => new Date(),
  })
  expect(await job.runNow()).toMatchObject({ scanned: 1, applied: 1 })
  expect(award).toHaveBeenCalledWith(expect.objectContaining({ venueId, orderId }))
  const cerrada = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { loyaltyProcessedAt: true, loyaltyLastError: true },
  })
  expect(cerrada.loyaltyProcessedAt).toBeInstanceOf(Date)
  expect(cerrada.loyaltyLastError).toBeNull() // el cierre bueno borra la marca
}

describe('🔴 cruce exacto: el cierre «sin cliente» espera el candado de la liga y, al soltarse, NO cierra (Postgres real)', () => {
  it('liga con la forma de la TPV (crea el OrderCustomer y reabre; no escribe Order.customerId)', async () => {
    const c = await cliente()
    const orderId = await ventaCobradaSinCliente()

    const { bloqueado, resultado, ligada } = await cruzarCierreConLiga(orderId, para =>
      prisma.$transaction(
        async tx => {
          await tx.orderCustomer.create({ data: { orderId, customerId: c, isPrimary: true } })
          const reabrio = await tardia.reabrirLealtadSiAplica(tx, { venueId: venueId!, orderId, customerId: c })
          await para()
          return reabrio
        },
        { timeout: 30_000 },
      ),
    )

    expect(bloqueado).toBe(true) // el cruce EXACTO sí ocurrió: el cierre esperó el candado de la liga
    expect(ligada).toBe(true) // la liga reabrió
    expect(resultado).toEqual({ complete: true, errors: [] })
    await elReconciliadorLaTermina(orderId)
  })

  it('«Agregar cliente» del móvil de verdad (attachCustomerToOrder: escribe Order.customerId y reabre al final) y el proceso muere tras el commit', async () => {
    const c = await cliente()
    const orderId = await ventaCobradaSinCliente()

    // Barrera DESPUÉS de la reapertura (la última escritura de la liga) y antes del commit.
    let para: () => Promise<void> = async () => undefined
    const reabrirDeVerdad = tardia.reabrirLealtadSiAplica
    const espiaReabrir = jest.spyOn(tardia, 'reabrirLealtadSiAplica').mockImplementation((async (tx: any, args: any, now?: number) => {
      const r = await reabrirDeVerdad(tx, args, now)
      await para()
      return r
    }) as never)
    // El proceso muere justo después del commit de la liga: el intento inmediato nunca corre. Lo único que queda es el
    // trabajo durable que dejó la liga.
    const espiaIntento = jest.spyOn(tardia, 'awardLoyaltyForLateCustomer').mockResolvedValue(null)

    try {
      const { bloqueado, resultado, ligada } = await cruzarCierreConLiga(orderId, p => {
        para = p
        return attachCustomerToOrder(venueId!, orderId, c)
      })

      expect(bloqueado).toBe(true)
      expect(espiaReabrir).toHaveBeenCalledTimes(1)
      expect(resultado).toEqual({ complete: true, errors: [] })
      expect(ligada).toMatchObject({ id: orderId, customerId: c })
      const orden = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { customerId: true } })
      expect(orden.customerId).toBe(c)
      await elReconciliadorLaTermina(orderId)
    } finally {
      espiaReabrir.mockRestore()
      espiaIntento.mockRestore()
    }
  })

  it('regresión: la venta que SIGUE sin cliente se cierra (la marca no deja colgada una venta de mostrador)', async () => {
    const orderId = await ventaCobradaSinCliente()

    expect(await awardLoyaltyForPaidOrder({ venueId: venueId!, orderId, orderTotal: 50 })).toEqual({ complete: true, errors: [] })

    const fila = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { loyaltyProcessedAt: true } })
    expect(fila.loyaltyProcessedAt).toBeInstanceOf(Date)
  })
})

/**
 * 🔴 H2 (auditoría de Codex del código + revisión final Minor 3, 15-oct-2026): las escrituras de FALLO no pueden borrar la
 * marca. El cruce de TRES participantes: la liga tiene el candado de la fila (ya escribió la marca); un trabajador cuya
 * lealtad falló llega a su escritura de fallo y espera PRIMERO; detrás espera el cierre «sin cliente» de otra corrida. Al
 * soltarse la liga, el fallo pasaba primero y PISABA la marca con su texto de error; el cierre, que relee sólo las columnas
 * de la fila y conserva su foto vieja de los clientes, ya no veía la marca y cerraba la venta: el sello se perdía otra vez.
 */
describe('🔴 H2: la escritura de fallo conserva la marca de la reapertura (Postgres real)', () => {
  /** Acota el reconciliador real a ESTA venta (otras pruebas comparten la base). */
  const reconciliadorDe = (orderId: string, award: jest.Mock) => {
    const soloEsta = (args: any) => ({ ...args, where: { AND: [args.where, { id: orderId }] } })
    return new LoyaltyReconciliationJob({
      prisma: {
        order: {
          findMany: (args: any) => prisma.order.findMany(soloEsta(args)),
          updateMany: (args: any) => prisma.order.updateMany(soloEsta(args)),
        },
      } as never,
      cron: { start: jest.fn(), stop: jest.fn() },
      award,
      now: () => new Date(),
    })
  }

  it('🔴 tres participantes: liga con el candado → fallo esperando → cierre «sin cliente» esperando detrás ⇒ la venta sigue pendiente y con su marca', async () => {
    const c = await cliente()
    const orderId = await ventaCobradaSinCliente()

    // 1) La liga: crea el OrderCustomer, reabre (deja la marca) y se queda con el candado de la fila, sin commit.
    let soltarLiga: () => void = () => undefined
    const ligaPuedeTerminar = new Promise<void>(r => (soltarLiga = r))
    let avisarPid: (pid: number) => void = () => undefined
    const pidDeLaLiga = new Promise<number>(r => (avisarPid = r))
    const liga = prisma.$transaction(
      async tx => {
        await tx.orderCustomer.create({ data: { orderId, customerId: c, isPrimary: true } })
        const reabrio = await tardia.reabrirLealtadSiAplica(tx, { venueId: venueId!, orderId, customerId: c })
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        avisarPid(Number(pid))
        await ligaPuedeTerminar
        return reabrio
      },
      { timeout: 30_000 },
    )
    liga.catch(() => undefined)

    // La 1.ª lectura de clientes (el trabajador que falla) truena; la 2.ª (la corrida vieja) lee la base de verdad: «sin
    // clientes», porque la liga todavía no hace commit.
    const leerClientes = prisma.orderCustomer.findMany.bind(prisma.orderCustomer)
    let lecturas = 0
    const espia = jest.spyOn(prisma.orderCustomer, 'findMany').mockImplementation((async (args: any) => {
      lecturas += 1
      if (lecturas === 1) throw new Error('P1001: simulado (la base se cayó a media lealtad)')
      return leerClientes(args)
    }) as never)

    let fallida: ReturnType<typeof awardLoyaltyForPaidOrder> | undefined
    let vieja: ReturnType<typeof awardLoyaltyForPaidOrder> | undefined
    try {
      const pidLiga = await aTiempo(pidDeLaLiga, 8_000, 'la liga no llegó a su barrera')
      // 2) El trabajador que falló llega a su escritura de fallo y espera el candado de la liga (PRIMERO en la fila).
      fallida = awardLoyaltyForPaidOrder({ venueId: venueId!, orderId, orderTotal: 50 })
      const esperaDelFallo = await esperarBloqueado(prisma, {
        bloqueadoPor: [pidLiga],
        consulta: /UPDATE[\s\S]*"Order"[\s\S]*SET\s+"loyaltyLastError"/,
      })
      expect(esperaDelFallo).not.toBeNull()
      // 3) DETRÁS de él, el cierre «sin cliente» de otra corrida.
      vieja = awardLoyaltyForPaidOrder({ venueId: venueId!, orderId, orderTotal: 50 })
      const esperaDelCierre = await esperarBloqueado(prisma, {
        bloqueadoPor: [pidLiga, esperaDelFallo!.pid],
        consulta: /UPDATE[\s\S]*"Order"[\s\S]*SET\s+"loyaltyProcessedAt"/,
        excepto: [esperaDelFallo!.pid],
      })
      expect(esperaDelCierre).not.toBeNull()
    } finally {
      // 4) Se suelta la liga: primero pasa el fallo, después el cierre.
      soltarLiga()
    }
    const [resultadoFallido, resultadoViejo, reabrio] = await Promise.all([fallida!, vieja!, liga]).finally(() => espia.mockRestore())
    expect(reabrio).toBe(true)
    expect(resultadoFallido.complete).toBe(false)
    expect(resultadoViejo).toEqual({ complete: true, errors: [] })

    // La venta sigue para el reconciliador, con la marca intacta, y él la termina.
    await elReconciliadorLaTermina(orderId)
  })

  it('🔴 el reconciliador: si su lealtad falla sobre una venta REABIERTA, suelta su reclamo SIN borrar la marca', async () => {
    const c = await cliente()
    const orderId = await ventaCobradaSinCliente()
    // La liga hace commit (marca) y su intento inmediato no llega (el proceso murió).
    await prisma.$transaction(async tx => {
      await tx.orderCustomer.create({ data: { orderId, customerId: c, isPrimary: true } })
      expect(await tardia.reabrirLealtadSiAplica(tx, { venueId: venueId!, orderId, customerId: c })).toBe(true)
    })

    // El reconciliador la reclama y su lealtad falla.
    const fallo = jest.fn().mockResolvedValue({ complete: false, errors: ['loyalty:caída'] })
    expect(await reconciliadorDe(orderId, fallo).runNow()).toMatchObject({ scanned: 1, failed: 1 })

    const fila = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { loyaltyProcessedAt: true, loyaltyProcessingAt: true, loyaltyLastError: true },
    })
    expect(fila).toEqual({ loyaltyProcessedAt: null, loyaltyProcessingAt: null, loyaltyLastError: MARCA })

    // Y la siguiente vuelta la termina.
    await elReconciliadorLaTermina(orderId)
  })
})
