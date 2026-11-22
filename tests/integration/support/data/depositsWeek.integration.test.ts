/**
 * C6 · «Lo que cae en el banco esta semana» (la B): lo que «Saldo Disponible» del panel enseña para la semana en curso
 * (`getSettlementsLandingInWeek`, la vara), sumado por grupos en la base (`getSettlementWeekByGroups`). Postgres de verdad (la base de
 * la nube). Lo que vale para toda capacidad (venenos, logs, datos ajenos, la sucursal sin datos) lo prueba el barrido
 * (`sweeps.integration.test.ts`). La paridad usa una semana fija, la del lun 16 al dom 22-nov-2026 (el 16 es día festivo); lo que pasa
 * por el orquestador, la semana de hoy, con cobros que caen hoy (la regla del mismo día natural).
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as balance from '@/services/dashboard/availableBalance.dashboard.service'
import * as calendar from '@/services/dashboard/settlementCalendar.dashboard.service'
import { getSettlementsLandingInWeek, venueWeekBounds } from '@/services/dashboard/settlementCalendar.dashboard.service'
import { getSettlementWeekByGroups, settlementGroupsSql } from '@/services/dashboard/settlementWeekByGroups.service'
import { prepareDataAnswer, type DataOutcome } from '@/services/support/data/answer.service'
import { depositsWeek } from '@/services/support/data/capabilities/depositsWeek'
import { dataCatalog, type DataCatalog, type DataRequest, type DataScope } from '@/services/support/data/catalog'
import { checkRendered } from '@/services/support/data/check'
import { fmtTime } from '@/services/support/data/format'
import { SUPPORT_DATA_QUERY_FAILED, SUPPORT_DATA_REFUSALS, supportDataNoPermission } from '@/services/support/data/texts'
import { venueDayKey } from '@/utils/venueDateKeys'
import {
  clearCardMerchants,
  clearSales,
  earlierToday,
  seedCardMerchant,
  seedCardPayment,
  seedDataFixture,
  spyLogger,
  spyQueries,
  type DataFixture,
  type QueryCall,
} from '@tests/__helpers__/supportData'

const CDMX = 'America/Mexico_City'
const CANCUN = 'America/Cancun'
const TIJUANA = 'America/Tijuana'
const DAY = 86_400_000
/** Los índices de Payment que empiezan por la sucursal y llevan la fecha (`schema.prisma`, Payment): el que nombra el servicio y el de C2. */
const VENUE_INDEXES = ['Payment_venueId_status_createdAt_idx', 'Payment_venueId_createdAt_idx']
const REQUEST: DataRequest = { capability: 'deposits_week', day: null, amount: null, time: null, otherVenue: false }
const MESSAGE = '¿Cuánto me cae en el banco esta semana?'
/** El miércoles 18-nov-2026 a las 14:32 de la CDMX: su semana es la del lun 16 (festivo) al dom 22-nov. */
const NOW = new Date('2026-11-18T20:32:00Z')
/** Una hora de noviembre de 2026 escrita en la CDMX (UTC−6 todo el año). */
const mx = (day: number, hhmm: string) => new Date(`2026-11-${String(day).padStart(2, '0')}T${hhmm}:00-06:00`)

let f: DataFixture
let venues: string[]
beforeAll(async () => {
  f = await seedDataFixture('support-data-deposits-week')
  venues = [f.northId, f.cancunId, f.emptyId, f.siblingId, f.foreignId]
})
afterAll(() => f?.clean())
beforeEach(async () => {
  await f.reset()
  process.env.SUPPORT_DATA_ENABLED = 'true'
  delete process.env.SUPPORT_DATA_DEPOSIT_GROUPS
  delete process.env.SUPPORT_DATA_DEPOSIT_TIMEOUT_SECONDS
  await clearSales(venues)
  await clearCardMerchants(venues)
  await f.grant({ permissions: ['settlements:read'], features: ['ADVANCED_REPORTS'] })
  await f.unlock()
})
afterEach(() => jest.restoreAllMocks())

