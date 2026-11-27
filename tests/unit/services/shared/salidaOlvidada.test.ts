/**
 * «Salida olvidada» (hz:f0a89d19:D3): cuándo se da por olvidado un turno, con qué horas se cierra, el job y la corrección del
 * gerente. La checada del celular tiene sus casos en `checadaDeCampo.service.test.ts`.
 */
const mockLogAction = jest.fn()
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: (...a: unknown[]) => mockLogAction(...(a as [])) }))

import { prismaMock } from '@tests/__helpers__/setup'
import { Settings } from 'luxon'
import {
  anotarSalidaQueNoSeUso,
  cerrarOlvidadasAntesDeChecar,
  cerrarSalidasOlvidadasPendientes,
  corregirSalidaOlvidada,
  leerCorte,
  limiteDelTurno,
  salidaDeSuHorario,
  textoSalidaYaOlvidada,
} from '@/services/shared/salidaOlvidada'

const MX = 'America/Mexico_City'
/** Hora de pared en CDMX (UTC-6, sin horario de verano desde 2022). */
const mx = (iso: string) => new Date(`${iso}-06:00`)

beforeEach(() => {
  jest.clearAllMocks()
})

describe('limiteDelTurno', () => {
  it('una entrada de las 09:00 vive hasta el corte de las 04:00 del día siguiente', () => {
    expect(limiteDelTurno(mx('2026-11-03T09:00:00'), MX)).toEqual(mx('2026-11-04T04:00:00'))
  })

  it('un turno nocturno (22:00) no se parte en el corte: nunca antes de 12 h (10:00)', () => {
    expect(limiteDelTurno(mx('2026-11-03T22:00:00'), MX)).toEqual(mx('2026-11-04T10:00:00'))
  })

  it('a las 03:30 todavía es el día de ayer: el corte de las 04:00 queda a 30 min, así que manda el mínimo de 12 h', () => {
    expect(limiteDelTurno(mx('2026-11-04T03:30:00'), MX)).toEqual(mx('2026-11-04T15:30:00'))
  })

  it('usa la zona de la sucursal (Tijuana, UTC-8 en noviembre)', () => {
    const entrada = new Date('2026-11-03T09:00:00-08:00')
    expect(limiteDelTurno(entrada, 'America/Tijuana')).toEqual(new Date('2026-11-04T04:00:00-08:00'))
  })

  it('una zona inválida cae a la de México (no truena)', () => {
    expect(limiteDelTurno(mx('2026-11-03T09:00:00'), 'No/Existe')).toEqual(mx('2026-11-04T04:00:00'))
  })
})

// La sucursal elige su hora de corte (founder, 26-nov: «A», como Toast y Square). El back-office pidió las 22:00: después de
// esa hora el turno queda como olvidado. Con hora propia no hay mínimo de 12 h; sólo una hora desde la entrada.
describe('leerCorte', () => {
  it('sólo HH:mm de 00:00 a 23:59; lo demás es la regla de fábrica (null)', () => {
    expect(leerCorte('22:00')).toEqual([22, 0])
    expect(leerCorte('00:05')).toEqual([0, 5])
    for (const v of [null, undefined, '', '24:00', '22:60', '7:00', ' 22:00', '22:00:00']) expect(leerCorte(v)).toBeNull()
  })
})

