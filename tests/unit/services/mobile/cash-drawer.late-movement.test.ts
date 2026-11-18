/**
 * Codex 3ª auditoría: un retiro que viene de la cola offline de un aparato llega cuando SU caja ya cerró.
 * Rechazarlo perdía dinero real; cargarlo a la caja abierta de hoy lo atribuía mal. Ahora: con `sessionId`
 * se acepta sobre ESA caja (cerrada), bajo candado, recalculando el overShort firmado y dejando bitácora.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
import { payOut } from '@/services/mobile/cash-drawer.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
/** La fila de bitácora escrita en la transacción (`writeLegacyActivityAuditTx` → `activityLog.create`). */
const bitacoraEnLaTx = (action: string) =>
  ((prismaMock as any).activityLog.create as jest.Mock).mock.calls.map(([a]) => a.data).find(d => d.action === action)
beforeEach(() => {
  jest.clearAllMocks()
  ;(prismaMock as any).$transaction = jest.fn((fn: any) => fn(prismaMock))
  ;(prismaMock as any).staff = { findUnique: jest.fn().mockResolvedValue({ firstName: 'Ana', lastName: 'M' }) }
})

it('🔴 retiro tardío sobre una caja CERRADA: se acepta sobre ESA caja, recalcula overShort y deja bitácora ADJUSTED_AFTER_CLOSE', async () => {
  const update = jest.fn().mockResolvedValue({})
  ;(prismaMock as any).cashDrawerSession = {
    findFirst: jest.fn().mockResolvedValue({ id: 's-cerrada', status: 'CLOSED' }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn().mockResolvedValue({ actualAmount: 250, overShort: 50, startingAmount: 300 }),
    update,
  }
  const stored = {
    id: 'e-1',
    sessionId: 's-cerrada',
    venueId: VENUE,
    type: 'PAY_OUT',
    amount: 50,
    staffId: 'st',
    staffName: 'Ana',
    note: null,
    createdAt: new Date(),
    localId: 'loc-1',
    orderId: null,
  }
  // Codex r2 #5: la suma de la caja la hace la base (como `/cash-drawer/sync`), no un `Number` sobre todos los movimientos.
  const groupBy = jest.fn().mockResolvedValue([{ type: 'PAY_OUT', _sum: { amount: 50 } }])
  ;(prismaMock as any).cashDrawerEvent = {
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
    findFirst: jest.fn().mockResolvedValue(stored),
    create: jest.fn(),
    groupBy,
  }
  const r = await payOut({ venueId: VENUE, staffId: 'st', staffName: 'Ana', amount: 50, localId: 'loc-1', sessionId: 's-cerrada' })
  expect(r.created).toBe(true)
  expect(groupBy.mock.calls[0][0]).toMatchObject({ by: ['type'], where: { venueId: VENUE, sessionId: 's-cerrada' } })
  // contado 250 − esperado (300 − 50 = 250) = 0: la diferencia firmada de +50 se corrige a 0
  expect(Number(update.mock.calls[0][0].data.overShort)).toBe(0)
  // Codex r1 #4 (naa08d0a): la bitácora del ajuste firmado se escribe DENTRO de la transacción.
  expect(bitacoraEnLaTx('CASH_DRAWER_ADJUSTED_AFTER_CLOSE')).toMatchObject({
    entityId: 's-cerrada',
    data: expect.objectContaining({ overShortBefore: 50, overShortAfter: 0, source: 'MOBILE_OFFLINE_REPLAY' }),
  })
})

it('🔴 con sessionId de una caja que NO es de este venue → 404 y nada se escribe', async () => {
  ;(prismaMock as any).cashDrawerSession = { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn() }
  ;(prismaMock as any).cashDrawerEvent = { createMany: jest.fn(), create: jest.fn(), findFirst: jest.fn() }
  await expect(payOut({ venueId: VENUE, staffId: 'st', staffName: 'Ana', amount: 50, sessionId: 's-ajena' })).rejects.toMatchObject({
    statusCode: 404,
  })
  expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
})

it('el reintento del MISMO retiro tardío (mismo localId) no duplica ni recalcula dos veces', async () => {
  const update = jest.fn()
  ;(prismaMock as any).cashDrawerSession = {
    findFirst: jest.fn().mockResolvedValue({ id: 's-cerrada', status: 'CLOSED' }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn(),
    update,
  }
  const stored = {
    id: 'e-1',
    sessionId: 's-cerrada',
    venueId: VENUE,
    type: 'PAY_OUT',
    amount: 50,
    staffId: 'st',
    staffName: 'Ana',
    note: null,
    createdAt: new Date(),
    localId: 'loc-1',
    orderId: null,
  }
  ;(prismaMock as any).cashDrawerEvent = {
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
    findFirst: jest.fn().mockResolvedValue(stored),
    create: jest.fn(),
  }
  const r = await payOut({ venueId: VENUE, staffId: 'st', staffName: 'Ana', amount: 50, localId: 'loc-1', sessionId: 's-cerrada' })
  expect(r.created).toBe(false)
  expect(update).not.toHaveBeenCalled()
})

/**
 * 🔴 hz:nube0000:naa08d0a (deuda 10-nov): fondo $1,000, otro aparato cierra caja y turno contando $900 (los dos firman −$100);
 * después sube el retiro sin red de $100. Antes se corregía la caja ($0) y el turno se quedaba en −$100. Ahora el turno ligado se
 * corrige con las MISMAS guardas de `/cash-drawer/sync` (turno cerrado, mismo conteo, CAS sobre el valor anterior) y deja
 * `SHIFT_UPDATED` con antes/después.
 */
describe('naa08d0a: el retiro tardío también corrige la diferencia del turno ligado', () => {
  const D = (n: number) => new (require('@prisma/client').Prisma.Decimal)(n)
  function cajaYTurno(turno: Record<string, unknown> | null) {
    const update = jest.fn().mockResolvedValue({})
    ;(prismaMock as any).cashDrawerSession = {
      findFirst: jest.fn().mockResolvedValue({ id: 's-cerrada', status: 'CLOSED' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ actualAmount: D(900), overShort: D(-100), startingAmount: D(1000), shiftId: 'shift-1' }),
      update,
    }
    const stored = {
      id: 'e-1',
      sessionId: 's-cerrada',
      venueId: VENUE,
      type: 'PAY_OUT',
      amount: 100,
      staffId: 'st',
      staffName: 'Ana',
      note: null,
      createdAt: new Date(),
      localId: 'loc-1',
      orderId: null,
    }
    ;(prismaMock as any).cashDrawerEvent = {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(stored),
      create: jest.fn(),
      groupBy: jest.fn().mockResolvedValue([{ type: 'PAY_OUT', _sum: { amount: D(100) } }]),
    }
    const shiftUpdateMany = jest.fn().mockResolvedValue({ count: 1 })
    ;(prismaMock as any).shift = { findFirst: jest.fn().mockResolvedValue(turno), updateMany: shiftUpdateMany }
    return { update, shiftUpdateMany }
  }
  const retiro = () => payOut({ venueId: VENUE, staffId: 'st', staffName: 'Ana', amount: 100, localId: 'loc-1', sessionId: 's-cerrada' })

  it('🔴 caja $0 y turno $0, con SHIFT_UPDATED antes −100 / después 0', async () => {
    const { update, shiftUpdateMany } = cajaYTurno({
      id: 'shift-1',
      venueId: VENUE,
      status: 'CLOSED',
      cashDeclared: D(900),
      cashDifference: D(-100),
    })
    await retiro()
    expect(Number(update.mock.calls[0][0].data.overShort)).toBe(0)
    expect(shiftUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'shift-1', venueId: VENUE, status: 'CLOSED' }),
      data: { cashDifference: expect.anything() },
    })
    expect(Number(shiftUpdateMany.mock.calls[0][0].data.cashDifference)).toBe(0)
    expect(bitacoraEnLaTx('SHIFT_UPDATED')).toMatchObject({
      entity: 'Shift',
      entityId: 'shift-1',
      data: expect.objectContaining({
        cashDifferenceBeforePesos: '-100.00',
        cashDifferenceAfterPesos: '0.00',
        cashDrawerSessionId: 's-cerrada',
      }),
    })
    expect(bitacoraEnLaTx('CASH_DRAWER_ADJUSTED_AFTER_CLOSE')).toMatchObject({
      data: expect.objectContaining({ linkedShiftId: 'shift-1', shiftReconciliationStatus: 'APPLIED' }),
    })
    // Codex r1 #3: antes que la caja, el candado del ciclo del turno del negocio (como «Corregir conteo» y el borrado del turno).
    const primeraConsulta = ((prismaMock as any).$queryRaw as jest.Mock).mock.invocationCallOrder[0]
    expect(primeraConsulta).toBeLessThan(((prismaMock as any).cashDrawerSession.updateMany as jest.Mock).mock.invocationCallOrder[0])
  })

  it.each([
    ['el turno sigue abierto', { status: 'OPEN', cashDeclared: null }, 'SHIFT_NOT_CLOSED'],
    ['el turno contó otra cosa', { status: 'CLOSED', cashDeclared: D(950) }, 'SHIFT_COUNT_MISMATCH'],
  ])('%s: el turno no se toca y queda pendiente con su razón', async (_caso, turno, razon) => {
    const { shiftUpdateMany } = cajaYTurno({ id: 'shift-1', venueId: VENUE, cashDifference: D(-100), ...turno })
    await retiro()
    expect(shiftUpdateMany).not.toHaveBeenCalled()
    expect(bitacoraEnLaTx('CASH_DRAWER_ADJUSTED_AFTER_CLOSE')).toMatchObject({
      data: expect.objectContaining({ shiftReconciliationStatus: 'PENDING', shiftReconciliationPendingReason: razon }),
    })
    expect(bitacoraEnLaTx('SHIFT_UPDATED')).toBeUndefined()
  })
})
