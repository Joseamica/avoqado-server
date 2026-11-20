/**
 * C4 · «Reservaciones de hoy»: la plantilla del plan, los nombres acortados y lo que `read` le pide al panel, sin base. Lo que pasa con
 * la base de verdad (el día entero de la sucursal, la paridad con la lista del panel, el candado de plan, los nombres guardados, el
 * plan de ejecución) está en `tests/integration/support/data/reservationsToday.integration.test.ts`.
 */
jest.mock('@/services/dashboard/shared-query.service', () => ({ SharedQueryService: { getReservations: jest.fn() } }))

import { SharedQueryService, type ReservationListSummary } from '@/services/dashboard/shared-query.service'
import { reservationsToday } from '@/services/support/data/capabilities/reservationsToday'
import type { DataRequest, DataScope } from '@/services/support/data/catalog'
import { checkRendered } from '@/services/support/data/check'

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
type Row = ReservationListSummary['reservations'][number]
const at = (hhmm: string) => new Date(`2026-11-12T${hhmm}:00-06:00`)
const row = (hhmm: string, over: Partial<Row> = {}): Row => ({
  confirmationCode: 'RES-A3X7K2',
  status: 'CONFIRMED',
  channel: 'DASHBOARD',
  startsAt: at(hhmm),
  endsAt: at(hhmm),
  partySize: 2,
  guestName: null,
  customerName: null,
  tableNumber: null,
  productName: null,
  assignedStaffName: null,
  ...over,
})
const render = (reservations: Row[], total = reservations.length) => {
  const rendered = reservationsToday.render(
    scope,
    {},
    { total, page: 1, pageSize: 5, totalPages: 1, period: 'custom', dateRange: { from: scope.now, to: scope.now }, reservations },
  )
  expect(checkRendered(rendered, scope.timezone)).toBe(true)
  return rendered.text
}
const request = (day: DataRequest['day']): DataRequest => ({
  capability: 'reservations_today',
  day,
  amount: null,
  time: null,
  otherVenue: false,
})

it('a restaurant row and a salon row print as the examples of the plan, and they pass the check', () =>
  expect(
    render([
      row('11:00', { productName: 'Corte', customerName: 'Ana Ramírez', assignedStaffName: 'Paola Gómez' }),
      row('14:00', { partySize: 4, guestName: 'Ana Ramírez', tableNumber: '5' }),
      row('19:30', { status: 'PENDING', guestName: 'Luis Martínez' }),
    ]),
  ).toBe(
    [
      'Reservaciones de hoy en Flautas Coyoacán (corte 14:32): 3',
      '11:00 · Corte · Ana R. · con Paola · Confirmada',
      '14:00 · 4 personas · Ana R. · Confirmada · mesa 5',
      '19:30 · 2 personas · Luis M. · Pendiente',
    ].join('\n'),
  ))

it('«1 persona» in singular; each status by its name; no client, no staff and no table leave no piece', () =>
  expect(
    render([
      row('09:00', { partySize: 1, status: 'PENDING' }),
      row('10:00', { status: 'CHECKED_IN', guestName: 'Ana' }),
      row('11:00', { status: 'COMPLETED' }),
      row('12:00', { status: 'CANCELLED' }),
      row('13:00', { status: 'NO_SHOW' }),
    ]),
  ).toBe(
    [
      'Reservaciones de hoy en Flautas Coyoacán (corte 14:32): 5',
      '09:00 · 1 persona · Pendiente',
      '10:00 · 2 personas · Ana · Llegó',
      '11:00 · 2 personas · Completada',
      '12:00 · 2 personas · Cancelada',
      '13:00 · 2 personas · No llegó',
    ].join('\n'),
  ))

it('a table of only spaces leaves no dangling «· mesa » (decided on the sanitized value)', () =>
  expect(render([row('12:00', { tableNumber: '   ', guestName: 'Ana Ramírez' })]).split('\n')[1]).toBe(
    '12:00 · 2 personas · Ana R. · Confirmada',
  ))

it('a service of only spaces still prints the party size (decided on the sanitized value)', () =>
  expect(render([row('13:00', { productName: ' \t ', partySize: 3 })]).split('\n')[1]).toBe('13:00 · 3 personas · Confirmada'))