describe('limiteDelTurno con la hora de corte de la sucursal', () => {
  it('22:00: una entrada de las 10:00 o de las 14:00 vence a las 22:00 del mismo día (sin el mínimo de 12 h)', () => {
    expect(limiteDelTurno(mx('2026-11-03T10:00:00'), MX, null, '22:00')).toEqual(mx('2026-11-03T22:00:00'))
    expect(limiteDelTurno(mx('2026-11-03T14:00:00'), MX, null, '22:00')).toEqual(mx('2026-11-03T22:00:00'))
  })

  it('22:00: entrar a menos de una hora del corte (21:30) o después (22:30) vence en el corte del día siguiente', () => {
    expect(limiteDelTurno(mx('2026-11-03T21:00:00'), MX, null, '22:00')).toEqual(mx('2026-11-03T22:00:00'))
    expect(limiteDelTurno(mx('2026-11-03T21:30:00'), MX, null, '22:00')).toEqual(mx('2026-11-04T22:00:00'))
    expect(limiteDelTurno(mx('2026-11-03T22:30:00'), MX, null, '22:00')).toEqual(mx('2026-11-04T22:00:00'))
  })

  it('su horario sólo alarga el corte si termina DESPUÉS de él: entonces manda una hora después de su salida', () => {
    expect(limiteDelTurno(mx('2026-11-03T14:00:00'), MX, mx('2026-11-03T23:00:00'), '22:00')).toEqual(mx('2026-11-04T00:00:00'))
    // Codex r1 #7: un horario que termina a las 21:30 o a las 22:00 no corre el corte de la sucursal.
    expect(limiteDelTurno(mx('2026-11-03T14:00:00'), MX, mx('2026-11-03T21:30:00'), '22:00')).toEqual(mx('2026-11-03T22:00:00'))
    expect(limiteDelTurno(mx('2026-11-03T14:00:00'), MX, mx('2026-11-03T22:00:00'), '22:00')).toEqual(mx('2026-11-03T22:00:00'))
  })

  it('Codex r2 #3: una hora que se repite (regreso al horario de invierno) da siempre la primera, sin importar el reloj', () => {
    // Tijuana, 1-nov-2026: las 01:xx pasan dos veces. Entrada 00:10 PDT, corte 01:30: la primera 01:30 (PDT) = 08:30Z.
    const entrada = new Date('2026-11-01T00:10:00-07:00')
    const original = Settings.now
    try {
      for (const reloj of ['2026-07-01T12:00:00Z', '2026-12-01T12:00:00Z']) {
        Settings.now = () => new Date(reloj).getTime()
        expect(limiteDelTurno(entrada, 'America/Tijuana', null, '01:30')).toEqual(new Date('2026-11-01T08:30:00Z'))
      }
    } finally {
      Settings.now = original
    }
  })

  it('Codex r1 #5: el día del cambio de horario no corre el corte del día siguiente (Tijuana, 8-mar-2026)', () => {
    // 01:40 PST + 1 h = 03:40 PDT (las 02:xx no existen ese día): el primer corte de las 02:30 que cumple es el del 9-mar.
    const entrada = new Date('2026-03-08T01:40:00-08:00')
    expect(limiteDelTurno(entrada, 'America/Tijuana', null, '02:30')).toEqual(new Date('2026-03-09T02:30:00-07:00'))
  })

  it('un corte de madrugada (02:30) cruza la medianoche y usa la zona de la sucursal', () => {
    expect(limiteDelTurno(mx('2026-11-03T18:00:00'), MX, null, '02:30')).toEqual(mx('2026-11-04T02:30:00'))
    const tj = new Date('2026-11-03T18:00:00-08:00')
    expect(limiteDelTurno(tj, 'America/Tijuana', null, '22:00')).toEqual(new Date('2026-11-03T22:00:00-08:00'))
  })

  it('sin hora o con una hora inválida es la regla de fábrica: 04:00 y nunca antes de 12 h', () => {
    for (const corte of [null, undefined, '', '25:00', '7', 'abc']) {
      expect(limiteDelTurno(mx('2026-11-03T22:00:00'), MX, null, corte)).toEqual(mx('2026-11-04T10:00:00'))
    }
  })
})

describe('salidaDeSuHorario', () => {
  const limite = mx('2026-11-04T04:00:00')

  it('con horario 09:00–17:00 ese día, la salida es las 17:00', () => {
    const r = salidaDeSuHorario(mx('2026-11-03T09:05:00'), MX, [{ fecha: '2026-11-03', start: '09:00', end: '17:00' }], limite)
    expect(r).toEqual(mx('2026-11-03T17:00:00'))
  })

  it('llegar hasta 4 h antes todavía es ese turno', () => {
    const r = salidaDeSuHorario(mx('2026-11-03T05:30:00'), MX, [{ fecha: '2026-11-03', start: '09:00', end: '17:00' }], limite)
    expect(r).toEqual(mx('2026-11-03T17:00:00'))
  })

  it('entró después de que terminó su horario → null (0 horas, no se inventan)', () => {
    expect(salidaDeSuHorario(mx('2026-11-03T18:00:00'), MX, [{ fecha: '2026-11-03', start: '09:00', end: '17:00' }], limite)).toBeNull()
  })

  it('sin horario o día de descanso → null', () => {
    expect(salidaDeSuHorario(mx('2026-11-03T09:00:00'), MX, [{ fecha: '2026-11-03', start: null, end: null }], limite)).toBeNull()
    expect(salidaDeSuHorario(mx('2026-11-03T09:00:00'), MX, [], limite)).toBeNull()
  })

  it('turno nocturno de AYER (22:00–06:00) con entrada a las 00:30: sale a las 06:00', () => {
    const r = salidaDeSuHorario(
      mx('2026-11-04T00:30:00'),
      MX,
      [
        { fecha: '2026-11-04', start: null, end: null },
        { fecha: '2026-11-03', start: '22:00', end: '06:00' },
      ],
      mx('2026-11-04T12:30:00'),
    )
    expect(r).toEqual(mx('2026-11-04T06:00:00'))
  })

  it('Codex r1 #2: entrada 03:30 que cubre el final del nocturno (22–06) no toma el diurno de las 07:00', () => {
    const r = salidaDeSuHorario(mx('2026-11-04T03:30:00'), MX, [
      { fecha: '2026-11-04', start: '07:00', end: '15:00' },
      { fecha: '2026-11-03', start: '22:00', end: '06:00' },
    ])
    expect(r).toEqual(mx('2026-11-04T06:00:00'))
  })

  it('Codex r1 #1: un nocturno de 21:00 a 10:00 alarga el límite a una hora después de su salida (11:00)', () => {
    const entrada = mx('2026-11-03T21:00:00')
    const fin = salidaDeSuHorario(entrada, MX, [{ fecha: '2026-11-03', start: '21:00', end: '10:00' }])
    expect(fin).toEqual(mx('2026-11-04T10:00:00'))
    expect(limiteDelTurno(entrada, MX, fin)).toEqual(mx('2026-11-04T11:00:00'))
    expect(limiteDelTurno(entrada, MX)).toEqual(mx('2026-11-04T09:00:00'))
  })

  it('nunca después del límite', () => {
    const r = salidaDeSuHorario(
      mx('2026-11-03T20:00:00'),
      MX,
      [{ fecha: '2026-11-03', start: '20:00', end: '09:00' }],
      mx('2026-11-04T08:00:00'),
    )
    expect(r).toEqual(mx('2026-11-04T08:00:00'))
  })
})

