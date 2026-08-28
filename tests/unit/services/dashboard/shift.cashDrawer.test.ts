/**
 * Fase 5 de la unificación de caja: el TURNO (Shift) deja de ser una segunda verdad del efectivo.
 *
 * `Shift` calculaba su propio "efectivo esperado" a partir de sus pagos, y el cajón (Android +
 * TPV) calculaba el suyo: dos números para el mismo dinero. Ahora el detalle del turno EXPONE el
 * arqueo del cajón que lo cubrió, en un campo NUEVO y OPCIONAL (`cashDrawer`), y nada de lo que
 * ya devolvía cambia. Una PAX vieja lo ignora; la nueva lo usa en vez de calcular aparte.
 *
 * Reglas:
 *   · se elige la sesión del cajón cuya ventana [openedAt, closedAt] cubre el inicio del turno,
 *     del MISMO venue; si no hay, `cashDrawer: null` (y el turno se sigue viendo igual que hoy);
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
    ;(prismaMock as any).cashDrawerSession = { findFirst: jest.fn().mockResolvedValue(caja()) }
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
    ;(prismaMock as any).cashDrawerSession = { findFirst }
    await getShiftById(VENUE, 'shift-1')
    const where = findFirst.mock.calls[0][0].where
    expect(where.venueId).toBe(VENUE)
    expect(where.openedAt).toEqual({ lte: new Date('2026-08-20T22:00:00Z') })
  })

  it('🔴 turno 08–20 con cajón A (07–12) y cajón B (12–20): elige B, el que operó al cierre', async () => {
    const A = caja({ id: 'A', openedAt: new Date('2026-08-20T07:00:00Z'), closedAt: new Date('2026-08-20T12:00:00Z') })
    const B = caja({ id: 'B', openedAt: new Date('2026-08-20T12:00:00Z'), closedAt: new Date('2026-08-20T22:30:00Z') })
    const findFirst = jest.fn().mockImplementation(async ({ where }: any) => {
      const anchor = where.openedAt.lte as Date
      return [B, A].find(c => c.openedAt <= anchor && (!c.closedAt || c.closedAt >= anchor)) ?? null
    })
    ;(prismaMock as any).cashDrawerSession = { findFirst }
    const r = await getShiftById(VENUE, 'shift-1')
    expect(r.cashDrawer.sessionId).toBe('B')
  })

  it('si ninguna sesión cubre el cierre, cae a la última que se traslapó con el turno', async () => {
    const A = caja({ id: 'A', openedAt: new Date('2026-08-20T07:00:00Z'), closedAt: new Date('2026-08-20T12:00:00Z') })
    const findFirst = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(A)
    ;(prismaMock as any).cashDrawerSession = { findFirst }
    const r = await getShiftById(VENUE, 'shift-1')
    expect(r.cashDrawer.sessionId).toBe('A')
    const fallback = findFirst.mock.calls[1][0].where
    expect(fallback.OR).toEqual([{ closedAt: null }, { closedAt: { gte: new Date('2026-08-20T14:30:00Z') } }])
  })

  it('🔴 P2 Codex: si la consulta del cajón truena, el detalle del turno sigue respondiendo (cashDrawer null), nunca un 500 en el endpoint viejo', async () => {
    ;(prismaMock as any).cashDrawerSession = { findFirst: jest.fn().mockRejectedValue(new Error('db down')) }
    const r = await getShiftById(VENUE, 'shift-1')
    expect(r.cashDrawer).toBeNull()
    expect(r.cashDeclared).toBe(1000)
  })

  it('sin caja que lo cubra, cashDrawer es null y el turno se ve igual que siempre', async () => {
    ;(prismaMock as any).cashDrawerSession = { findFirst: jest.fn().mockResolvedValue(null) }
    const r = await getShiftById(VENUE, 'shift-1')
    expect(r.cashDrawer).toBeNull()
    expect(r.cashDeclared).toBe(1000)
  })

  it('🔴 una caja cerrada SIN conteo trae counted=false y overShort=null — nunca "cuadró"', async () => {
    ;(prismaMock as any).cashDrawerSession = { findFirst: jest.fn().mockResolvedValue(caja({ actualAmount: null, overShort: null })) }
    const r = await getShiftById(VENUE, 'shift-1')
    expect(r.cashDrawer).toMatchObject({ counted: false, actualAmount: null, overShort: null, expectedAmount: 1300 })
  })
})
