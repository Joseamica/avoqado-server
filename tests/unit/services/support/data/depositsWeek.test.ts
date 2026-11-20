/**
 * C6 · «Lo que cae en el banco esta semana»: el renglón del catálogo, los parámetros, la semana que pide la lectura y la plantilla,
 * sin base (el servicio del panel es de mentira). Lo que pasa con la base de verdad (la paridad con el panel, el aislamiento, los
 * candados, el tope y el corte por tiempo) está en `tests/integration/support/data/depositsWeek.integration.test.ts`.
 * La semana no puede depender de la zona del proceso: este archivo se corre con TZ=UTC, America/Havana, America/Mexico_City y
 * America/Tijuana delante de jest (un `process.env.TZ` dentro de la prueba no llega al proceso).
 */
jest.mock('@/services/dashboard/settlementWeekByGroups.service', () => ({ getSettlementWeekByGroups: jest.fn() }))

import { getSettlementWeekByGroups } from '@/services/dashboard/settlementWeekByGroups.service'
// La capacidad primero, a propósito: carga sola, sin pasar por el catálogo (C6 r1, el ciclo roto)
import { depositsWeek } from '@/services/support/data/capabilities/depositsWeek'
import { DataReadRefusal, type DataRequest, type DataScope } from '@/services/support/data/catalog'
import { checkRendered } from '@/services/support/data/check'
import { SUPPORT_DATA_OMITTED } from '@/services/support/data/texts'

const weekRead = getSettlementWeekByGroups as jest.Mock
const scope: DataScope = {
  venueId: 'ckq7z1x2y0000abcd1234efgh',
  organizationId: 'org',
  venueName: 'Flautas Coyoacán',
  timezone: 'America/Mexico_City',
  day: '2026-11-12',
  kycVerified: true,
  now: new Date('2026-11-12T20:32:00Z'), // jueves 12-nov, 14:32 en la CDMX
  rows: 5,
  openOrdersDays: 7,
  depositGroups: 2000,
  depositTimeoutMs: 3000,
}
const REQUEST: DataRequest = { capability: 'deposits_week', day: null, amount: null, time: null, otherVenue: false }
type Week = { days: { date: string; net: number }[]; total: { gross: number; commission: number; net: number; count: number } }
/** El texto, con el cotejo pasado: una plantilla que no lo pasa nunca sale. */
const say = (week: Week, s: DataScope = scope) => {
  const rendered = depositsWeek.render(s, {}, { ok: true, ...week })
  expect(checkRendered(rendered, s.timezone)).toBe(true)
  return rendered.text
}
const total = (net: number) => ({ gross: net, commission: 0, net, count: 1 })

afterEach(() => jest.useRealTimers())

it('the capability loads on its own, before the catalog, and refuses with the same class the orchestrator catches (C6 r1)', () => {
  jest.isolateModules(() => {
    const alone =
      require('@/services/support/data/capabilities/depositsWeek') as typeof import('@/services/support/data/capabilities/depositsWeek')
    const catalog = require('@/services/support/data/catalog') as typeof import('@/services/support/data/catalog')
    const readRefusal = require('@/services/support/data/readRefusal') as typeof import('@/services/support/data/readRefusal')
    expect(catalog.DATA_CAPABILITIES.deposits_week).toBe(alone.depositsWeek)
    expect(catalog.DataReadRefusal).toBe(readRefusal.DataReadRefusal)
  })
})

it('the row of the catalog: its texts, the permission and the gate of Saldo Disponible, no role', () => {
  expect(depositsWeek).toMatchObject({
    key: 'deposits_week',
    label: 'lo que cae en el banco esta semana',
    object: 'lo que cae en el banco esta semana',
    aiHint: 'Cuánto se estima que cae en el banco esta semana por los cobros con tarjeta, día por día. Sólo la semana en curso.',
    permissions: ['settlements:read'],
    gate: { featureCode: 'ADVANCED_REPORTS', gateKind: 'FEATURE', refusal: 'PLAN_DEPOSITS' },
  })
  expect(depositsWeek.roles).toBeUndefined()
})

it('not offered without the business verification (the KYCProtectedRoute of the panel)', () => {
  expect(depositsWeek.notOffered!({ ...scope, kycVerified: false })).toBe('DEPOSITS_NEEDS_KYC')
  expect(depositsWeek.notOffered!(scope)).toBeNull()
})

it.each<DataRequest['day']>([null, 'today', 'yesterday'])('day %p is the current week', day =>
  expect(depositsWeek.params({ ...REQUEST, day }, '¿Qué me cae esta semana?', scope)).toEqual({ ok: true, value: {} }),
)
it('«¿qué me cae la próxima semana?» (day other) → DEPOSITS_THIS_WEEK_ONLY', () =>
  expect(depositsWeek.params({ ...REQUEST, day: 'other' }, '¿Qué me cae la próxima semana?', scope)).toEqual({
    ok: false,
    refusal: 'DEPOSITS_THIS_WEEK_ONLY',
  }))

