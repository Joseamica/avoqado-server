/**
 * C6 · «lo que cae en el banco esta semana» (la B): la semana del panel sumada por GRUPOS en la base. Aquí, sin base: el pliegue
 * puro (`foldSettlementGroups`, el día de cada grupo con las funciones del panel y la suma exacta) y la lectura con la consulta de
 * mentira (`prismaMock`): el tope de grupos, el `statement_timeout` en SU transacción, las reglas por los ids de los grupos y un
 * corte de la base que sube tal cual. La paridad con el panel, el aislamiento y el plan de ejecución van en la integración
 * (`tests/integration/support/data/depositsWeek.integration.test.ts`).
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { venueWeekBounds } from '@/services/dashboard/settlementCalendar.dashboard.service'
import { foldSettlementGroups, getSettlementWeekByGroups, type SettlementGroup } from '@/services/dashboard/settlementWeekByGroups.service'

const CDMX = 'America/Mexico_City'
const TIJUANA = 'America/Tijuana'
/** Una regla del panel con su id (la de los grupos). */
const rule = (id: string, over: Partial<Parameters<typeof foldSettlementGroups>[1][number]> = {}) => ({
  id,
  merchantAccountId: 'm1',
  cardType: 'CREDIT' as const,
  settlementDays: 1,
  settlementDayType: 'BUSINESS_DAYS' as const,
  cutoffTime: '23:00',
  cutoffTimezone: CDMX,
  effectiveFrom: new Date('2020-01-01T00:00:00Z'),
  effectiveTo: null,
  ...over,
})
const group = (configId: string | null, first: string, last: string, gross: string, commission: string, count = 1): SettlementGroup => ({
  configId,
  gross,
  commission,
  count,
  first: new Date(first),
  last: new Date(last),
})
/**
 * Siete días cuyo total en pesos, sumando los días ya redondeados, se pasa por un centavo (lo mismo en
 * `settlementCalendar.dashboard.service.test.ts`): cada día es un importe de cobro por su número de cobros, en centavos.
 */
const BIG_DAYS = (
  [
    [163865194830n, 999n],
    [210659239271n, 997n],
    [273800645335n, 999n],
    [258531448482n, 997n],
    [191139309694n, 998n],
    [178015368479n, 999n],
    [260898872017n, 998n],
  ] as const
).map(([cents, payments]) => cents * payments)
const BIG_TOTAL = 15_339_827_484_726.75
const pesosText = (cents: bigint) => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
/** La semana del lun 16 al dom 22-nov-2026 en la CDMX (el 16 es el tercer lunes de noviembre: día festivo). */
const WEEK = venueWeekBounds('2026-11-18', CDMX)

