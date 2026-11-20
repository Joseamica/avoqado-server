import {
  encontrarReglaActiva,
  getSettlementsLandingInWeek,
  projectPaymentSettlement,
  venueWeekBounds,
} from '@/services/dashboard/settlementCalendar.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'
import { formatInTimeZone } from 'date-fns-tz'

const TZ = 'America/Mexico_City'

const cfg = {
  merchantAccountId: 'm1',
  cardType: 'CREDIT' as const,
  settlementDays: 1,
  settlementDayType: 'BUSINESS_DAYS' as const,
  cutoffTime: '23:00',
  cutoffTimezone: TZ,
  effectiveFrom: new Date('2026-01-01'),
  effectiveTo: null,
}

describe('projectPaymentSettlement', () => {
  it('projects net = gross − (charge+fixed) onto the venue-tz settlement day', () => {
    const p = {
      amount: 1000,
      tipAmount: 50,
      createdAt: new Date('2026-07-04T02:00:00Z'),
      merchantAccountId: 'm1',
      transactionCost: { transactionType: 'CREDIT' as const, venueChargeAmount: 30, venueFixedFee: 5 },
    }
    expect(projectPaymentSettlement(p, [cfg], TZ)).toEqual({
      settlementDateKey: '2026-07-06',
      gross: 1050,
      commission: 35,
      net: 1015,
      settlementDays: 1,
    })
  })

  it('Codex R4 (P2): usa la MISMA proyección monetaria que el costo — comisión a 2 decimales, neto = bruto − comisión', () => {
    const p = {
      amount: 1.11,
      tipAmount: 0,
      createdAt: new Date('2026-07-04T02:00:00Z'),
      merchantAccountId: 'm1',
      // 2.25 % de $1.11 se persiste como 0.0250 (escala 4) más $0.50 fijo: la comisión proyectada es $0.53, no 0.525.
      transactionCost: { transactionType: 'CREDIT' as const, venueChargeAmount: 0.025, venueFixedFee: 0.5 },
    }
    expect(projectPaymentSettlement(p, [cfg], TZ)).toMatchObject({ gross: 1.11, commission: 0.53, net: 0.58 })
  })

  it('returns null with no cost', () => {
    const p = {
      amount: 100,
      tipAmount: 0,
      createdAt: new Date('2026-07-01T18:00:00Z'),
      merchantAccountId: 'm1',
      transactionCost: null,
    }
    expect(projectPaymentSettlement(p, [cfg], TZ)).toBeNull()
  })

  it('returns null when no active config matches the merchant×cardType', () => {
    const p = {
      amount: 100,
      tipAmount: 0,
      createdAt: new Date('2026-07-01T18:00:00Z'),
      merchantAccountId: 'zzz',
      transactionCost: { transactionType: 'CREDIT' as const, venueChargeAmount: 4, venueFixedFee: 0 },
    }
    expect(projectPaymentSettlement(p, [cfg], TZ)).toBeNull()
  })
})

