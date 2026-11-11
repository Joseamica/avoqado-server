/**
 * hz:381780f0:D1 (Codex r4 #2 de D25) — PostgreSQL real. Un interbloqueo (40P01) que agota `withDeadlockRetry` sale de la base
 * envuelto: en una consulta cruda como `P2010` con el SQLSTATE en `meta.code`; en una de modelo, sin código exterior. La cola sin
 * red lo mandaba a cuarentena (REJECTED) aunque es pasajero.
 *
 *  (a) y (b) provocan un 40P01 de verdad (dos transacciones, candados en orden inverso) y fijan su forma.
 *  (c) el recorrido: una caja anula sin red (CANCEL_ORDER por el reducer real) mientras otra caja tiene la cuenta y luego pide
 *      su candado de comandas. Postgres elige víctima a la anulación; con un solo intento, el reducer debe contestar RETRY, no
 *      guardar rechazo y, al repetir el intent, anular la cuenta una vez.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { esErrorTransitorio } from '@/services/shared/erroresTransitorios'
import { REINTENTO_POR_INTERBLOQUEO } from '@/utils/serializableRetry'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.setTimeout(60_000)

type Tx = Prisma.TransactionClient
const fixture = `interbloqueo-${randomUUID().slice(0, 8)}`
const device = 'device-interbloqueo'
let venueId: string
let staffId: string
let productId: string
let seq = 0

const params = (intents: any[]) => ({ venueId, staffId, deviceId: device, intents, authorizeIntent: () => true })
const OPCIONES_TX = { timeout: 30_000, maxWait: 10_000 }

function senal<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => (resolve = r))
  return { promise, resolve }
}

/**
 * Hasta que la sesión que cumple `quien` (en ESTA base y que no sea `miPid`) quede esperando un candado. Apunta a una sesión
 * concreta: «cualquiera esperando» podía ser otra y armar un cruce que no es el de la prueba (Codex r1 #2).
 */
