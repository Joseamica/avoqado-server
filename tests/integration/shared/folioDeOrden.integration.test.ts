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
let cajera: string

const numero = (folio: string) => Number(folio.slice('ORD-0'.length, 'ORD-0'.length + 12))
const mesas = (n: number) =>
  Promise.all(
    Array.from({ length: n }, () =>
      prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 8), capacity: 4, qrCode: randomUUID() }, select: { id: true } }),
    ),
  ).then(ms => ms.map(m => m.id))

type Folio = { id: string; mesa: string; folio: string }
type Paso = { mesa: string; staffId: string }
/**
 * Otro servidor: un Node aparte con su propio cliente de Prisma que abre mesas con `assignTable`. Se lanza `node --import tsx`
 * (no el lanzador `tsx`, que reenvía señales a un Node hijo): así `pid` ES el escritor y un SIGKILL lo interrumpe de verdad.
 */
function lanzarProceso() {
  const hijo: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(__dirname, 'folioDeOrden.proceso.ts')],
    {
      cwd: RAIZ,
      env: { ...process.env },
    },
  )
  let errores = ''
  hijo.stderr.on('data', d => (errores += d))
  const esperando: Array<(linea: string) => void> = []
  readline.createInterface({ input: hijo.stdout }).on('line', linea => {
    if (linea.startsWith('D30>')) esperando.shift()?.(linea.slice(4))
  })
  const siguiente = <T>(que: string) =>
    new Promise<T>((ok, mal) => {
      const reloj = setTimeout(() => mal(new Error(`el proceso no contestó ${que}: ${errores.slice(-2000)}`)), 45_000)
      esperando.push(linea => (clearTimeout(reloj), ok(JSON.parse(linea))))
    })
  const enviar = (pasos: Paso[], t0: number, serie = false) => hijo.stdin.write(`${JSON.stringify({ venueId, pasos, t0, serie })}\n`)
  return {
    pid: hijo.pid,
    listo: siguiente<{ pid: number }>('LISTO'),
    siguiente,
    enviar,
    async abrir(ids: string[], t0: number): Promise<Folio[]> {
      const respuesta = siguiente<Folio[]>('las mesas')
      enviar(
        ids.map(mesa => ({ mesa, staffId: mesera })),
        t0,
      )
      return respuesta
    },
    matar: () =>
      new Promise<void>(ok => {
        if (hijo.exitCode !== null || hijo.signalCode !== null) return ok()
        hijo.once('exit', () => ok())
        hijo.kill('SIGKILL')
      }),
  }
}

