/**
 * Auto-cierre de sesiones de caja por DÍA DE NEGOCIO.
 *
 * Toca dinero, así que el test manda: lo que se prueba aquí no es "que cierre",
 * sino las cuatro cosas que NO puede hacer nunca —inventar un conteo, tocar los
 * movimientos, pisar una caja que sigue en uso, o duplicar trabajo al correr dos
 * veces—. Cada una tiene su caso.
 */

import { CashDrawerAutoCloseJob } from '@/jobs/cash-drawer-auto-close.job'
import { AUTO_CLOSED_BY_NAME, AUTO_CLOSE_NOTE_PREFIX, businessDayStart, isAutoClosedSession } from '@/services/shared/cashDrawerAutoClose'
import { shouldRetryDbConnectionError } from '@/utils/retry'

// 12:00 del 16-ago en CDMX (UTC-6). El corte del día de negocio de HOY ya pasó
// (04:00 locales = 10:00Z), así que todo lo abierto antes de las 10:00Z pertenece
// a un día de negocio que ya terminó.
const NOW = new Date('2026-08-16T18:00:00.000Z')
const BOUNDARY_CDMX = new Date('2026-08-16T10:00:00.000Z')

const CDMX = 'America/Mexico_City'

type SessionRow = {
  id: string
  venueId: string
  openedAt: Date
  openedByName: string
  deviceName: string | null
  venue: { name: string; timezone: string }
  events: { createdAt: Date }[]
}

function session(over: Partial<SessionRow> & Pick<SessionRow, 'id'>): SessionRow {
  return {
    venueId: 'venue-1',
    openedAt: new Date('2026-04-28T15:00:00.000Z'),
    openedByName: 'Ana',
    deviceName: 'Caja mostrador',
    venue: { name: 'Testarudo Cafe', timezone: CDMX },
    events: [],
    ...over,
  }
}

async function retryConnectionFailureOnce<T>(
  operation: () => Promise<T>,
  options: { shouldRetry?: (error: unknown) => boolean },
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!options.shouldRetry?.(error)) throw error
    return operation()
  }
}

