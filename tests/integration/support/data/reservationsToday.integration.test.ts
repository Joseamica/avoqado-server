/**
 * C4 · «Reservaciones de hoy» (la B): las reservaciones del día calendario ENTERO de la sucursal, también las que todavía no pasan,
 * como la pestaña «Hoy» de Reservaciones del panel (mismo filtro y mismo orden: cualquier estado, de la más temprana a la más
 * tardía). Postgres de verdad (la base de la nube). Lo que vale para toda capacidad (venenos, logs, candados, datos ajenos) lo prueba
 * el barrido (`sweeps.integration.test.ts`). Las horas son fijas donde la respuesta depende del reloj: el jueves 12-nov-2026 a las
 * 14:32 de la CDMX.
 */
import { PrismaClient, type ReservationStatus } from '@prisma/client'
import type { Request, Response } from 'express'
import { fromZonedTime } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import { getReservations as panelReservations } from '@/controllers/dashboard/reservation.dashboard.controller'
import { getReservationsQuerySchema } from '@/schemas/dashboard/reservation.schema'
import { prepareDataAnswer, type DataOutcome } from '@/services/support/data/answer.service'
import { reservationsToday } from '@/services/support/data/capabilities/reservationsToday'
import { DATA_CAPABILITIES, dataCatalog, type DataCatalog, type DataRequest, type DataScope } from '@/services/support/data/catalog'
import { checkRendered } from '@/services/support/data/check'
import { fmtTime } from '@/services/support/data/format'
import { wholeDayBounds } from '@/services/support/data/params'
import { SUPPORT_DATA_NEEDS_UNLOCK, SUPPORT_DATA_REFUSALS } from '@/services/support/data/texts'
import { venueDayKey } from '@/utils/venueDateKeys'
import {
  clearReservations,
  clearTables,
  earlierToday,
  seedDataFixture,
  seedReservation,
  type DataFixture,
} from '@tests/__helpers__/supportData'

const CDMX = 'America/Mexico_City'
const CANCUN = 'America/Cancun'
const DAY = 86_400_000
const GRANT = { permissions: ['reservations:read'], features: ['RESERVATIONS'] }
const REQUEST: DataRequest = { capability: 'reservations_today', day: 'today', amount: null, time: null, otherVenue: false }
const MESSAGE = '¿Qué reservaciones tengo hoy?'
/** El corte de los ejemplos del plan: jueves 12-nov-2026, 14:32 en la CDMX. */
const NOW = new Date('2026-11-12T20:32:00Z')
/** Una hora de un día de noviembre de 2026 en una zona (el 12 en la CDMX, por omisión). */
const at = (hhmm: string, day = 12, timezone = CDMX) => fromZonedTime(`2026-11-${String(day).padStart(2, '0')}T${hhmm}:00.000`, timezone)
/** Una cita de salón: servicio, cliente ligado y quién atiende, y su mesa. */
const SALON = {
  product: 'Corte',
  customer: { firstName: 'Ana', lastName: 'Ramírez' },
  staff: { firstName: 'Paola', lastName: 'Gómez' },
}

let f: DataFixture
let venues: string[]
beforeAll(async () => {
  f = await seedDataFixture('support-data-reservations')
  venues = [f.northId, f.cancunId, f.emptyId, f.siblingId, f.foreignId]
})
afterAll(() => f?.clean())
beforeEach(async () => {
  await f.reset()
  process.env.SUPPORT_DATA_ENABLED = 'true'
  await clearReservations(venues)
  await clearTables(venues)
  await f.grant(GRANT)
  await f.unlock()
})
afterEach(() => jest.restoreAllMocks())

/** La pregunta por el orquestador, con el reloj de verdad (el desbloqueo es de hoy), en la plática de la persona (una por teléfono). */
const ask = async (venueId = f.northId, request = REQUEST, catalog: DataCatalog = DATA_CAPABILITIES, now = new Date()) =>
  prepareDataAnswer({ conversation: { ...(await f.conversation()), venueId }, request, message: MESSAGE, now }, catalog)
