/**
 * C3 · «Cuentas abiertas de los últimos 7 días»: la plantilla del plan y lo que `read` le pide al panel, sin base. Lo que pasa con la
 * base de verdad (qué cuenta es abierta, el aislamiento, la ventana, el plan de ejecución, los candados) está en
 * `tests/integration/support/data/openOrders.integration.test.ts`.
 */
jest.mock('@/services/dashboard/openOrders.service', () => ({ listOpenOrdersBrief: jest.fn() }))

import type { OrderType } from '@prisma/client'
import { listOpenOrdersBrief } from '@/services/dashboard/openOrders.service'
import { openOrders } from '@/services/support/data/capabilities/openOrders'
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
const at = (hhmm: string, day = 12) => new Date(`2026-11-${day}T${hhmm}:00-06:00`)
type Row = { createdAt: Date; type: OrderType; tableNumber: string | null }
const row = (createdAt: Date, type: OrderType, tableNumber: string | null = null): Row => ({ createdAt, type, tableNumber })
const render = (orders: Row[], total = orders.length, over: Partial<DataScope> = {}) => {
  const s = { ...scope, ...over }
  const rendered = openOrders.render(s, {}, { total, orders })
  expect(checkRendered(rendered, s.timezone)).toBe(true)
  return rendered.text
}

it('the template of the plan, exactly, and it passes the check', () =>
  expect(render([row(at('21:15', 10), 'DINE_IN', '7'), row(at('12:40'), 'TAKEOUT'), row(at('13:05'), 'DINE_IN', '2')], 4)).toBe(
    [
      'Cuentas abiertas de los últimos 7 días en Flautas Coyoacán (corte 14:32): 4. Las más antiguas:',
      'Mesa 7 · desde el mar 10-nov a las 21:15',
      'Para llevar · hoy 12:40',
      'Mesa 2 · hoy 13:05',
      'y 1 más. Los montos están en el panel.',
    ].join('\n'),
  ))

it('without a table, by type; another type says «Cuenta»; all of them fit: no «y N más» and no «Las más antiguas:»', () =>
  expect(
    render([
      row(at('23:59', 11), 'DELIVERY'),
      row(at('09:00'), 'PICKUP'),
      row(at('10:00'), 'DINE_IN'),
      row(at('11:00'), 'MANUAL_ENTRY'),
      row(at('12:00'), 'TAKEOUT', ''),
    ]),
  ).toBe(
    [
      'Cuentas abiertas de los últimos 7 días en Flautas Coyoacán (corte 14:32): 5.',
      'A domicilio · desde el mié 11-nov a las 23:59',
      'Para recoger · hoy 09:00',
      'En el local · hoy 10:00',
      'Cuenta · hoy 11:00',
      'Para llevar · hoy 12:00',
      'Los montos están en el panel.',
    ].join('\n'),
  ))

it('with 6 open and 5 rows: «y 1 más», 7 lines at most', () => {
  const text = render(
    [1, 2, 3, 4, 5].map(i => row(at(`0${i}:00`), 'TAKEOUT')),
    6,
  )
  expect(text.split('\n')).toHaveLength(7)
  expect(text.split('\n')[6]).toBe('y 1 más. Los montos están en el panel.')
})

it('the count and the list read apart: 3 rows with a total of 2 say «: 3.», never fewer than listed, and no «y N más»', () =>
  expect(render([row(at('11:00'), 'TAKEOUT'), row(at('12:00'), 'PICKUP'), row(at('13:00'), 'DELIVERY')], 2)).toBe(
    [
      'Cuentas abiertas de los últimos 7 días en Flautas Coyoacán (corte 14:32): 3.',
      'Para llevar · hoy 11:00',
      'Para recoger · hoy 12:00',
      'A domicilio · hoy 13:00',
      'Los montos están en el panel.',
    ].join('\n'),
  ))

it('a table numbered «55 1234 5678» prints «Mesa [dato omitido]» (case 20)', () =>
  expect(render([row(at('13:05'), 'DINE_IN', '55 1234 5678')]).split('\n')[1]).toBe('Mesa [dato omitido] · hoy 13:05'))

it('zero rows: a complete sentence (Review Focus 2)', () =>
  expect(render([], 0)).toBe('No hay cuentas abiertas de los últimos 7 días en Flautas Coyoacán (corte 14:32).'))

it('the days come from the scope: with 3, «de los últimos 3 días»', () =>
  expect(render([], 0, { openOrdersDays: 3 })).toBe('No hay cuentas abiertas de los últimos 3 días en Flautas Coyoacán (corte 14:32).'))

it('read asks the panel for its venue, from 00:00 of the first of the last 7 calendar days, and as many rows as the scope', async () => {
  const brief = { total: 0, orders: [] }
  jest.mocked(listOpenOrdersBrief).mockResolvedValueOnce(brief)
  expect(await openOrders.read(scope, {})).toBe(brief)
  // viernes 6-nov a las 00:00 en la CDMX
  expect(listOpenOrdersBrief).toHaveBeenCalledWith(scope.venueId, new Date('2026-11-06T06:00:00.000Z'), 5)
})

it('params: always the same, whatever day the person said (no refusal of its own)', () => {
  const request: DataRequest = { capability: 'open_orders', day: 'other', amount: '850', time: '14:00', otherVenue: false }
  expect(openOrders.params(request, '¿qué cuentas tengo abiertas?', scope)).toEqual({ ok: true, value: {} })
})
