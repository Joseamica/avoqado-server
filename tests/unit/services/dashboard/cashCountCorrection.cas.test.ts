/**
 * 🔴 DINERO — los CAS perdidos de «Corregir conteo», y el orden de candados del borrado.
 *
 * Contra Postgres (tests/integration/shifts/corregirConteo.integration.test.ts) estos casos sólo salen por suerte de una carrera;
 * aquí se fuerzan: si la caja o el turno ya no tienen los números leídos, la corrección no escribe nada más (ni bitácora).
 * Y `deleteShift` toma el candado del ciclo ANTES del `deleteMany`, en la misma transacción (Codex r2, F2).
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'
import { correctCashCount } from '@/services/dashboard/cashCountCorrection.service'
import { deleteShift } from '@/services/dashboard/shift.dashboard.service'

const VENUE = 'venue-1'
const TURNO = 'turno-1'
const CAJA = 'caja-1'

const entrada = {
  venueId: VENUE,
  shiftId: TURNO,
  countedCash: 2000,
  reason: 'error de dedo',
  expectedCurrentCount: 20000,
  expectedResultingDifference: 0,
  expectedCorrectionCount: 0,
  staffId: 'staff-1',
  source: 'DASHBOARD' as const,
}

beforeEach(() => {
  for (const m of [
    prismaMock.$queryRaw,
    prismaMock.shift.findFirst,
    prismaMock.shift.updateMany,
    prismaMock.cashDrawerSession.findFirst,
    prismaMock.cashDrawerSession.updateMany,
    prismaMock.activityLog.count,
    prismaMock.activityLog.create,
  ])
    m.mockReset()
  // Lecturas felices: un corte cerrado y contado en $20,000 contra un esperado de $2,000, con su caja ligada.
  prismaMock.$queryRaw.mockResolvedValue([{ pg_advisory_xact_lock: '' }])
  prismaMock.shift.findFirst.mockResolvedValue({
    id: TURNO,
    status: 'CLOSED',
    originSystem: 'AVOQADO',
    cashDeclared: new Prisma.Decimal('20000'),
    cashDifference: new Prisma.Decimal('18000'),
  })
  prismaMock.cashDrawerSession.findFirst.mockResolvedValue({
    id: CAJA,
    status: 'CLOSED',
    actualAmount: new Prisma.Decimal('20000'),
    overShort: new Prisma.Decimal('18000'),
    startingAmount: new Prisma.Decimal('2000'),
    events: [{ type: 'CLOSE', amount: new Prisma.Decimal('20000') }],
  })
  prismaMock.activityLog.count.mockResolvedValue(0)
  prismaMock.shift.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.activityLog.create.mockResolvedValue({})
})

describe('correctCashCount — CAS perdido', () => {
  it('la caja ya no tiene los números leídos ⇒ CASH_COUNT_CHANGED, sin tocar el turno ni la bitácora', async () => {
    prismaMock.cashDrawerSession.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })

    await expect(correctCashCount(entrada)).rejects.toMatchObject({ statusCode: 409, code: 'CASH_COUNT_CHANGED' })

    expect(prismaMock.cashDrawerSession.updateMany).toHaveBeenCalledTimes(2)
    expect(prismaMock.cashDrawerSession.updateMany.mock.calls[1][0].where).toMatchObject({
      id: CAJA,
      venueId: VENUE,
      status: 'CLOSED',
      actualAmount: new Prisma.Decimal('20000'),
      overShort: new Prisma.Decimal('18000'),
    })
    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('el turno ya no tiene los números leídos ⇒ CASH_COUNT_CHANGED, sin bitácora', async () => {
    prismaMock.cashDrawerSession.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.shift.updateMany.mockResolvedValue({ count: 0 })

    await expect(correctCashCount(entrada)).rejects.toMatchObject({ statusCode: 409, code: 'CASH_COUNT_CHANGED' })

    expect(prismaMock.shift.updateMany.mock.calls[0][0].where).toMatchObject({
      id: TURNO,
      venueId: VENUE,
      status: 'CLOSED',
      cashDeclared: new Prisma.Decimal('20000'),
      cashDifference: new Prisma.Decimal('18000'),
    })
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })
})

describe('correctCashCount — orden de candados', () => {
  it('ciclo del negocio (advisory) → fila de la caja → fila del turno, como el resto del código (evita el 40P01)', async () => {
    prismaMock.cashDrawerSession.updateMany.mockResolvedValue({ count: 1 })

    await expect(correctCashCount(entrada)).resolves.toMatchObject({ countedAfter: 2000, differenceAfter: 0 })

    const [advisory] = prismaMock.$queryRaw.mock.invocationCallOrder
    const [candadoDeLaCaja] = prismaMock.cashDrawerSession.updateMany.mock.invocationCallOrder
    const [turno] = prismaMock.shift.updateMany.mock.invocationCallOrder
    expect(prismaMock.$queryRaw.mock.calls[0][0].values).toContain(`avoqado:shift-lifecycle:v1:${VENUE}`)
    expect(prismaMock.cashDrawerSession.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: CAJA, venueId: VENUE } })
    expect(advisory).toBeLessThan(candadoDeLaCaja)
    expect(candadoDeLaCaja).toBeLessThan(turno)
  })
})

describe('deleteShift — el candado del ciclo antes del borrado', () => {
  it('llama $queryRaw (el candado) ANTES que tx.shift.deleteMany, dentro de la misma $transaction', async () => {
    prismaMock.shift.findFirst.mockResolvedValue({ id: TURNO, venueId: VENUE, status: 'CLOSED', endTime: new Date('2020-01-01T00:00:00Z') })
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      shift: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    }
    prismaMock.$transaction.mockImplementationOnce((fn: (t: typeof tx) => unknown) => fn(tx))

    await expect(deleteShift(VENUE, TURNO, 'staff-1')).resolves.toBe(true)

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(tx.$queryRaw.mock.calls[0][0].values).toContain(`avoqado:shift-lifecycle:v1:${VENUE}`)
    expect(tx.shift.deleteMany).toHaveBeenCalledTimes(1)
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.shift.deleteMany.mock.invocationCallOrder[0])
    expect(prismaMock.shift.deleteMany).not.toHaveBeenCalled()
  })
})