/** Espera (hasta 10 s) a que `cumple` sea verdad. */
async function hasta(que: string, cumple: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await cumple()) return
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`nunca pasó: ${que}`)
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
  cajera = (await prisma.staff.create({ data: { email: `c-${fixture}@staff.test`, firstName: 'Cajera', lastName: 'Dos', active: true } }))
    .id
  await prisma.staffVenue.createMany({
    data: [
      { venueId, staffId: mesera, role: 'WAITER' },
      { venueId, staffId: cajera, role: 'WAITER' },
    ],
  })
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

  it('dos procesos Node independientes abren mesas a la vez, con el reloj congelado, sin repetir folio; uno muere con una mesa escrita y otra en vuelo, y al relanzarlo tampoco repite', async () => {
    const libres = await mesas(40)
    const [escrita, enVuelo] = [libres[20], libres[21]]
    let a = lanzarProceso()
    const b = lanzarProceso()
    const candado = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await candado.connect()
    try {
      // El PID que se matará es el del Node que escribe, no el de un lanzador.
      expect((await a.listo).pid).toBe(a.pid)
      expect((await b.listo).pid).toBe(b.pid)

      // Ronda 1: los dos procesos escriben en el mismo instante.
      const t0 = Date.now() + 500
      const ronda1 = (await Promise.all([a.abrir(libres.slice(0, 10), t0), b.abrir(libres.slice(10, 20), t0)])).flat()

      // A abre `escrita` (a nombre de la mesera) y después `enVuelo` (de la cajera). Este cliente aparta el renglón de la cajera:
      // el INSERT de `enVuelo` ya tomó su folio de la secuencia y espera en la revisión de su llave foránea.
      await candado.query('BEGIN')
      await candado.query('SELECT id FROM "Staff" WHERE id = $1 FOR UPDATE', [cajera])
      const miPid: number = (await candado.query('SELECT pg_backend_pid() AS p')).rows[0].p
      const primera = a.siguiente<Folio[]>('la mesa escrita')
      a.enviar(
        [
          { mesa: escrita, staffId: mesera },
          { mesa: enVuelo, staffId: cajera },
        ],
        Date.now(),
        true,
      )
      const [deEscrita] = await primera
      expect(deEscrita.mesa).toBe(escrita)
      expect((await prisma.order.findFirstOrThrow({ where: { venueId, tableId: escrita } })).orderNumber).toBe(deEscrita.folio)
      let enEspera = 0
      await hasta('que la cuenta en vuelo espere al candado', async () => {
        const filas = await prisma.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity WHERE ${miPid}::int = ANY(pg_blocking_pids(pid))`
        enEspera = filas[0]?.pid ?? 0
        return enEspera > 0
      })
      const tomados = Number((await candado.query('SELECT last_value FROM order_number_seq')).rows[0].last_value)
      expect(tomados).toBe(numero(deEscrita.folio) + 1) // la cuenta en vuelo ya tiene su folio, sin confirmar

      // Muere el escritor con esa cuenta en vuelo (su respuesta se pierde); se suelta el candado y su transacción se deshace.
      await a.matar()
      await candado.query('COMMIT')
      await hasta('que la conexión del escritor muerto termine', async () => {
        const filas = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_stat_activity WHERE pid = ${enEspera}::int`
        return Number(filas[0].n) === 0
      })
      expect(await prisma.order.count({ where: { venueId, tableId: enVuelo } })).toBe(0)

      // Se relanza A (B siguió vivo con su pool) y los dos escriben otra vez a la vez; `enVuelo` se vuelve a abrir.
      a = lanzarProceso()
      expect((await a.listo).pid).toBe(a.pid)
      const t1 = Date.now() + 500
      const ronda2 = (await Promise.all([a.abrir([enVuelo, ...libres.slice(22, 30)], t1), b.abrir(libres.slice(30, 40), t1)])).flat()

      const respuestas = [...ronda1, deEscrita, ...ronda2]
      const folios = respuestas.map(o => o.folio)
      expect(folios.every(f => FOLIO.test(f))).toBe(true)
      expect(new Set(folios).size).toBe(folios.length)
      // La secuencia vive en la base: lo del proceso relanzado va después de todo, también del folio que se llevó la cuenta en vuelo.
      expect(Math.min(...ronda2.map(o => numero(o.folio)))).toBeGreaterThan(tomados)
      // Cada respuesta trae lo realmente insertado; lo que dejó el escritor muerto no repite folio con nada de la base.
      const guardadas = await prisma.order.findMany({
        where: { venueId, tableId: { in: libres } },
        select: { id: true, orderNumber: true },
      })
      expect(guardadas).toHaveLength(respuestas.length)
      const porId = new Map(guardadas.map(o => [o.id, o.orderNumber]))
      for (const o of respuestas) expect(porId.get(o.id)).toBe(o.folio)
      const repetidos = await prisma.$queryRaw<Array<{ orderNumber: string }>>`
        SELECT "orderNumber" FROM "Order" WHERE "orderNumber" ~ '^ORD-0[0-9]{12}$' GROUP BY 1 HAVING count(*) > 1`
      expect(repetidos).toEqual([])
    } finally {
      await candado.query('ROLLBACK').catch(() => undefined)
      await candado.end()
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

    it('sólo cuentan el folio completo y el tronco con `-S…`; las demás formas se ignoran', async () => {
      const ajenas = ['ORD-0999999999999-X', 'ORD-0999999999999-s1', 'ORD-09999999999990', 'ord-0999999999999', 'ORD-1794963374538']
      expect(await migrarCon(ajenas)).toBe('ORD-0000000000001')
    })

    // Codex D30 r2 (ROMPE): el SERVIDOR admite asientos negativos y emite `…-S-1`; si la migración no lo cuenta, la siguiente
    // división por asiento repite ese folio histórico completo.
    it('`ORD-0000000000001-S-1` (asiento negativo) cuenta: arranca en 2', async () => {
      expect(await migrarCon(['ORD-0000000000001-S-1'])).toBe('ORD-0000000000002')
    })

    it.each(['ORD-0000000000009-S', 'ORD-0000000000009-S1.5', 'ORD-0000000000009-S-12'])(
      'cualquier sufijo `-S` que el servidor pueda emitir cuenta (%s): arranca en 10',
      async folio => {
        expect(await migrarCon([folio])).toBe('ORD-0000000000010')
      },
    )

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