it("the week is the one of the question: with scope.day 2026-11-15 and now 2026-11-16T05:30Z (Sunday 23:30 in Mexico City, already Monday in UTC), read asks getSettlementWeekByGroups for Monday 9-nov 00:00 to Sunday 15-nov 23:59:59.999 of Mexico City, whatever the machine's clock says", async () => {
  jest.useFakeTimers({ now: new Date('2031-03-09T10:00:00Z') }) // otro año, otra semana: la lectura no mira este reloj
  weekRead.mockResolvedValue({ ok: true, days: [], total: { gross: 0, commission: 0, net: 0, count: 0 } })
  await depositsWeek.read(
    { ...scope, day: '2026-11-15', now: new Date('2026-11-16T05:30:00Z'), depositGroups: 7, depositTimeoutMs: 4321 },
    {},
  )
  expect(weekRead.mock.calls).toEqual([
    [
      scope.venueId,
      new Date('2026-11-09T06:00:00.000Z'),
      new Date('2026-11-16T05:59:59.999Z'),
      'America/Mexico_City',
      { groups: 7, timeoutMs: 4321 },
    ],
  ])
})

it('a week it cannot add up exactly (an uneven group or too many groups) → DataReadRefusal OVER_CAP with DEPOSITS_OVER_CAP', async () => {
  for (const reason of ['UNEVEN_GROUP', 'TOO_MANY_GROUPS']) {
    weekRead.mockResolvedValueOnce({ ok: false, reason })
    const thrown = await depositsWeek.read(scope, {}).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(DataReadRefusal)
    expect(thrown).toMatchObject({ result: 'OVER_CAP', refusal: 'DEPOSITS_OVER_CAP' })
  }
})

it('the example of the plan: every day on ONE line, the total, and the note', () =>
  expect(
    say({
      days: [
        { date: '2026-11-09', net: 5120 },
        { date: '2026-11-11', net: 8410.25 },
        { date: '2026-11-13', net: 2819.75 },
      ],
      total: { gross: 17000, commission: 650, net: 16350, count: 31 },
    }),
  ).toBe(
    [
      'Lo que se estima que cae esta semana en Flautas Coyoacán (corte 14:32):',
      'lun 9-nov $5,120.00 · mié 11-nov $8,410.25 · vie 13-nov $2,819.75',
      'Total de la semana: $16,350.00.',
      'Son fechas estimadas, no depósitos confirmados por el banco. Sólo cuenta cobros con tarjeta que procesó Avoqado; el efectivo ya está en tu caja.',
    ].join('\n'),
  ))

it('zero rows: a complete sentence (Review Focus 2)', () =>
  expect(say({ days: [], total: { gross: 0, commission: 0, net: 0, count: 0 } })).toBe(
    'No hay depósitos estimados para esta semana en Flautas Coyoacán (corte 14:32). Sólo cuenta cobros con tarjeta que procesó Avoqado.',
  ))

it('every day is on ONE line, there is no «y N más», and the total equals the sum of the listed days; with 7 days it is still 4 lines', () => {
  const nets = [1000.01, 2000.02, 3000.03, 4000.04, 5000.05, 6000.06, 7000.07]
  const text = say({
    days: nets.map((net, i) => ({ date: `2026-11-${String(9 + i).padStart(2, '0')}`, net })),
    total: { gross: 28000.28, commission: 0, net: 28000.28, count: 7 },
  })
  const lines = text.split('\n')
  expect(lines).toHaveLength(4)
  expect(lines[1]).toBe(
    'lun 9-nov $1,000.01 · mar 10-nov $2,000.02 · mié 11-nov $3,000.03 · jue 12-nov $4,000.04 · vie 13-nov $5,000.05 · sáb 14-nov $6,000.06 · dom 15-nov $7,000.07',
  )
  expect(text).not.toMatch(/ más/)
  expect(lines[2]).toBe('Total de la semana: $28,000.28.')
})

it('a week of refunds only says the negative amount, in the day and in the total', () =>
  expect(
    say({ days: [{ date: '2026-11-10', net: -110.02 }], total: total(-110.02) })
      .split('\n')
      .slice(1, 3),
  ).toEqual(['mar 10-nov −$110.02', 'Total de la semana: −$110.02.']))

it('each day is the noon of its date in the venue: in Cancún and in Tijuana the weekday is the one of that date', () => {
  for (const timezone of ['America/Cancun', 'America/Tijuana']) {
    const text = say({ days: [{ date: '2026-11-15', net: 1 }], total: total(1) }, { ...scope, timezone })
    expect(text.split('\n')[1]).toBe('dom 15-nov $1.00')
  }
})

it('a venue named like a card number is omitted, and no account, CLABE nor card appears', () => {
  const text = say({ days: [{ date: '2026-11-10', net: 50 }], total: total(50) }, { ...scope, venueName: 'Caja 4111111111111111' })
  expect(text.split('\n')[0]).toBe(`Lo que se estima que cae esta semana en ${SUPPORT_DATA_OMITTED} (corte 14:32):`)
  expect(text).not.toMatch(/4111|CLABE|terminaci[oó]n|\*{2}/i)
})
