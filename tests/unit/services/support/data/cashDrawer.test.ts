/**
 * C8 · «Quién abrió o cerró la caja, hoy o ayer»: la regla de los nombres, la lista cerrada de campos, el renglón del catálogo, lo que
 * `read` le pide al panel (con la lectura de mentira), las plantillas y la revisión de los índices (con `$queryRaw` de mentira), sin
 * base. Lo que pasa con la base de verdad (las ventanas del día, el aislamiento, el directorio, la paridad con «Turnos de caja», el plan
 * de ejecución y los índices después de las migraciones) está en `tests/integration/support/data/cashDrawer.integration.test.ts`.
 */
jest.mock('@/services/dashboard/cashDrawerWho.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/cashDrawerWho.dashboard.service'),
  readCashDrawers: jest.fn(),
}))

import { prismaMock } from '@tests/__helpers__/setup'
import {
  CASH_DRAWER_SELECT,
  cashDrawerIndexesReady,
  nombreDeCajaVisible,
  readCashDrawers,
  type CashDrawerRow,
} from '@/services/dashboard/cashDrawerWho.dashboard.service'
import { resolveMobileStaffName } from '@/services/mobile/cash-drawer.mobile.service'
import { nombreDelCajero } from '@/services/shared/turnoDeCaja'
// La capacidad primero, a propósito: carga sola, sin pasar por el catálogo (C6 r1, el ciclo roto)
import { cashDrawer } from '@/services/support/data/capabilities/cashDrawer'
import { DATA_CAPABILITIES, type DataRequest, type DataScope } from '@/services/support/data/catalog'
import { checkRendered } from '@/services/support/data/check'

type Drawers = Awaited<ReturnType<typeof readCashDrawers>>
const read = readCashDrawers as jest.Mock
/** Flautas Coyoacán, America/Mexico_City, now = 2026-11-12T20:32:00Z (jueves, 14:32). */
const scope: DataScope = {
  venueId: 'ckq7z1x2y0000abcd1234efgh',
  organizationId: 'org',
  venueName: 'Flautas Coyoacán',
  timezone: 'America/Mexico_City',
  day: '2026-11-12',
  kycVerified: true,
  now: new Date('2026-11-12T20:32:00Z'),
  rows: 5,
  openOrdersDays: 7,
  depositGroups: 2000,
  depositTimeoutMs: 3000,
}
/** Una hora de noviembre de 2026 en la CDMX (el 12 por omisión). */
const at = (hhmm: string, day = 12) => new Date(`2026-11-${String(day).padStart(2, '0')}T${hhmm}:00-06:00`)
/** Una caja abierta hoy a las 08:02 por «Ana López», sin cerrar; `over` cambia lo que haga falta. */
const row = (over: Partial<CashDrawerRow> = {}): CashDrawerRow => ({
  abrió: 'Ana López',
  openedAt: at('08:02'),
  cerró: null,
  closedAt: null,
  open: true,
  autoClosed: false,
  ...over,
})
const closed = (over: Partial<CashDrawerRow> = {}) => row({ open: false, cerró: 'Luis Pérez', closedAt: at('14:05'), ...over })
const REQUEST: DataRequest = { capability: 'cash_drawer', day: 'today', amount: null, time: null, otherVenue: false }
/** El texto, con el cotejo pasado: una plantilla que no lo pasa nunca sale. */
const say = (rows: CashDrawerRow[], over: Partial<Drawers> = {}, day: 'today' | 'yesterday' = 'today', s: DataScope = scope) => {
  const rendered = cashDrawer.render(s, { day }, { total: rows.length, rows, ...over })
  expect(checkRendered(rendered, s.timezone)).toBe(true)
  return rendered.text
}

beforeEach(() => read.mockReset())

