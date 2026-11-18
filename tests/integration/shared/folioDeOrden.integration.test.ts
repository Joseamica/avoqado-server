/**
 * D30 (17-nov-2026) — dos cuentas nuevas nunca reciben el mismo folio completo. Postgres REAL.
 *
 * El caso (ensayo del 17-nov): la SAMSUNG y la D3 subieron su cola a la vez; dos `OPEN_TABLE` de mesas distintas armaron
 * `ORD-${Date.now()}` en el mismo milisegundo y las dos cuentas quedaron `ORD-1794963374538`. Ahora el folio lo pone la base
 * (`order_number_next()`, una secuencia compartida): distinto con el mismo reloj, en procesos distintos y tras reiniciar uno.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { Client } from 'pg'
import prisma from '@/utils/prismaClient'
import { assignTable } from '@/services/tpv/table.tpv.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.setTimeout(60_000)

const RAIZ = path.join(__dirname, '../../..')
const MIGRACION = fs.readFileSync(path.join(RAIZ, 'prisma/migrations/20261118120000_d30_folio_de_la_base/migration.sql'), 'utf8')
const FOLIO = /^ORD-0\d{12}$/
const RELOJ_DEL_ENSAYO = 1_794_963_374_538
const fixture = `d30-${randomUUID().slice(0, 8)}`
let venueId: string
let mesera: string

const numero = (folio: string) => Number(folio.slice('ORD-0'.length, 'ORD-0'.length + 12))
const mesas = (n: number) =>
  Promise.all(
    Array.from({ length: n }, () =>
      prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 8), capacity: 4, qrCode: randomUUID() }, select: { id: true } }),
    ),
  ).then(ms => ms.map(m => m.id))

type Folio = { id: string; folio: string }
/** Otro servidor: un Node aparte (`tsx`) con su propio cliente de Prisma que abre mesas con `assignTable`. */
function lanzarProceso() {
  const hijo: ChildProcessWithoutNullStreams = spawn(
    path.join(RAIZ, 'node_modules/.bin/tsx'),
    [path.join(__dirname, 'folioDeOrden.proceso.ts')],
    { cwd: RAIZ, env: { ...process.env } },
  )
  let errores = ''
  hijo.stderr.on('data', d => (errores += d))
  const esperando: Array<(linea: string) => void> = []
  readline.createInterface({ input: hijo.stdout }).on('line', linea => {
    if (linea.startsWith('D30>')) esperando.shift()?.(linea.slice(4))
  })
  const siguiente = (que: string) =>
    new Promise<string>((ok, mal) => {
      const reloj = setTimeout(() => mal(new Error(`el proceso no contestó ${que}: ${errores.slice(-2000)}`)), 45_000)
      esperando.push(linea => (clearTimeout(reloj), ok(linea)))
    })
  const enviar = (ids: string[], t0: number) => hijo.stdin.write(`${JSON.stringify({ venueId, staffId: mesera, mesas: ids, t0 })}\n`)
  return {
    listo: siguiente('LISTO'),
    enviar,
    async abrir(ids: string[], t0: number): Promise<Folio[]> {
      const respuesta = siguiente('las mesas')
      enviar(ids, t0)
      return JSON.parse(await respuesta)
    },
    matar: () =>
      new Promise<void>(ok => {
        if (hijo.exitCode !== null || hijo.signalCode !== null) return ok()
        hijo.once('exit', () => ok())
        hijo.kill('SIGKILL')
      }),
  }
}

/**
 * Corre la migración de D30 COMPLETA en un esquema vacío propio (su "Order" ya trae `filas`), como `migrate deploy`: el archivo en
 * un solo lote, en una transacción implícita. Devuelve el primer folio que da el valor por defecto.
 */