describe('foldSettlementGroups', () => {
  it('D17: a group of refunds (no rule) lands on the venue day it was registered, even on a Friday night of the window', () => {
    const out = foldSettlementGroups(
      [
        group(null, '2026-11-20T23:00:00-06:00', '2026-11-20T23:30:00-06:00', '-110.02', '-3.00', 2),
        group(null, '2026-11-14T10:00:00-06:00', '2026-11-14T10:00:00-06:00', '-50.00', '0.00'), // before the week: out
      ],
      [],
      WEEK.weekStart,
      WEEK.weekEnd,
      CDMX,
    )
    expect(out).toEqual({
      ok: true,
      days: [{ date: '2026-11-20', net: -107.02 }],
      total: { gross: -110.02, commission: -3, net: -107.02, count: 2 },
    })
  })

  it('each group lands on its day with the functions of the panel, and the days and the total are exact sums', () => {
    const r = rule('r1')
    const out = foldSettlementGroups(
      [
        group('r1', '2026-11-13T17:00:00Z', '2026-11-13T22:00:00Z', '1110.02', '33.30', 2), // vie 13 → (sáb, dom, lun festivo) mar 17
        group('r1', '2026-11-17T16:00:00Z', '2026-11-17T18:00:00Z', '500.00', '15.00', 3), // mar 17 → mié 18
        group('r1', '2026-11-18T05:30:00Z', '2026-11-18T05:40:00Z', '20.01', '0.45'), // mar 17 23:30, después del corte → jue 19
        group('r1', '2026-11-11T16:00:00Z', '2026-11-11T17:00:00Z', '999.99', '9.99'), // mié 11 → jue 12: antes de la semana
      ],
      [r],
      WEEK.weekStart,
      WEEK.weekEnd,
      CDMX,
    )
    expect(out).toEqual({
      ok: true,
      days: [
        { date: '2026-11-17', net: 1076.72 },
        { date: '2026-11-18', net: 485 },
        { date: '2026-11-19', net: 19.56 },
      ],
      total: { gross: 1630.03, commission: 48.75, net: 1581.28, count: 6 },
    })
  })

  it('a group whose first and last payment land on different days → UNEVEN_GROUP (case 38)', () => {
    // Tijuana con el corte en la hora de la CDMX, a 1 día natural. El dom 1-nov a las 00:30 (todavía PDT) y a las 03:00 (ya PST) son
    // el mismo día del corte (01:30 y 05:00 en la CDMX) y de la sucursal; un día después, en PST, el primero cae el dom 1-nov a las
    // 23:30 y el segundo el lun 2-nov a las 03:00.
    const out = foldSettlementGroups(
      [group('r1', '2026-11-01T07:30:00Z', '2026-11-01T11:00:00Z', '100.00', '3.00', 2)],
      [rule('r1', { settlementDayType: 'CALENDAR_DAYS' })],
      venueWeekBounds('2026-11-01', TIJUANA).weekStart,
      venueWeekBounds('2026-11-01', TIJUANA).weekEnd,
      TIJUANA,
    )
    expect(out).toEqual({ ok: false, reason: 'UNEVEN_GROUP' })
  })

  it('a timezone that changes its offset between the payment and the deposit → UNEVEN_GROUP, even when the two days match', () => {
    // El sáb 31-oct a las 03:00 y a las 05:00 PDT caen el dom 1-nov a las 02:00 y 04:00 PST: el mismo día, otro desfase.
    const tijuanaWeek = venueWeekBounds('2026-11-01', TIJUANA)
    const groups = [group('r1', '2026-10-31T10:00:00Z', '2026-10-31T12:00:00Z', '100.00', '3.00', 2)]
    const rules = [rule('r1', { settlementDayType: 'CALENDAR_DAYS' })]
    expect(foldSettlementGroups(groups, rules, tijuanaWeek.weekStart, tijuanaWeek.weekEnd, TIJUANA)).toEqual({
      ok: false,
      reason: 'UNEVEN_GROUP',
    })
    // El control: la misma forma una semana después (sin cambio de horario) sí sale, en su día
    const next = venueWeekBounds('2026-11-08', TIJUANA)
    expect(
      foldSettlementGroups(
        [group('r1', '2026-11-07T11:00:00Z', '2026-11-07T13:00:00Z', '100.00', '3.00', 2)],
        rules,
        next.weekStart,
        next.weekEnd,
        TIJUANA,
      ),
    ).toEqual({ ok: true, days: [{ date: '2026-11-08', net: 97 }], total: { gross: 100, commission: 3, net: 97, count: 2 } })
  })

  it('a group that lands entirely outside the week is left out like the panel leaves out its payments, even if it is uneven', () => {
    // El grupo de arriba (cae dom 1-nov y lun 2-nov) leído desde la semana del 9 al 15-nov: nada de él cae en ella
    const week = venueWeekBounds('2026-11-11', TIJUANA)
    expect(
      foldSettlementGroups(
        [group('r1', '2026-11-01T07:30:00Z', '2026-11-01T11:00:00Z', '100.00', '3.00', 2)],
        [rule('r1', { settlementDayType: 'CALENDAR_DAYS' })],
        week.weekStart,
        week.weekEnd,
        TIJUANA,
      ),
    ).toEqual({ ok: true, days: [], total: { gross: 0, commission: 0, net: 0, count: 0 } })
  })

  it('one group of 500,000 payments with gross 5000005000.00 gives $5,000,005,000.00 (case 47)', () => {
    expect(
      foldSettlementGroups(
        [group('r1', '2026-11-17T16:00:00Z', '2026-11-17T18:00:00Z', '5000005000.00', '0.00', 500_000)],
        [rule('r1')],
        WEEK.weekStart,
        WEEK.weekEnd,
        CDMX,
      ),
    ).toEqual({
      ok: true,
      days: [{ date: '2026-11-18', net: 5_000_005_000 }],
      total: { gross: 5_000_005_000, commission: 0, net: 5_000_005_000, count: 500_000 },
    })
  })

  it('groups with gross 110.02, 20.01 and −110.02 give those totals and none throws (case 47)', () => {
    const out = foldSettlementGroups(
      [
        group('r1', '2026-11-17T16:00:00Z', '2026-11-17T16:00:00Z', '110.02', '0.00'), // → mié 18
        group('r1', '2026-11-18T16:00:00Z', '2026-11-18T16:00:00Z', '20.01', '0.00'), // → jue 19
        group('r1', '2026-11-19T16:00:00Z', '2026-11-19T16:00:00Z', '-110.02', '0.00'), // → vie 20
      ],
      [rule('r1')],
      WEEK.weekStart,
      WEEK.weekEnd,
      CDMX,
    )
    expect(out).toEqual({
      ok: true,
      days: [
        { date: '2026-11-18', net: 110.02 },
        { date: '2026-11-19', net: 20.01 },
        { date: '2026-11-20', net: -110.02 },
      ],
      total: { gross: 20.01, commission: 0, net: 20.01, count: 3 },
    })
  })

  it.each([null, '', 'abc', 'NaN', 'Infinity', '-Infinity'])(
    'a sum the database gave as %p cannot be read: it throws (QUERY_FAILED), never a silent $0 (C6 r1)',
    unreadable => {
      for (const [gross, commission] of [
        [unreadable, '0.00'],
        ['100.00', unreadable],
      ])
        expect(() =>
          foldSettlementGroups(
            [group('r1', '2026-11-17T16:00:00Z', '2026-11-17T16:00:00Z', gross as string, commission as string)],
            [rule('r1')],
            WEEK.weekStart,
            WEEK.weekEnd,
            CDMX,
          ),
        ).toThrow()
    },
  )

  it('the total is the exact sum of the cents of its days, not the sum of the days already in pesos (C6 r1)', () => {
    // Siete días de unos 2 billones de pesos (cerca de 1,000 cobros de ~2 mil millones cada uno, dentro de Decimal(12,2)): sumar
    // los días ya pasados a pesos y redondear da un centavo de más; los centavos exactos, no.
    const sameDay = rule('r1', { settlementDays: 0, settlementDayType: 'CALENDAR_DAYS', cutoffTime: '23:59' })
    const out = foldSettlementGroups(
      BIG_DAYS.map((cents, i) => {
        const at = `2026-11-${16 + i}T18:00:00Z`
        return group('r1', at, at, pesosText(cents), '0.00', 1000)
      }),
      [sameDay],
      WEEK.weekStart,
      WEEK.weekEnd,
      CDMX,
    )
    if (!out.ok) throw new Error('se esperaba la semana')
    const roundedDays = Math.round(out.days.reduce((sum, d) => sum + d.net, 0) * 100) / 100
    expect(roundedDays).not.toBe(BIG_TOTAL) // la condición de la prueba: aquí las dos sumas sí difieren
    expect(out.total).toEqual({ gross: BIG_TOTAL, commission: 0, net: BIG_TOTAL, count: 7000 })
  })

  it('a group whose rule was not loaded throws: never a partial sum', () => {
    expect(() =>
      foldSettlementGroups(
        [group('gone', '2026-11-17T16:00:00Z', '2026-11-17T16:00:00Z', '1.00', '0.00')],
        [],
        WEEK.weekStart,
        WEEK.weekEnd,
        CDMX,
      ),
    ).toThrow()
  })
})