const answered = (out: DataOutcome) => {
  if (out.kind !== 'answer') throw new Error(`reservations_today: ${out.text}`)
  return out.envelope.text
}
/** El catálogo con la capacidad de verdad y su lectura espiada (un catálogo registrado está congelado y no se espía). */
const spied = () => {
  const read = jest.fn(reservationsToday.read)
  return { read, catalog: dataCatalog({ ...reservationsToday, read }) }
}
/** Un alcance armado a mano, con el reloj fijo de los ejemplos. */
const scopeFor = (venueId: string, now = NOW, timezone = CDMX): DataScope => ({
  venueId,
  organizationId: f.orgId,
  venueName: 'Flautas Coyoacán',
  timezone,
  day: venueDayKey(now, timezone),
  kycVerified: true,
  now,
  rows: 5,
  openOrdersDays: 7,
  depositGroups: 2000,
  depositTimeoutMs: 3000,
})
/** La capacidad directa, sin los candados del orquestador: su lectura y su plantilla, que tiene que pasar el cotejo. */
async function answerAt(venueId = f.northId, now = NOW, timezone = CDMX): Promise<string> {
  const scope = scopeFor(venueId, now, timezone)
  const params = reservationsToday.params(REQUEST, MESSAGE, scope)
  if (!params.ok) throw new Error(params.refusal)
  const rendered = reservationsToday.render(scope, params.value, await reservationsToday.read(scope, params.value))
  expect(checkRendered(rendered, timezone)).toBe(true)
  return rendered.text
}

it('a restaurant row and a salon row print as the examples above', async () => {
  await seedReservation(f.northId, at('19:30'), { status: 'PENDING', guestName: 'Luis Martínez' })
  await seedReservation(f.northId, at('14:00'), { partySize: 4, guestName: 'Ana Ramírez', table: '5' })
  await seedReservation(f.northId, at('11:00'), SALON)
  expect(await answerAt()).toBe(
    [
      'Reservaciones de hoy en Flautas Coyoacán (corte 14:32): 3',
      '11:00 · Corte · Ana R. · con Paola · Confirmada',
      '14:00 · 4 personas · Ana R. · Confirmada · mesa 5',
      '19:30 · 2 personas · Luis M. · Pendiente',
    ].join('\n'),
  )
})

const LABEL: Record<ReservationStatus, string> = {
  PENDING: 'Pendiente',
  CONFIRMED: 'Confirmada',
  CHECKED_IN: 'Llegó',
  COMPLETED: 'Completada',
  CANCELLED: 'Cancelada',
  NO_SHOW: 'No llegó',
}

it('parity: the count and the order are those of the panel list for today; with 7 today, 5 rows and «y 2 más»', async () => {
  const now = new Date()
  const today = venueDayKey(now, CDMX)
  const local = (offset: number, hhmm: string) =>
    fromZonedTime(`${new Date(Date.parse(`${today}T00:00:00Z`) + offset * DAY).toISOString().slice(0, 10)}T${hhmm}:00.000`, CDMX)
  // Siete de hoy, sembradas en desorden y con todos los estados: la pestaña «Hoy» del panel no filtra por estado
  const seven: [string, ReservationStatus, string][] = [
    ['20:00', 'PENDING', 'Gil Uno'],
    ['09:00', 'CANCELLED', 'Ana Dos'],
    ['23:00', 'CONFIRMED', 'Eva Tres'],
    ['12:00', 'NO_SHOW', 'Rui Cuatro'],
    ['10:30', 'CHECKED_IN', 'Ivo Cinco'],
    ['16:45', 'COMPLETED', 'Lia Seis'],
    ['13:15', 'CONFIRMED', 'Teo Siete'],
  ]
  for (const [hhmm, status, guestName] of seven) await seedReservation(f.northId, local(0, hhmm), { status, guestName })
  // Ayer a las 23:59 y mañana a las 00:00 no son de hoy, ni en el panel ni aquí
  await seedReservation(f.northId, local(-1, '23:59'), { guestName: 'Ayer Uno' })
  await seedReservation(f.northId, local(1, '00:00'), { guestName: 'Mañana Uno' })
  // La lista del panel en su pestaña «Hoy»: dateFrom = dateTo = el día de la sucursal, como lo manda el panel y lo valida la ruta
  const res = { json: jest.fn() }
  const next = jest.fn()
  await panelReservations(
    { params: { venueId: f.northId }, query: getReservationsQuerySchema.parse({ dateFrom: today, dateTo: today }) } as unknown as Request,
    res as unknown as Response,
    next,
  )
  expect(next).not.toHaveBeenCalled()
  const panel = res.json.mock.calls[0][0] as {
    data: { startsAt: Date; status: ReservationStatus; guestName: string }[]
    meta: { total: number }
  }
  expect([panel.meta.total, panel.data.map(r => fmtTime(r.startsAt, CDMX))]).toEqual([
    7,
    ['09:00', '10:30', '12:00', '13:15', '16:45', '20:00', '23:00'],
  ])
  const short = (name: string) => name.replace(/ (\S)\S*$/, ' $1.')
  expect(answered(await ask(f.northId, REQUEST, DATA_CAPABILITIES, now)).split('\n')).toEqual([
    `Reservaciones de hoy en Norte (corte ${fmtTime(now, CDMX)}): ${panel.meta.total}`,
    ...panel.data.slice(0, 5).map(r => `${fmtTime(r.startsAt, CDMX)} · 2 personas · ${short(r.guestName)} · ${LABEL[r.status]}`),
    'y 2 más; el resto está en el panel.',
  ])
})

