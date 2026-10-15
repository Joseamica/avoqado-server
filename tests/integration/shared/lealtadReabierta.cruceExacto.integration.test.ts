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