const abierta = (extra: Record<string, unknown> = {}) => ({
  id: 'te-1',
  staffId: 'staff-1',
  venueId: 'venue-1',
  clockInTime: mx('2026-11-03T09:00:00'),
  notes: null,
  breaks: [] as { id: string; startTime: Date; endTime: Date | null }[],
  venue: {
    timezone: MX,
    settings: null as null | { salidaOlvidadaEnabled: boolean; rotatingShiftsEnabled: boolean; salidaOlvidadaCorte?: string | null },
  },
  ...extra,
})

describe('cerrarSalidasOlvidadasPendientes (el job)', () => {
  it('cierra en 0 h lo que pasó su límite y no tiene horario, marca «salida olvidada» y lo anota en la bitácora', async () => {
    prismaMock.timeEntry.findMany.mockResolvedValue([abierta()] as any)
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 1 })

    const r = await cerrarSalidasOlvidadasPendientes(mx('2026-11-04T04:10:00'))

    expect(r).toEqual({ cerradas: 1, errores: 0 })
    expect(prismaMock.timeEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'te-1', clockOutTime: null },
      data: expect.objectContaining({
        clockOutTime: mx('2026-11-03T09:00:00'),
        status: 'CLOCKED_OUT',
        totalHours: 0,
        autoClockOut: true,
        salidaOlvidada: true,
      }),
    })
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'TIME_ENTRY_FORGOTTEN_CLOCKOUT', staffId: null, entityId: 'te-1' }),
    )
  })

  it('la lectura tiene tope, deja fuera a los negocios que la apagaron y pide las de más de 1 h (el corte más temprano posible)', async () => {
    prismaMock.timeEntry.findMany.mockResolvedValue([])
    const ahora = mx('2026-11-04T04:10:00')

    await cerrarSalidasOlvidadasPendientes(ahora)

    const args = prismaMock.timeEntry.findMany.mock.calls[0][0] as any
    expect(args.take).toBe(500)
    expect(args.where.venue).toEqual({ OR: [{ settings: null }, { settings: { salidaOlvidadaEnabled: true } }] })
    // Codex r1 #9 y #6: las de fábrica desde 12 h; sólo las sucursales con hora propia desde 1 h; con `lte` (justo en el límite).
    expect(args.where.AND).toEqual([
      {
        OR: [
          { clockInTime: { lte: new Date(ahora.getTime() - 12 * 3_600_000) } },
          {
            clockInTime: { lte: new Date(ahora.getTime() - 1 * 3_600_000) },
            venue: { settings: { salidaOlvidadaCorte: { not: null } } },
          },
        ],
      },
    ])
    expect(args.select.venue.select.settings.select).toMatchObject({ salidaOlvidadaCorte: true })
  })

  it('con corte de las 22:00 cierra a las 22:05 una entrada de las 14:00 (8 h), en 0 h y marcada para revisar', async () => {
    const e = abierta({
      clockInTime: mx('2026-11-03T14:00:00'),
      venue: { timezone: MX, settings: { salidaOlvidadaEnabled: true, rotatingShiftsEnabled: false, salidaOlvidadaCorte: '22:00' } },
    })
    prismaMock.timeEntry.findMany.mockResolvedValue([e] as any)
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.venueSettings.findUnique.mockResolvedValue({ salidaOlvidadaEnabled: true, salidaOlvidadaCorte: '22:00' } as any)
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 1 })

    await expect(cerrarSalidasOlvidadasPendientes(mx('2026-11-03T22:05:00'))).resolves.toEqual({ cerradas: 1, errores: 0 })
    // El límite con el que cerró queda guardado (Codex r1 #1): cambiar el corte después no lo mueve.
    expect(prismaMock.timeEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ totalHours: 0, salidaOlvidada: true, limiteOlvidada: mx('2026-11-03T22:00:00') }),
      }),
    )
  })

  it('Codex r3 #9: el cierre toma el candado de la regla de su sucursal antes de releer el corte', async () => {
    const e = abierta({ clockInTime: mx('2026-11-03T14:00:00'), venue: { timezone: MX, settings: null } })
    prismaMock.timeEntry.findMany.mockResolvedValue([e] as any)
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.venueSettings.findUnique.mockResolvedValue({ salidaOlvidadaEnabled: true, salidaOlvidadaCorte: '22:00' } as any)
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 1 })

    await cerrarSalidasOlvidadasPendientes(mx('2026-11-04T10:00:00'))

    const candado = prismaMock.$queryRaw.mock.calls.find((c: unknown[]) => String(c[1]) === 'salida-olvidada:venue-1')
    expect(candado).toBeDefined()
    expect((candado![0] as unknown as string[]).join('?')).toContain('pg_advisory_xact_lock')
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[prismaMock.$queryRaw.mock.calls.indexOf(candado!)]).toBeLessThan(
      prismaMock.venueSettings.findUnique.mock.invocationCallOrder[0],
    )
  })

  it('Codex r1 #2: si el gerente movió el corte a las 23:00 después de leer la página, a las 22:05 no se cierra', async () => {
    const e = abierta({
      clockInTime: mx('2026-11-03T14:00:00'),
      venue: { timezone: MX, settings: { salidaOlvidadaEnabled: true, rotatingShiftsEnabled: false, salidaOlvidadaCorte: '22:00' } },
    })
    prismaMock.timeEntry.findMany.mockResolvedValue([e] as any)
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.venueSettings.findUnique.mockResolvedValue({ salidaOlvidadaEnabled: true, salidaOlvidadaCorte: '23:00' } as any)

    await expect(cerrarSalidasOlvidadasPendientes(mx('2026-11-03T22:05:00'))).resolves.toEqual({ cerradas: 0, errores: 0 })
    expect(prismaMock.timeEntry.updateMany).not.toHaveBeenCalled()
  })

  it('con corte de las 22:00, a las 21:50 todavía no toca la entrada de las 14:00', async () => {
    const e = abierta({
      clockInTime: mx('2026-11-03T14:00:00'),
      venue: { timezone: MX, settings: { salidaOlvidadaEnabled: true, rotatingShiftsEnabled: false, salidaOlvidadaCorte: '22:00' } },
    })
    prismaMock.timeEntry.findMany.mockResolvedValue([e] as any)

    await expect(cerrarSalidasOlvidadasPendientes(mx('2026-11-03T21:50:00'))).resolves.toEqual({ cerradas: 0, errores: 0 })
    expect(prismaMock.timeEntry.updateMany).not.toHaveBeenCalled()
  })

  it('antes del límite no toca nada', async () => {
    prismaMock.timeEntry.findMany.mockResolvedValue([abierta({ clockInTime: mx('2026-11-03T15:00:00') })] as any)

    const r = await cerrarSalidasOlvidadasPendientes(mx('2026-11-04T03:50:00'))

    expect(r.cerradas).toBe(0)
    expect(prismaMock.timeEntry.updateMany).not.toHaveBeenCalled()
  })

  it('con la regla apagada en la sucursal no toca nada', async () => {
    prismaMock.timeEntry.findMany.mockResolvedValue([
      abierta({ venue: { timezone: MX, settings: { salidaOlvidadaEnabled: false, rotatingShiftsEnabled: false } } }),
    ] as any)

    const r = await cerrarSalidasOlvidadasPendientes(mx('2026-11-09T12:00:00'))

    expect(r.cerradas).toBe(0)
    expect(prismaMock.timeEntry.updateMany).not.toHaveBeenCalled()
  })

  it('con horario cierra a la salida de su horario y descuenta el descanso; el descanso abierto termina en la salida', async () => {
    prismaMock.timeEntry.findMany.mockResolvedValue([
      abierta({
        breaks: [
          { id: 'b1', startTime: mx('2026-11-03T13:00:00'), endTime: mx('2026-11-03T13:30:00') },
          { id: 'b2', startTime: mx('2026-11-03T16:30:00'), endTime: null },
        ],
      }),
    ] as any)
    prismaMock.staffVenue.findFirst.mockResolvedValue({
      workSchedule: { weekly: { tuesday: { enabled: true, ranges: [{ open: '09:00', close: '17:00' }] } } },
      workScheduleExceptions: [],
    } as any)
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.timeEntryBreak.updateMany.mockResolvedValue({ count: 1 })

    await cerrarSalidasOlvidadasPendientes(mx('2026-11-04T05:00:00'))

    // 8 h − 30 min − 30 min = 7 h
    expect(prismaMock.timeEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clockOutTime: mx('2026-11-03T17:00:00'), totalHours: 7, breakMinutes: 60 }),
      }),
    )
    expect(prismaMock.timeEntryBreak.updateMany).toHaveBeenCalledWith({
      where: { id: 'b2', endTime: null },
      data: { endTime: mx('2026-11-03T17:00:00') },
    })
  })

  it('Codex r1 #11: las que aún no vencen no abren transacción y el job sigue a la página siguiente', async () => {
    const noVence = abierta({ id: 'te-x', clockInTime: mx('2026-11-03T22:00:00') }) // límite base 10:00
    prismaMock.timeEntry.findMany
      .mockResolvedValueOnce(Array.from({ length: 500 }, (_, i) => ({ ...noVence, id: `te-${i}` })) as any)
      .mockResolvedValueOnce([abierta({ id: 'te-vieja', clockInTime: mx('2026-11-03T09:00:00') })] as any)
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 1 })

    const r = await cerrarSalidasOlvidadasPendientes(mx('2026-11-04T05:00:00'))

    expect(r.cerradas).toBe(1)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect((prismaMock.timeEntry.findMany.mock.calls[1][0] as any).cursor).toEqual({ id: 'te-499' })
  })

  it('un nocturno largo con horario (21:00–10:00) NO se cierra a las 09:30: todavía es su turno', async () => {
    prismaMock.timeEntry.findMany.mockResolvedValue([abierta({ clockInTime: mx('2026-11-03T21:00:00') })] as any)
    prismaMock.staffVenue.findFirst.mockResolvedValue({
      workSchedule: { weekly: { tuesday: { enabled: true, ranges: [{ open: '21:00', close: '10:00' }] } } },
      workScheduleExceptions: [],
    } as any)

    const r = await cerrarSalidasOlvidadasPendientes(mx('2026-11-04T09:30:00'))

    expect(r.cerradas).toBe(0)
    expect(prismaMock.timeEntry.updateMany).not.toHaveBeenCalled()
  })

  it('Codex r2 #11 y #12: relee el interruptor en la transacción y el cierre exige el estado leído', async () => {
    prismaMock.timeEntry.findMany.mockResolvedValue([abierta({ status: 'CLOCKED_IN' })] as any)
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.venueSettings.findUnique.mockResolvedValueOnce({ salidaOlvidadaEnabled: false } as any)

    expect((await cerrarSalidasOlvidadasPendientes(mx('2026-11-04T05:00:00'))).cerradas).toBe(0)
    expect(prismaMock.timeEntry.updateMany).not.toHaveBeenCalled()

    prismaMock.venueSettings.findUnique.mockResolvedValue(null)
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 1 })
    await cerrarSalidasOlvidadasPendientes(mx('2026-11-04T05:00:00'))
    expect(prismaMock.timeEntry.updateMany.mock.calls[0][0].where).toEqual({ id: 'te-1', clockOutTime: null, status: 'CLOCKED_IN' })
  })

  it('una salida real que ganó la carrera (0 filas) no se cuenta ni se anota', async () => {
    prismaMock.timeEntry.findMany.mockResolvedValue([abierta()] as any)
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 0 })

    const r = await cerrarSalidasOlvidadasPendientes(mx('2026-11-04T05:00:00'))

    expect(r.cerradas).toBe(0)
    expect(mockLogAction).not.toHaveBeenCalled()
  })
})

