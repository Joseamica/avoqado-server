/**
 * Fase 5 de la unificación de caja: el TURNO (Shift) deja de ser una segunda verdad del efectivo.
 *
 * `Shift` calculaba su propio "efectivo esperado" a partir de sus pagos, y el cajón (Android +
 * TPV) calculaba el suyo: dos números para el mismo dinero. Ahora el detalle del turno EXPONE el
 * arqueo del cajón que lo cubrió, en un campo NUEVO y OPCIONAL (`cashDrawer`), y nada de lo que
 * ya devolvía cambia. Una PAX vieja lo ignora; la nueva lo usa en vez de calcular aparte.
 *
 * Reglas:
 *   · manda la liga exacta; para legacy se elige una sesión inequívoca del MISMO venue anclada
 *     al cierre del turno; si no hay, `cashDrawer: null` (y el turno se ve igual que hoy);
 *   · `counted` es explícito: una caja cerrada sin conteo no se pinta como cuadrada;
 *   · `cashDeclared` / `cashDifference` del Shift NO se tocan: contrato intacto.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { getShiftById } from '@/services/dashboard/shift.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'v1'
const turno = () => ({
  id: 'shift-1',
  venueId: VENUE,
  staffId: 'staff-1',
  status: 'CLOSED',
  startTime: new Date('2026-08-20T14:30:00Z'),
  endTime: new Date('2026-08-20T22:00:00Z'),
  startingCash: 1000,
  endingCash: null,
  cashDeclared: 1000,
  cashDifference: null,
  cardDeclared: null,
  vouchersDeclared: null,
  otherDeclared: null,
  totalSales: 500,
  totalTips: 0,
  totalCashTips: 0,
  totalOrders: 1,
  totalCashPayments: 300,
  totalCardPayments: 200,
  totalVoucherPayments: 0,
  totalOtherPayments: 0,
  totalProductsSold: 0,
  notes: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  staff: { id: 'staff-1', firstName: 'Ana', lastName: 'M', email: 'a@a.com' },
  venue: { id: VENUE, name: 'V', timezone: 'America/Mexico_City' },
  payments: [],
  orders: [],
})
const caja = (over: Record<string, unknown> = {}) => ({
  id: 'cds-1',
  venueId: VENUE,
  status: 'CLOSED',
  deviceName: 'Caja 1',
  openedByName: 'Ana',
  closedByName: 'Ana',
  openedAt: new Date('2026-08-20T14:00:00Z'),
  closedAt: new Date('2026-08-20T22:30:00Z'),
  startingAmount: 1000,
  actualAmount: 1290,
  overShort: -10,
  closingNote: null,
  events: [
    { type: 'OPEN', amount: 1000 },
    { type: 'CASH_SALE', amount: 300 },
    { type: 'PAY_OUT', amount: 0 },
  ],
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  ;(prismaMock as any).shift = { findFirst: jest.fn().mockResolvedValue(turno()) }
})

describe('getShiftById · cashDrawer (fase 5)', () => {
  it('🔴 expone el arqueo del cajón que cubrió el turno, con esperado / contado / diferencia y counted', async () => {
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(caja()),
    }
    const r = await getShiftById(VENUE, 'shift-1')
    expect(r.cashDrawer).toMatchObject({
      sessionId: 'cds-1',
      expectedAmount: 1300,
      actualAmount: 1290,
      overShort: -10,
      counted: true,
      status: 'CLOSED',
    })
    // contrato viejo intacto
    expect(r.cashDeclared).toBe(1000)
    expect(r.cashDifference).toBeNull()
  })

  it('🔴 P1 Codex: busca la sesión del MISMO venue cuya ventana cubre el CIERRE del turno (el cajón vigente al cerrar), no su inicio', async () => {
    const findFirst = jest.fn().mockResolvedValue(null)
    const findMany = jest.fn().mockResolvedValue([])
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findFirst,
      findMany,
    }
    await getShiftById(VENUE, 'shift-1')
    const where = findMany.mock.calls[0][0].where
    expect(where.venueId).toBe(VENUE)
    expect(where.openedAt).toEqual({ lte: new Date('2026-08-20T22:00:00Z') })
  })

  it('🔴 turno 08–20 con cajón A (07–12) y cajón B (12–20): elige B, el que operó al cierre', async () => {
    const B = caja({ id: 'B', openedAt: new Date('2026-08-20T12:00:00Z'), closedAt: new Date('2026-08-20T22:30:00Z') })
    const findFirst = jest.fn().mockImplementation(async ({ where }: any) => {
      if (where.shiftId === 'shift-1') return null
      return where.id === 'B' ? B : null
    })
    const findMany = jest.fn().mockResolvedValue([{ id: 'B' }])
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findFirst,
      findMany,
    }
    const r = await getShiftById(VENUE, 'shift-1')
    expect(r.cashDrawer.sessionId).toBe('B')
  })

  it('si ninguna sesión cubre el cierre, cae a la última que se traslapó con el turno', async () => {
    const A = caja({ id: 'A', openedAt: new Date('2026-08-20T07:00:00Z'), closedAt: new Date('2026-08-20T12:00:00Z') })
    const findFirst = jest.fn().mockImplementation(async ({ where }: any) => (where.id === 'A' ? A : null))
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'A' }])
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findFirst,
      findMany,
    }
    const r = await getShiftById(VENUE, 'shift-1')
    expect(r.cashDrawer.sessionId).toBe('A')
    const fallback = findMany.mock.calls[1][0].where
    expect(fallback.OR).toEqual([{ closedAt: null }, { closedAt: { gte: new Date('2026-08-20T14:30:00Z') } }])
  })

  it('🔴 P2 Codex: si la consulta del cajón truena, el detalle del turno sigue respondiendo (cashDrawer null), nunca un 500 en el endpoint viejo', async () => {
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockRejectedValue(new Error('db down')),
    }
    const r = await getShiftById(VENUE, 'shift-1')
    expect(r.cashDrawer).toBeNull()
    expect(r.cashDeclared).toBe(1000)
  })

  it('dos candidatas legacy no exponen una caja arbitraria ni convierten el detalle en 500', async () => {
    const candidate = caja({ id: 'legacy-a', shiftId: null })
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([{ id: 'legacy-a' }, { id: 'legacy-b' }]),
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        if (where.shiftId === 'shift-1') return null
        if (where.id) return candidate
        return candidate
      }),
    }

    const r = await getShiftById(VENUE, 'shift-1')

    expect(r.cashDrawer).toBeNull()
    expect(r.cashDeclared).toBe(1000)
  })

  it('una candidata legacy que cambia de liga antes de hidratar se omite sin exponer otra caja ni responder 500', async () => {
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([{ id: 'legacy-movida' }]),
      findFirst: jest.fn().mockResolvedValue(null),
    }

    const r = await getShiftById(VENUE, 'shift-1')

    expect(r.cashDrawer).toBeNull()
    expect(r.cashDeclared).toBe(1000)
  })

  it('sin caja que lo cubra, cashDrawer es null y el turno se ve igual que siempre', async () => {
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    }
    const r = await getShiftById(VENUE, 'shift-1')
    expect(r.cashDrawer).toBeNull()
    expect(r.cashDeclared).toBe(1000)
  })

  it('🔴 una caja cerrada SIN conteo trae counted=false y overShort=null — nunca "cuadró"', async () => {
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(caja({ actualAmount: null, overShort: null })),
    }
    const r = await getShiftById(VENUE, 'shift-1')
    expect(r.cashDrawer).toMatchObject({ counted: false, actualAmount: null, overShort: null, expectedAmount: 1300 })
  })
})
