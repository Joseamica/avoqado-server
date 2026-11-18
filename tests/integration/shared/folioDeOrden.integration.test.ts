/**
 * D30 (17-nov-2026) — dos cuentas nuevas nunca reciben el mismo folio completo. Postgres REAL.
 *
 * El caso (ensayo del 17-nov): la SAMSUNG y la D3 subieron su cola a la vez; dos `OPEN_TABLE` de mesas distintas armaron
 * `ORD-${Date.now()}` en el mismo milisegundo y las dos cuentas quedaron `ORD-1794963374538`. Ahora el folio lo pone la base
 * (`order_number_next()`, una secuencia compartida): distinto con el mismo reloj, en procesos distintos y tras reiniciar uno.
 */
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { assignTable } from '@/services/tpv/table.tpv.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.setTimeout(60_000)

const FOLIO = /^ORD-0\d{12}$/
const RELOJ_DEL_ENSAYO = 1_794_963_374_538
const fixture = `d30-${randomUUID().slice(0, 8)}`
let venueId: string
let mesera: string

/** Otro «proceso del servidor»: su propio cliente y su propio pool de conexiones. */
const procesos: PrismaClient[] = []
function otroProceso(): PrismaClient {
  const c = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } })
  procesos.push(c)
  return c
}
const nueva = (c: PrismaClient | typeof prisma) =>
  c.order.create({ data: { venueId, subtotal: 0, taxAmount: 0, total: 0 }, select: { id: true, orderNumber: true } })
const numero = (folio: string) => Number(folio.slice('ORD-0'.length, 'ORD-0'.length + 12))

/** El bloque de la migración que fija el arranque de la secuencia (el mismo texto que corrió en `migrate deploy`). */
function arranqueDeLaMigracion(): string {
  const dir = path.join(__dirname, '../../../prisma/migrations')
  const sql = fs
    .readdirSync(dir)
    .map(d => path.join(dir, d, 'migration.sql'))
    .filter(f => fs.existsSync(f))
    .map(f => fs.readFileSync(f, 'utf8'))
    .find(s => s.includes('CREATE SEQUENCE "order_number_seq"'))
  const bloque = sql?.match(/DO \$\$[\s\S]*?END \$\$;/)?.[0]
  if (!bloque) throw new Error('No encontré el arranque de la secuencia en la migración de D30')
  return bloque
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
  for (const c of procesos) await c.$disconnect()
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

  it('dos procesos a la vez, con el reloj congelado, nunca repiten folio; y tras reiniciar uno, tampoco', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(RELOJ_DEL_ENSAYO)
    const a = otroProceso()
    const b = otroProceso()
    const creadas = await Promise.all(Array.from({ length: 20 }, (_, i) => nueva(i % 2 ? a : b)))

    const folios = creadas.map(o => o.orderNumber)
    expect(folios.every(f => FOLIO.test(f))).toBe(true)
    expect(new Set(folios).size).toBe(20)
    // Cada respuesta trae lo realmente insertado.
    const guardadas = await prisma.order.findMany({
      where: { id: { in: creadas.map(o => o.id) } },
      select: { id: true, orderNumber: true },
    })
    expect(new Map(guardadas.map(o => [o.id, o.orderNumber]))).toEqual(new Map(creadas.map(o => [o.id, o.orderNumber])))

    // «Reiniciar el proceso»: se cierra su pool y nace otro; la secuencia vive en la base y sigue adelante.
    await a.$disconnect()
    const despues = await nueva(otroProceso())
    expect(despues.orderNumber).toMatch(FOLIO)
    expect(folios).not.toContain(despues.orderNumber)
    expect(numero(despues.orderNumber)).toBeGreaterThan(Math.max(...folios.map(numero)))
  })

  it('el ensayo del 17-nov: dos mesas abiertas en el mismo milisegundo reciben folios distintos', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(RELOJ_DEL_ENSAYO)
    const [m6, m1] = await Promise.all(
      ['M6', 'M1'].map(n =>
        prisma.table.create({ data: { venueId, number: `${n}-${fixture}`, capacity: 4, qrCode: randomUUID() }, select: { id: true } }),
      ),
    )

    const [uno, dos] = await Promise.all([assignTable(venueId, m6.id, mesera, 2), assignTable(venueId, m1.id, mesera, 2)])

    expect(uno.order.orderNumber).toMatch(FOLIO)
    expect(dos.order.orderNumber).toMatch(FOLIO)
    expect(uno.order.orderNumber).not.toBe(dos.order.orderNumber)
    for (const { order } of [uno, dos]) {
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).orderNumber).toBe(order.orderNumber)
    }
  })

  it('la migración arranca por encima del mayor folio `ORD-0…` que ya existe, también con sufijo', async () => {
    await prisma.order.create({ data: { venueId, orderNumber: 'ORD-0500000000000-S2', subtotal: 0, taxAmount: 0, total: 0 } })

    await prisma.$executeRawUnsafe(arranqueDeLaMigracion())

    expect(numero((await nueva(prisma)).orderNumber)).toBeGreaterThan(500_000_000_000)
  })

  it.each(['ORD-0999999999999', 'ORD-0999000000000-S2'])(
    'si ya existe %s (sin margen), la migración falla con un mensaje claro y no mueve la secuencia',
    async folio => {
      const ocupada = await prisma.order.create({ data: { venueId, orderNumber: folio, subtotal: 0, taxAmount: 0, total: 0 } })
      try {
        const [antes] = await prisma.$queryRaw<Array<{ last_value: bigint }>>`SELECT last_value FROM order_number_seq`

        await expect(prisma.$executeRawUnsafe(arranqueDeLaMigracion())).rejects.toThrow(/folios.*margen/i)

        const [despues] = await prisma.$queryRaw<Array<{ last_value: bigint }>>`SELECT last_value FROM order_number_seq`
        expect(despues.last_value).toBe(antes.last_value)
      } finally {
        await prisma.order.delete({ where: { id: ocupada.id } })
      }
    },
  )
})