describe('anotarSalidaQueNoSeUso (PAX y POS tras el cierre)', () => {
  const marcada = {
    id: 'te-1',
    clockInTime: mx('2026-11-09T09:00:00'),
    clockOutTime: mx('2026-11-09T09:00:00'),
    notes: null,
    checkOutPhotoUrl: null,
    depositPhotoUrl: null,
    venue: { timezone: MX },
  }

  it('pega el voucher a la checada marcada y lo dice', async () => {
    prismaMock.timeEntry.findFirst.mockResolvedValue(marcada as any)
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 1 })

    const t = await anotarSalidaQueNoSeUso({ staffId: 's', venueId: 'v', origen: 'PAX', depositPhotoUrl: 'https://x/voucher.jpg' })

    expect(t).toContain('quedaron anotadas')
    expect(prismaMock.timeEntry.updateMany.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ depositPhotoUrl: 'https://x/voucher.jpg' }),
    )
    // D4 (Codex r2 #1, founder «A»): primero la nota con su evidencia y después el asiento con la hora real, que lee la
    // bitácora de marca blanca; si el asiento fallara, la evidencia ya quedó guardada (`logAction` nunca lanza).
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 's',
        venueId: 'v',
        action: 'TIME_ENTRY_LATE_CLOCKOUT_NOT_USED',
        entity: 'TimeEntry',
        entityId: 'te-1',
        data: expect.objectContaining({ origen: 'PAX', salidaRecibida: expect.any(String) }),
      }),
    )
    expect(prismaMock.timeEntry.updateMany.mock.invocationCallOrder[0]).toBeLessThan(mockLogAction.mock.invocationCallOrder[0])
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  // FLAUTAS_C (revisión de apps viejas, 21-nov): la salida tardía de la PAX o del POS tiraba el GPS; en PlayTelecom el GPS
  // de la checada es la prueba de que el promotor estuvo en su punto. Se guarda como las fotos: si la checada no trae el suyo.
  it('guarda el GPS de la salida tardía si la checada no trae el suyo, y no pisa uno que ya tenga', async () => {
    prismaMock.timeEntry.findFirst.mockResolvedValue({ ...marcada, clockOutLatitude: null } as any)
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 1 })

    await anotarSalidaQueNoSeUso({ staffId: 's', venueId: 'v', origen: 'PAX', latitude: 19.43, longitude: -99.13, accuracy: 8 })

    expect(prismaMock.timeEntry.updateMany.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ clockOutLatitude: 19.43, clockOutLongitude: -99.13, clockOutAccuracy: 8 }),
    )

    prismaMock.timeEntry.findFirst.mockResolvedValue({ ...marcada, clockOutLatitude: 20.5 } as any)
    await anotarSalidaQueNoSeUso({ staffId: 's', venueId: 'v', origen: 'POS', latitude: 19.43, longitude: -99.13, accuracy: 8 })

    expect(prismaMock.timeEntry.updateMany.mock.calls[1][0].data).not.toHaveProperty('clockOutLatitude')
  })

  it('Codex r2 #5: si otro escritor la cambió (0 filas), NO dice que quedaron anotadas', async () => {
    prismaMock.timeEntry.findFirst.mockResolvedValue(marcada as any)
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 0 })

    const t = await anotarSalidaQueNoSeUso({ staffId: 's', venueId: 'v', origen: 'PAX', depositPhotoUrl: 'https://x/voucher.jpg' })

    expect(t).not.toContain('quedaron anotadas')
    expect(t).toContain('no se pudo anotar')
    expect(mockLogAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'TIME_ENTRY_LATE_CLOCKOUT_NOT_USED' })) // sin nota, sin asiento (D4)
  })
})

