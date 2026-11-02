jest.mock('@/communication/rabbitmq/commandListener', () => ({ deliverPosCommand: jest.fn() }))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { abrirTurnoDeCaja } from '@/services/shared/turnoDeCaja'
import { logAction } from '@/services/dashboard/activity-log.service'

const m = prisma as any
const VENUE = 'cm00000000000000000000001'
const STAFF = 'cm00000000000000000000002'
const OP = 'cm00000000000000000000003'
const NOW = new Date('2026-10-27T15:00:00.000Z')
let operation: any

const params = (over: Record<string, unknown> = {}) => ({
  venueId: VENUE,
  staffId: STAFF,
  startingCash: 500,
  source: 'TURNO_TPV' as const,
  now: () => NOW,
  localId: OP,
  openedAt: new Date('2026-10-27T14:00:00.000Z'),
  tpvOperation: { operationId: OP, terminalSerial: 'AVQD-123', declaredStaffId: 'declared-only', isOfflineReplay: true },
  ...over,
})

function existingPair(suffix = 'A') {
  m.shift.findFirst.mockResolvedValue({
    id: `shift-${suffix}`,
    status: 'OPEN',
    startTime: NOW,
    startingCash: new Prisma.Decimal(2000),
    notes: null,
  })
  m.cashDrawerSession.findFirst.mockResolvedValue({
    id: `drawer-${suffix}`,
    shiftId: `shift-${suffix}`,
    openedAt: NOW,
    startingAmount: new Prisma.Decimal(2000),
  })
  m.cashDrawerSession.findUnique.mockImplementation(() =>
    Promise.resolve({ id: `drawer-${suffix}`, shiftId: `shift-${suffix}`, venueId: VENUE, startingAmount: new Prisma.Decimal(2000) }),
  )
  m.cashDrawerEvent.findFirst.mockImplementation(({ where }: any) => Promise.resolve(where.localId ? null : { localId: `open-${suffix}` }))
}

beforeEach(() => {
  operation = null
  // Until the new model is registered globally, the RED still exercises real service behavior.
  m.tpvShiftOperation ??= { findFirst: jest.fn(), create: jest.fn() }
  m.tpvShiftOperation.findFirst.mockImplementation(({ where }: any) =>
    Promise.resolve(operation?.venueId === where.venueId ? operation : null),
  )
  m.tpvShiftOperation.create.mockImplementation(({ data }: any) => {
    operation = structuredClone(data)
    return Promise.resolve(operation)
  })
  m.terminal.findFirst.mockResolvedValue({ id: 'terminal-1', venueId: VENUE, serialNumber: 'AVQD-123' })
  m.venue.findUnique.mockResolvedValue({ id: VENUE, timezone: 'America/Mexico_City', posType: null, posStatus: 'NOT_INTEGRATED' })
  m.staffVenue.findFirst.mockResolvedValue({ staff: { id: STAFF, firstName: 'Actual', lastName: 'Actor' } })
  m.shift.findMany.mockResolvedValue([])
  m.shift.findFirst.mockResolvedValue(null)
  m.shift.findUnique.mockResolvedValue(null)
  m.cashDrawerSession.findFirst.mockResolvedValue(null)
  m.cashDrawerSession.findUnique.mockResolvedValue(null)
  m.cashDrawerEvent.findFirst.mockResolvedValue(null)
  m.shift.create.mockResolvedValue({ id: 'shift-own' })
  m.cashDrawerSession.create.mockResolvedValue({ id: 'drawer-own' })
  m.shift.updateMany.mockResolvedValue({ count: 1 })
  m.cashDrawerSession.updateMany.mockResolvedValue({ count: 1 })
})