it('without the RESERVATIONS plan → SUPPORT_DATA_REFUSALS.PLAN_RESERVATIONS, PLAN_REQUIRED, read never called (case 35)', async () => {
  await seedReservation(f.northId, earlierToday(CDMX), { guestName: 'Ana Ramírez' })
  await f.grant({ permissions: ['reservations:read'] })
  const { read, catalog } = spied()
  expect(await ask(f.northId, REQUEST, catalog)).toMatchObject({
    kind: 'refusal',
    text: SUPPORT_DATA_REFUSALS.PLAN_RESERVATIONS,
    log: { result: 'PLAN_REQUIRED', capability: 'reservations_today' },
  })
  expect(read).not.toHaveBeenCalled()
  // Con el plan, la misma pregunta sí lee (el control positivo)
  await f.grant(GRANT)
  expect(await ask(f.northId, REQUEST, catalog)).toMatchObject({ kind: 'answer' })
  expect(read).toHaveBeenCalledTimes(1)
})

it('«¿qué reservaciones tengo mañana?» (day other) → SUPPORT_DATA_REFUSALS.RESERVATIONS_TODAY_ONLY, PARAM_INVALID, read never called (case 35)', async () => {
  const { read, catalog } = spied()
  for (const [day, message] of [
    ['other', '¿Qué reservaciones tengo mañana?'],
    ['yesterday', '¿Y las de ayer?'],
  ] as const) {
    const out = await prepareDataAnswer(
      { conversation: await f.conversation(), request: { ...REQUEST, day }, message, now: new Date() },
      catalog,
    )
    expect(out).toMatchObject({
      kind: 'refusal',
      text: SUPPORT_DATA_REFUSALS.RESERVATIONS_TODAY_ONLY,
      log: { result: 'PARAM_INVALID', capability: 'reservations_today' },
    })
  }
  expect(read).not.toHaveBeenCalled()
})

it("accepted yesterday and no tap today, with a service named «Corte $850.00»: the fixed unlock text and nothing of the name; with today's unlock the name comes out as it is (cases 5 and 20)", async () => {
  await f.accept()
  await seedReservation(f.northId, earlierToday(CDMX), { ...SALON, product: 'Corte $850.00' })
  const refused = await ask()
  expect(refused).toMatchObject({ kind: 'refusal', text: SUPPORT_DATA_NEEDS_UNLOCK, log: { result: 'NEEDS_UNLOCK' } })
  expect((refused as { text: string }).text).not.toMatch(/Corte|850/)
  await f.unlock()
  expect(answered(await ask()).split('\n')[1]).toMatch(/^\d{2}:\d{2} · Corte \$850\.00 · Ana R\. · con Paola · Confirmada$/)
})