async function migrarCon(filas: string[]): Promise<string> {
  const esquema = `d30_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  const c = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await c.connect()
  try {
    await c.query(`CREATE SCHEMA ${esquema}; CREATE TABLE ${esquema}."Order" ("orderNumber" TEXT NOT NULL)`)
    for (const f of filas) await c.query(`INSERT INTO ${esquema}."Order" VALUES ($1)`, [f])
    await c.query(`SET search_path TO ${esquema}`)
    try {
      await c.query(MIGRACION)
    } catch (error) {
      // Si falla, no queda nada aplicado: ni la secuencia ni el valor por defecto.
      expect((await c.query(`SELECT to_regclass('${esquema}.order_number_seq') AS s`)).rows[0].s).toBeNull()
      throw error
    }
    return (await c.query(`INSERT INTO "Order" DEFAULT VALUES RETURNING "orderNumber"`)).rows[0].orderNumber
  } finally {
    await c.query(`DROP SCHEMA ${esquema} CASCADE`)
    await c.end()
  }
}

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: fixture, email: `${fixture}@example.test`, phone: '' } })
  venueId = (
    await prisma.venue.create({ data: { organizationId: org.id, name: fixture, slug: fixture, type: 'RESTAURANT', status: 'TRIAL' } })
  ).id
  await prisma.venueSettings.create({ data: { venueId, enableShifts: false, requirePinLogin: false } })
  mesera = (await prisma.staff.create({ data: { email: `m-${fixture}@staff.test`, firstName: 'Mesera', lastName: 'Uno', active: true } }))
    .id
  await prisma.staffVenue.create({ data: { venueId, staffId: mesera, role: 'WAITER' } })
})
afterEach(() => jest.restoreAllMocks())
afterAll(async () => {
  await prisma.$disconnect()
}) // Se conservan las filas únicas de esta corrida como evidencia.

describe('D30 · el folio de la orden lo pone la base', () => {
  it('la secuencia tope 999999999999 no da la vuelta, y es el valor por defecto de Order.orderNumber', async () => {
    const [seq] = await prisma.$queryRaw<Array<{ max_value: bigint; cycle: boolean }>>`
      SELECT max_value, cycle FROM pg_sequences WHERE sequencename = 'order_number_seq'`
    expect(seq).toEqual({ max_value: BigInt('999999999999'), cycle: false })
    const [col] = await prisma.$queryRaw<Array<{ column_default: string }>>`
      SELECT column_default FROM information_schema.columns WHERE table_name = 'Order' AND column_name = 'orderNumber'`
    expect(col.column_default).toBe('order_number_next()')
  })

  it('el ensayo del 17-nov: dos mesas abiertas en el mismo milisegundo reciben folios distintos', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(RELOJ_DEL_ENSAYO)
    const [m6, m1] = await mesas(2)

    const [uno, dos] = await Promise.all([assignTable(venueId, m6, mesera, 2), assignTable(venueId, m1, mesera, 2)])

    expect(uno.order.orderNumber).toMatch(FOLIO)
    expect(dos.order.orderNumber).toMatch(FOLIO)
    expect(uno.order.orderNumber).not.toBe(dos.order.orderNumber)
    for (const { order } of [uno, dos]) {
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).orderNumber).toBe(order.orderNumber)
    }
  })

  it('dos procesos Node independientes abren mesas a la vez, con el reloj congelado, sin repetir folio; también tras matar y relanzar uno', async () => {
    const libres = await mesas(40)
    let a = lanzarProceso()
    const b = lanzarProceso()
    try {
      await Promise.all([a.listo, b.listo])

      // Ronda 1: los dos procesos escriben en el mismo instante.
      const t0 = Date.now() + 500
      const ronda1 = (await Promise.all([a.abrir(libres.slice(0, 10), t0), b.abrir(libres.slice(10, 20), t0)])).flat()

      // A muere a media escritura (respuesta perdida) y se relanza; B sigue vivo con su pool.
      a.enviar(libres.slice(20, 25), Date.now())
      await new Promise(r => setTimeout(r, 40))
      await a.matar()
      a = lanzarProceso()
      await a.listo

      const t1 = Date.now() + 500
      const ronda2 = (await Promise.all([a.abrir(libres.slice(25, 32), t1), b.abrir(libres.slice(32, 40), t1)])).flat()

      const folios = [...ronda1, ...ronda2].map(o => o.folio)
      expect(folios.every(f => FOLIO.test(f))).toBe(true)
      expect(new Set(folios).size).toBe(folios.length)
      // La secuencia vive en la base: lo del proceso relanzado va después de todo lo anterior.
      expect(Math.min(...ronda2.map(o => numero(o.folio)))).toBeGreaterThan(Math.max(...ronda1.map(o => numero(o.folio))))
      // Cada respuesta trae lo realmente insertado, y en la base no hay folio repetido (tampoco lo que dejó el proceso muerto).
      const guardadas = await prisma.order.findMany({
        where: { venueId, tableId: { in: libres } },
        select: { id: true, orderNumber: true },
      })
      const porId = new Map(guardadas.map(o => [o.id, o.orderNumber]))
      for (const o of [...ronda1, ...ronda2]) expect(porId.get(o.id)).toBe(o.folio)
      expect(new Set(guardadas.map(o => o.orderNumber)).size).toBe(guardadas.length)
    } finally {
      await Promise.all([a.matar(), b.matar()])
    }
  }, 180_000)

  describe('la migración mide su arranque', () => {
    it('sin folios ORD-0 arranca en 1', async () => {
      expect(await migrarCon([])).toBe('ORD-0000000000001')
    })

    // Codex D30 r1 (ROMPE): una referencia externa con letra al final hacía creer que ya no había folios libres.
    it('`ORD-0999999999999A` de un POS externo no cuenta: migra y arranca en 1', async () => {
      expect(await migrarCon(['ORD-0999999999999A'])).toBe('ORD-0000000000001')
    })

    it('sólo cuentan las dos formas que emite D30; las demás se ignoran', async () => {
      const ajenas = ['ORD-0999999999999-X', 'ORD-0999999999999-S', 'ORD-09999999999990', 'ord-0999999999999', 'ORD-1794963374538']
      expect(await migrarCon(ajenas)).toBe('ORD-0000000000001')
    })

    it('arranca por encima del mayor folio D30, completo o de dividir por asiento', async () => {
      expect(await migrarCon(['ORD-0000000000007', 'ORD-0000500000000-S12', 'ORD-0999999999999A'])).toBe('ORD-0000500000001')
    })

    it('con mil millones de folios libres exactos, migra', async () => {
      expect(await migrarCon(['ORD-0998999999999'])).toBe('ORD-0999000000000')
    })

    it.each(['ORD-0999999999999', 'ORD-0999000000000-S2'])(
      'si ya existe %s (sin margen), falla con un mensaje claro y no aplica nada',
      async folio => {
        await expect(migrarCon([folio])).rejects.toThrow(/folios.*margen/i)
      },
    )
  })
})
