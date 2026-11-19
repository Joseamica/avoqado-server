/**
 * C8 · «Quién abrió o cerró la caja, hoy o ayer» (la B): quién abrió y quién cerró la caja física de la sucursal, a qué hora y si sigue
 * abierta, como el bloque de la caja de «Turnos de caja» del panel (`/cash-drawer/sessions`). Sin montos, sin el aparato y sin la nota.
 * Un nombre sólo sale donde el guardado en la caja es igual al del directorio de personal (StaffVenue de la sucursal o StaffOrganization
 * de su organización). Postgres de verdad (la base de la nube, con todas las migraciones). Lo que vale para toda capacidad (venenos,
 * logs, candados, datos ajenos) lo prueba también el barrido (`sweeps.integration.test.ts`). El reloj es el de verdad (el desbloqueo es
 * de hoy): las horas se escriben relativas a ahora y el texto esperado se arma con los formatos de la B.
 */
import { PrismaClient } from '@prisma/client'
import { fromZonedTime } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import { getDrawerSessions } from '@/services/dashboard/cashDrawer.dashboard.service'
import { CASH_DRAWER_SELECT, cashDrawerIndexesReady, readCashDrawers } from '@/services/dashboard/cashDrawerWho.dashboard.service'
import { closeSession, openSession } from '@/services/mobile/cash-drawer.mobile.service'
import { prepareDataAnswer, type DataOutcome } from '@/services/support/data/answer.service'
import { cashDrawer } from '@/services/support/data/capabilities/cashDrawer'
import { DATA_CAPABILITIES, dataCatalog, type DataCatalog, type DataRequest } from '@/services/support/data/catalog'
import { fmtShortDay, fmtTime } from '@/services/support/data/format'
import { dayBounds } from '@/services/support/data/params'
import { SUPPORT_DATA_REFUSALS, supportDataOutOfCatalog } from '@/services/support/data/texts'
import { venueDayKey } from '@/utils/venueDateKeys'
import {
  clearCashDrawers,
  seedCashDrawer,
  seedCashier,
  seedDataFixture,
  spyLogger,
  spyQueries,
  type DataFixture,
  type QueryCall,
} from '@tests/__helpers__/supportData'

const CDMX = 'America/Mexico_City'
const DAY = 86_400_000
type Day = 'today' | 'yesterday' | 'other'
const REQUEST: DataRequest = { capability: 'cash_drawer', day: 'today', amount: null, time: null, otherVenue: false }
const MESSAGE: Record<Day, string> = {
  today: '¿Quién abrió la caja hoy?',
  yesterday: '¿Quién abrió la caja ayer?',
  other: '¿Quién abrió la caja el lunes?',
}

let f: DataFixture
let venues: string[]
beforeAll(async () => {
  f = await seedDataFixture('support-data-cash-drawer')
  venues = [f.northId, f.cancunId, f.emptyId, f.siblingId, f.foreignId]
})
afterAll(() => f?.clean())
beforeEach(async () => {
  await f.reset()
  process.env.SUPPORT_DATA_ENABLED = 'true'
  await clearCashDrawers(venues)
  await f.grant({ permissions: ['shifts:read'] })
  await f.unlock()
})
afterEach(() => jest.restoreAllMocks())

/** La pregunta por el orquestador, con el reloj de verdad, en la plática de la persona (Norte). */
const ask = async (day: Day = 'today', catalog: DataCatalog = DATA_CAPABILITIES) =>
  prepareDataAnswer({ conversation: await f.conversation(), request: { ...REQUEST, day }, message: MESSAGE[day], now: new Date() }, catalog)
const answered = (out: DataOutcome) => {
  if (out.kind !== 'answer') throw new Error(`cash_drawer: ${out.text}`)
  return out.envelope.text
}
const say = async (day: Exclude<Day, 'other'> = 'today') => answered(await ask(day))