describe('getSettlementWeekByGroups', () => {
  const caps = { groups: 2000, timeoutMs: 3000 }
  const row = (i: number, configId = 'r1') => ({
    configId,
    gross: '100.00',
    commission: '3.00',
    count: 1,
    first: new Date(Date.parse('2026-11-17T16:00:00Z') + i * 60_000),
    last: new Date(Date.parse('2026-11-17T16:00:00Z') + i * 60_000),
  })

  it('2,001 groups → TOO_MANY_GROUPS, and no rule is loaded', async () => {
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue(Array.from({ length: 2001 }, (_, i) => row(i)))
    expect(await getSettlementWeekByGroups('v1', WEEK.weekStart, WEEK.weekEnd, CDMX, caps)).toEqual({
      ok: false,
      reason: 'TOO_MANY_GROUPS',
    })
    expect(prismaMock.settlementConfiguration.findMany).not.toHaveBeenCalled()
  })

  it('the query asks the database for at most groups + 1 rows, with the venue and the window of the panel (weekStart − 21 days to weekEnd)', async () => {
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([])
    await getSettlementWeekByGroups('v1', WEEK.weekStart, WEEK.weekEnd, CDMX, caps)
    const [sql] = (prismaMock.$queryRaw as jest.Mock).mock.calls[0] as [Prisma.Sql]
    expect(sql.values).toEqual(
      expect.arrayContaining(['v1', new Date(WEEK.weekStart.getTime() - 21 * 86_400_000), WEEK.weekEnd, CDMX, 2001]),
    )
    // La misma ventana dos veces: los cobros por su regla y las devoluciones por su día (D17).
    expect(sql.values.filter(v => v instanceof Date)).toHaveLength(4)
    expect(sql.sql).toContain(`p."type" IS NOT DISTINCT FROM 'REFUND'`)
  })

  it('the read sets SET LOCAL statement_timeout to depositTimeoutMs in its transaction, before its one query (case 39)', async () => {
    const order: string[] = []
    const tx = {
      $executeRawUnsafe: jest.fn(async (sql: string) => {
        order.push(sql)
        return 0
      }),
      $queryRaw: jest.fn(async () => {
        order.push('query')
        return [row(0)]
      }),
      settlementConfiguration: {
        findMany: jest.fn(async () => {
          order.push('rules')
          return [rule('r1')]
        }),
      },
    }
    ;(prismaMock.$transaction as jest.Mock).mockImplementationOnce((work: (t: typeof tx) => unknown) => work(tx))
    expect(await getSettlementWeekByGroups('v1', WEEK.weekStart, WEEK.weekEnd, CDMX, { groups: 2000, timeoutMs: 4321 })).toMatchObject({
      ok: true,
    })
    expect(order).toEqual(['SET LOCAL statement_timeout = 4321', 'query', 'rules'])
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled() // nada fuera de la transacción
    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled()
  })

  it('the rules are loaded by the ids of the groups, with a cap; payment.findMany is never called (case 39)', async () => {
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([row(0, 'r1'), row(1, 'r2'), row(2, 'r1')])
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValue([rule('r1'), rule('r2')])
    expect(await getSettlementWeekByGroups('v1', WEEK.weekStart, WEEK.weekEnd, CDMX, caps)).toEqual({
      ok: true,
      days: [{ date: '2026-11-18', net: 291 }],
      total: { gross: 300, commission: 9, net: 291, count: 3 },
    })
    const [args] = (prismaMock.settlementConfiguration.findMany as jest.Mock).mock.calls[0]
    expect(args).toMatchObject({ where: { id: { in: ['r1', 'r2'] } }, take: 2000 })
    expect(prismaMock.payment.findMany).not.toHaveBeenCalled()
  })

  it('no groups: no rule is read, and the week is empty', async () => {
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([])
    expect(await getSettlementWeekByGroups('v1', WEEK.weekStart, WEEK.weekEnd, CDMX, caps)).toEqual({
      ok: true,
      days: [],
      total: { gross: 0, commission: 0, net: 0, count: 0 },
    })
    expect(prismaMock.settlementConfiguration.findMany).not.toHaveBeenCalled()
  })

  it('a query cancelled by the database (57014) rejects: never a partial sum', async () => {
    const cancelled = new Prisma.PrismaClientKnownRequestError('canceling statement due to statement timeout', {
      code: 'P2010',
      clientVersion: 'test',
      meta: { code: '57014' },
    })
    ;(prismaMock.$queryRaw as jest.Mock).mockRejectedValue(cancelled)
    await expect(getSettlementWeekByGroups('v1', WEEK.weekStart, WEEK.weekEnd, CDMX, caps)).rejects.toBe(cancelled)
  })
})