function harness(rows: SessionRow[], counts: number[] = []) {
  const prisma = {
    cashDrawerSession: {
      findMany: jest.fn().mockResolvedValue(rows),
      updateMany: jest.fn().mockImplementation(async () => ({ count: counts.length ? (counts.shift() ?? 0) : 1 })),
    },
    cashDrawerEvent: {
      create: jest.fn(),
      createMany: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  }
  const job = new CashDrawerAutoCloseJob({
    prisma: prisma as never,
    cron: { start: jest.fn(), stop: jest.fn() } as never,
    now: () => NOW,
  })
  return { job, prisma }
}

/** Los `data` con los que se cerró la sesión `id`. */
function closeDataFor(prisma: ReturnType<typeof harness>['prisma'], id: string): Record<string, unknown> {
  const call = prisma.cashDrawerSession.updateMany.mock.calls.find(([arg]: [any]) => arg?.where?.id === id)
  if (!call) throw new Error(`no se intentó cerrar ${id}`)
  return call[0].data
}

describe('businessDayStart — el corte de las 04:00 del día de negocio', () => {
  it('a mediodía, el corte es el de HOY a las 04:00 locales', () => {
    expect(businessDayStart(NOW, CDMX, 4)).toEqual(BOUNDARY_CDMX)
  })

  it('a las 03:30 de la madrugada todavía se está en el día de negocio de AYER', () => {
    // 2026-08-16T09:30Z = 03:30 en CDMX → el corte vigente es el del 15 a las 04:00.
    expect(businessDayStart(new Date('2026-08-16T09:30:00.000Z'), CDMX, 4)).toEqual(new Date('2026-08-15T10:00:00.000Z'))
  })

  it('respeta el huso del venue: Tijuana corta una hora después que CDMX', () => {
    // Mismo instante: 03:30 en Tijuana (UTC-7) y 04:30 en CDMX (UTC-6).
    const instant = new Date('2026-08-16T10:30:00.000Z')
    expect(businessDayStart(instant, 'America/Tijuana', 4)).toEqual(new Date('2026-08-15T11:00:00.000Z'))
    expect(businessDayStart(instant, CDMX, 4)).toEqual(new Date('2026-08-16T10:00:00.000Z'))
  })
})

describe('cash-drawer-auto-close.job', () => {
  it('cierra la sesión zombi cuyo día de negocio ya terminó', async () => {
    const h = harness([session({ id: 'sess-zombi' })])

    await expect(h.job.runNow()).resolves.toMatchObject({ scanned: 1, closed: 1, skipped: 0, errors: 0 })

    expect(h.prisma.cashDrawerSession.updateMany).toHaveBeenCalledTimes(1)
    const [arg] = h.prisma.cashDrawerSession.updateMany.mock.calls[0]
    expect(arg.where).toEqual({ id: 'sess-zombi', status: 'OPEN' })
    expect(arg.data).toMatchObject({ status: 'CLOSED', closedAt: NOW, closedByStaffId: null, closedByName: AUTO_CLOSED_BY_NAME })
  })

  it('🔴 NO inventa un conteo físico: nunca escribe actualAmount ni overShort', async () => {
    const h = harness([session({ id: 'sess-zombi' })])

    await h.job.runNow()

    const data = closeDataFor(h.prisma, 'sess-zombi')
    expect(Object.keys(data)).not.toContain('actualAmount')
    expect(Object.keys(data)).not.toContain('overShort')
  })

  it('🔴 deja la marca legible: la nota dice que nadie la cerró y que no hay conteo', async () => {
    const h = harness([session({ id: 'sess-zombi' })])

    await h.job.runNow()

    const note = closeDataFor(h.prisma, 'sess-zombi').closingNote as string
    expect(note.startsWith(AUTO_CLOSE_NOTE_PREFIX)).toBe(true)
    expect(note).toContain('nadie la cerró')
    expect(note).toContain('SIN CONTEO FÍSICO')
    expect(note).toContain('2026-08-16 04:00') // el corte que la cerró, en hora del venue
  })

  it('🔴 la fila resultante se distingue de un arqueo hecho por una persona', () => {
    const auto = { status: 'CLOSED', actualAmount: null, closedByStaffId: null }
    const humano = { status: 'CLOSED', actualAmount: 1500, closedByStaffId: 'staff-1' }
    const abierta = { status: 'OPEN', actualAmount: null, closedByStaffId: null }

    expect(isAutoClosedSession(auto)).toBe(true)
    expect(isAutoClosedSession(humano)).toBe(false)
    expect(isAutoClosedSession(abierta)).toBe(false)
  })

  it('🔴 NO toca los movimientos existentes', async () => {
    const h = harness([session({ id: 'sess-zombi', events: [{ createdAt: new Date('2026-04-28T16:00:00.000Z') }] })])

    await h.job.runNow()

    expect(h.prisma.cashDrawerEvent.create).not.toHaveBeenCalled()
    expect(h.prisma.cashDrawerEvent.createMany).not.toHaveBeenCalled()
    expect(h.prisma.cashDrawerEvent.updateMany).not.toHaveBeenCalled()
    expect(h.prisma.cashDrawerEvent.deleteMany).not.toHaveBeenCalled()
  })

  it('NO toca la caja del día en curso', async () => {
    // Abierta a las 09:00 locales de HOY — después del corte de las 04:00.
    const h = harness([session({ id: 'sess-hoy', openedAt: new Date('2026-08-16T15:00:00.000Z') })])

    await expect(h.job.runNow()).resolves.toMatchObject({ scanned: 1, closed: 0, skipped: 1, errors: 0 })
    expect(h.prisma.cashDrawerSession.updateMany).not.toHaveBeenCalled()
  })

  it('NO le arranca la caja a quien sigue vendiendo, aunque haya cruzado el corte', async () => {
    const h = harness([
      session({
        id: 'sess-activa',
        openedAt: new Date('2026-08-15T20:00:00.000Z'),
        events: [{ createdAt: new Date('2026-08-16T17:30:00.000Z') }], // hace 30 min
      }),
    ])

    await expect(h.job.runNow()).resolves.toMatchObject({ scanned: 1, closed: 0, skipped: 1, errors: 0 })
    expect(h.prisma.cashDrawerSession.updateMany).not.toHaveBeenCalled()
  })

  it('sí cierra la que cruzó el corte y lleva horas sin un solo movimiento', async () => {
    const h = harness([
      session({
        id: 'sess-vieja',
        openedAt: new Date('2026-08-15T20:00:00.000Z'),
        events: [{ createdAt: new Date('2026-08-16T14:00:00.000Z') }], // hace 4 h
      }),
    ])

    await expect(h.job.runNow()).resolves.toMatchObject({ scanned: 1, closed: 1, skipped: 0, errors: 0 })
  })

  it('respeta el huso horario de cada venue', async () => {
    // 03:30 en Tijuana: su día de negocio SIGUE corriendo, así que no se toca.
    const job = new CashDrawerAutoCloseJob({
      prisma: {
        cashDrawerSession: {
          findMany: jest.fn().mockResolvedValue([
            session({
              id: 'sess-tj',
              openedAt: new Date('2026-08-15T20:00:00.000Z'),
              venue: { name: 'BAE Tijuana', timezone: 'America/Tijuana' },
            }),
          ]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        cashDrawerEvent: {},
      } as never,
      cron: { start: jest.fn(), stop: jest.fn() } as never,
      now: () => new Date('2026-08-16T10:30:00.000Z'),
    })

    await expect(job.runNow()).resolves.toMatchObject({ scanned: 1, closed: 0, skipped: 1 })
  })

  it('🔴 es idempotente: la segunda corrida no vuelve a cerrar nada', async () => {
    // El CAS `status: 'OPEN'` es el candado: la segunda vez ya está CLOSED y
    // Postgres reporta 0 filas afectadas.
    const h = harness([session({ id: 'sess-zombi' })], [1, 0])

    await expect(h.job.runNow()).resolves.toMatchObject({ closed: 1, skipped: 0 })
    await expect(h.job.runNow()).resolves.toMatchObject({ closed: 0, skipped: 1 })
    expect(h.prisma.cashDrawerSession.updateMany).toHaveBeenCalledTimes(2)
  })

  it('sigue con las demás cuando una falla', async () => {
    const h = harness([session({ id: 'sess-a' }), session({ id: 'sess-b', venueId: 'venue-2' })])
    h.prisma.cashDrawerSession.updateMany.mockRejectedValueOnce(new Error('db write failed'))

    await expect(h.job.runNow()).resolves.toMatchObject({ scanned: 2, closed: 1, errors: 1 })
  })

  it('reintenta SÓLO la lectura de entrada ante una caída transitoria de conexión', async () => {
    const findMany = jest.fn().mockRejectedValueOnce({ code: 'P1001' }).mockResolvedValueOnce([])
    const updateMany = jest.fn()
    const job = new CashDrawerAutoCloseJob({
      prisma: { cashDrawerSession: { findMany, updateMany }, cashDrawerEvent: {} } as never,
      cron: { start: jest.fn(), stop: jest.fn() } as never,
      now: () => NOW,
      retryEntry: retryConnectionFailureOnce as never,
    })

    await expect(job.runNow()).resolves.toMatchObject({ scanned: 0, closed: 0, errors: 0 })
    expect(findMany).toHaveBeenCalledTimes(2)
    expect(updateMany).not.toHaveBeenCalled()
    expect(shouldRetryDbConnectionError({ code: 'P1001' })).toBe(true)
  })

  it('no corre dos pasadas encimadas', async () => {
    let release!: () => void
    const findMany = jest.fn(
      () =>
        new Promise(resolve => {
          release = () => resolve([])
        }),
    )
    const job = new CashDrawerAutoCloseJob({
      prisma: { cashDrawerSession: { findMany, updateMany: jest.fn() }, cashDrawerEvent: {} } as never,
      cron: { start: jest.fn(), stop: jest.fn() } as never,
      now: () => NOW,
    })

    const first = job.runNow()
    await expect(job.runNow()).resolves.toMatchObject({ scanned: 0, closed: 0, skipped: 1 })
    release()
    await first
    expect(findMany).toHaveBeenCalledTimes(1)
  })

  it('en dry-run reporta lo que cerraría, pero no escribe', async () => {
    const h = harness([session({ id: 'sess-zombi' })])

    await expect(h.job.runNow({ dryRun: true })).resolves.toMatchObject({ scanned: 1, closed: 1, errors: 0 })
    expect(h.prisma.cashDrawerSession.updateMany).not.toHaveBeenCalled()
  })

  it('sólo mira sesiones ABIERTAS', async () => {
    const h = harness([])

    await h.job.runNow()

    const [arg] = h.prisma.cashDrawerSession.findMany.mock.calls[0]
    expect(arg.where).toMatchObject({ status: 'OPEN' })
  })
})
