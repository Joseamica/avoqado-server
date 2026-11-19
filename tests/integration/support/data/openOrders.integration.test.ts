/**
 * C3 · «Cuentas abiertas de los últimos 7 días» (la B): qué cuentas de la sucursal siguen debiendo, de la más vieja a la más nueva, sin
 * montos. «Abierta» es la definición del tool `open_orders` del MCP (`openOrdersWhere`); «los últimos 7 días» son los 7 días calendario
 * de la sucursal, hoy incluido, como el «Últimos 7 días» del panel. Postgres de verdad (la base de la nube). Lo que vale para toda
 * capacidad (venenos, logs, candados, datos ajenos) lo prueba el barrido (`sweeps.integration.test.ts`). Las horas son fijas donde la
 * respuesta depende del reloj: el jueves 12-nov-2026 a las 14:32 de la CDMX.
 */
import { PrismaClient, type OrderStatus, type PaymentStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { listOpenOrdersBrief } from '@/services/dashboard/openOrders.service'
import { prepareDataAnswer, type DataOutcome } from '@/services/support/data/answer.service'
import { openOrders } from '@/services/support/data/capabilities/openOrders'
import type { DataRequest, DataScope } from '@/services/support/data/catalog'
import { checkRendered } from '@/services/support/data/check'
import { fmtTime } from '@/services/support/data/format'
import { lastDaysStart } from '@/services/support/data/params'
import { venueDayKey } from '@/utils/venueDateKeys'
import { clearSales, clearTables, seedDataFixture, seedOrder, type DataFixture } from '@tests/__helpers__/supportData'

const CDMX = 'America/Mexico_City'
const DAY = 86_400_000
const REQUEST: DataRequest = { capability: 'open_orders', day: null, amount: null, time: null, otherVenue: false }
const MESSAGE = '¿Qué cuentas tengo abiertas?'
/** El corte de los ejemplos del plan: jueves 12-nov-2026, 14:32 en la CDMX. */
const NOW = new Date('2026-11-12T20:32:00Z')
/** Una hora de un día de noviembre de 2026 en la CDMX (el 12 por omisión). */
const at = (hhmm: string, day = 12) => new Date(`2026-11-${String(day).padStart(2, '0')}T${hhmm}:00-06:00`)

let f: DataFixture
let venues: string[]
beforeAll(async () => {
  f = await seedDataFixture('support-data-open-orders')
  venues = [f.northId, f.cancunId, f.emptyId, f.siblingId, f.foreignId]
})
afterAll(() => f?.clean())
beforeEach(async () => {
  await f.reset()
  process.env.SUPPORT_DATA_ENABLED = 'true'
  await clearSales(venues)
  await clearTables(venues)
  await f.grant({ permissions: ['orders:read'] })
  await f.unlock()
})
afterEach(() => jest.restoreAllMocks())

/** La pregunta por el orquestador, con el reloj de verdad (el desbloqueo es de hoy), en la plática de la persona (una por teléfono). */
const ask = async (venueId = f.northId) =>
  prepareDataAnswer({ conversation: { ...(await f.conversation()), venueId }, request: REQUEST, message: MESSAGE, now: new Date() })
const answered = (out: DataOutcome) => {
  if (out.kind !== 'answer') throw new Error(`open_orders: ${out.text}`)
  return out.envelope.text
}
/** Un alcance armado a mano, con el reloj fijo de los ejemplos. */
const scopeFor = (venueId: string, now = NOW): DataScope => ({
  venueId,
  organizationId: f.orgId,
  venueName: 'Flautas Coyoacán',
  timezone: CDMX,
  day: venueDayKey(now, CDMX),
  kycVerified: true,
  now,
  rows: 5,
  openOrdersDays: 7,
  depositGroups: 2000,
  depositTimeoutMs: 3000,
})
/** La capacidad directa, sin los candados del orquestador: su lectura y su plantilla, que tiene que pasar el cotejo. */
async function answerAt(venueId = f.northId, now = NOW): Promise<string> {
  const scope = scopeFor(venueId, now)
  const params = openOrders.params(REQUEST, MESSAGE, scope)
  if (!params.ok) throw new Error(params.refusal)
  const rendered = openOrders.render(scope, params.value, await openOrders.read(scope, params.value))
  expect(checkRendered(rendered, CDMX)).toBe(true)
  return rendered.text
}
/** Desde cuándo lee la B a la hora fija: el viernes 6-nov a las 00:00 de la CDMX. */
const SINCE = lastDaysStart(7, { timezone: CDMX, now: NOW })

it('an order open for 8 days does not appear, and the answer says «de los últimos 7 días» (case 19)', async () => {
  // Por el orquestador, con el reloj de verdad
  const now = Date.now()
  await seedOrder(f.northId, new Date(now - 8 * DAY), { table: '8' })
  await seedOrder(f.northId, new Date(now - DAY), { table: '1' })
  const lines = answered(await ask()).split('\n')
  expect(lines[0]).toMatch(/^Cuentas abiertas de los últimos 7 días en Norte \(corte \d{2}:\d{2}\): 1\.$/)
  expect(lines.slice(1)).toEqual([
    expect.stringMatching(/^Mesa 1 · desde el \S+ \d{1,2}-\S+ a las \d{2}:\d{2}$/),
    'Los montos están en el panel.',
  ])
  // El borde es la medianoche del primero de los 7 días calendario (como «Últimos 7 días» del panel), no 7 × 24 h hacia atrás:
  // a las 14:32 del jueves 12, las 20:00 del jueves 5 caben en 7 × 24 h y no entran; las 00:00 del viernes 6 sí.
  await clearSales([f.northId])
  await clearTables([f.northId])
  await seedOrder(f.northId, at('20:00', 5), { table: '4' })
  await seedOrder(f.northId, new Date(SINCE.getTime() - 1), { table: '5' })
  await seedOrder(f.northId, SINCE, { table: '3' })
  expect(await answerAt()).toBe(
    [
      'Cuentas abiertas de los últimos 7 días en Flautas Coyoacán (corte 14:32): 1.',
      'Mesa 3 · desde el vie 6-nov a las 00:00',
      'Los montos están en el panel.',
    ].join('\n'),
  )
})

it('listOpenOrdersBrief keeps to its venue: an open order in the same window of a sibling venue and of another organization never appears nor counts (T-B41)', async () => {
  await seedOrder(f.northId, at('13:00'), { table: '7' })
  // La misma ventana, la misma hora: una sucursal hermana (misma organización) y una de otra organización
  await seedOrder(f.siblingId, at('12:00'), { table: 'Hermana' })
  await seedOrder(f.siblingId, at('12:30'), { table: 'Hermana 2' })
  await seedOrder(f.foreignId, at('11:00'), { table: 'Ajena' })
  const own = await listOpenOrdersBrief(f.northId, SINCE, 5)
  expect([own.total, own.orders.map(o => o.tableNumber)]).toEqual([1, ['7']])
  expect(await answerAt()).toBe(
    [
      'Cuentas abiertas de los últimos 7 días en Flautas Coyoacán (corte 14:32): 1.',
      'Mesa 7 · hoy 13:00',
      'Los montos están en el panel.',
    ].join('\n'),
  )
  // …y las otras dos sí tienen las suyas (la siembra es eficaz: no salen porque la consulta filtra por sucursal)
  const sibling = await listOpenOrdersBrief(f.siblingId, SINCE, 5)
  expect([sibling.total, sibling.orders.map(o => o.tableNumber)]).toEqual([2, ['Hermana', 'Hermana 2']])
  const foreign = await listOpenOrdersBrief(f.foreignId, SINCE, 5)
  expect([foreign.total, foreign.orders.map(o => o.tableNumber)]).toEqual([1, ['Ajena']])
})

it('PENDING and PARTIAL count; PAID, CANCELLED and DELETED do not; oldest first; with 6 open, 5 rows and «y 1 más»', async () => {
  const open: [Date, { status?: OrderStatus; paymentStatus?: PaymentStatus; type?: 'TAKEOUT' | 'DELIVERY' | 'PICKUP'; table?: string }][] =
    [
      [at('13:05'), { status: 'READY', paymentStatus: 'PARTIAL', table: '2' }],
      [at('21:15', 10), { status: 'PREPARING', paymentStatus: 'PARTIAL', table: '7' }],
      [at('14:00'), { status: 'COMPLETED', paymentStatus: 'PARTIAL', type: 'PICKUP' }], // entregada y todavía debe: abierta
      [at('12:40'), { status: 'PENDING', type: 'TAKEOUT' }],
      [at('09:00', 10), { table: '1' }],
      [at('13:30'), { type: 'DELIVERY' }],
    ]
  for (const [when, order] of open) await seedOrder(f.northId, when, order)
  // Más viejas que todas las abiertas, así que si contaran saldrían primero
  await seedOrder(f.northId, at('08:00', 10), { status: 'COMPLETED', paymentStatus: 'PAID', table: '9' })
  await seedOrder(f.northId, at('08:10', 10), { status: 'COMPLETED', paymentStatus: 'REFUNDED', table: '10' })
  await seedOrder(f.northId, at('08:20', 10), { status: 'CANCELLED', paymentStatus: 'PENDING', table: '11' })
  await seedOrder(f.northId, at('08:30', 10), { status: 'DELETED', paymentStatus: 'PARTIAL', table: '12' })
  expect(await answerAt()).toBe(
    [
      'Cuentas abiertas de los últimos 7 días en Flautas Coyoacán (corte 14:32): 6. Las más antiguas:',
      'Mesa 1 · desde el mar 10-nov a las 09:00',
      'Mesa 7 · desde el mar 10-nov a las 21:15',
      'Para llevar · hoy 12:40',
      'Mesa 2 · hoy 13:05',
      'A domicilio · hoy 13:30',
      'y 1 más. Los montos están en el panel.',
    ].join('\n'),
  )
  // El tope lo pone el servidor: ni 0 ni 10,000 cambian el total
  const none = await listOpenOrdersBrief(f.northId, SINCE, 0)
  const many = await listOpenOrdersBrief(f.northId, SINCE, 10_000)
  expect([none.total, none.orders.length, many.total, many.orders.length]).toEqual([6, 1, 6, 6])
})

it('no amount is printed: the totals of the seeded orders are not in the text', async () => {
  await seedOrder(f.northId, at('12:00'), { table: '7', total: 1234.56, paymentStatus: 'PARTIAL' })
  await seedOrder(f.northId, at('13:00'), { type: 'TAKEOUT', total: 987.65 })
  const text = await answerAt()
  expect(text).toBe(
    [
      'Cuentas abiertas de los últimos 7 días en Flautas Coyoacán (corte 14:32): 2.',
      'Mesa 7 · hoy 12:00',
      'Para llevar · hoy 13:00',
      'Los montos están en el panel.',
    ].join('\n'),
  )
  for (const leak of ['$', '1,234', '1234', '987']) expect(text).not.toContain(leak)
})

it('a table numbered «55 1234 5678» prints «Mesa [dato omitido]» (case 20)', async () => {
  await seedOrder(f.northId, new Date(Date.now() - 60_000), { table: '55 1234 5678' })
  const text = answered(await ask()) // ANSWERED: pasó checkRendered
  expect(text.split('\n')[1]).toMatch(/^Mesa \[dato omitido\] · hoy \d{2}:\d{2}$/)
  expect(text).not.toMatch(/1234|5678/)
})

it('zero rows: a complete sentence (Review Focus 2)', async () => {
  expect(await answerAt(f.emptyId)).toBe('No hay cuentas abiertas de los últimos 7 días en Flautas Coyoacán (corte 14:32).')
  // Y por el orquestador, con el reloj de verdad
  await f.unlock(f.emptyId)
  const now = new Date()
  const out = await prepareDataAnswer({
    conversation: { ...(await f.conversation()), venueId: f.emptyId },
    request: REQUEST,
    message: MESSAGE,
    now,
  })
  expect(answered(out)).toBe(`No hay cuentas abiertas de los últimos 7 días en Sur (corte ${fmtTime(now, CDMX)}).`)
})

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; 'Index Cond'?: string; Plans?: PlanNode[] }