/** La cita del caso 20: cada caso cambia UN nombre guardado. */
const CASE_20 = { ...SALON, table: '3' }
it.each<[string, Parameters<typeof seedReservation>[2], string]>([
  [
    'a service «Corte 4111/1111/1111/1111»',
    { product: 'Corte 4111/1111/1111/1111' },
    '12:00 · [dato omitido] · Ana R. · con Paola · Confirmada · mesa 3',
  ],
  [
    'a client «Ana ana@correo.com»',
    { customer: { firstName: 'Ana', lastName: 'ana@correo.com' } },
    '12:00 · Corte · [dato omitido] · con Paola · Confirmada · mesa 3',
  ],
  [
    'a name typed at booking «Ana ana@correo.com»',
    { customer: undefined, guestName: 'Ana ana@correo.com' },
    '12:00 · Corte · [dato omitido] · con Paola · Confirmada · mesa 3',
  ],
  [
    'a staff «Luis +525512345678»',
    { staff: { firstName: 'Luis', lastName: '+525512345678' } },
    '12:00 · Corte · Ana R. · con [dato omitido] · Confirmada · mesa 3',
  ],
  [
    'a staff «Paola GODE561231GR8»',
    { staff: { firstName: 'Paola', lastName: 'GODE561231GR8' } },
    '12:00 · Corte · Ana R. · con [dato omitido] · Confirmada · mesa 3',
  ],
  ['a table «55 1234 5678»', { table: '55 1234 5678' }, '12:00 · Corte · Ana R. · con Paola · Confirmada · mesa [dato omitido]'],
  [
    'a service «Corte y barba» and a table «12» (whole)',
    { product: 'Corte y barba', table: '12' },
    '12:00 · Corte y barba · Ana R. · con Paola · Confirmada · mesa 12',
  ],
])('a name saved as %s (case 20); the check still passes', async (_name, over, line) => {
  await seedReservation(f.northId, at('12:00'), { ...CASE_20, ...over })
  const text = await answerAt() // pasa checkRendered
  expect(text.split('\n')).toEqual(['Reservaciones de hoy en Flautas Coyoacán (corte 14:32): 1', line])
  expect(text).not.toMatch(/4111|@|correo|5512345678|GODE|1234 5678/)
})

it('the phone, the email and the confirmation code of a reservation are never in the text', async () => {
  const first = earlierToday(CDMX)
  await seedReservation(f.northId, first, {
    guestName: 'Luis Martínez',
    guestPhone: '+525598765432',
    guestEmail: 'luis@ejemplo.com',
    confirmationCode: 'RES-A3X7K2',
  })
  await seedReservation(f.northId, new Date(first.getTime() + 60_000), {
    customer: { firstName: 'Ana', lastName: 'Ramírez', phone: '+525511112222', email: 'ana@ejemplo.com' },
    confirmationCode: 'RES-B9Y8Z7',
  })
  const text = answered(await ask())
  expect(text.split('\n')).toHaveLength(3)
  for (const leak of ['98765432', '11112222', '+52', '@', 'ejemplo', 'RES-', 'A3X7K2', 'B9Y8Z7']) expect(text).not.toContain(leak)
  // Ni siquiera llegan a la capacidad: la lista del panel que lee no trae el teléfono ni el correo
  const list = await reservationsToday.read(scopeFor(f.northId, new Date()), {})
  const read = JSON.stringify(list)
  for (const leak of ['98765432', '11112222', 'ejemplo']) expect(read).not.toContain(leak)
  // …porque la envoltura es una lista cerrada: un campo nuevo en ella (las notas, para el chatbot) falla aquí antes de llegar a la B
  expect(list.reservations).toHaveLength(2)
  for (const row of list.reservations)
    expect(Object.keys(row).sort()).toEqual([
      'assignedStaffName',
      'channel',
      'confirmationCode',
      'customerName',
      'endsAt',
      'guestName',
      'partySize',
      'productName',
      'startsAt',
      'status',
      'tableNumber',
    ])
})

it("a reservation at 23:30 yesterday and one at 00:10 tomorrow are not today's, in Cancún and in Mexico City", async () => {
  for (const [venueId, timezone, now] of [
    [f.northId, CDMX, NOW],
    [f.cancunId, CANCUN, new Date('2026-11-12T19:32:00Z')], // las 14:32 en Cancún
  ] as const) {
    await seedReservation(venueId, at('23:30', 11, timezone), { guestName: 'Ayer Uno' })
    await seedReservation(venueId, at('00:10', 13, timezone), { guestName: 'Mañana Uno' })
    await seedReservation(venueId, at('12:00', 12, timezone), { guestName: 'Ana Ramírez' })
    expect([timezone, await answerAt(venueId, now, timezone)]).toEqual([
      timezone,
      ['Reservaciones de hoy en Flautas Coyoacán (corte 14:32): 1', '12:00 · 2 personas · Ana R. · Confirmada'].join('\n'),
    ])
  }
})

it("one at 19:30 asked at 14:32 is today's (what is left of the day comes out too)", async () => {
  await seedReservation(f.northId, at('19:30'), { guestName: 'Luis Martínez' })
  expect(await answerAt()).toBe(
    ['Reservaciones de hoy en Flautas Coyoacán (corte 14:32): 1', '19:30 · 2 personas · Luis M. · Confirmada'].join('\n'),
  )
})