/** Las `hh:mm` del día civil de la CDMX de hace `days` días (0 = hoy), escritas como texto en su zona. */
const local = (hhmm: string, days = 0) => {
  const key = new Date(Date.parse(`${venueDayKey(new Date(), CDMX)}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10)
  return fromZonedTime(`${key}T${hhmm}:00`, CDMX)
}
/** Hace `minutes` minutos, sin salirse de hoy: las pruebas corren a cualquier hora (a las 00:10, «hace 30 min» sería ayer). */
const earlier = (minutes: number) => new Date(Math.max(local('00:00').getTime(), Date.now() - minutes * 60_000))
/** Hoy a esa hora, pero nunca en el futuro: a las 00:30, «hoy a la 01:00» todavía no pasa. */
const todayAt = (hhmm: string) => new Date(Math.max(local('00:00').getTime(), Math.min(local(hhmm).getTime(), Date.now() - 60_000)))
const hour = (d: Date) => fmtTime(d, CDMX)
const dayOf = (d: Date) => fmtShortDay(d, CDMX)
const today = () => dayBounds('today', { timezone: CDMX, now: new Date() })

/** Ana López y Luis Pérez, con su fila en Norte. */
const people = async () => ({ ana: await seedCashier(f.northId, 'Ana', 'López'), luis: await seedCashier(f.northId, 'Luis', 'Pérez') })

describe('case 44: opened and closed the same day or on different days', () => {
  it('opened and closed today', async () => {
    const { ana, luis } = await people()
    const [opened, closed] = [earlier(30), earlier(10)]
    await seedCashDrawer(f.northId, {
      openedBy: ana,
      openedByName: 'Ana López',
      openedAt: opened,
      closedBy: luis,
      closedByName: 'Luis Pérez',
      closedAt: closed,
    })
    const text = await say()
    expect(text.startsWith(`Caja de Norte, ${dayOf(new Date())} (corte `)).toBe(true)
    expect(text).toMatch(/\(corte \d{2}:\d{2}\): /)
    expect(text.endsWith(`: Ana López la abrió a las ${hour(opened)} y Luis Pérez la cerró a las ${hour(closed)}.`)).toBe(true)
  })

  it('Luis opens yesterday at 23:10 and Ana closes today at 01:00: it comes out in «hoy» and in «ayer», with both dates', async () => {
    const { ana, luis } = await people()
    const [opened, closed] = [local('23:10', 1), todayAt('01:00')]
    await seedCashDrawer(f.northId, {
      openedBy: luis,
      openedByName: 'Luis Pérez',
      openedAt: opened,
      closedBy: ana,
      closedByName: 'Ana López',
      closedAt: closed,
    })
    const both = `: Luis Pérez la abrió el ${dayOf(opened)} a las ${hour(opened)} y Ana López la cerró el ${dayOf(closed)} a las ${hour(closed)}.`
    const hoy = await say('today')
    const ayer = await say('yesterday')
    expect([hoy.startsWith(`Caja de Norte, ${dayOf(closed)} (corte `), hoy.endsWith(both)]).toEqual([true, true])
    expect([ayer.startsWith(`Caja de Norte, ${dayOf(opened)} (corte `), ayer.endsWith(both)]).toEqual([true, true])
  })

  it('open for three days: it comes out with its date, today and yesterday', async () => {
    const { ana } = await people()
    const opened = local('08:02', 3)
    await seedCashDrawer(f.northId, { openedBy: ana, openedByName: 'Ana López', openedAt: opened })
    const sentence = `: Ana López la abrió el ${dayOf(opened)} a las 08:02 y sigue abierta.`
    expect((await say('today')).endsWith(sentence)).toBe(true)
    expect((await say('yesterday')).endsWith(sentence)).toBe(true)
  })

  it('a drawer opened and closed three days ago does not come out', async () => {
    const { ana, luis } = await people()
    await seedCashDrawer(f.northId, {
      openedBy: ana,
      openedByName: 'Ana López',
      openedAt: local('08:02', 3),
      closedBy: luis,
      closedByName: 'Luis Pérez',
      closedAt: local('18:00', 3),
    })
    expect(await say()).toMatch(/^No encontré cajas abiertas ni cerradas hoy en Norte \(corte \d{2}:\d{2}\)\.$/)
  })

  // «Dos abiertas a la vez» ya no se puede guardar: desde el 27-ago la base deja UNA caja abierta por sucursal (el índice único parcial
  // `CashDrawerSession_venueId_open_key`, migración 20260827151634). «Hay N cajas abiertas al mismo tiempo.» queda en la plantilla como
  // el aviso del panel (`MULTIPLE_OPEN_SESSIONS`) y se prueba ahí (cashDrawer.test.ts); aquí, varias cajas del día con una abierta.
  it('two open at once cannot be saved (one open drawer per venue); several drawers of the day: all of them, no «Hay N cajas abiertas»', async () => {
    const { ana, luis } = await people()
    const [first, firstClosed, second] = [earlier(40), earlier(30), earlier(20)]
    await seedCashDrawer(f.northId, {
      openedBy: ana,
      openedByName: 'Ana López',
      openedAt: first,
      closedBy: luis,
      closedByName: 'Luis Pérez',
      closedAt: firstClosed,
    })
    await seedCashDrawer(f.northId, { openedBy: luis, openedByName: 'Luis Pérez', openedAt: second })
    await expect(seedCashDrawer(f.northId, { openedBy: ana, openedByName: 'Ana López', openedAt: earlier(10) })).rejects.toMatchObject({
      code: 'P2002',
    })
    const lines = (await say()).split('\n')
    expect(lines[0]).toMatch(new RegExp(`^Cajas de Norte, ${dayOf(new Date())} \\(corte \\d{2}:\\d{2}\\): 2$`))
    expect(lines.slice(1)).toEqual([
      `Ana López la abrió a las ${hour(first)} y Luis Pérez la cerró a las ${hour(firstClosed)}.`,
      `Luis Pérez la abrió a las ${hour(second)} y sigue abierta.`,
    ])
  })

  // r1: «ayer» no lista la caja abierta HOY (sigue abierta, pero ayer todavía no existía): la rama «sigue abierta» lleva openedAt ≤ el fin del día
  it('a drawer opened today and still open, asked «ayer» → the zero-row sentence', async () => {
    const { ana } = await people()
    await seedCashDrawer(f.northId, { openedBy: ana, openedByName: 'Ana López', openedAt: earlier(30) })
    expect(await say('yesterday')).toMatch(/^No encontré cajas abiertas ni cerradas ayer en Norte \(corte \d{2}:\d{2}\)\.$/)
    expect(await say('today')).toContain(': Ana López la abrió a las ')
  })

  it('the same plus a drawer closed yesterday, asked «ayer» → the single «Caja de …» form, with no count of 2', async () => {
    const { ana, luis } = await people()
    await seedCashDrawer(f.northId, { openedBy: ana, openedByName: 'Ana López', openedAt: earlier(30) })
    const [opened, closed] = [local('10:00', 1), local('18:00', 1)]
    await seedCashDrawer(f.northId, {
      openedBy: luis,
      openedByName: 'Luis Pérez',
      openedAt: opened,
      closedBy: ana,
      closedByName: 'Ana López',
      closedAt: closed,
    })
    const text = await say('yesterday')
    expect(text).toMatch(new RegExp(`^Caja de Norte, ${dayOf(opened)} \\(corte \\d{2}:\\d{2}\\): `))
    expect(text.endsWith(': Luis Pérez la abrió a las 10:00 y Ana López la cerró a las 18:00.')).toBe(true)
    expect(text.split('\n')).toHaveLength(1)
  })

  it('another day → SUPPORT_DATA_REFUSALS.CASH_DRAWER_TODAY_OR_YESTERDAY, PARAM_INVALID', async () =>
    expect(await ask('other')).toMatchObject({
      kind: 'refusal',
      text: SUPPORT_DATA_REFUSALS.CASH_DRAWER_TODAY_OR_YESTERDAY,
      log: { result: 'PARAM_INVALID', capability: 'cash_drawer' },
    }))

  it('parity: every person named is the string /cash-drawer/sessions gives for that session, and the hours match', async () => {
    const { ana, luis } = await people()
    await seedCashDrawer(f.northId, {
      openedBy: luis,
      openedByName: 'Luis Pérez',
      openedAt: local('23:10', 1),
      closedBy: ana,
      closedByName: 'Ana López',
      closedAt: todayAt('01:00'),
    })
    await seedCashDrawer(f.northId, {
      openedBy: ana,
      openedByName: 'Ana López',
      openedAt: earlier(50),
      closedBy: luis,
      closedByName: 'Luis Pérez',
      closedAt: earlier(40),
    })
    await seedCashDrawer(f.northId, { openedBy: luis, openedByName: 'Luis Pérez', openedAt: earlier(30) })
    const { sessions } = await getDrawerSessions(f.northId, { page: 1, pageSize: 20 })
    const { rows } = await readCashDrawers(f.northId, today(), 5)
    const text = await say()
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      const panel = sessions.find(s => s.openedAt === row.openedAt.toISOString())
      expect([row.abrió, row.cerró, row.closedAt?.toISOString() ?? null]).toEqual([
        panel?.openedByName,
        panel?.closedByName,
        panel?.closedAt,
      ])
      expect(text).toContain(`${row.abrió} la abrió `)
      expect(text).toContain(`a las ${hour(new Date(panel!.openedAt))}`)
      if (panel?.closedAt) expect(text).toContain(`${row.cerró} la cerró `)
      if (panel?.closedAt) expect(text).toContain(`a las ${hour(new Date(panel.closedAt))}`)
    }
  })
})

describe('case 45: no amount, no free text of the POS', () => {
  it('the two queries select exactly the eight fields and id, firstName, lastName', async () => {
    const { ana, luis } = await people()
    await seedCashDrawer(f.northId, {
      openedBy: ana,
      openedByName: 'Ana López',
      openedAt: earlier(30),
      closedBy: luis,
      closedByName: 'Luis Pérez',
      closedAt: earlier(10),
    })
    const spy = spyQueries()
    let calls: QueryCall[]
    try {
      await readCashDrawers(f.northId, today(), 5)
    } finally {
      calls = spy.calls
      spy.restore()
    }
    // r1: sin el conteo de cajas abiertas (desde el 27-ago la base deja una sola por sucursal)
    expect(calls.map(c => [c.model, c.action])).toEqual([
      ['CashDrawerSession', 'count'],
      ['CashDrawerSession', 'findMany'],
      ['Staff', 'findMany'],
    ])
    const args = calls.map(c => c.args as { select?: unknown; include?: unknown; take?: unknown })
    expect(args.map(a => a.include)).toEqual([undefined, undefined, undefined])
    expect(args[0].select).toBeUndefined()
    expect(args[1].select).toEqual({
      id: true,
      openedByStaffId: true,
      openedByName: true,
      openedAt: true,
      closedByStaffId: true,
      closedByName: true,
      closedAt: true,
      status: true,
    })
    expect(args[1].select).toBe(CASH_DRAWER_SELECT)
    expect([args[2].select, args[2].take]).toEqual([{ id: true, firstName: true, lastName: true }, 10])
  })

  it('with anything in deviceName and closingNote, none of it comes out', async () => {
    const { ana, luis } = await people()
    await seedCashDrawer(f.northId, {
      openedBy: ana,
      openedByName: 'Ana López',
      openedAt: earlier(30),
      closedBy: luis,
      closedByName: 'Luis Pérez',
      closedAt: earlier(10),
      deviceName: 'Barra Patio · fondo $850.00',
      closingNote: 'Faltaron $120 en Patio',
    })
    const text = await say()
    for (const piece of ['Barra', 'Patio', 'fondo', 'Faltaron', '850', '120', '1,234.56', '987.65']) expect(text).not.toContain(piece)
  })

  // Lo que el POS pudo mandar en lugar del nombre: con otro nombre en el directorio (Ana López), sale «una persona».
  it.each([
    'Encargada',
    'fondo 85 mil',
    'fondo ochocientos cincuenta',
    'fondo 2k',
    'fondo 85\nmil',
    'Caja · fondo $850.00',
    '$850.00',
    'fondo 850',
    'Staff',
    'Ana López de Haro',
  ])('saved «%s» with «Ana López» in the directory → «una persona», open and closed, with and without view-expected', async saved => {
    const ana = await seedCashier(f.northId, 'Ana', 'López')
    const [opened, closed] = [earlier(30), earlier(10)]
    for (const permissions of [['shifts:read'], ['shifts:read', 'cash-drawer:view-expected']]) {
      await f.grant({ permissions })
      await prisma.cashDrawerSession.deleteMany({ where: { venueId: f.northId } })
      await seedCashDrawer(f.northId, { openedBy: ana, openedByName: saved, openedAt: opened })
      const open = await say()
      expect([open.endsWith(`: una persona la abrió a las ${hour(opened)} y sigue abierta.`), open.includes(saved)]).toEqual([true, false])
      await prisma.cashDrawerSession.deleteMany({ where: { venueId: f.northId } })
      await seedCashDrawer(f.northId, {
        openedBy: ana,
        openedByName: 'Ana López',
        openedAt: opened,
        closedBy: ana,
        closedByName: saved,
        closedAt: closed,
      })
      const shut = await say()
      const sentence = `: Ana López la abrió a las ${hour(opened)} y una persona la cerró a las ${hour(closed)}.`
      expect([shut.endsWith(sentence), shut.includes(saved)]).toEqual([true, false])
    }
  })

  it('openedByName = «CENTINELA» with another name in the directory: CENTINELA is not in what the template receives, not in the text and not in any logger argument', async () => {
    const ana = await seedCashier(f.northId, 'Ana', 'López')
    await seedCashDrawer(f.northId, {
      openedBy: ana,
      openedByName: 'CENTINELA',
      openedAt: earlier(30),
      closedBy: ana,
      closedByName: 'CENTINELA',
      closedAt: earlier(10),
    })
    const render = jest.fn(cashDrawer.render)
    const log = spyLogger()
    let text: string
    try {
      text = answered(await ask('today', dataCatalog({ ...cashDrawer, render })))
    } finally {
      log.restore()
    }
    expect(render).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(render.mock.calls)).not.toContain('CENTINELA')
    expect(text).not.toContain('CENTINELA')
    expect(text).toContain('una persona la abrió')
    expect(
      log
        .args()
        .map(a => JSON.stringify(a) ?? String(a))
        .filter(a => a.includes('CENTINELA')),
    ).toEqual([])
  })

  it('no answer has a parenthesis other than «(corte HH:mm)»', async () => {
    const { ana, luis } = await people()
    const texts = [await say()] // ninguna
    await seedCashDrawer(f.northId, { openedBy: ana, openedByName: 'Ana López', openedAt: earlier(30), deviceName: 'Caja (iPad 2)' })
    texts.push(await say())
    await seedCashDrawer(f.northId, {
      openedBy: luis,
      openedByName: 'Luis Pérez',
      openedAt: local('23:10', 1),
      closedBy: null,
      closedAt: todayAt('01:00'),
    })
    texts.push(await say(), await say('yesterday'))
    for (const text of texts) expect([text, /[()]/.test(text.replace(/\(corte \d{2}:\d{2}\)/g, ''))]).toEqual([text, false])
  })
})

/** Un nodo del plan de Postgres (EXPLAIN en JSON). */
type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PlanNode[] }
const NEW_INDEXES = ['CashDrawerSession_venueId_openedAt_idx', 'CashDrawerSession_venueId_closedAt_idx']
/**
 * Los índices que el plan puede usar: los dos de C8 para las ramas con fecha y, para la rama «sigue abierta», uno de los dos que leen sólo
 * cajas ABIERTAS: el único parcial de la caja abierta por sucursal (`CashDrawerSession_venueId_open_key`, migración 20260827151634) o
 * `CashDrawerSession_status_idx` (las abiertas de todas las sucursales: como mucho una por sucursal, por ese mismo único; medido en la nube
 * en la ronda 1, el planificador lo eligió). No: `CashDrawerSession_venueId_idx`, que recorre toda la historia de cajas de la sucursal.
 */
const VENUE_INDEXES = [...NEW_INDEXES, 'CashDrawerSession_venueId_open_key', 'CashDrawerSession_status_idx']

describe('case 46: the indexes of the drawer', () => {
  it('after the migrations the two indexes of C8 and the open-drawer one are valid and ready, and the capability is on', async () => {
    const rows = await prisma.$queryRaw<{ name: string; valid: boolean; ready: boolean; def: string }[]>`
      SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready, pg_get_indexdef(i.indexrelid) AS def
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = to_regclass('"CashDrawerSession"') AND c.relname IN (
        'CashDrawerSession_venueId_openedAt_idx', 'CashDrawerSession_venueId_closedAt_idx', 'CashDrawerSession_venueId_open_key',
        'CashDrawerSession_venueId_status_idx')
      ORDER BY 1`
    // r1: el de [venueId, status] ya no existe; la rama «sigue abierta» va por el único parcial de la caja abierta (27-ago)
    // (la condición del único parcial sin el nombre del tipo del enum, que Postgres escribe con su cast)
    const def = (r: { def: string }) => r.def.slice(r.def.indexOf('USING')).replace(/::"?CashDrawerStatus"?/g, '')
    expect(rows.map(r => [r.name, r.valid, r.ready, def(r)])).toEqual([
      ['CashDrawerSession_venueId_closedAt_idx', true, true, 'USING btree ("venueId", "closedAt")'],
      ['CashDrawerSession_venueId_open_key', true, true, `USING btree ("venueId") WHERE (status = 'OPEN')`],
      ['CashDrawerSession_venueId_openedAt_idx', true, true, 'USING btree ("venueId", "openedAt")'],
    ])
    expect(await cashDrawerIndexesReady()).toBe(true)
    const { ana } = await people()
    await seedCashDrawer(f.northId, { openedBy: ana, openedByName: 'Ana López', openedAt: earlier(30) })
    expect(await ask()).toMatchObject({ kind: 'answer', capability: 'cash_drawer' })
  })

  it('while one of them is missing or invalid, the capability is out of the catalog and nothing is read', async () => {
    // Un proceso nuevo (lo que recuerda el servicio es del proceso) al que pg_index le contesta que sólo dos de los tres (los dos de C8 y el de la caja abierta) sirven
    let isolated!: { prepare: typeof prepareDataAnswer; client: typeof prisma }
    jest.isolateModules(() => {
      isolated = {
        prepare: (require('@/services/support/data/answer.service') as typeof import('@/services/support/data/answer.service'))
          .prepareDataAnswer,
        client: (require('@/utils/prismaClient') as typeof import('@/utils/prismaClient')).default,
      }
    })
    const real = isolated.client.$queryRaw.bind(isolated.client)
    const raw = jest
      .spyOn(isolated.client, '$queryRaw')
      .mockImplementation(((sql: TemplateStringsArray, ...values: unknown[]) =>
        sql.join('?').includes('pg_index') ? Promise.resolve([{ ready: 2 }]) : real(sql, ...values)) as never)
    const sessions = jest.spyOn(isolated.client.cashDrawerSession, 'findMany')
    try {
      const out = await isolated.prepare({
        conversation: await f.conversation(),
        request: REQUEST,
        message: MESSAGE.today,
        now: new Date(),
      })
      const labels = Object.values(DATA_CAPABILITIES)
        .filter(c => c.key !== 'cash_drawer')
        .map(c => c.label)
      expect(out).toMatchObject({ kind: 'refusal', text: supportDataOutOfCatalog(labels), log: null })
      expect(raw.mock.calls.some(([sql]) => (sql as TemplateStringsArray).join('?').includes('pg_index'))).toBe(true)
      expect(sessions).not.toHaveBeenCalled()
    } finally {
      await isolated.client.$disconnect()
    }
  })

  it('with 3,000 sessions of the venue and 3,000 of another, ANALYZE, the plan of the query has no «Seq Scan» on CashDrawerSession', async () => {
    const now = Date.now()
    for (const venueId of [f.northId, f.siblingId]) {
      await prisma.cashDrawerSession.createMany({
        data: Array.from({ length: 3000 }, (_, i) => {
          const openedAt = new Date(now - (i % 60) * DAY - (i % 600) * 60_000 - 3_600_000)
          const open = i === 0 // una sola abierta por sucursal: la base no deja guardar dos
          return {
            venueId,
            openedByStaffId: `plan-${i}`,
            openedByName: 'Plan',
            openedAt,
            startingAmount: 100,
            status: open ? ('OPEN' as const) : ('CLOSED' as const),
            closedAt: open ? null : new Date(openedAt.getTime() + 3_600_000),
            closedByStaffId: open ? null : `plan-${i}`,
            closedByName: open ? null : 'Plan',
          }
        }),
      })
    }
    await prisma.$executeRawUnsafe('ANALYZE "CashDrawerSession"')
    // Las consultas que Prisma arma de verdad para readCashDrawers: la misma función, por un cliente que anota su SQL. El `afterEach`
    // del archivo (`jest.restoreAllMocks`) regresa los espías, también si la prueba se pasa de tiempo.
    const logged = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })
    const queries: { query: string; params: string }[] = []
    logged.$on('query', e => queries.push({ query: e.query, params: e.params }))
    jest.spyOn(prisma, '$transaction').mockImplementation(((ops: never) => logged.$transaction(ops)) as never)
    jest.spyOn(prisma.cashDrawerSession, 'count').mockImplementation(((args: never) => logged.cashDrawerSession.count(args)) as never)
    jest.spyOn(prisma.cashDrawerSession, 'findMany').mockImplementation(((args: never) => logged.cashDrawerSession.findMany(args)) as never)
    jest.spyOn(prisma.staff, 'findMany').mockImplementation(((args: never) => logged.staff.findMany(args)) as never)
    let read: Awaited<ReturnType<typeof readCashDrawers>>
    try {
      read = await readCashDrawers(f.northId, today(), 5)
    } finally {
      await logged.$disconnect()
    }
    expect(read.rows).toHaveLength(5)
    const onDrawers = queries.filter(q => /FROM "[^"]+"\."CashDrawerSession"/.test(q.query))
    expect(onDrawers).toHaveLength(2) // el conteo y la lista
    for (const { query, params } of onDrawers) {
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
      walk((typeof plan === 'string' ? JSON.parse(plan) : (plan as { Plan: PlanNode }[]))[0].Plan)
      const used = nodes.filter(n => n['Index Name']).map(n => n['Index Name'])
      const seq = nodes.filter(n => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'CashDrawerSession')
      // El plan va dentro de lo que se compara: sólo se imprime si la revisión falla (la consulta primero, junto al plan)
      expect({ consulta: query, seq, fuera: used.filter(name => !VENUE_INDEXES.includes(String(name))), plan: used }).toEqual({
        consulta: query,
        seq: [],
        fuera: [],
        plan: used,
      })
    }
  }, 60_000)

  it('while a CREATE INDEX CONCURRENTLY runs on the table, opening a drawer is not blocked', async () => {
    const probe = 'CashDrawerSession_b_probe_idx'
    const ana = await seedCashier(f.northId, 'Ana', 'López')
    const held = await seedCashDrawer(f.northId, {
      openedBy: ana,
      openedByName: 'Ana López',
      openedAt: earlier(30),
      closedBy: ana,
      closedByName: 'Ana López',
      closedAt: earlier(20),
    })
    const [holder, builder, opener] = [new PrismaClient(), new PrismaClient(), new PrismaClient()]
    let release = () => {}
    const released = new Promise<void>(resolve => (release = resolve))
    let locked = () => {}
    const isLocked = new Promise<void>(resolve => (locked = resolve))
    /** El CREATE INDEX de la sonda, mientras esté en curso (y esperando un candado: el del escritor de abajo). */
    const building = async () =>
      (
        await prisma.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'
            AND query ILIKE 'CREATE INDEX CONCURRENTLY%' AND position(${probe} in query) > 0 AND wait_event = 'virtualxid'`
      )[0].n === 1
    try {
      // 1. Un escritor con su transacción abierta: CREATE INDEX CONCURRENTLY espera a que termine antes de construir
      const holding = holder.$transaction(
        async tx => {
          await tx.$executeRaw`UPDATE "CashDrawerSession" SET "deviceName" = 'sonda' WHERE id = ${held}`
          locked()
          await released
        },
        { timeout: 60_000, maxWait: 10_000 },
      )
      await isLocked
      // 2. El índice de la sonda, CONCURRENTLY, como las migraciones de C8: queda esperando al escritor. Un PrismaPromise no sale hasta
      //    su `then`: se lanza aquí, sin esperarlo, y su error (si lo hay) se ve al final
      const built = builder
        .$executeRawUnsafe(
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${probe}" ON "public"."CashDrawerSession"("venueId", "openedByStaffId")`,
        )
        .then(
          () => 'built',
          (err: unknown) => err,
        )
      for (let i = 0; i < 150 && !(await building()); i++) await new Promise(resolve => setTimeout(resolve, 100))
      expect(await building()).toBe(true)
      // 3. Abrir una caja mientras tanto: con lock_timeout de 2 s, una espera por el índice la haría fallar
      const opened = await opener.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'")
        return tx.cashDrawerSession.create({
          data: { venueId: f.northId, openedByStaffId: ana, openedByName: 'Ana López', openedAt: new Date(), startingAmount: 500 },
          select: { id: true },
        })
      })
      expect(opened.id).toEqual(expect.any(String))
      expect(await building()).toBe(true) // el índice seguía en curso: la apertura no esperó a que terminara
      release()
      await holding
      expect(await built).toBe('built')
      const [{ valid }] = await prisma.$queryRaw<{ valid: boolean }[]>`
        SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass(${`"${probe}"`})`
      expect(valid).toBe(true)
    } finally {
      release()
      await prisma.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${probe}"`)
      await Promise.all([holder.$disconnect(), builder.$disconnect(), opener.$disconnect()])
    }
  }, 60_000)
})