describe('getSettlementsLandingInWeek', () => {
  const merchant = { displayName: 'Amaena - B', alias: null, provider: { name: 'AngelPay (Nexgo)' } }
  // Week Mon 2026-07-06 → Sun 2026-07-12, in venue tz (MX = UTC−6).
  const weekStart = new Date('2026-07-06T06:00:00Z') // Mon 00:00 MX
  const weekEnd = new Date('2026-07-13T05:59:59Z') // Sun 23:59 MX

  it('buckets net by SETTLEMENT day: cross-week sales land in-week; no-rule & out-of-week excluded', async () => {
    ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValue([
      // Sold Fri 2026-07-03 20:00 MX → 1 biz day → lands Mon 07-06 (in week)
      {
        amount: 1000,
        tipAmount: 0,
        createdAt: new Date('2026-07-04T02:00:00Z'),
        merchantAccountId: 'm1',
        transactionCost: { transactionType: 'CREDIT', venueChargeAmount: 30, venueFixedFee: 5 },
        merchantAccount: merchant,
      },
      // Sold Mon 2026-07-06 12:00 MX → 1 biz day → lands Tue 07-07 (in week)
      {
        amount: 500,
        tipAmount: 50,
        createdAt: new Date('2026-07-06T18:00:00Z'),
        merchantAccountId: 'm1',
        transactionCost: { transactionType: 'CREDIT', venueChargeAmount: 16.5, venueFixedFee: 5 },
        merchantAccount: merchant,
      },
      // No active config (merchant m2) → cannot be placed on any landing day → excluded
      {
        amount: 700,
        tipAmount: 0,
        createdAt: new Date('2026-07-05T18:00:00Z'),
        merchantAccountId: 'm2',
        transactionCost: { transactionType: 'CREDIT', venueChargeAmount: 25, venueFixedFee: 0 },
        merchantAccount: { displayName: 'Sin regla', alias: null, provider: { name: 'Blumon' } },
      },
      // Sold Sat 2026-07-11 20:00 MX → 1 biz day → lands Mon 07-13 (NEXT week) → excluded
      {
        amount: 200,
        tipAmount: 0,
        createdAt: new Date('2026-07-12T02:00:00Z'),
        merchantAccountId: 'm1',
        transactionCost: { transactionType: 'CREDIT', venueChargeAmount: 6, venueFixedFee: 0 },
        merchantAccount: merchant,
      },
    ])
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValue([
      {
        merchantAccountId: 'm1',
        cardType: 'CREDIT',
        settlementDays: 1,
        settlementDayType: 'BUSINESS_DAYS',
        cutoffTime: '23:00',
        cutoffTimezone: TZ,
        effectiveFrom: new Date('2026-01-01'),
        effectiveTo: null,
      },
    ])

    const r = await getSettlementsLandingInWeek('v1', weekStart, weekEnd, TZ)

    expect(r.weekStart).toBe('2026-07-06')
    expect(r.weekEnd).toBe('2026-07-12')
    expect(r.days.map(d => d.date)).toEqual(['2026-07-06', '2026-07-07']) // sorted; P3 no-rule + P4 next-week gone
    const [mon, tue] = r.days
    expect(mon).toMatchObject({ date: '2026-07-06', gross: 1000, commission: 35, net: 965, count: 1 })
    expect(mon.byMerchant).toEqual([
      { merchantAccountId: 'm1', displayName: 'Amaena - B', provider: 'AngelPay (Nexgo)', gross: 1000, commission: 35, net: 965, count: 1 },
    ])
    expect(mon.byCardType).toEqual([{ cardType: 'CREDIT', gross: 1000, commission: 35, net: 965, count: 1 }])
    expect(tue).toMatchObject({ date: '2026-07-07', gross: 550, commission: 21.5, net: 528.5, count: 1 })
    expect(r.weekTotal).toEqual({ gross: 1550, commission: 56.5, net: 1493.5, count: 2 })
    expect(['settled', 'today', 'projected']).toContain(mon.status)
  })

  it('returns an empty week (no days, zero totals) when nothing lands', async () => {
    ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValue([])
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValue([])
    const r = await getSettlementsLandingInWeek('v1', weekStart, weekEnd, TZ)
    expect(r.days).toEqual([])
    expect(r.weekTotal).toEqual({ gross: 0, commission: 0, net: 0, count: 0 })
  })
})

