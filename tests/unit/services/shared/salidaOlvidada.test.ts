/**
 * «Salida olvidada» (hz:f0a89d19:D3): cuándo se da por olvidado un turno, con qué horas se cierra, el job y la corrección del
 * gerente. La checada del celular tiene sus casos en `checadaDeCampo.service.test.ts`.
 */
const mockLogAction = jest.fn()
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: (...a: unknown[]) => mockLogAction(...(a as [])) }))

import { prismaMock } from '@tests/__helpers__/setup'
import {
  anotarSalidaQueNoSeUso,
  cerrarOlvidadasAntesDeChecar,
  cerrarSalidasOlvidadasPendientes,
  corregirSalidaOlvidada,
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
  venue: { timezone: MX, settings: null as null | { salidaOlvidadaEnabled: boolean; rotatingShiftsEnabled: boolean } },
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

  it('la lectura tiene tope, deja fuera a los negocios que la apagaron y sólo pide las de más de 12 h', async () => {
    prismaMock.timeEntry.findMany.mockResolvedValue([])
    const ahora = mx('2026-11-04T04:10:00')

    await cerrarSalidasOlvidadasPendientes(ahora)

    const args = prismaMock.timeEntry.findMany.mock.calls[0][0] as any
    expect(args.take).toBe(500)
    expect(args.where.venue).toEqual({ OR: [{ settings: null }, { settings: { salidaOlvidadaEnabled: true } }] })
    expect(args.where.clockInTime.lt).toEqual(new Date(ahora.getTime() - 12 * 3_600_000))
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
  })

  it('Codex r2 #5: si otro escritor la cambió (0 filas), NO dice que quedaron anotadas', async () => {
    prismaMock.timeEntry.findFirst.mockResolvedValue(marcada as any)
    prismaMock.timeEntry.updateMany.mockResolvedValue({ count: 0 })

    const t = await anotarSalidaQueNoSeUso({ staffId: 's', venueId: 'v', origen: 'PAX', depositPhotoUrl: 'https://x/voucher.jpg' })

    expect(t).not.toContain('quedaron anotadas')
    expect(t).toContain('no se pudo anotar')
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