describe('cerrarSalidasOlvidadasDe: candados en orden (Codex 26-nov r4 #4)', () => {
  it('toma el candado de la regla de cada sucursal una vez y en orden de id, antes de cerrar', async () => {
    const { cerrarSalidasOlvidadasDe } = jest.requireActual('@/services/shared/salidaOlvidada')
    prismaMock.timeEntry.findMany.mockResolvedValue([
      abierta({ id: 'te-b', venueId: 'venue-b' }),
      abierta({ id: 'te-a', venueId: 'venue-a' }),
      abierta({ id: 'te-b2', venueId: 'venue-b' }),
    ] as any)
    prismaMock.venueSettings.findUnique.mockResolvedValue({ salidaOlvidadaEnabled: false } as any)

    await cerrarSalidasOlvidadasDe(prismaMock, 'staff-1', mx('2026-11-04T10:00:00'), 'ENTRADA')

    const candados = prismaMock.$queryRaw.mock.calls
      .map((c: unknown[]) => String(c[1]))
      .filter((k: string) => k.startsWith('salida-olvidada:'))
    expect(candados.slice(0, 2)).toEqual(['salida-olvidada:venue-a', 'salida-olvidada:venue-b'])
  })

  it('Codex r5 #3: un turno todavía vigente no toma el candado (una salida normal no hace fila)', async () => {
    const { cerrarSalidasOlvidadasDe } = jest.requireActual('@/services/shared/salidaOlvidada')
    prismaMock.timeEntry.findMany.mockResolvedValue([abierta({ clockInTime: mx('2026-11-04T08:00:00') })] as any)

    await cerrarSalidasOlvidadasDe(prismaMock, 'staff-1', mx('2026-11-04T17:00:00'), 'SALIDA')

    expect(prismaMock.$queryRaw.mock.calls.filter((c: unknown[]) => String(c[1]).startsWith('salida-olvidada:'))).toHaveLength(0)
  })
})