describe('TPV opening operation: durable correspondence', () => {
  it('ADOPTED + lost response + A closed/B open recovers A and its actual OPEN key, without new money', async () => {
    existingPair()
    // A has another OPEN key: the request key must never be echoed as though it opened A.
    const first = await abrirTurnoDeCaja(params())
    expect(first).toMatchObject({
      shiftId: 'shift-A',
      cashDrawerSessionId: 'drawer-A',
      fondoAplicado: '2000',
      localId: 'open-A',
      openingDisposition: 'ADOPTED',
    })
    expect(operation).toMatchObject({
      id: OP,
      venueId: VENUE,
      kind: 'OPEN',
      state: 'APPLIED',
      shiftId: 'shift-A',
      cashDrawerSessionId: 'drawer-A',
    })
    existingPair('B')
    const replay = await abrirTurnoDeCaja(params())
    expect(replay).toMatchObject({ ...first, reintento: true })
    expect(m.shift.create).not.toHaveBeenCalled()
    expect(m.shift.updateMany).not.toHaveBeenCalled()
    expect(m.cashDrawerSession.create).not.toHaveBeenCalled()
    expect(m.cashDrawerEvent.create).not.toHaveBeenCalled()
    expect(m.tpvShiftOperation.create).toHaveBeenCalledTimes(1)
    expect(m.activityLog.create).toHaveBeenCalledTimes(1)
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'SHIFT_OPENED' }))
  })

  it('OWN keeps its result after its drawer closes and another pair is current; replay does not emit another opening', async () => {
    const first = await abrirTurnoDeCaja(params())
    expect(first).toMatchObject({ openingDisposition: 'OWN', shiftId: 'shift-own', cashDrawerSessionId: 'drawer-own', localId: OP })
    existingPair('B')
    const before = (logAction as jest.Mock).mock.calls.length
    await expect(abrirTurnoDeCaja(params())).resolves.toMatchObject({ ...first, reintento: true })
    expect(m.shift.create).toHaveBeenCalledTimes(1)
    expect(m.cashDrawerSession.create).toHaveBeenCalledTimes(1)
    expect((logAction as jest.Mock).mock.calls.length).toBe(before)
  })

  it.each([
    ['money', { startingCash: 501 }],
    ['date', { openedAt: new Date('2026-10-27T13:00:00.000Z') }],
    ['station', { stationId: 'other-station' }],
    ['terminal', { tpvOperation: { ...params().tpvOperation, terminalSerial: 'AVQD-OTHER' } }],
    ['kind', null],
  ])('same key + changed %s returns 409 before looking at the live shift', async (_kind, override) => {
    await abrirTurnoDeCaja(params())
    if (!override) operation.kind = 'CLOSE'
    m.shift.findFirst.mockClear()
    await expect(abrirTurnoDeCaja(params(override ?? {}))).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHIFT_OPERATION_CONTRACT_MISMATCH',
    })
    expect(m.shift.findFirst).not.toHaveBeenCalled()
    expect(m.tpvShiftOperation.create).toHaveBeenCalledTimes(1)
  })

  it('same key in another venue cannot return the first venue result or leave effects', async () => {
    await abrirTurnoDeCaja(params())
    m.tpvShiftOperation.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate id', { code: 'P2002', clientVersion: 'test', meta: { target: ['id'] } }),
    )
    await expect(abrirTurnoDeCaja(params({ venueId: 'cm00000000000000000000004' }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHIFT_OPERATION_CONTRACT_MISMATCH',
    })
    expect(m.tpvShiftOperation.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: OP, venueId: 'cm00000000000000000000004' } }),
    )
  })

  it('changing the currently authenticated actor does not change the operation fingerprint', async () => {
    const first = await abrirTurnoDeCaja(params())
    await expect(abrirTurnoDeCaja(params({ staffId: 'cm00000000000000000000005' }))).resolves.toMatchObject({ ...first, reintento: true })
  })

  it('rejects mismatched operation/open keys before creating a shift', async () => {
    await expect(abrirTurnoDeCaja(params({ localId: 'cm00000000000000000000006' }))).rejects.toMatchObject({
      code: 'SHIFT_OPERATION_CONTRACT_MISMATCH',
    })
    expect(m.shift.create).not.toHaveBeenCalled()
  })

  it('does not return a drawer already linked to another shift as a coherent pair', async () => {
    existingPair()
    m.cashDrawerSession.findFirst.mockResolvedValue({
      id: 'drawer-A',
      shiftId: 'shift-other',
      openedAt: NOW,
      startingAmount: new Prisma.Decimal(2000),
    })
    await expect(abrirTurnoDeCaja(params())).rejects.toMatchObject({ statusCode: 409, code: 'SHIFT_OPEN_PAIR_CONFLICT' })
    expect(m.tpvShiftOperation.create).not.toHaveBeenCalled()
    expect(m.cashDrawerSession.updateMany).not.toHaveBeenCalled()
  })

  it('a prior OPEN without an explicit shift link cannot attach the new operation to the current shift', async () => {
    existingPair('B')
    m.cashDrawerEvent.findFirst.mockResolvedValue({ session: { id: 'drawer-A', shiftId: null, startingAmount: new Prisma.Decimal(500) } })
    await expect(abrirTurnoDeCaja(params())).rejects.toMatchObject({ code: 'SHIFT_OPEN_PAIR_CONFLICT' })
    expect(m.tpvShiftOperation.create).not.toHaveBeenCalled()
    expect(m.shift.findFirst).not.toHaveBeenCalled()
  })

  it('a prior OPEN with its exact shift link still persists the new operation once without creating money', async () => {
    m.cashDrawerEvent.findFirst.mockResolvedValue({
      session: { id: 'drawer-A', shiftId: 'shift-A', startingAmount: new Prisma.Decimal(500) },
    })
    await expect(abrirTurnoDeCaja(params())).resolves.toMatchObject({
      shiftId: 'shift-A',
      cashDrawerSessionId: 'drawer-A',
      reintento: true,
      openingDisposition: 'ADOPTED',
      cajaCreada: false,
    })
    expect(m.tpvShiftOperation.create).toHaveBeenCalledTimes(1)
    expect(m.activityLog.create).toHaveBeenCalledTimes(1)
    expect(m.shift.create).not.toHaveBeenCalled()
    expect(m.cashDrawerSession.create).not.toHaveBeenCalled()
  })

  it('propagates a failure in the operation write AFTER creating the pair (real rollback is an integration assertion)', async () => {
    m.tpvShiftOperation.create.mockRejectedValueOnce(new Error('operation persistence failed'))
    await expect(abrirTurnoDeCaja(params())).rejects.toThrow('operation persistence failed')
    expect(m.cashDrawerSession.create).toHaveBeenCalledTimes(1)
    expect(m.cashDrawerSession.create.mock.invocationCallOrder[0]).toBeLessThan(m.tpvShiftOperation.create.mock.invocationCallOrder[0])
  })

  it('REGRESSION: callers without the TPV context do not touch the new table or acquire new response fields', async () => {
    const result = await abrirTurnoDeCaja(params({ tpvOperation: undefined, localId: null }))
    expect(result).toMatchObject({ shiftId: 'shift-own', reintento: false })
    expect(result).not.toHaveProperty('openingDisposition')
    expect(m.tpvShiftOperation.create).not.toHaveBeenCalled()
  })
})