describe('nombreDeCajaVisible: a name only where the saved one and the directory agree', () => {
  it.each([
    ['Ana López', 'Ana López', 'Ana López'],
    ['  ana   LÓPEZ ', 'Ana López', 'ana LÓPEZ'], // sólo mayúsculas y espacios: sale el guardado, limpio
    ['Ana​ López', 'Ana López', 'Ana López'], // un carácter invisible
    ['Ochocientos Cincuenta', 'Ochocientos Cincuenta', 'Ochocientos Cincuenta'], // el límite aceptado, escrito como prueba
    ['Encargada', 'Lucía Pérez', null], // Codex r10
    ['fondo 85 mil', 'Ana López', null],
    ['fondo ochocientos cincuenta', 'Ana López', null],
    ['fondo 2k', 'Ana López', null],
    ['fondo 85\nmil', 'Ana López', null], // Codex r9
    ['Caja · fondo $850.00', 'Ana López', null],
    ['$850.00', 'Ana López', null],
    ['fondo 850', 'Ana López', null],
    ['Ana López', 'Ana López de Haro', null], // le cambiaron el nombre después
    ['Staff', 'Ana López', null],
    ['Ana López', null, null],
    [null, 'Ana López', null],
    ['Ana $850', 'Ana $850', null],
    ['Luis 1,200', 'Luis 1,200', null], // la última barrera
  ])('nombreDeCajaVisible(%j, %j) → %j', (guardado, delDirectorio, visible) =>
    expect(nombreDeCajaVisible(guardado, delDirectorio)).toBe(visible),
  )

  it('what the server saves when the app sends no name passes the comparison', async () => {
    const staff = { firstName: 'Ana', lastName: 'López' }
    expect(nombreDeCajaVisible(nombreDelCajero(null, staff), 'Ana López')).toBe('Ana López') // abrir y cerrar desde la terminal
    expect(nombreDeCajaVisible(nombreDelCajero('Staff', staff), 'Ana López')).toBe('Ana López') // lo que pone el controlador de la tablet
    prismaMock.staff.findUnique.mockResolvedValueOnce(staff)
    expect(nombreDeCajaVisible(await resolveMobileStaffName('staff-1', 'Staff'), 'Ana López')).toBe('Ana López') // cerrar desde la tablet
  })
})

it('the select is exactly the eight fields', () =>
  expect(Object.keys(CASH_DRAWER_SELECT).sort()).toEqual([
    'closedAt',
    'closedByName',
    'closedByStaffId',
    'id',
    'openedAt',
    'openedByName',
    'openedByStaffId',
    'status',
  ]))

it('the capability loads on its own and the catalog registers it in its place, after payment_invoice and before open_orders', () => {
  jest.isolateModules(() => {
    const alone =
      require('@/services/support/data/capabilities/cashDrawer') as typeof import('@/services/support/data/capabilities/cashDrawer')
    const catalog = require('@/services/support/data/catalog') as typeof import('@/services/support/data/catalog')
    expect(catalog.DATA_CAPABILITIES.cash_drawer).toBe(alone.cashDrawer)
  })
  const keys = Object.keys(DATA_CAPABILITIES)
  expect(keys.indexOf('cash_drawer')).toBe(keys.indexOf('payment_invoice') + 1)
  expect(keys.indexOf('open_orders')).toBe(keys.indexOf('cash_drawer') + 1)
})

it('the row of the catalog: its texts, the permission of «Turnos de caja», no role nor plan, on only with its indexes', () => {
  expect(cashDrawer).toMatchObject({
    key: 'cash_drawer',
    label: 'quién abrió o cerró la caja',
    object: 'quién abrió o cerró la caja',
    aiHint: 'Quién abrió o cerró la caja de la sucursal hoy o ayer, a qué hora, y si sigue abierta. Sin montos.',
    permissions: ['shifts:read'],
  })
  expect(cashDrawer.roles).toBeUndefined()
  expect(cashDrawer.gate).toBeUndefined()
  expect(cashDrawer.available).toBe(cashDrawerIndexesReady)
})

describe('params: today or yesterday', () => {
  it.each<[DataRequest['day'], 'today' | 'yesterday']>([
    [null, 'today'],
    ['today', 'today'],
    ['yesterday', 'yesterday'],
  ])('day %j → %j', (day, value) =>
    expect(cashDrawer.params({ ...REQUEST, day }, '¿Quién abrió la caja?', scope)).toEqual({ ok: true, value: { day: value } }),
  )
  it('another day → its own refusal key', () =>
    expect(cashDrawer.params({ ...REQUEST, day: 'other' }, '¿Quién abrió la caja el lunes?', scope)).toEqual({
      ok: false,
      refusal: 'CASH_DRAWER_TODAY_OR_YESTERDAY',
    }))
})

describe('read: the venue of the scope, the civil day and the cap', () => {
  const answer: Drawers = { total: 0, rows: [] }
  it('today: from 00:00 of the venue to the cut', async () => {
    read.mockResolvedValue(answer)
    expect(await cashDrawer.read(scope, { day: 'today' })).toBe(answer)
    expect(read.mock.calls).toEqual([
      [scope.venueId, { from: new Date('2026-11-12T06:00:00.000Z'), to: new Date('2026-11-12T20:32:00.000Z') }, 5],
    ])
  })
  it('yesterday: the whole civil day of the venue', async () => {
    read.mockResolvedValue(answer)
    await cashDrawer.read({ ...scope, rows: 3 }, { day: 'yesterday' })
    expect(read.mock.calls).toEqual([
      [scope.venueId, { from: new Date('2026-11-11T06:00:00.000Z'), to: new Date('2026-11-12T05:59:59.999Z') }, 3],
    ])
  })
})