it('execution plan: with 3,000 orders of the venue over 60 days (and 3,000 of another), no Seq Scan on Order and the scan is bounded to the venue by an index with an Index Cond on venueId', async () => {
  for (const venueId of [f.northId, f.siblingId]) {
    await prisma.order.createMany({
      data: Array.from({ length: 3000 }, (_, i) => ({
        venueId,
        orderNumber: `PLAN-${venueId}-${i}`,
        createdAt: new Date(NOW.getTime() - (i % 60) * DAY - (i % 600) * 60_000),
        subtotal: 100,
        taxAmount: 0,
        total: 100,
        remainingBalance: i % 4 === 0 ? 100 : 0,
        status: i % 4 === 0 ? ('CONFIRMED' as const) : ('COMPLETED' as const),
        paymentStatus: i % 4 === 0 ? ('PENDING' as const) : ('PAID' as const),
      })),
    })
  }
  await prisma.$executeRawUnsafe('ANALYZE "Order"')
  // Las consultas que Prisma arma de verdad para listOpenOrdersBrief: la misma función, por un cliente que anota su SQL. El
  // `afterEach` del archivo (`jest.restoreAllMocks`) regresa los tres espías, también si la prueba se pasa de tiempo.
  const logged = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })
  const queries: { query: string; params: string }[] = []
  logged.$on('query', e => queries.push({ query: e.query, params: e.params }))
  jest.spyOn(prisma, '$transaction').mockImplementation(((ops: never) => logged.$transaction(ops)) as never)
  jest.spyOn(prisma.order, 'count').mockImplementation(((args: never) => logged.order.count(args)) as never)
  jest.spyOn(prisma.order, 'findMany').mockImplementation(((args: never) => logged.order.findMany(args)) as never)
  let brief: Awaited<ReturnType<typeof listOpenOrdersBrief>>
  try {
    brief = await listOpenOrdersBrief(f.northId, SINCE, 10_000)
  } finally {
    await logged.$disconnect()
  }
  // Con muchas abiertas en la ventana, el tope del servidor (50) y el total entero
  expect(brief.orders).toHaveLength(50)
  expect(brief.total).toBeGreaterThan(50)
  const onOrder = queries.filter(q => /FROM "[^"]+"\."Order"/.test(q.query))
  expect(onOrder).toHaveLength(2) // el conteo y la lista
  for (const { query, params } of onOrder) {
    const values = JSON.parse(params) as unknown[]
    const literal = query.replace(/\$(\d+)/g, (_, n: string) => {
      const value = values[Number(n) - 1]
      return typeof value === 'number' ? String(value) : `'${String(value).replace(/'/g, "''")}'`
    })
    const [{ 'QUERY PLAN': plan }] = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': unknown }[]>(`EXPLAIN (FORMAT JSON) ${literal}`)
    const nodes: PlanNode[] = []
    const walk = (node: PlanNode) => {
      nodes.push(node)
      for (const child of node.Plans ?? []) walk(child)
    }
    // El tipo json de Postgres llega ya leído; si llegara como texto, se lee aquí
    walk((typeof plan === 'string' ? JSON.parse(plan) : (plan as { Plan: PlanNode }[]))[0].Plan)
    expect([query, nodes.filter(n => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'Order')]).toEqual([query, []])
    // Lo que importa es que la consulta no recorra toda la tabla y que el índice la acote a la sucursal (`Index Cond` con `venueId`).
    // 🔴 No se afirma CUÁL índice escoge Postgres: su elección cambia con las filas que las demás suites siembran en `Order` (con
    // `--maxWorkers=4` escogió `Order_venueId_customerIdentifier_paymentStatus_idx` y `Order_venueId_areaDeliveryCode_key`, T-F23). Si
    // `createdAt` queda como `Filter` y no como `Index Cond`, también se acepta; la medición real del plan en producción la hace T16 con
    // `EXPLAIN ANALYZE` en la sucursal más grande.
    const indexed = nodes.filter(n => n['Index Name']).map(n => ({ index: n['Index Name'], cond: n['Index Cond'] }))
    const acotadoASucursal = indexed.some(({ cond }) => /"venueId"/.test(cond ?? ''))
    // El plan va dentro de lo que se compara: sólo se imprime si la revisión falla. `consulta` va primero para que salga junto al plan
    expect({ consulta: query, plan: indexed, acotadoASucursal }).toEqual({ consulta: query, plan: indexed, acotadoASucursal: true })
  }
})