async function esperarQueEspere(miPid: number, quien: Prisma.Sql): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> ${miPid}::int AND ${quien}`
    if (n > 0) return
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('La sesión esperada no quedó esperando un candado en 10 s: el cruce no se armó')
}
const pidDe = async (tx: Tx) => (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid

/**
 * A toma X y luego pide Y; B toma Y y, cuando A (por su pid) ya espera, pide X: un ciclo. Postgres aborta a una de las dos —la
 * que corre su revisión de `deadlock_timeout` con el ciclo ya armado—; aquí sólo importa la FORMA del error de la víctima, sea
 * cual sea. Devuelve ese error.
 */
async function interbloqueo(x: (tx: Tx) => Promise<unknown>, y: (tx: Tx) => Promise<unknown>): Promise<unknown> {
  const aTieneX = senal<number>()
  const bTieneY = senal()
  const resultados = await Promise.allSettled([
    prisma.$transaction(async tx => {
      await x(tx)
      aTieneX.resolve(await pidDe(tx))
      await bTieneY.promise
      await y(tx)
    }, OPCIONES_TX),
    prisma.$transaction(async tx => {
      const pidA = await aTieneX.promise
      await y(tx)
      bTieneY.resolve()
      await esperarQueEspere(await pidDe(tx), Prisma.sql`pid = ${pidA}::int`)
      await x(tx)
    }, OPCIONES_TX),
  ])
  const fallidas = resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  expect(fallidas).toHaveLength(1)
  return fallidas[0].reason
}

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: fixture, email: `${fixture}@example.test`, phone: '' } })
  const venue = await prisma.venue.create({
    data: { organizationId: org.id, name: fixture, slug: fixture, type: 'RESTAURANT', status: 'TRIAL' },
  })
  venueId = venue.id
  await prisma.venueSettings.create({ data: { venueId, enableShifts: false, requirePinLogin: false } })
  const staff = await prisma.staff.create({
    data: { email: `${fixture}@staff.test`, firstName: 'Interbloqueo', lastName: 'QA', active: true },
  })
  staffId = staff.id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'OWNER' } })
  const cat = await prisma.menuCategory.create({ data: { venueId, name: 'Cocina', slug: 'cocina' } })
  productId = (await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Taco', sku: 'INT-1', price: 50 } })).id
})
afterAll(async () => {
  await prisma.$disconnect()
}) // Se conservan las filas únicas de esta corrida como evidencia.

async function mesa(): Promise<string> {
  const t = await prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 6), capacity: 4, qrCode: randomUUID() } })
  return t.id
}

describe('la forma real del interbloqueo (40P01)', () => {
  it('(a) en una consulta cruda (pg_advisory_xact_lock) sale como P2010 con el 40P01 en meta.code, y es transitorio', async () => {
    const candado = (nombre: string) => (tx: Tx) =>
      tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${fixture}:${nombre}`}, 0))::text`

    const error = await interbloqueo(candado('x'), candado('y'))

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    expect(error).toMatchObject({ code: 'P2010', meta: { code: '40P01' } })
    expect(esErrorTransitorio(error)).toBe(true)
  })

  it('(b) en una consulta de modelo (update de dos mesas en orden inverso) también es transitorio', async () => {
    const [m1, m2] = [await mesa(), await mesa()]
    const tocar = (id: string) => (tx: Tx) => tx.table.update({ where: { id }, data: { capacity: { increment: 1 } } })

    const error = await interbloqueo(tocar(m1), tocar(m2))

    // Prisma 6.19 no le da código a un 40P01 de modelo: el SQLSTATE viaja sólo en el mensaje (forma medida el 28-sep).
    expect(error).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError)
    expect(String((error as Error).message)).toContain('PostgresError { code: "40P01"')
    expect(esErrorTransitorio(error)).toBe(true)
  })
})

describe('(c) recorrido: anular sin red mientras otra caja toca la misma cuenta', () => {
  /** Abre una cuenta con un platillo por la cola, como lo haría el aparato. */
  async function cuentaConPlatillo() {
    const tableId = await mesa()
    const localOrderId = randomUUID()
    const [abrir, agregar] = await processIntents(
      params([
        { id: randomUUID(), seq: ++seq, type: 'OPEN_TABLE', payload: { tableId, covers: 2, localOrderId } },
        { id: randomUUID(), seq: ++seq, type: 'ADD_ITEMS', payload: { localOrderId, items: [{ productId, quantity: 1 }] } },
      ]),
    )
    expect([abrir.status, agregar.status]).toEqual(['ACKED', 'ACKED'])
    return { orderId: String(abrir.result!.orderId), localOrderId }
  }

  /**
   * La otra caja tiene la fila de la cuenta; cuando la anulación ya espera por ella (con el candado de comandas en la mano: su
   * `FOR UPDATE` sobre "Order"), pide ese candado. Ciclo. Devuelve el ack de la anulación y si la víctima fue la otra caja.
   */
  async function cruce(orderId: string, anular: { id: string }) {
    const otraCajaTieneLaCuenta = senal()
    // Su error se atrapa AL CREARLA (Codex r2 #4): si la víctima es la otra caja, su rechazo nunca queda sin manejador
    // mientras la anulación termina. Resuelve con el error (o null si terminó bien).
    const otraCaja: Promise<unknown> = prisma
      .$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`
        otraCajaTieneLaCuenta.resolve()
        await esperarQueEspere(await pidDe(tx), Prisma.sql`query LIKE '%FROM "Order"%FOR UPDATE%'`)
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`kds-order:${orderId}`}, 0))::text`
      }, OPCIONES_TX)
      .then(
        () => null,
        (e: unknown) => e,
      )
    await Promise.race([otraCajaTieneLaCuenta.promise, otraCaja])
    const [ack] = await processIntents(params([anular]))
    const otra = await otraCaja
    return { ack, perdioLaOtraCaja: otra !== null, errorDeLaOtraCaja: otra }
  }

  it('el interbloqueo que agotó los intentos queda en RETRY y, al repetirse, la cuenta se anula una vez', async () => {
    const intentosDeHoy = REINTENTO_POR_INTERBLOQUEO.intentos
    REINTENTO_POR_INTERBLOQUEO.intentos = 1 // como si ya se hubieran agotado: el primer 40P01 sale tal cual
    let caso: { orderId: string; anular: { id: string; seq: number; type: 'CANCEL_ORDER'; payload: Record<string, unknown> } } | null = null
    let primero: Awaited<ReturnType<typeof cruce>>['ack'] | null = null
    try {
      // Postgres elige a la víctima (la que revisa el ciclo primero). Si pierde la otra caja, la anulación pasa sin choque: se
      // repite con otra cuenta, nunca se da por bueno ni por malo (Codex r1 #2).
      for (let vuelta = 1; vuelta <= 3 && !caso; vuelta++) {
        const { orderId, localOrderId } = await cuentaConPlatillo()
        const anular = { id: randomUUID(), seq: ++seq, type: 'CANCEL_ORDER' as const, payload: { localOrderId, reason: 'interbloqueo' } }
        const r = await cruce(orderId, anular)
        if (r.perdioLaOtraCaja) {
          expect(r.errorDeLaOtraCaja).toMatchObject({ code: 'P2010', meta: { code: '40P01' } })
          expect(r.ack).toMatchObject({ id: anular.id, status: 'ACKED' })
          continue
        }
        caso = { orderId, anular }
        primero = r.ack
      }
    } finally {
      REINTENTO_POR_INTERBLOQUEO.intentos = intentosDeHoy
    }
    if (!caso || !primero) throw new Error('En 3 vueltas Postgres eligió siempre a la otra caja: el cruce no probó nada')

    expect(primero).toMatchObject({ id: caso.anular.id, status: 'RETRY', errorCode: 'P2010' })
    expect(primero.message).toContain('40P01')
    const reserva = await prisma.posSyncIntent.findUnique({
      where: { venueId_idempotencyKey: { venueId, idempotencyKey: caso.anular.id } },
    })
    expect(reserva?.status).not.toBe('REJECTED')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: caso.orderId } })).status).not.toBe('CANCELLED')

    // El aparato vuelve a mandar el mismo intent (RETRY no se guarda): ahora sin choque, se aplica una vez.
    const [segundo] = await processIntents(params([caso.anular]))
    expect(segundo).toMatchObject({ id: caso.anular.id, status: 'ACKED' })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: caso.orderId } })).status).toBe('CANCELLED')
    const [tercero] = await processIntents(params([caso.anular]))
    expect(tercero).toMatchObject({ id: caso.anular.id, status: 'ACKED' })
    expect(await prisma.posSyncIntent.count({ where: { venueId, idempotencyKey: caso.anular.id } })).toBe(1)
  })
})