describe('the templates', () => {
  it('the template has no general text hole and never prints [dato omitido]', () => {
    const out = cashDrawer.render(
      { ...scope, venueName: 'Corte 4111 1111 1111 1111' },
      { day: 'today' },
      { total: 1, rows: [row({ abrió: null })] },
    )
    expect(out.figures.some(f => f.kind === 'text')).toBe(false)
    expect(out.text).toBe('Caja de tu sucursal, jue 12-nov (corte 14:32): una persona la abrió a las 08:02 y sigue abierta.')
  })

  it('still open, opened that day', () =>
    expect(say([row()])).toBe('Caja de Flautas Coyoacán, jue 12-nov (corte 14:32): Ana López la abrió a las 08:02 y sigue abierta.'))

  it('opened and closed that day: only the hours', () =>
    expect(say([closed()])).toBe(
      'Caja de Flautas Coyoacán, jue 12-nov (corte 14:32): Ana López la abrió a las 08:02 y Luis Pérez la cerró a las 14:05.',
    ))

  it('opened one day and closed another: both events with their date, asked today and asked yesterday', () => {
    const night = closed({ abrió: 'Luis Pérez', openedAt: at('23:10', 11), cerró: 'Ana López', closedAt: at('01:00') })
    const both = 'Luis Pérez la abrió el mié 11-nov a las 23:10 y Ana López la cerró el jue 12-nov a las 01:00.'
    expect(say([night])).toBe(`Caja de Flautas Coyoacán, jue 12-nov (corte 14:32): ${both}`)
    expect(say([night], {}, 'yesterday')).toBe(`Caja de Flautas Coyoacán, mié 11-nov (corte 14:32): ${both}`)
  })

  it('still open since another day: with its date', () =>
    expect(say([row({ openedAt: at('08:02', 9) })])).toBe(
      'Caja de Flautas Coyoacán, jue 12-nov (corte 14:32): Ana López la abrió el lun 9-nov a las 08:02 y sigue abierta.',
    ))

  it('closed by the system: «se cerró sola», never a name', () => {
    expect(say([closed({ openedAt: at('00:30'), cerró: null, closedAt: at('04:00'), autoClosed: true })])).toBe(
      'Caja de Flautas Coyoacán, jue 12-nov (corte 14:32): Ana López la abrió a las 00:30 y se cerró sola a las 04:00.',
    )
    expect(say([closed({ openedAt: at('23:10', 11), cerró: null, closedAt: at('04:00'), autoClosed: true })])).toBe(
      'Caja de Flautas Coyoacán, jue 12-nov (corte 14:32): Ana López la abrió el mié 11-nov a las 23:10 y se cerró sola el jue 12-nov a las 04:00.',
    )
  })

  it('nobody in the directory: «una persona», for the one who opened and for the one who closed', () =>
    expect(say([closed({ abrió: null, cerró: null })])).toBe(
      'Caja de Flautas Coyoacán, jue 12-nov (corte 14:32): una persona la abrió a las 08:02 y una persona la cerró a las 14:05.',
    ))

  it('two drawers of the day: the header with the count and a line per drawer, nothing about how many are open (r1)', () =>
    expect(say([closed({ closedAt: at('09:00') }), row({ abrió: 'Luis Pérez', openedAt: at('09:15') })])).toBe(
      [
        'Cajas de Flautas Coyoacán, jue 12-nov (corte 14:32): 2',
        'Ana López la abrió a las 08:02 y Luis Pérez la cerró a las 09:00.',
        'Luis Pérez la abrió a las 09:15 y sigue abierta.',
      ].join('\n'),
    ))

  it('more than fit: «y N más» in the closing line, within 7 lines', () => {
    const rows = [closed(), closed({ openedAt: at('09:00') }), closed({ openedAt: at('10:00') }), closed({ openedAt: at('11:00') }), row()]
    const lines = say(rows, { total: 6 }).split('\n')
    expect(lines).toHaveLength(7)
    expect(lines[0]).toBe('Cajas de Flautas Coyoacán, jue 12-nov (corte 14:32): 6')
    expect(lines[6]).toBe('y 1 más; el resto está en Turnos de caja.')
  })

  it('one drawer: no closing line', () => expect(say([row()]).split('\n')).toHaveLength(1))

  // r1: el conteo y la lista son dos lecturas (READ COMMITTED: cada una con su foto). Si el conteo ve cajas y la lista ninguna, se dice
  // la frase de cero, nunca un encabezado con «y N más» sin nada listado.
  it.each<['today' | 'yesterday', string]>([
    ['today', 'No encontré cajas abiertas ni cerradas hoy en Flautas Coyoacán (corte 14:32).'],
    ['yesterday', 'No encontré cajas abiertas ni cerradas ayer en Flautas Coyoacán (corte 14:32).'],
  ])('the count sees drawers but the list none (%s): the zero-row sentence (r1)', (day, text) =>
    expect(say([], { total: 3 }, day)).toBe(text),
  )

  it.each<['today' | 'yesterday', string]>([
    ['today', 'No encontré cajas abiertas ni cerradas hoy en Flautas Coyoacán (corte 14:32).'],
    ['yesterday', 'No encontré cajas abiertas ni cerradas ayer en Flautas Coyoacán (corte 14:32).'],
  ])('zero rows: a complete sentence (%s)', (day, text) => expect(say([], {}, day)).toBe(text))

  it('a venue named with an amount says «tu sucursal»', () =>
    expect(say([row()], {}, 'today', { ...scope, venueName: 'Flautas $850' })).toBe(
      'Caja de tu sucursal, jue 12-nov (corte 14:32): Ana López la abrió a las 08:02 y sigue abierta.',
    ))

  it('a closed drawer without its closing hour is not said (it fails closed)', () =>
    expect(() => cashDrawer.render(scope, { day: 'today' }, { total: 1, rows: [closed({ closedAt: null })] })).toThrow())
})