describe('case 48: a name only where the two sources agree', () => {
  it('the organization owner without a venue row closes and «Encargada» stays saved → «una persona»; with her directory name saved → her name', async () => {
    const ana = await seedCashier(f.northId, 'Ana', 'López')
    const owner = await seedCashier(f.northId, 'Lucía', 'Pérez', { membership: 'organization' })
    const [opened, closed] = [earlier(30), earlier(10)]
    await seedCashDrawer(f.northId, {
      openedBy: ana,
      openedByName: 'Ana López',
      openedAt: opened,
      closedBy: owner,
      closedByName: 'Encargada',
      closedAt: closed,
    })
    expect((await say()).endsWith(`: Ana López la abrió a las ${hour(opened)} y una persona la cerró a las ${hour(closed)}.`)).toBe(true)
    await prisma.cashDrawerSession.updateMany({ where: { venueId: f.northId }, data: { closedByName: 'Lucía Pérez' } })
    expect((await say()).endsWith(`: Ana López la abrió a las ${hour(opened)} y Lucía Pérez la cerró a las ${hour(closed)}.`)).toBe(true)
  })

  it('an id of another business, or empty → «una persona» even if the saved name is hers', async () => {
    const stranger = await seedCashier(f.foreignId, 'Sara', 'Beta') // su fila es de la sucursal de otra organización
    const [first, firstClosed, second] = [earlier(40), earlier(30), earlier(20)]
    await seedCashDrawer(f.northId, {
      openedBy: '',
      openedByName: 'Sara Beta',
      openedAt: first,
      closedBy: '',
      closedByName: 'Sara Beta',
      closedAt: firstClosed,
    })
    await seedCashDrawer(f.northId, { openedBy: stranger, openedByName: 'Sara Beta', openedAt: second })
    const lines = (await say()).split('\n')
    expect(lines.slice(1)).toEqual([
      `una persona la abrió a las ${hour(first)} y una persona la cerró a las ${hour(firstClosed)}.`,
      `una persona la abrió a las ${hour(second)} y sigue abierta.`,
    ])
    // Control positivo: en SU sucursal, el mismo guardado sí sale (la comparación pasaría si el directorio la incluyera)
    await seedCashDrawer(f.foreignId, { openedBy: stranger, openedByName: 'Sara Beta', openedAt: earlier(40) })
    expect((await readCashDrawers(f.foreignId, today(), 5)).rows.map(r => r.abrió)).toEqual(['Sara Beta'])
  })

  it('a person whose venue row is inactive still comes out', async () => {
    const gone = await seedCashier(f.northId, 'Ana', 'López', { inactive: true })
    await seedCashDrawer(f.northId, { openedBy: gone, openedByName: 'Ana López', openedAt: earlier(30) })
    expect(await say()).toContain(': Ana López la abrió a las ')
  })

  it('a CLOSED drawer with closedByStaffId NULL says «se cerró sola a las…» whatever closedByName says', async () => {
    const { ana } = await people()
    const [opened, closed] = [earlier(30), earlier(10)]
    await seedCashDrawer(f.northId, {
      openedBy: ana,
      openedByName: 'Ana López',
      openedAt: opened,
      closedBy: null,
      closedByName: 'Ana López',
      closedAt: closed,
    })
    expect((await say()).endsWith(`: Ana López la abrió a las ${hour(opened)} y se cerró sola a las ${hour(closed)}.`)).toBe(true)
  })

  it('five drawers → one directory query with at most 10 ids', async () => {
    const names = [
      'Ana López',
      'Luis Pérez',
      'Rosa Díaz',
      'Iván Ruiz',
      'Eva Mora',
      'Juan Cruz',
      'Paz Gil',
      'León Sáenz',
      'Inés Vela',
      'Tomás Rey',
    ]
    const ids: string[] = []
    for (const name of names) ids.push(await seedCashier(f.northId, name.split(' ')[0], name.split(' ')[1]))
    for (let i = 0; i < 5; i++)
      await seedCashDrawer(f.northId, {
        openedBy: ids[2 * i],
        openedByName: names[2 * i],
        openedAt: earlier(50 - i * 5),
        closedBy: ids[2 * i + 1],
        closedByName: names[2 * i + 1],
        closedAt: earlier(48 - i * 5),
      })
    const spy = spyQueries()
    let text: string
    let calls: QueryCall[]
    try {
      text = await say()
    } finally {
      calls = spy.calls
      spy.restore()
    }
    // la del directorio (los demás `Staff` que lee el orquestador son por llave: el acceso y la sesión de quien pregunta)
    const directory = calls.filter(c => c.model === 'Staff' && c.action === 'findMany')
    expect(directory).toHaveLength(1)
    const asked = (directory[0].args as { where: { id: { in: string[] } } }).where.id.in
    expect([...asked].sort()).toEqual([...ids].sort())
    for (const name of names) expect(text).toContain(name)
    expect(text.split('\n')).toHaveLength(6)
  })

  it('a venue named «Flautas $850» → «tu sucursal»', async () => {
    await prisma.venue.update({ where: { id: f.northId }, data: { name: 'Flautas $850' } })
    expect(await say()).toMatch(/^No encontré cajas abiertas ni cerradas hoy en tu sucursal \(corte \d{2}:\d{2}\)\.$/)
    const { ana } = await people()
    await seedCashDrawer(f.northId, { openedBy: ana, openedByName: 'Ana López', openedAt: earlier(30) })
    expect(await say()).toMatch(/^Caja de tu sucursal, /)
  })

  it('opened and closed through the real mobile service without a name → the name comes out', async () => {
    const { ana, luis } = await people()
    // La app no manda nombre: el controlador de la tablet pone «Staff» y el servicio lo cambia por el del directorio
    await openSession({ venueId: f.northId, staffId: ana, staffName: 'Staff', startingAmount: 500 })
    expect(await say()).toContain(': Ana López la abrió a las ')
    await closeSession({ venueId: f.northId, staffId: luis, staffName: 'Staff', actualAmount: 500 })
    const saved = await prisma.cashDrawerSession.findFirstOrThrow({
      where: { venueId: f.northId },
      select: { openedByName: true, closedByName: true },
    })
    expect(saved).toEqual({ openedByName: 'Ana López', closedByName: 'Luis Pérez' })
    const text = await say()
    expect([text.includes(': Ana López la abrió a las '), text.includes(' y Luis Pérez la cerró a las ')]).toEqual([true, true])
  })

  it.each<[Exclude<Day, 'other'>, string]>([
    ['today', 'hoy'],
    ['yesterday', 'ayer'],
  ])('zero rows: a complete sentence (%s)', async (day, word) =>
    expect(await say(day)).toMatch(new RegExp(`^No encontré cajas abiertas ni cerradas ${word} en Norte \\(corte \\d{2}:\\d{2}\\)\\.$`)),
  )
})