it('the linked customer goes before the name typed at booking, as the panel list shows it', () =>
  expect(render([row('12:00', { guestName: 'Mesa de Ana', customerName: 'Ana Ramírez' })]).split('\n')[1]).toBe(
    '12:00 · 2 personas · Ana R. · Confirmada',
  ))

it('with 7 today and 5 rows: 7 lines, the last «y 2 más; el resto está en el panel.»', () => {
  const lines = render(
    ['09:00', '10:00', '11:00', '12:00', '13:00'].map(h => row(h)),
    7,
  ).split('\n')
  expect(lines).toHaveLength(7)
  expect([lines[0], lines[6]]).toEqual(['Reservaciones de hoy en Flautas Coyoacán (corte 14:32): 7', 'y 2 más; el resto está en el panel.'])
})

it('the count and the list read apart: 3 rows with a total of 2 say «: 3», never fewer than listed, and no «y N más»', () =>
  expect(render([row('09:00'), row('10:00'), row('11:00')], 2)).toBe(
    [
      'Reservaciones de hoy en Flautas Coyoacán (corte 14:32): 3',
      '09:00 · 2 personas · Confirmada',
      '10:00 · 2 personas · Confirmada',
      '11:00 · 2 personas · Confirmada',
    ].join('\n'),
  ))

it('zero rows: a complete sentence (Review Focus 2)', () =>
  expect(render([])).toBe('No hay reservaciones hoy en Flautas Coyoacán (corte 14:32).'))

it.each([
  ['a client with an email', { customerName: 'Ana ana@correo.com' }, '12:00 · 2 personas · [dato omitido] · Confirmada'],
  [
    'a staff name with a phone',
    { productName: 'Corte', assignedStaffName: 'Luis +525512345678' },
    '12:00 · Corte · con [dato omitido] · Confirmada',
  ],
  [
    'a staff name with an RFC',
    { productName: 'Corte', assignedStaffName: 'Paola GODE561231GR8' },
    '12:00 · Corte · con [dato omitido] · Confirmada',
  ],
  ['a one-word client', { guestName: 'Ana' }, '12:00 · 2 personas · Ana · Confirmada'],
  ['a client whose surname was a link', { guestName: 'Ana https://bit.ly/x' }, '12:00 · 2 personas · Ana · Confirmada'],
  ['a long staff name', { productName: 'Corte', assignedStaffName: 'María José Pérez' }, '12:00 · Corte · con María · Confirmada'],
])('the WHOLE name goes through the output rule before it is shortened: %s', (_name, over, line) =>
  expect(render([row('12:00', over)]).split('\n')[1]).toBe(line),
)

it('the confirmation code is never in the text', () =>
  expect(render([row('12:00', { confirmationCode: 'RES-A3X7K2', guestName: 'Ana Ramírez' })])).not.toMatch(/RES|A3X7K2/))

it('read asks the panel list for the whole calendar day of the venue (00:00 to 23:59:59.999), scope.rows and its zone', async () => {
  const list = { total: 0, reservations: [] }
  jest.mocked(SharedQueryService.getReservations).mockResolvedValue(list as never)
  await expect(reservationsToday.read(scope, {})).resolves.toBe(list)
  expect(SharedQueryService.getReservations).toHaveBeenCalledWith(
    scope.venueId,
    { from: new Date('2026-11-12T06:00:00.000Z'), to: new Date('2026-11-13T05:59:59.999Z') },
    { limit: 5 },
    'America/Mexico_City',
  )
})

it('params: today or no day answer; yesterday and another day are RESERVATIONS_TODAY_ONLY', () => {
  expect(reservationsToday.params(request(null), '¿Qué reservaciones tengo?', scope)).toEqual({ ok: true, value: {} })
  expect(reservationsToday.params(request('today'), '¿Qué reservaciones tengo hoy?', scope)).toEqual({ ok: true, value: {} })
  for (const day of ['yesterday', 'other'] as const)
    expect(reservationsToday.params(request(day), '¿Qué reservaciones tengo mañana?', scope)).toEqual({
      ok: false,
      refusal: 'RESERVATIONS_TODAY_ONLY',
    })
})