describe('the indexes: on only when the two of C8 and the open-drawer one are valid and ready ($queryRaw de mentira, sobre el servicio)', () => {
  const raw = prismaMock.$queryRaw as jest.Mock
  /** El servicio recién cargado (lo que recuerda es del proceso), y el logger que él ve (el de mentira de setup, del mismo registro). */
  let warn: jest.Mock
  const fresh = () => {
    let fn!: typeof cashDrawerIndexesReady
    jest.isolateModules(() => {
      fn = (
        jest.requireActual(
          '@/services/dashboard/cashDrawerWho.dashboard.service',
        ) as typeof import('@/services/dashboard/cashDrawerWho.dashboard.service')
      ).cashDrawerIndexesReady
      warn = (require('@/config/logger') as { default: { warn: jest.Mock } }).default.warn
    })
    return fn
  }
  let now = 1_000_000
  beforeEach(() => {
    raw.mockReset()
    now = 1_000_000
    jest.spyOn(Date, 'now').mockImplementation(() => now)
  })
  afterEach(() => jest.restoreAllMocks())

  it('the three valid and ready → ready, and the yes is remembered: it does not ask again (and logs nothing)', async () => {
    const ready = fresh()
    raw.mockResolvedValue([{ ready: 3 }])
    expect(await ready()).toBe(true)
    now += 3_600_000
    expect(await ready()).toBe(true)
    expect(raw).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
    // lo que pregunta: pg_index de esos tres (los dos de C8 y el único parcial de la caja abierta), válidos y listos; sin binds
    const [sql, ...binds] = raw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    const text = sql.join('?')
    expect(binds).toEqual([])
    for (const piece of [
      'pg_index',
      'indisvalid',
      'indisready',
      '"CashDrawerSession"',
      '"CashDrawerSession_venueId_openedAt_idx"',
      '"CashDrawerSession_venueId_closedAt_idx"',
      '"CashDrawerSession_venueId_open_key"',
    ])
      expect(text).toContain(piece)
    expect(text).not.toContain('CashDrawerSession_venueId_status_idx') // r1: ya no existe
  })

  it.each([
    ['one missing or invalid (two of three)', [{ ready: 2 }]],
    ['none', [{ ready: 0 }]],
    ['no row', []],
  ])('%s → not ready; asks again only after 60 s', async (_case, answer) => {
    const ready = fresh()
    raw.mockResolvedValue(answer)
    expect(await ready()).toBe(false)
    // r1: un aviso con el número y nada más, una vez por pregunta (a lo más una cada 60 s)
    expect(warn.mock.calls).toEqual([[expect.any(String), { ready: answer[0]?.ready ?? 0 }]])
    now += 59_999
    expect(await ready()).toBe(false)
    expect(raw).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    now += 1
    raw.mockResolvedValue([{ ready: 3 }])
    expect(await ready()).toBe(true)
    expect(raw).toHaveBeenCalledTimes(2)
  })

  it('the database fails → not on (it rejects: the orchestrator turns it off), and asks again after 60 s', async () => {
    const ready = fresh()
    raw.mockRejectedValue(new Error('connection lost'))
    await expect(ready()).rejects.toThrow()
    // r1: el rechazo también se recuerda dentro de los 60 s: no vuelve a preguntar
    now += 59_999
    await expect(ready()).rejects.toThrow()
    expect(raw).toHaveBeenCalledTimes(1)
    now += 1
    raw.mockResolvedValue([{ ready: 3 }])
    expect(await ready()).toBe(true)
  })
})