describe('venueWeekBounds', () => {
  const dateKey = (d: Date) => formatInTimeZone(d, TZ, 'yyyy-MM-dd')

  it('returns the Monday–Sunday venue-local week containing a mid-week date', () => {
    const { weekStart, weekEnd } = venueWeekBounds('2026-07-08', TZ) // Wed
    expect(dateKey(weekStart)).toBe('2026-07-06') // Mon
    expect(dateKey(weekEnd)).toBe('2026-07-12') // Sun
  })

  it('anchors correctly at the week edges (Monday and Sunday map to the same week)', () => {
    expect(dateKey(venueWeekBounds('2026-07-06', TZ).weekStart)).toBe('2026-07-06') // Monday itself
    expect(dateKey(venueWeekBounds('2026-07-12', TZ).weekStart)).toBe('2026-07-06') // Sunday → same Monday
    expect(dateKey(venueWeekBounds('2026-07-13', TZ).weekStart)).toBe('2026-07-13') // next Monday
  })

  it('week spans exactly 7 venue-local days', () => {
    const { weekStart, weekEnd } = venueWeekBounds('2026-07-08', TZ)
    // Sunday 23:59:59.999 minus Monday 00:00 ≈ 7 days
    expect(weekEnd.getTime() - weekStart.getTime()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000)
    expect(weekEnd.getTime() - weekStart.getTime()).toBeLessThan(7 * 24 * 60 * 60 * 1000)
  })

  const isMonday = (d: Date) => new Date(dateKey(d) + 'T12:00:00Z').getUTCDay() === 1

  // Regression (from /full-testing): `weekStart` is a user-controlled query param.
  // These parse to NaN → pre-fix they produced an Invalid Date that crashed the
  // downstream Prisma query (500). Must fall back to a valid Monday-anchored week.
  // (Each case here genuinely FAILS without the fix — Invalid Date → getTime() NaN.)
  it.each(['garbage', '', 'DROP TABLE', '2026/07/08'])(
    'never yields an Invalid Date for unparseable weekStart=%p (would 500 pre-fix)',
    bad => {
      const { weekStart, weekEnd } = venueWeekBounds(bad, TZ)
      expect(Number.isNaN(weekStart.getTime())).toBe(false)
      expect(Number.isNaN(weekEnd.getTime())).toBe(false)
      expect(weekEnd.getTime() - weekStart.getTime()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000)
      expect(weekEnd.getTime() - weekStart.getTime()).toBeLessThan(7 * 24 * 60 * 60 * 1000)
      expect(isMonday(weekStart)).toBe(true)
    },
  )

  // Out-of-range-but-finite values: pre-fix `Date.UTC` normalizes them and the week
  // silently DRIFTS (e.g. month 13 → next Jan; year 99999 → Invalid via fromZonedTime).
  // The range guard makes them fall back to the CURRENT week — asserting equality with
  // the no-arg (current-week) result discriminates the fix (drifted week ≠ current).
  it.each(['2026-13-08', '1999-07-08', '2026-07-40', '99999-01-01'])(
    'out-of-range weekStart=%p falls back to the current venue week (no silent drift)',
    bad => {
      expect(dateKey(venueWeekBounds(bad, TZ).weekStart)).toBe(dateKey(venueWeekBounds(undefined, TZ).weekStart))
    },
  )

  // The default (no arg) is the most common path (current week) — cover it explicitly.
  it('with no weekStart returns the current venue week, Monday-anchored, containing today', () => {
    const { weekStart, weekEnd } = venueWeekBounds(undefined, TZ)
    expect(Number.isNaN(weekStart.getTime())).toBe(false)
    expect(isMonday(weekStart)).toBe(true)
    const now = Date.now()
    expect(now).toBeGreaterThanOrEqual(weekStart.getTime())
    expect(now).toBeLessThanOrEqual(weekEnd.getTime())
  })
})

