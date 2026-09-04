/**
 * DINERO — Task 5p: una ventana temporal puede identificar una gaveta, pero nunca
 * desempatar dos libros de caja plausibles. La liga durable por shiftId siempre manda.
 */

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { esperadoDeLaGavetaDelTurno, resolveShiftCashDrawer } from '@/services/dashboard/shift.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-selector'
const SHIFT = 'shift-selector'
const START = new Date('2026-09-03T14:00:00.000Z')
const END = new Date('2026-09-04T02:00:00.000Z')

function drawer(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    venueId: VENUE,
    shiftId: null,
    status: 'CLOSED',
    deviceName: `Caja ${id}`,
    openedByName: 'Ana',
    closedByName: 'Ana',
    openedAt: START,
    closedAt: END,
    startingAmount: '500.00',
    actualAmount: '1300.00',
    overShort: '0.00',
    events: [{ type: 'CASH_SALE', amount: '800.00', createdAt: END }],
    ...overrides,
  }
}

function isAnchorWindow(where: any): boolean {
  return where?.OR?.some((branch: any) => branch?.closedAt?.gte?.getTime?.() === END.getTime()) ?? false
}

function world(
  options: {
    exact?: any | null
    exactReads?: Array<any | null>
    anchor?: any[]
    fallback?: any[]
    hydrationMissing?: boolean
  } = {},
) {
  const exact = options.exact ?? null
  const exactReads = options.exactReads ?? [exact]
  let exactReadIndex = 0
  const anchor = options.anchor ?? []
  const fallback = options.fallback ?? []
  const all = [...exactReads, ...anchor, ...fallback].filter(Boolean)

  const findFirst = jest.fn(async (args: any) => {
    const where = args?.where ?? {}
    if (where.shiftId === SHIFT) {
      const result = exactReads[Math.min(exactReadIndex, exactReads.length - 1)] ?? null
      exactReadIndex += 1
      return result
    }
    if (where.id) return options.hydrationMissing ? null : (all.find(candidate => candidate.id === where.id) ?? null)

    // Hace que la implementación anterior revele el defecto: su única consulta mezclaba
    // liga + legacy y elegía la primera por openedAt.
    const candidates = isAnchorWindow(where) ? anchor : fallback
    return candidates[0] ?? null
  })
  const findMany = jest.fn(async (args: any) => {
    const candidates = isAnchorWindow(args?.where) ? anchor : fallback
    return candidates.map(candidate => ({ id: candidate.id }))
  })

  ;(prismaMock as any).cashDrawerSession = { findFirst, findMany }
  return { findFirst, findMany }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('resolveShiftCashDrawer · selector inequívoco', () => {
  it('la liga exacta y tenant-scoped gana aunque haya una legacy más nueva y plausible', async () => {
    const exact = drawer('exacta', { shiftId: SHIFT, openedAt: new Date('2026-09-03T13:00:00.000Z') })
    const legacy = drawer('legacy-nueva', { openedAt: new Date('2026-09-03T20:00:00.000Z') })
    const { findFirst, findMany } = world({ exact, anchor: [legacy] })

    const result = await resolveShiftCashDrawer(VENUE, START, END, true, SHIFT)

    expect(result?.sessionId).toBe('exacta')
    expect(findFirst.mock.calls[0][0].where).toEqual({ venueId: VENUE, shiftId: SHIFT })
    expect(findMany).not.toHaveBeenCalled()
  })

  it('si la liga exacta aparece mientras los scans legacy dan cero, se revalida y nunca cae a TURNO', async () => {
    const linked = drawer('ligada-durante-scans', { shiftId: SHIFT })
    const { findFirst, findMany } = world({ exactReads: [null, linked] })

    const result = await esperadoDeLaGavetaDelTurno(VENUE, { id: SHIFT, startTime: START, endTime: END }, true)

    expect(result).toEqual({ esperado: 1300, sessionId: 'ligada-durante-scans', fuente: 'CAJON' })
    expect(findMany).toHaveBeenCalledTimes(2)
    const exactQueries = findFirst.mock.calls.filter(([args]: any[]) => args?.where?.shiftId === SHIFT)
    expect(exactQueries).toHaveLength(2)
    for (const [args] of exactQueries) expect(args.where).toEqual({ venueId: VENUE, shiftId: SHIFT })
  })

  it('una liga exacta aparecida durante los scans gana sobre la única legacy identificada', async () => {
    const linked = drawer('exacta-concurrente', { shiftId: SHIFT, startingAmount: '700.00' })
    const legacy = drawer('legacy-identificada')
    const { findFirst, findMany } = world({ exactReads: [null, linked], anchor: [legacy] })

    const result = await resolveShiftCashDrawer(VENUE, START, END, true, SHIFT)

    expect(result?.sessionId).toBe('exacta-concurrente')
    expect(result?.expectedAmount).toBe(1500)
    expect(findMany).toHaveBeenCalledTimes(1)
    expect(findFirst.mock.calls.some(([args]: any[]) => args?.where?.id === 'legacy-identificada')).toBe(false)
  })

  it('una única legacy que cubre el ancla se selecciona con take:2 y sólo ella carga eventos', async () => {
    const winner = drawer('ancla-unica')
    const { findFirst, findMany } = world({ anchor: [winner] })

    const result = await resolveShiftCashDrawer(VENUE, START, END, true, SHIFT)

    expect(result?.sessionId).toBe('ancla-unica')
    expect(findMany).toHaveBeenCalledTimes(1)
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ venueId: VENUE, shiftId: null }),
        select: { id: true },
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        take: 2,
      }),
    )
    expect(findMany.mock.calls[0][0]).not.toHaveProperty('include')
    const hydration = findFirst.mock.calls.find(([args]: any[]) => args?.where?.id === 'ancla-unica')?.[0]
    expect(hydration).toEqual(
      expect.objectContaining({
        where: { id: 'ancla-unica', venueId: VENUE, shiftId: null },
        include: { events: { orderBy: { createdAt: 'asc' } } },
      }),
    )
  })

  it('dos legacy que cubren el ancla producen DESCONOCIDO y ninguna se hidrata', async () => {
    const { findFirst } = world({ anchor: [drawer('ancla-a'), drawer('ancla-b')] })

    const result = await esperadoDeLaGavetaDelTurno(VENUE, { id: SHIFT, startTime: START, endTime: END }, true)

    expect(result).toEqual({ esperado: null, sessionId: null, fuente: 'DESCONOCIDO' })
    expect(findFirst.mock.calls.some(([args]: any[]) => args?.where?.id)).toBe(false)
  })

  it('una identidad seleccionada que cambia de liga antes de hidratar no se confunde con ausencia/TURNO', async () => {
    const { findFirst } = world({ anchor: [drawer('candidata-movida')], hydrationMissing: true })

    const result = await esperadoDeLaGavetaDelTurno(VENUE, { id: SHIFT, startTime: START, endTime: END }, true)

    expect(result).toEqual({ esperado: null, sessionId: null, fuente: 'DESCONOCIDO' })
    const hydration = findFirst.mock.calls.find(([args]: any[]) => args?.where?.id === 'candidata-movida')?.[0]
    expect(hydration?.where).toEqual({ id: 'candidata-movida', venueId: VENUE, shiftId: null })
  })

  it('si ninguna cubre el ancla, una única legacy del fallback se selecciona', async () => {
    const winner = drawer('fallback-unica', { closedAt: new Date('2026-09-03T23:00:00.000Z') })
    const { findMany } = world({ fallback: [winner] })

    const result = await resolveShiftCashDrawer(VENUE, START, END, true, SHIFT)

    expect(result?.sessionId).toBe('fallback-unica')
    expect(findMany).toHaveBeenCalledTimes(2)
    expect(findMany.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          venueId: VENUE,
          shiftId: null,
          OR: [{ closedAt: null }, { closedAt: { gte: START } }],
        }),
        take: 2,
      }),
    )
  })

  it('dos legacy sólo plausibles en el fallback producen DESCONOCIDO', async () => {
    world({ fallback: [drawer('fallback-a'), drawer('fallback-b')] })

    await expect(esperadoDeLaGavetaDelTurno(VENUE, { id: SHIFT, startTime: START, endTime: END }, true)).resolves.toEqual({
      esperado: null,
      sessionId: null,
      fuente: 'DESCONOCIDO',
    })
  })

  it('cero candidatas conserva ausencia/TURNO, no DESCONOCIDO', async () => {
    const { findMany } = world()

    const result = await esperadoDeLaGavetaDelTurno(VENUE, { id: SHIFT, startTime: START, endTime: END }, true)

    expect(result).toEqual({ esperado: null, sessionId: null, fuente: 'TURNO' })
    expect(findMany).toHaveBeenCalledTimes(2)
    for (const [args] of findMany.mock.calls) {
      expect(args.where).toEqual(expect.objectContaining({ venueId: VENUE, shiftId: null }))
      expect(args.take).toBe(2)
    }
  })
})