it('zero rows: a complete sentence (Review Focus 2)', async () => {
  expect(await answerAt(f.emptyId)).toBe('No hay reservaciones hoy en Flautas Coyoacán (corte 14:32).')
  // Y por el orquestador, con el reloj de verdad
  await f.unlock(f.emptyId)
  const now = new Date()
  expect(answered(await ask(f.emptyId, REQUEST, DATA_CAPABILITIES, now))).toBe(
    `No hay reservaciones hoy en Sur (corte ${fmtTime(now, CDMX)}).`,
  )
})

/** Los índices de `Reservation` que empiezan por la sucursal y siguen con la hora (`schema.prisma`, modelo Reservation). */
const VENUE_DATE_INDEXES = ['Reservation_venueId_startsAt_endsAt_idx', 'Reservation_venueId_startsAt_blockedEndsAt_idx']
type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; 'Index Cond'?: string; Plans?: PlanNode[] }

it('execution plan: with 3,000 reservations of the venue over 60 days (and 3,000 of another), no Seq Scan on Reservation and only a venue+date index with an Index Cond on venueId and startsAt', async () => {
  for (const venueId of [f.northId, f.siblingId]) {
    await prisma.reservation.createMany({
      data: Array.from({ length: 3000 }, (_, i) => {
        const startsAt = new Date(NOW.getTime() - (i % 60) * DAY - (i % 600) * 60_000)
        const endsAt = new Date(startsAt.getTime() + 60 * 60_000)
        return { venueId, confirmationCode: `PLAN-${i}`, startsAt, endsAt, blockedEndsAt: endsAt, duration: 60, guestName: 'Plan' }
      }),
    })
  }
  await prisma.$executeRawUnsafe('ANALYZE "Reservation"')
  const { from, to } = wholeDayBounds('today', { timezone: CDMX, now: NOW })
  const today = await prisma.reservation.count({ where: { venueId: f.northId, startsAt: { gte: from, lte: to } } })
  // Las consultas que Prisma arma de verdad para la lectura de la capacidad: la misma, por un cliente que anota su SQL. El
  // `afterEach` del archivo (`jest.restoreAllMocks`) regresa los tres espías, también si la prueba se pasa de tiempo.
  const logged = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })
  const queries: { query: string; params: string }[] = []
  logged.$on('query', e => queries.push({ query: e.query, params: e.params }))
  jest.spyOn(prisma, '$transaction').mockImplementation(((ops: never) => logged.$transaction(ops)) as never)
  jest.spyOn(prisma.reservation, 'count').mockImplementation(((args: never) => logged.reservation.count(args)) as never)
  jest.spyOn(prisma.reservation, 'findMany').mockImplementation(((args: never) => logged.reservation.findMany(args)) as never)
  let list: Awaited<ReturnType<typeof reservationsToday.read>>
  try {
    list = await reservationsToday.read(scopeFor(f.northId), {})
  } finally {
    await logged.$disconnect()
  }
  // El tope (scope.rows) y el total del día entero, contado antes del tope
  expect([list.reservations.length, list.total, today > 5]).toEqual([5, today, true])
  const onReservation = queries.filter(q => /FROM "[^"]+"\."Reservation"/.test(q.query))
  expect(onReservation).toHaveLength(2) // la lista y el conteo
  for (const { query, params } of onReservation) {
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
    expect([query, nodes.filter(n => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'Reservation')]).toEqual([query, []])
    // Sólo un índice de la sucursal y la hora, y su condición lleva las dos
    const indexed = nodes
      .filter(n => n['Index Name']?.startsWith('Reservation_'))
      .map(n => [n['Index Name'], /"venueId"/.test(n['Index Cond'] ?? '') && /"startsAt"/.test(n['Index Cond'] ?? '')])
    // El plan va dentro de lo que se compara: sólo se imprime si la revisión falla. Jest ordena las llaves y muestra pocas líneas
    // alrededor de la diferencia: `consulta` va primero para que la consulta salga junto al plan
    const fuera = indexed.filter(([name]) => !VENUE_DATE_INDEXES.includes(String(name)))
    expect({ consulta: query, fuera, plan: indexed }).toEqual({ consulta: query, fuera: [], plan: indexed })
    const sucursalYFecha = indexed.some(([, venueAndDate]) => venueAndDate)
    expect({ consulta: query, plan: indexed, sucursalYFecha }).toEqual({ consulta: query, plan: indexed, sucursalYFecha: true })
  }
})