describe('getSettlementsLandingInWeek — recorre los pagos por páginas de 500 con cursor (query-guard 2026-09-07)', () => {
  const merchant = { displayName: 'Amaena - B', alias: null, provider: { name: 'AngelPay (Nexgo)' } }
  const weekStart = new Date('2026-07-06T06:00:00Z') // Mon 00:00 MX
  const weekEnd = new Date('2026-07-13T05:59:59Z') // Sun 23:59 MX
  const regla = (merchantAccountId: string) => ({
    merchantAccountId,
    cardType: 'CREDIT',
    settlementDays: 1,
    settlementDayType: 'BUSINESS_DAYS',
    cutoffTime: '23:00',
    cutoffTimezone: TZ,
    effectiveFrom: new Date('2026-01-01'),
    effectiveTo: null,
  })
  // Vendido lunes 06-jul 12:00 MX → 1 día hábil → cae martes 07-jul, dentro de la semana.
  const fila = (i: number, merchantAccountId = 'm1') => ({
    id: `p${String(i).padStart(4, '0')}`,
    amount: 100,
    tipAmount: 0,
    createdAt: new Date('2026-07-06T18:00:00Z'),
    merchantAccountId,
    transactionCost: { transactionType: 'CREDIT', venueChargeAmount: 3, venueFixedFee: 0 },
    merchantAccount: merchant,
  })

  it('una página llena pide la siguiente con cursor en el último id; una corta termina — y el total es el de las 503 filas', async () => {
    const pagina1 = Array.from({ length: 500 }, (_, i) => fila(i))
    const pagina2 = [fila(500), fila(501), fila(502)]
    ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValueOnce(pagina1).mockResolvedValueOnce(pagina2)
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValue([regla('m1')])

    const r = await getSettlementsLandingInWeek('v1', weekStart, weekEnd, TZ)

    expect(prismaMock.payment.findMany).toHaveBeenCalledTimes(2)
    const [primera, segunda] = (prismaMock.payment.findMany as jest.Mock).mock.calls.map(c => c[0])
    expect(primera).toMatchObject({ take: 500, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    expect(primera.cursor).toBeUndefined()
    expect(segunda).toMatchObject({ take: 500, cursor: { id: 'p0499' }, skip: 1 })
    expect(segunda.select.id).toBe(true)
    // El where no cambió: mismo venue, COMPLETED, con comercio, sin efectivo, misma ventana.
    expect(primera.where).toEqual(segunda.where)
    expect(primera.where).toMatchObject({ venueId: 'v1', status: 'COMPLETED', merchantAccountId: { not: null }, method: { not: 'CASH' } })

    expect(r.days).toHaveLength(1)
    expect(r.days[0]).toMatchObject({ date: '2026-07-07', gross: 50300, commission: 1509, net: 48791, count: 503 })
    expect(r.weekTotal).toEqual({ gross: 50300, commission: 1509, net: 48791, count: 503 })
  })

  it('las reglas de un comercio se cargan UNA vez aunque aparezca en varias páginas; un comercio nuevo en la 2ª página carga las suyas ahí', async () => {
    const pagina1 = Array.from({ length: 500 }, (_, i) => fila(i, 'm1'))
    const pagina2 = [fila(500, 'm1'), fila(501, 'm2')]
    ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValueOnce(pagina1).mockResolvedValueOnce(pagina2)
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValueOnce([regla('m1')]).mockResolvedValueOnce([regla('m2')])

    const r = await getSettlementsLandingInWeek('v1', weekStart, weekEnd, TZ)

    const llamadas = (prismaMock.settlementConfiguration.findMany as jest.Mock).mock.calls.map(c => c[0].where.merchantAccountId.in)
    expect(llamadas).toEqual([['m1'], ['m2']])
    expect(r.days[0].count).toBe(502)
    expect(r.days[0].byMerchant.map(m => m.merchantAccountId).sort()).toEqual(['m1', 'm2'])
  })

  it('regresión: menos de 500 filas es una sola consulta (los mocks con mockResolvedValue no ciclan)', async () => {
    ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValue([fila(0), fila(1)])
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValue([regla('m1')])
    const r = await getSettlementsLandingInWeek('v1', weekStart, weekEnd, TZ)
    expect(prismaMock.payment.findMany).toHaveBeenCalledTimes(1)
    expect(r.weekTotal.count).toBe(2)
  })
})

describe('encontrarReglaActiva (R2 del reporte de liquidación)', () => {
  it('elige por comercio × tipo × vigencia a la fecha del COBRO, igual que projectPaymentSettlement', () => {
    const vieja = { ...cfg, settlementDays: 3, effectiveFrom: new Date('2025-01-01'), effectiveTo: new Date('2025-12-31T23:59:59Z') }
    const configs = [cfg, vieja]
    expect(encontrarReglaActiva('m1', 'CREDIT', new Date('2026-07-01T18:00:00Z'), configs)).toBe(cfg)
    expect(encontrarReglaActiva('m1', 'CREDIT', new Date('2025-06-01T18:00:00Z'), configs)).toBe(vieja)
    expect(encontrarReglaActiva('m1', 'DEBIT', new Date('2026-07-01T18:00:00Z'), configs)).toBeNull()
    expect(encontrarReglaActiva('otro', 'CREDIT', new Date('2026-07-01T18:00:00Z'), configs)).toBeNull()
  })
})

// ── P1 (la B, «lo que cae en el banco esta semana»): la semana del panel, en centavos exactos ─────────────────────────────

/**
 * Los 6 cobros de la caracterización (Task P1, Paso 1): dos comercios, crédito y débito, propinas, comisiones con 4 decimales y
 * uno que cae la semana siguiente. Los mismos, como texto, en `tests/unit/services/payments/sumaExactaDeDinero.test.ts`.
 */
const SEMANA_P1 = {
  weekStart: new Date('2026-07-06T06:00:00Z'), // lun 00:00 CDMX
  weekEnd: new Date('2026-07-13T05:59:59.999Z'), // dom 23:59:59.999 CDMX
  comercios: {
    m1: { displayName: 'Comercio Uno', alias: null, provider: { name: 'Blumon' } },
    m2: { displayName: null, alias: 'Alias Dos', provider: { name: 'AngelPay (Nexgo)' } },
  },
  reglas: (['m1', 'm2'] as const).flatMap(merchantAccountId =>
    (['CREDIT', 'DEBIT'] as const).map(cardType => ({ ...cfg, merchantAccountId, cardType })),
  ),
}
const cobroP1 = (
  id: string,
  merchant: 'm1' | 'm2',
  transactionType: 'CREDIT' | 'DEBIT',
  createdAt: string,
  amount: number,
  tipAmount: number,
  venueChargeAmount: number,
  venueFixedFee: number,
) => ({
  id,
  amount,
  tipAmount,
  createdAt: new Date(createdAt),
  merchantAccountId: merchant,
  transactionCost: { transactionType, venueChargeAmount, venueFixedFee },
  merchantAccount: SEMANA_P1.comercios[merchant],
})

describe('getSettlementsLandingInWeek — P1: la caracterización y la suma exacta', () => {
  it('the week keeps its fields and its figures', async () => {
    ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValue([
      cobroP1('p4', 'm1', 'CREDIT', '2026-07-04T02:00:00Z', 1000, 0, 25.005, 0), // vie 20:00 → lun 06; comisión 25.005 → 25.01
      cobroP1('p1', 'm1', 'CREDIT', '2026-07-06T18:00:00Z', 100.01, 10.01, 3.3003, 0.5), // lun 12:00 → mar 07
      cobroP1('p2', 'm1', 'DEBIT', '2026-07-06T19:00:00Z', 19.99, 0.02, 0.4498, 0), // lun 13:00 → mar 07
      cobroP1('p3', 'm2', 'DEBIT', '2026-07-07T16:00:00Z', 250.5, 25.25, 6.2501, 0.25), // mar 10:00 → mié 08
      cobroP1('p5', 'm2', 'DEBIT', '2026-07-09T05:30:00Z', 80, 8.88, 1.7776, 0), // mié 23:30, después del corte → vie 10
      cobroP1('p6', 'm1', 'CREDIT', '2026-07-12T02:00:00Z', 500, 50, 15, 0), // sáb 20:00 → lun 13, la semana siguiente
    ])
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValue(SEMANA_P1.reglas)

    const uno = { merchantAccountId: 'm1', displayName: 'Comercio Uno', provider: 'Blumon' }
    const dos = { merchantAccountId: 'm2', displayName: 'Alias Dos', provider: 'AngelPay (Nexgo)' }
    expect(await getSettlementsLandingInWeek('v1', SEMANA_P1.weekStart, SEMANA_P1.weekEnd, TZ)).toEqual({
      weekStart: '2026-07-06',
      weekEnd: '2026-07-12',
      days: [
        {
          date: '2026-07-06',
          status: 'settled',
          gross: 1000,
          commission: 25.01,
          net: 974.99,
          count: 1,
          byMerchant: [{ ...uno, gross: 1000, commission: 25.01, net: 974.99, count: 1 }],
          byCardType: [{ cardType: 'CREDIT', gross: 1000, commission: 25.01, net: 974.99, count: 1 }],
        },
        {
          date: '2026-07-07',
          status: 'settled',
          gross: 130.03,
          commission: 4.25,
          net: 125.78,
          count: 2,
          byMerchant: [{ ...uno, gross: 130.03, commission: 4.25, net: 125.78, count: 2 }],
          byCardType: [
            { cardType: 'CREDIT', gross: 110.02, commission: 3.8, net: 106.22, count: 1 },
            { cardType: 'DEBIT', gross: 20.01, commission: 0.45, net: 19.56, count: 1 },
          ],
        },
        {
          date: '2026-07-08',
          status: 'settled',
          gross: 275.75,
          commission: 6.5,
          net: 269.25,
          count: 1,
          byMerchant: [{ ...dos, gross: 275.75, commission: 6.5, net: 269.25, count: 1 }],
          byCardType: [{ cardType: 'DEBIT', gross: 275.75, commission: 6.5, net: 269.25, count: 1 }],
        },
        {
          date: '2026-07-10',
          status: 'settled',
          gross: 88.88,
          commission: 1.78,
          net: 87.1,
          count: 1,
          byMerchant: [{ ...dos, gross: 88.88, commission: 1.78, net: 87.1, count: 1 }],
          byCardType: [{ cardType: 'DEBIT', gross: 88.88, commission: 1.78, net: 87.1, count: 1 }],
        },
      ],
      weekTotal: { gross: 1494.66, commission: 37.54, net: 1457.12, count: 5 },
    })
  })
})

describe('getSettlementsLandingInWeek — P1: exacta a volumen', () => {
  const regla = { ...cfg, merchantAccountId: 'm1', cardType: 'CREDIT' as const }
  const pagina = (precio: number) =>
    Array.from({ length: 500 }, (_, i) => ({
      ...cobroP1(`v${String(i).padStart(4, '0')}`, 'm1', 'CREDIT', '2026-07-06T18:00:00Z', precio, 0, 0, 0), // lun → mar 07
    }))

  it('the panel week is exact at volume: 1,000 pages of 500 payments of $10,000.01', async () => {
    const mock = prismaMock.payment.findMany as jest.Mock
    const llena = pagina(10000.01)
    for (let i = 0; i < 1000; i++) mock.mockResolvedValueOnce(llena)
    mock.mockResolvedValue([])
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValue([regla])
    expect((await getSettlementsLandingInWeek('v1', SEMANA_P1.weekStart, SEMANA_P1.weekEnd, TZ)).weekTotal).toEqual({
      gross: 5_000_005_000,
      commission: 0,
      net: 5_000_005_000,
      count: 500_000,
    }) // antes: net 5,000,005,000.06
  }, 180_000)

  it('Codex r9 through the panel: $100.01 + $10.01, $19.99 + $0.02 and −$100.01 with −$10.01 give $110.02, $20.01 and −$110.02, and none throws', async () => {
    ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValue([
      cobroP1('a', 'm1', 'CREDIT', '2026-07-06T18:00:00Z', 100.01, 10.01, 0, 0), // → mar 07
      cobroP1('b', 'm1', 'CREDIT', '2026-07-07T18:00:00Z', 19.99, 0.02, 0, 0), // → mié 08
      cobroP1('c', 'm1', 'CREDIT', '2026-07-08T18:00:00Z', -100.01, -10.01, 0, 0), // → jue 09
    ])
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValue([regla])
    const week = await getSettlementsLandingInWeek('v1', SEMANA_P1.weekStart, SEMANA_P1.weekEnd, TZ)
    expect(week.days.map(d => [d.date, d.gross, d.net])).toEqual([
      ['2026-07-07', 110.02, 110.02],
      ['2026-07-08', 20.01, 20.01],
      ['2026-07-09', -110.02, -110.02],
    ])
    expect(week.weekTotal).toEqual({ gross: 20.01, commission: 0, net: 20.01, count: 3 })
  })
})

describe('getSettlementsLandingInWeek — P1 r1: la semana suma centavos exactos, no los días ya en pesos', () => {
  /**
   * Siete días de casi 1,000 cobros de ~2 mil millones cada uno (dentro de Decimal(12,2)): sumar los días ya redondeados da un
   * centavo de más (15,339,827,484,726.76); los centavos exactos de los días, 15,339,827,484,726.75. Los mismos días que
   * `settlementWeekByGroups.test.ts`.
   */
  const DIAS: [number, number][] = [
    [1638651948.3, 999],
    [2106592392.71, 997],
    [2738006453.35, 999],
    [2585314484.82, 997],
    [1911393096.94, 998],
    [1780153684.79, 999],
    [2608988720.17, 998],
  ]
  const TOTAL = 15_339_827_484_726.75

  it('several days whose rounded sum differs from the exact one: the week is the exact sum of their cents', async () => {
    const mismoDia = {
      ...cfg,
      merchantAccountId: 'm1',
      cardType: 'CREDIT' as const,
      settlementDays: 0,
      settlementDayType: 'CALENDAR_DAYS' as const,
      cutoffTime: '23:59',
    }
    const cobros = DIAS.flatMap(([precio, n], d) =>
      Array.from({ length: n }, (_, i) =>
        cobroP1(`d${d}-${i}`, 'm1', 'CREDIT', `2026-07-${String(6 + d).padStart(2, '0')}T18:00:00Z`, precio, 0, 0, 0),
      ),
    )
    const mock = prismaMock.payment.findMany as jest.Mock
    for (let i = 0; i < cobros.length; i += 500) mock.mockResolvedValueOnce(cobros.slice(i, i + 500))
    mock.mockResolvedValue([])
    ;(prismaMock.settlementConfiguration.findMany as jest.Mock).mockResolvedValue([mismoDia])
    const week = await getSettlementsLandingInWeek('v1', SEMANA_P1.weekStart, SEMANA_P1.weekEnd, TZ)
    expect(week.days).toHaveLength(7)
    const diasRedondeados = Math.round(week.days.reduce((suma, d) => suma + d.net, 0) * 100) / 100
    expect(diasRedondeados).not.toBe(TOTAL) // la condición de la prueba: aquí las dos sumas sí difieren
    expect(week.weekTotal).toEqual({ gross: TOTAL, commission: 0, net: TOTAL, count: 6987 })
  })
})