describe('isolation of readCashDrawers (T-B41): another venue of the organization and a venue of another organization', () => {
  it('their drawers, open and closed that day, never come out nor count in the total; each read alone shows its own', async () => {
    const { ana } = await people()
    await seedCashDrawer(f.northId, { openedBy: ana, openedByName: 'Ana López', openedAt: earlier(30) })
    for (const [venueId, opened, closed] of [
      [f.siblingId, 'Rita Alfa', 'Sara Alfa'],
      [f.foreignId, 'Carla Beta', 'Bruno Beta'],
    ] as const) {
      const o = await seedCashier(venueId, ...(opened.split(' ') as [string, string]))
      const c = await seedCashier(venueId, ...(closed.split(' ') as [string, string]))
      await seedCashDrawer(venueId, { openedBy: o, openedByName: opened, openedAt: earlier(25) })
      await seedCashDrawer(venueId, {
        openedBy: o,
        openedByName: opened,
        openedAt: earlier(20),
        closedBy: c,
        closedByName: closed,
        closedAt: earlier(15),
      })
      // Control positivo: leída con SU sucursal, salen las dos y sus nombres
      const theirs = await readCashDrawers(venueId, today(), 5)
      expect([theirs.total, theirs.rows.map(r => [r.abrió, r.cerró])]).toEqual([
        2,
        [
          [opened, null],
          [opened, closed],
        ],
      ])
    }
    const own = await readCashDrawers(f.northId, today(), 5)
    expect([own.total, own.rows.map(r => r.abrió)]).toEqual([1, ['Ana López']])
    const text = await say()
    for (const name of ['Rita', 'Sara', 'Carla', 'Bruno']) expect(text).not.toContain(name)
  })

  it('a person who is only in the other organization never brings a name from the directory', async () => {
    const stranger = await seedCashier(f.foreignId, 'Carla', 'Beta')
    await seedCashDrawer(f.northId, {
      openedBy: stranger,
      openedByName: 'Carla Beta',
      openedAt: earlier(30),
      closedBy: stranger,
      closedByName: 'Carla Beta',
      closedAt: earlier(10),
    })
    expect((await readCashDrawers(f.northId, today(), 5)).rows.map(r => [r.abrió, r.cerró])).toEqual([[null, null]])
    // Control positivo: con su fila en Norte, el mismo guardado sí sale
    await prisma.staffVenue.create({ data: { staffId: stranger, venueId: f.northId, role: 'CASHIER' } })
    expect((await readCashDrawers(f.northId, today(), 5)).rows.map(r => [r.abrió, r.cerró])).toEqual([['Carla Beta', 'Carla Beta']])
  })
})