describe('cerrarOlvidadasAntesDeChecar (PAX y POS)', () => {
  it('sin nada viejo abierto no abre transacción', async () => {
    prismaMock.timeEntry.findMany.mockResolvedValue([])
    await expect(cerrarOlvidadasAntesDeChecar('staff-1', 'ENTRADA', mx('2026-11-04T09:00:00'))).resolves.toEqual([])
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('el texto para quien quiso marcar salida dice de qué día era la entrada', () => {
    const t = textoSalidaYaOlvidada(
      {
        timeEntryId: 'te-1',
        staffId: 's',
        venueId: 'v',
        clockInTime: mx('2026-11-09T09:00:00'),
        clockOutTime: mx('2026-11-09T09:00:00'),
        totalHours: 0,
        motivo: 'SIN_HORARIO',
        disparador: 'SALIDA',
      },
      MX,
    )
    expect(t).toContain('9-nov')
    expect(t).toContain('salida olvidada')
  })
})

describe('corregirSalidaOlvidada (el gerente, en Asistencia)', () => {
  const olvidada = (extra: Record<string, unknown> = {}) => ({
    id: 'te-1',
    staffId: 'staff-1',
    clockInTime: mx('2026-11-03T09:00:00'),
    clockOutTime: mx('2026-11-03T09:00:00'),
    totalHours: 0,
    salidaOlvidada: true,
    notes: null,
    breaks: [],
    llaveSalida: null,
    venue: { timezone: MX, settings: null },
    ...extra,
  })
  const ahora = mx('2026-11-05T10:00:00')

  beforeEach(() => {
    prismaMock.timeEntry.findFirst.mockReset()
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  })

  it('toma el candado de la persona (el mismo de la checada del celular) y no pisa una nota que llegó después de leer', async () => {
    prismaMock.timeEntry.findFirst
      .mockResolvedValueOnce({ staffId: 'staff-1' } as any)
      .mockResolvedValueOnce(olvidada({ notes: 'nota', llaveSalida: null }) as any)
      .mockResolvedValueOnce(null)
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 0 })

    await expect(
      corregirSalidaOlvidada({
        venueId: 'venue-1',
        timeEntryId: 'te-1',
        clockOutTime: mx('2026-11-03T18:00:00'),
        actorStaffId: 'gerente',
        ahora,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CHECADA_EN_PROCESO' })
    const sql = (prismaMock.$queryRaw as jest.Mock).mock.calls[0]
    expect(sql[1]).toBe('checada:staff-1')
    expect(prismaMock.timeEntry.updateMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ notes: 'nota', llaveSalida: null, salidaOlvidada: true }),
    )
  })

  it('un descanso que el sistema terminó en su propio inicio (cierre en 0 h) termina en la salida corregida y se descuenta', async () => {
    const b = { id: 'b1', startTime: mx('2026-11-03T17:00:00'), endTime: mx('2026-11-03T17:00:00') }
    prismaMock.timeEntry.findFirst
      .mockResolvedValueOnce({ staffId: 'staff-1' } as any)
      .mockResolvedValueOnce(olvidada({ breaks: [b] }) as any)
      .mockResolvedValueOnce(null)
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 1 })

    const r = await corregirSalidaOlvidada({
      venueId: 'venue-1',
      timeEntryId: 'te-1',
      clockOutTime: mx('2026-11-03T18:00:00'),
      actorStaffId: 'gerente',
      ahora,
    })

    expect(r.totalHours).toBe(8) // 9 h − 1 h de descanso
    expect(prismaMock.timeEntryBreak.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { endTime: mx('2026-11-03T18:00:00') } })
  })

  // Revisión de apps viejas antes de publicar (Codex, 26-nov, «grave»): con corte propio a las 22:00, quien de verdad trabajó
  // hasta las 22:40 no podía recuperar esas horas: la corrección no dejaba pasar del corte. El gerente puede poner la salida
  // real hasta el límite de fábrica («un turno no dura días»); el cierre y la salida tardía del celular siguen con el corte.
  it('con corte propio (22:00), el gerente sí puede poner la salida real de las 22:40', async () => {
    prismaMock.timeEntry.findFirst
      .mockResolvedValueOnce({ staffId: 'staff-1' } as any)
      .mockResolvedValueOnce(
        olvidada({
          clockInTime: mx('2026-11-03T14:00:00'),
          clockOutTime: mx('2026-11-03T14:00:00'),
          limiteOlvidada: mx('2026-11-03T22:00:00'),
        }) as any,
      )
      .mockResolvedValueOnce(null)
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 1 })

    const r = await corregirSalidaOlvidada({
      venueId: 'venue-1',
      timeEntryId: 'te-1',
      clockOutTime: mx('2026-11-03T22:40:00'),
      actorStaffId: 'gerente',
      ahora,
    })

    expect(r.totalHours).toBe(8.67)
  })

  it('con corte propio, la corrección sigue sin pasar del límite de fábrica (un turno no dura días)', async () => {
    prismaMock.timeEntry.findFirst.mockResolvedValueOnce({ staffId: 'staff-1' } as any).mockResolvedValueOnce(
      olvidada({
        clockInTime: mx('2026-11-03T14:00:00'),
        clockOutTime: mx('2026-11-03T14:00:00'),
        limiteOlvidada: mx('2026-11-03T22:00:00'),
      }) as any,
    )

    await expect(
      corregirSalidaOlvidada({
        venueId: 'venue-1',
        timeEntryId: 'te-1',
        clockOutTime: mx('2026-11-04T05:00:00'),
        actorStaffId: 'gerente',
        ahora,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'SALIDA_DESPUES_DEL_DIA' })
  })

  // Codex 26-nov sobre #659 (#2): el tope de fábrica sale de lo que había AL CERRAR (su salida de horario), no del horario de
  // hoy: un turno publicado después para esa fecha no alarga una checada vieja.
  it('un horario puesto después del cierre no alarga el tope de la corrección', async () => {
    prismaMock.timeEntry.findFirst.mockResolvedValueOnce({ staffId: 'staff-1' } as any).mockResolvedValueOnce(
      olvidada({
        clockInTime: mx('2026-11-03T14:00:00'),
        clockOutTime: mx('2026-11-03T14:00:00'),
        limiteOlvidada: mx('2026-11-04T04:00:00'),
      }) as any,
    )
    prismaMock.staffVenue.findFirst.mockResolvedValue({
      workSchedule: { weekly: { tuesday: { enabled: true, ranges: [{ open: '14:00', close: '10:00' }] } } },
      workScheduleExceptions: [],
    } as any)

    await expect(
      corregirSalidaOlvidada({
        venueId: 'venue-1',
        timeEntryId: 'te-1',
        clockOutTime: mx('2026-11-04T10:30:00'),
        actorStaffId: 'gerente',
        ahora,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'SALIDA_DESPUES_DEL_DIA' })
  })

  // Codex 26-nov sobre #659 (#3): con corte a las 06:00 y horario hasta las 06:00, el cierre congela las 06:00; el tope de
  // fábrica con ESE horario es las 07:00, aunque después le quiten el horario.
  it('quitar el horario después del cierre no baja el tope de fábrica de la corrección', async () => {
    prismaMock.timeEntry.findFirst
      .mockResolvedValueOnce({ staffId: 'staff-1' } as any)
      .mockResolvedValueOnce(
        olvidada({
          clockInTime: mx('2026-11-03T14:00:00'),
          clockOutTime: mx('2026-11-04T06:00:00'),
          limiteOlvidada: mx('2026-11-04T06:00:00'),
        }) as any,
      )
      .mockResolvedValueOnce(null)
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 1 })

    const r = await corregirSalidaOlvidada({
      venueId: 'venue-1',
      timeEntryId: 'te-1',
      clockOutTime: mx('2026-11-04T06:40:00'),
      actorStaffId: 'gerente',
      ahora,
    })

    expect(r.totalHours).toBe(16.67)
  })

  // Codex 26-nov sobre #659 (#1): la entrada de la TPV y del POS toma otro candado; la corrección también lo toma antes de
  // buscar la siguiente entrada, para no encimarse con una que se está guardando en ese instante.
  it('toma el candado de la entrada de la TPV y del POS (de la persona, en cualquier sucursal) antes de buscar la siguiente', async () => {
    prismaMock.timeEntry.findFirst
      .mockResolvedValueOnce({ staffId: 'staff-1' } as any)
      .mockResolvedValueOnce(olvidada() as any)
      .mockResolvedValueOnce(null)
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 1 })

    await corregirSalidaOlvidada({
      venueId: 'venue-1',
      timeEntryId: 'te-1',
      clockOutTime: mx('2026-11-03T18:00:00'),
      actorStaffId: 'gerente',
      ahora,
    })

    const calls = (prismaMock.$queryRaw as jest.Mock).mock.calls
    const i = calls.findIndex((c: unknown[]) => String(c[1]) === 'time-entry-clock-in:staff-1')
    expect(i).toBeGreaterThanOrEqual(0)
    const orden = (prismaMock.$queryRaw as jest.Mock).mock.invocationCallOrder[i]
    expect(orden).toBeLessThan(prismaMock.timeEntry.findFirst.mock.invocationCallOrder[2])
  })

  it('pone la salida real, recalcula horas, quita la marca y lo anota con el antes y el después', async () => {
    prismaMock.timeEntry.findFirst
      .mockResolvedValueOnce({ staffId: 'staff-1' } as any)
      .mockResolvedValueOnce(olvidada() as any)
      .mockResolvedValueOnce(null)
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 1 })

    const r = await corregirSalidaOlvidada({
      venueId: 'venue-1',
      timeEntryId: 'te-1',
      clockOutTime: mx('2026-11-03T18:00:00'),
      actorStaffId: 'gerente',
      ahora,
    })

    expect(r).toEqual({ timeEntryId: 'te-1', clockOutTime: mx('2026-11-03T18:00:00').toISOString(), totalHours: 9 })
    expect(prismaMock.timeEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'te-1', salidaOlvidada: true, clockOutTime: mx('2026-11-03T09:00:00'), notes: null, llaveSalida: null },
      data: expect.objectContaining({ salidaOlvidada: false, autoClockOut: false, totalHours: 9, editedBy: 'gerente' }),
    })
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'TIME_ENTRY_FORGOTTEN_CLOCKOUT_CORRECTED', staffId: 'gerente', venueId: 'venue-1' }),
    )
  })

  it('nadie corrige su propia checada', async () => {
    prismaMock.timeEntry.findFirst.mockResolvedValueOnce({ staffId: 'staff-1' } as any).mockResolvedValueOnce(olvidada() as any)
    await expect(
      corregirSalidaOlvidada({
        venueId: 'venue-1',
        timeEntryId: 'te-1',
        clockOutTime: mx('2026-11-03T18:00:00'),
        actorStaffId: 'staff-1',
        ahora,
      }),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('una checada que no está como «salida olvidada» no se toca (409)', async () => {
    prismaMock.timeEntry.findFirst
      .mockResolvedValueOnce({ staffId: 'staff-1' } as any)
      .mockResolvedValueOnce(olvidada({ salidaOlvidada: false }) as any)
    await expect(
      corregirSalidaOlvidada({
        venueId: 'venue-1',
        timeEntryId: 'te-1',
        clockOutTime: mx('2026-11-03T18:00:00'),
        actorStaffId: 'gerente',
        ahora,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'NO_ES_SALIDA_OLVIDADA' })
  })

  it.each([
    ['antes de la entrada', mx('2026-11-03T08:00:00'), 'SALIDA_ANTES_DE_ENTRADA'],
    ['en el futuro', mx('2026-11-06T08:00:00'), 'SALIDA_EN_EL_FUTURO'],
    ['después del día del turno (días de largo)', mx('2026-11-04T09:00:00'), 'SALIDA_DESPUES_DEL_DIA'],
  ])('rechaza una salida %s', async (_n, salida, code) => {
    prismaMock.timeEntry.findFirst.mockResolvedValueOnce({ staffId: 'staff-1' } as any).mockResolvedValueOnce(olvidada() as any)
    await expect(
      corregirSalidaOlvidada({ venueId: 'venue-1', timeEntryId: 'te-1', clockOutTime: salida, actorStaffId: 'gerente', ahora }),
    ).rejects.toMatchObject({ statusCode: 400, code })
  })

  it('rechaza una salida que se encima con su siguiente entrada', async () => {
    prismaMock.timeEntry.findFirst
      .mockResolvedValueOnce({ staffId: 'staff-1' } as any)
      .mockResolvedValueOnce(olvidada() as any)
      .mockResolvedValueOnce({ id: 'te-2' } as any)
    await expect(
      corregirSalidaOlvidada({
        venueId: 'venue-1',
        timeEntryId: 'te-1',
        clockOutTime: mx('2026-11-03T23:00:00'),
        actorStaffId: 'gerente',
        ahora,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'SALIDA_SE_ENCIMA' })
  })
})