/** Un alcance armado a mano, con el reloj fijo de la semana de la paridad. */
const scopeFor = (venueId: string, timezone = CDMX, now = NOW): DataScope => ({
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
/** La pregunta por el orquestador, con el reloj de verdad (el desbloqueo es de hoy), en la plática de la persona. */
const ask = async (over: Partial<DataRequest> = {}, catalog?: DataCatalog, venueId = f.northId) =>
  prepareDataAnswer(
    { conversation: { ...(await f.conversation()), venueId }, request: { ...REQUEST, ...over }, message: MESSAGE, now: new Date() },
    catalog,
  )
const answered = (out: DataOutcome) => {
  if (out.kind !== 'answer') throw new Error(`deposits_week: ${out.text}`)
  return out.envelope.text
}
/** Un catálogo con la capacidad de verdad y su `read` espiado (o cambiado por otro que llama al de verdad). */
const spiedCatalog = (read: typeof depositsWeek.read = depositsWeek.read) => {
  const spy = jest.fn(read)
  return { read: spy, catalog: dataCatalog({ ...depositsWeek, read: spy }) }
}
/** La B (la lectura de la capacidad) y el panel, para la misma sucursal y la misma semana. */
async function both(venueId: string, timezone = CDMX, now = NOW) {
  const scope = scopeFor(venueId, timezone, now)
  const b = await depositsWeek.read(scope, {})
  const { weekStart, weekEnd } = venueWeekBounds(scope.day, timezone)
  const panel = await getSettlementsLandingInWeek(venueId, weekStart, weekEnd, timezone)
  return { b, panel, scope }
}
const panelDays = (panel: Awaited<ReturnType<typeof getSettlementsLandingInWeek>>) => panel.days.map(d => ({ date: d.date, net: d.net }))

describe('parity to the cent with getSettlementsLandingInWeek (case 37)', () => {
  it('Norte: a minute before and after the cutoff, a rule change in the window, tips, 4-decimal fees, a weekend and a holiday, debit and credit', async () => {
    const merchant = await seedCardMerchant(f.northId, [
      // Crédito: 1 día hábil y corte 23:00 hasta el vie 13 a las 11:59:59.999; desde ahí, 2 días hábiles y corte 22:00
      { settlementDays: 1, settlementDayType: 'BUSINESS_DAYS', cutoffTime: '23:00', effectiveTo: new Date('2026-11-13T17:59:59.999Z') },
      { settlementDays: 2, settlementDayType: 'BUSINESS_DAYS', cutoffTime: '22:00', effectiveFrom: new Date('2026-11-13T18:00:00Z') },
      // Débito: 1 día natural, corte 23:00
      { cardType: 'DEBIT', settlementDays: 1, settlementDayType: 'CALENDAR_DAYS', cutoffTime: '23:00' },
    ])
    const pay = (at: Date, amount: number, tip: number, charge: string, extra: Parameters<typeof seedCardPayment>[3] = { amount }) =>
      seedCardPayment(f.northId, merchant, at, { ...extra, amount, tip, charge, fixed: extra.fixed ?? '0.5000' })
    await pay(mx(11, '10:00'), 999.99, 0, '9.9999') // mié 11 → jue 12: cae antes de la semana
    await pay(mx(13, '11:00'), 100.01, 10.01, '3.3003') // vie 13, regla vieja → (sáb, dom, lun 16 festivo) mar 17
    await pay(mx(13, '13:00'), 19.99, 0.02, '0.4498') // vie 13, regla nueva → mié 18
    await pay(mx(13, '23:30'), 250.5, 25.25, '6.2501') // vie 13 después del corte → sáb 14 → mié 18
    await pay(mx(17, '21:59'), 80, 8.88, '1.7776') // un minuto antes del corte → jue 19
    await pay(mx(17, '22:01'), 1000, 0, '25.0050') // un minuto después del corte → vie 20
    await pay(mx(21, '10:00'), 333.33, 33.33, '8.3333', { amount: 0, cardType: 'DEBIT' }) // débito sáb 21 → dom 22
    await pay(mx(22, '23:30'), 444.44, 0, '11.1111', { amount: 0, cardType: 'DEBIT' }) // débito dom 22 después del corte → la siguiente
    await pay(mx(18, '12:00'), -100.01, -10.01, '-2.5003', { amount: 0, refund: true, fixed: '-0.5000' }) // una devolución → el mié 18 en que se registró (D17)
    // Una devolución no espera su costo ni su regla: cae el día en que se registró, con comisión 0 si su costo no llegó (D17)
    await pay(mx(19, '12:00'), -50, 0, '0.0000', { amount: 0, refund: true, cost: false, fixed: '0.0000' }) // jue 19, −50
    await pay(mx(19, '13:00'), -20, 0, '-0.5000', { amount: 0, refund: true, cardType: 'AMEX', fixed: '0.0000' }) // jue 19, −19.50
    // …pero una devolución por transferencia que guardó la afiliación, sin costo, no sale del banco (Codex r2 del carril C2, #1)
    await pay(mx(19, '14:00'), -30.03, 0, '0.0000', { amount: 0, refund: true, cost: false, method: 'BANK_TRANSFER', fixed: '0.0000' })
    await prisma.payment.updateMany({ where: { venueId: f.northId, amount: -30.03 }, data: { fundsFlow: 'EXTERNAL_RECORDED' } })
    // …y si ya trae su costo (copiado del cobro), sigue como antes: por su regla, el mar 17 → jue 19, no el día en que se registró (r3 #2)
    await pay(mx(17, '12:00'), -10, 0, '0.0000', { amount: 0, refund: true, method: 'BANK_TRANSFER', fixed: '0.0000' })
    await prisma.payment.updateMany({ where: { venueId: f.northId, amount: -10 }, data: { fundsFlow: 'EXTERNAL_RECORDED' } })
    // Lo que el panel no cuenta, tampoco la B: efectivo, pendiente, sin costo, y sin regla para su tipo de tarjeta
    await pay(mx(17, '12:00'), 777.77, 0, '1.0000', { amount: 0, method: 'CASH' })
    await pay(mx(17, '12:00'), 666.66, 0, '1.0000', { amount: 0, status: 'PENDING' })
    await pay(mx(17, '12:00'), 555.55, 0, '1.0000', { amount: 0, cost: false })
    await pay(mx(17, '12:00'), 888.88, 0, '1.0000', { amount: 0, cardType: 'AMEX' })

    const { b, panel } = await both(f.northId)
    // A mano: neto = importe + propina − redondeo a 2 decimales de (comisión + cargo fijo)
    expect(panelDays(panel)).toEqual([
      { date: '2026-11-17', net: 106.22 }, // 110.02 − 3.80
      { date: '2026-11-18', net: 181.04 }, // (20.01 − 0.95) + (275.75 − 6.75) + (−110.02 + 3.00) de la devolución
      { date: '2026-11-19', net: 7.1 }, // 88.88 − 2.28 − 50 − 19.50 − 10 (la devolución por transferencia, por su regla)
      { date: '2026-11-20', net: 974.49 }, // 1000 − 25.51
      { date: '2026-11-22', net: 357.83 }, // 366.66 − 8.83
    ])
    expect(panel.weekTotal).toEqual({ gross: 1671.3, commission: 44.62, net: 1626.68, count: 10 })
    expect(b.days).toEqual(panelDays(panel))
    expect(b.total).toEqual(panel.weekTotal)
  })

  it('Cancún with its cutoff in Mexico City time: a payment after the cutoff of Mexico City lands on another day of Cancún', async () => {
    const merchant = await seedCardMerchant(f.cancunId, [{ settlementDays: 1, settlementDayType: 'BUSINESS_DAYS', cutoffTime: '23:00' }])
    const pay = (at: Date, amount: number, charge: string) => seedCardPayment(f.cancunId, merchant, at, { amount, tip: 5, charge })
    await pay(mx(18, '22:30'), 300, '7.5000') // 23:30 en Cancún → jue 19 22:30 CDMX = jue 19 23:30 Cancún
    await pay(mx(18, '22:59'), 301, '7.5250') // → jue 19
    await pay(mx(18, '23:10'), 302, '7.5500') // después del corte → vie 20 23:10 CDMX = sáb 21 00:10 en Cancún
    await pay(mx(17, '23:30'), 303, '7.5750') // mié 18 00:30 en Cancún, después del corte → jue 19 23:30 CDMX = vie 20 00:30 Cancún
    // El mismo día del corte y del mismo lado de él, pero otro día de Cancún: sólo el día de la sucursal los separa en dos grupos
    await pay(mx(18, '21:00'), 304, '7.6000') // mié 18 22:00 en Cancún → jue 19 22:00 Cancún
    await pay(new Date(mx(18, '23:00').getTime() + 30_000), 305, '7.6250') // 23:00:30, no pasa el corte; jue 19 00:00:30 en Cancún → vie 20
    const { b, panel } = await both(f.cancunId, CANCUN)
    expect(panelDays(panel).map(d => d.date)).toEqual(['2026-11-19', '2026-11-20', '2026-11-21'])
    expect(b.days).toEqual(panelDays(panel))
    expect(b.total).toEqual(panel.weekTotal)
  })

  it('the ROUND of the query breaks ties like the server: three costs of 0.0250, 0.0249 and −0.0250 give 3, 2 and −3 cents of commission', async () => {
    const merchant = await seedCardMerchant(f.northId)
    for (const [charge, cents] of [
      ['0.0250', 0.03],
      ['0.0249', 0.02],
      ['-0.0250', -0.03],
    ] as const) {
      await clearSales([f.northId])
      await seedCardPayment(f.northId, merchant, mx(17, '12:00'), { amount: 1, charge })
      const { b, panel } = await both(f.northId)
      expect([b.total.commission, panel.weekTotal.commission]).toEqual([cents, cents])
      expect(b.total).toEqual(panel.weekTotal)
    }
    // Dos de 0.0250 en el MISMO grupo: 3 + 3 centavos, como el panel cobro por cobro (redondear la suma daría 5)
    await clearSales([f.northId])
    for (const minute of ['12:00', '12:01']) await seedCardPayment(f.northId, merchant, mx(17, minute), { amount: 1, charge: '0.0250' })
    const { b, panel } = await both(f.northId)
    expect([b.total.commission, panel.weekTotal.commission]).toEqual([0.06, 0.06])
    expect(b.total).toEqual(panel.weekTotal)
  })

  it('seven days with a payment each: still the same as the panel, on ONE line, and the answer is 4 lines', async () => {
    const merchant = await seedCardMerchant(f.northId)
    for (let day = 16; day <= 22; day++) await seedCardPayment(f.northId, merchant, mx(day, '12:00'), { amount: 1000 + day / 100 })
    const { b, panel, scope } = await both(f.northId)
    expect(b.days).toEqual(panelDays(panel))
    expect(b.days).toHaveLength(7)
    const rendered = depositsWeek.render(scope, {}, b)
    expect(checkRendered(rendered, CDMX)).toBe(true)
    expect(rendered.text.split('\n')).toHaveLength(4)
    expect(rendered.text.split('\n')[2]).toBe('Total de la semana: $7,001.33.')
  })
})

describe('isolation of getSettlementWeekByGroups (T-B41)', () => {
  it('card payments of the same week in a sibling venue and in another organization, by the SAME merchant account, move no day and no total', async () => {
    const shared = await seedCardMerchant(f.northId)
    const pay = (venueId: string, amount: number) => seedCardPayment(venueId, shared, mx(17, '12:00'), { amount })
    await pay(f.northId, 100)
    const alone = await both(f.northId)
    await pay(f.siblingId, 711.11)
    await pay(f.foreignId, 722.22)
    const after = await both(f.northId)
    expect(after.b).toEqual(alone.b)
    expect(after.b).toEqual({
      ok: true,
      days: [{ date: '2026-11-17', net: 100 }],
      total: { gross: 100, commission: 0, net: 100, count: 1 },
    })
    expect(after.b.total).toEqual(after.panel.weekTotal)
    // Los controles: leídas con su sucursal, salen sus cobros (la siembra sí se lee)
    for (const [venueId, net] of [
      [f.siblingId, 711.11],
      [f.foreignId, 722.22],
    ] as const)
      expect((await both(venueId)).b.days).toEqual([{ date: '2026-11-17', net }])
  })
})

/** Lo que consulta la lectura de la capacidad (sólo ella), al contestar por el orquestador; `check` mira el texto de la respuesta. */
async function readCalls(check: (text: string) => void = () => undefined): Promise<QueryCall[]> {
  let calls: QueryCall[] = []
  const { catalog } = spiedCatalog(async (scope, params) => {
    const spy = spyQueries()
    try {
      return await depositsWeek.read(scope, params)
    } finally {
      calls = spy.calls
      spy.restore()
    }
  })
  check(answered(await ask({}, catalog)))
  return calls
}

describe('what the B cannot add up exactly, it does not say (cases 38 and 39)', () => {
  it('a group whose first and last payment land on different days → SUPPORT_DATA_REFUSALS.DEPOSITS_OVER_CAP, no figure, OVER_CAP logged (case 38)', async () => {
    // Tijuana con el corte en la hora de la CDMX, a 1 día natural: el dom 1-nov a las 00:30 (todavía PDT) y a las 03:00 (ya PST) son
    // un grupo; el panel los pone el dom 1-nov (23:30) y el lun 2-nov (03:00): la B no puede repartirlo y no da la cifra.
    await prisma.venue.update({ where: { id: f.northId }, data: { timezone: TIJUANA } })
    await f.unlock() // el desbloqueo es del día de la sucursal, ahora en su zona nueva
    const merchant = await seedCardMerchant(f.northId, [{ cutoffTime: '23:00', settlementDays: 1 }])
    await seedCardPayment(f.northId, merchant, new Date('2026-11-01T07:30:00Z'), { amount: 100 })
    await seedCardPayment(f.northId, merchant, new Date('2026-11-01T11:00:00Z'), { amount: 200 })
    const tijuanaWeek = venueWeekBounds('2026-11-01', TIJUANA)
    const panel = await getSettlementsLandingInWeek(f.northId, tijuanaWeek.weekStart, tijuanaWeek.weekEnd, TIJUANA)
    expect(panelDays(panel)).toEqual([{ date: '2026-11-01', net: 100 }]) // el de 200 cae el lun 2-nov, la semana siguiente
    // La lectura de verdad, con la semana de ese domingo (la pregunta, por el orquestador, con su reloj de verdad)
    const { read, catalog } = spiedCatalog(scope => depositsWeek.read({ ...scope, day: '2026-11-01' }, {}))
    const out = await ask({}, catalog)
    expect(out).toMatchObject({ kind: 'refusal', text: SUPPORT_DATA_REFUSALS.DEPOSITS_OVER_CAP, log: { result: 'OVER_CAP' } })
    expect(read).toHaveBeenCalledTimes(1)
    if (out.kind !== 'refusal') throw new Error('se esperaba la negativa')
    expect(out.text).not.toMatch(/[$\d]/)
  })

  it('more groups than SUPPORT_DATA_DEPOSIT_GROUPS → SUPPORT_DATA_REFUSALS.DEPOSITS_OVER_CAP and OVER_CAP, never the first groups', async () => {
    process.env.SUPPORT_DATA_DEPOSIT_GROUPS = '1'
    const merchant = await seedCardMerchant(f.northId)
    await seedCardPayment(f.northId, merchant, earlierToday(CDMX), { amount: 100 })
    await seedCardPayment(f.northId, merchant, new Date(Date.now() - 3 * DAY), { amount: 200 }) // otro día: otro grupo
    expect(await ask()).toMatchObject({ kind: 'refusal', text: SUPPORT_DATA_REFUSALS.DEPOSITS_OVER_CAP, log: { result: 'OVER_CAP' } })
    process.env.SUPPORT_DATA_DEPOSIT_GROUPS = '2'
    expect((await ask()).kind).toBe('answer')
  })

  it('a query cancelled by the database → SUPPORT_DATA_QUERY_FAILED, QUERY_FAILED, never a partial sum', async () => {
    // statement_timeout de 1 s, y la tabla de reglas tomada por otra conexión: la base cancela la consulta (57014) a su tope
    process.env.SUPPORT_DATA_DEPOSIT_TIMEOUT_SECONDS = '1'
    const merchant = await seedCardMerchant(f.northId)
    await seedCardPayment(f.northId, merchant, earlierToday(CDMX), { amount: 100 })
    const log = spyLogger()
    let out: DataOutcome | undefined
    await prisma.$transaction(
      async tx => {
        await tx.$executeRawUnsafe('LOCK TABLE "SettlementConfiguration" IN ACCESS EXCLUSIVE MODE')
        out = await ask()
      },
      { timeout: 30_000 },
    )
    expect(out).toMatchObject({ kind: 'refusal', text: SUPPORT_DATA_QUERY_FAILED, log: { result: 'QUERY_FAILED' } })
    expect(out?.kind === 'refusal' && out.text).not.toMatch(/[$\d]/)
    const warned = log
      .args()
      .find(a => typeof a === 'object' && a !== null && (a as { capability?: string }).capability === 'deposits_week')
    expect(warned).toMatchObject({ error: 'PrismaClientKnownRequestError', code: 'P2010' }) // la base la canceló, no se venció la espera
    log.restore()
  })

  it('the read sets SET LOCAL statement_timeout to depositTimeoutMs in its transaction (case 39)', async () => {
    process.env.SUPPORT_DATA_DEPOSIT_TIMEOUT_SECONDS = '4'
    const merchant = await seedCardMerchant(f.northId)
    await seedCardPayment(f.northId, merchant, earlierToday(CDMX), { amount: 100 })
    const calls = await readCalls()
    expect(calls.filter(c => c.model === null).map(c => [c.action, c.args])).toEqual([
      ['$executeRawUnsafe', ['SET LOCAL statement_timeout = 4000']],
      ['$queryRaw', [expect.anything()]],
    ])
    // Que ese tope es de la MISMA transacción que la consulta lo prueba la de arriba: con 1 s la base cancela la consulta
  })

  it('only groups travel to the server: payment.findMany, cargarReglasFaltantes and getAvailableBalance are never called, and the rules are loaded by the ids of the groups (case 39)', async () => {
    const merchant = await seedCardMerchant(f.northId, [{}, { cardType: 'DEBIT' }])
    const rules = await prisma.settlementConfiguration.findMany({
      where: { merchantAccountId: merchant },
      select: { id: true, cardType: true },
    })
    for (let i = 0; i < 5; i++) await seedCardPayment(f.northId, merchant, earlierToday(CDMX), { amount: 100 + i })
    await seedCardPayment(f.northId, merchant, earlierToday(CDMX), { amount: 50, cardType: 'DEBIT' })
    const loads = jest.spyOn(calendar, 'cargarReglasFaltantes')
    const available = jest.spyOn(balance, 'getAvailableBalance')
    const calls = await readCalls(text => expect(text).toContain('$560.00'))
    expect(calls.filter(c => c.model === 'Payment')).toEqual([])
    const ruleReads = calls.filter(c => c.model === 'SettlementConfiguration')
    expect(ruleReads).toHaveLength(1)
    const args = ruleReads[0].args as { where: { id: { in: string[] } }; take: number }
    expect([...args.where.id.in].sort()).toEqual(rules.map(r => r.id).sort())
    expect(args.take).toBe(2000)
    expect(loads).not.toHaveBeenCalled()
    expect(available).not.toHaveBeenCalled()
    // El control: el panel sí recorre los cobros (y el espía lo ve)
    const panelSpy = spyQueries()
    const today = venueWeekBounds(venueDayKey(new Date(), CDMX), CDMX)
    await getSettlementsLandingInWeek(f.northId, today.weekStart, today.weekEnd, CDMX)
    panelSpy.restore()
    expect(panelSpy.calls.filter(c => c.model === 'Payment' && c.action === 'findMany').length).toBeGreaterThan(0)
  })

  it('execution plan: 9,000 card payments of three venues over 120 days, written in time order and interleaved as in production: no Seq Scan on Payment and a venue index with createdAt in its condition', async () => {
    const merchant = await seedCardMerchant(f.northId)
    const three = [f.northId, f.siblingId, f.foreignId]
    const orders = new Map<string, string>()
    for (const venueId of three) {
      const { id } = await prisma.order.create({
        data: {
          venueId,
          orderNumber: `EXPLAIN-${venueId}`,
          subtotal: 1,
          taxAmount: 0,
          total: 1,
          status: 'COMPLETED',
          paymentStatus: 'PAID',
        },
        select: { id: true },
      })
      orders.set(venueId, id)
    }
    // Como en producción: los cobros llegan en orden de tiempo y las sucursales se intercalan en la tabla. Con cada sucursal junta,
    // en una tabla chica, al planificador le conviene leer toda la sucursal y no el rango de fechas.
    const created = await prisma.payment.createManyAndReturn({
      data: Array.from({ length: 9000 }, (_, k) => {
        const venueId = three[k % 3]
        return {
          venueId,
          orderId: orders.get(venueId)!,
          merchantAccountId: merchant,
          amount: 100 + (k % 900),
          tipAmount: 0,
          method: 'CREDIT_CARD' as const,
          status: 'COMPLETED' as const,
          type: 'REGULAR' as const,
          feePercentage: 0,
          feeAmount: 0,
          netAmount: 100,
          createdAt: new Date(NOW.getTime() - 120 * DAY + Math.floor((k * 120 * DAY) / 9000)),
        }
      }),
      select: { id: true },
    })
    await prisma.transactionCost.createMany({
      data: created.map(p => ({
        paymentId: p.id,
        merchantAccountId: merchant,
        transactionType: 'CREDIT' as const,
        amount: 100,
        providerRate: 0,
        providerCostAmount: 0,
        venueRate: 0,
        venueChargeAmount: 2.5,
        venueFixedFee: 0,
        grossProfit: 0,
        profitMargin: 0,
      })),
    })
    await prisma.$executeRawUnsafe('ANALYZE "Payment"')
    await prisma.$executeRawUnsafe('ANALYZE "TransactionCost"')
    const { weekStart, weekEnd } = venueWeekBounds(venueDayKey(NOW, CDMX), CDMX)
    const sql = settlementGroupsSql(f.northId, weekStart, weekEnd, CDMX, 2001)
    const [{ 'QUERY PLAN': plan }] = await prisma.$queryRaw<{ 'QUERY PLAN': unknown }[]>(Prisma.sql`EXPLAIN (FORMAT JSON) ${sql}`)
    type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; 'Index Cond'?: string; Plans?: PlanNode[] }
    const nodes: PlanNode[] = []
    const walk = (node: PlanNode) => {
      nodes.push(node)
      for (const child of node.Plans ?? []) walk(child)
    }
    walk((typeof plan === 'string' ? JSON.parse(plan) : (plan as { Plan: PlanNode }[]))[0].Plan)
    // Los índices de Payment que usa (también en un Bitmap Index Scan, que no trae «Relation Name»): sólo los de sucursal y fecha
    const onPayment = nodes
      .filter(n => n['Index Name']?.startsWith('Payment_'))
      .map(n => [n['Index Name'], /venueId/.test(n['Index Cond'] ?? '') && /createdAt/.test(n['Index Cond'] ?? '')])
    try {
      expect(nodes.filter(n => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'Payment')).toEqual([])
      // UN índice de Payment por cada mitad de la consulta (los cobros por su regla y las devoluciones por su día, D17), de los que
      // empiezan por la sucursal y llevan la fecha, con las dos en su condición. Con estos datos (todos COMPLETED, como casi todo en
      // producción) el planificador toma el de sucursal y fecha; el estado no filtra nada.
      expect(onPayment).toHaveLength(2)
      for (const [index, conFecha] of onPayment) {
        expect(VENUE_INDEXES).toContain(index)
        expect(conFecha).toBe(true)
      }
    } catch (err) {
      console.log('settlementGroupsPlan', JSON.stringify(plan)) // el plan sólo se imprime si falla
      throw err
    }
    // Y el resultado de esa misma semana sigue siendo el del panel
    const b = await getSettlementWeekByGroups(f.northId, weekStart, weekEnd, CDMX, { groups: 2000, timeoutMs: 3000 })
    const panel = await getSettlementsLandingInWeek(f.northId, weekStart, weekEnd, CDMX)
    expect(b).toMatchObject({ ok: true, days: panelDays(panel), total: panel.weekTotal })
  }, 120_000)
})

describe('the gates of Saldo Disponible (case 40)', () => {
  const object = 'lo que cae en el banco esta semana'
  it('without settlements:read → supportDataNoPermission, NO_PERMISSION; read is not called', async () => {
    await f.grant({ permissions: ['reports:read'], features: ['ADVANCED_REPORTS'] })
    const { read, catalog } = spiedCatalog()
    expect(await ask({}, catalog)).toMatchObject({
      kind: 'refusal',
      text: supportDataNoPermission(object),
      log: { result: 'NO_PERMISSION' },
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('without ADVANCED_REPORTS → SUPPORT_DATA_REFUSALS.PLAN_DEPOSITS, PLAN_REQUIRED; read is not called', async () => {
    await f.grant({ permissions: ['settlements:read'] })
    const { read, catalog } = spiedCatalog()
    expect(await ask({}, catalog)).toMatchObject({
      kind: 'refusal',
      text: SUPPORT_DATA_REFUSALS.PLAN_DEPOSITS,
      log: { result: 'PLAN_REQUIRED' },
    })
    expect(read).not.toHaveBeenCalled()
  })

  it.each(['NOT_SUBMITTED', 'PENDING_REVIEW', 'IN_REVIEW', 'REJECTED'] as const)(
    'kycStatus %s → SUPPORT_DATA_REFUSALS.DEPOSITS_NEEDS_KYC, NOT_OFFERED; read is not called',
    async kycStatus => {
      await prisma.venue.update({ where: { id: f.northId }, data: { kycStatus } })
      const { read, catalog } = spiedCatalog()
      expect(await ask({}, catalog)).toMatchObject({
        kind: 'refusal',
        text: SUPPORT_DATA_REFUSALS.DEPOSITS_NEEDS_KYC,
        log: { result: 'NOT_OFFERED' },
      })
      expect(read).not.toHaveBeenCalled()
    },
  )

  it('a TRIAL venue passes, as in the panel: without the verification and without ADVANCED_REPORTS', async () => {
    await prisma.venue.update({ where: { id: f.northId }, data: { status: 'TRIAL', kycStatus: 'NOT_SUBMITTED' } })
    await f.grant({ permissions: ['settlements:read'] })
    const { read, catalog } = spiedCatalog()
    expect((await ask({}, catalog)).kind).toBe('answer')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('«¿qué me cae la próxima semana?» (day other) → SUPPORT_DATA_REFUSALS.DEPOSITS_THIS_WEEK_ONLY, PARAM_INVALID; read is not called', async () => {
    const { read, catalog } = spiedCatalog()
    expect(await ask({ day: 'other' }, catalog)).toMatchObject({
      kind: 'refusal',
      text: SUPPORT_DATA_REFUSALS.DEPOSITS_THIS_WEEK_ONLY,
      log: { result: 'PARAM_INVALID' },
    })
    expect(read).not.toHaveBeenCalled()
  })
})

describe('the answer, through the orchestrator', () => {
  it('a week whose only card movements are refunds: the day and the total say «−$110.02» in the final answer, ANSWERED and never CHECK_FAILED, with the same figure as getSettlementsLandingInWeek', async () => {
    const merchant = await seedCardMerchant(f.northId)
    await seedCardPayment(f.northId, merchant, earlierToday(CDMX), { amount: -100.01, tip: -10.01, refund: true })
    const out = await ask()
    expect(out).toMatchObject({ kind: 'answer', log: { result: 'ANSWERED' } })
    const lines = answered(out).split('\n')
    expect(lines[1]).toMatch(/^\S+ \d{1,2}-\S+ −\$110\.02$/)
    expect(lines[2]).toBe('Total de la semana: −$110.02.')
    const today = venueWeekBounds(venueDayKey(new Date(), CDMX), CDMX)
    const panel = await getSettlementsLandingInWeek(f.northId, today.weekStart, today.weekEnd, CDMX)
    expect(panel.weekTotal.net).toBe(-110.02)
    expect(panelDays(panel).map(d => d.net)).toEqual([-110.02])
  })

  it('zero rows: a complete sentence (Review Focus 2)', async () => {
    const now = new Date()
    const out = await prepareDataAnswer({ conversation: await f.conversation(), request: REQUEST, message: MESSAGE, now })
    expect(answered(out)).toBe(
      `No hay depósitos estimados para esta semana en Norte (corte ${fmtTime(now, CDMX)}). Sólo cuenta cobros con tarjeta que procesó Avoqado.`,
    )
  })
})
