jest.mock('@/communication/rabbitmq/commandListener', () => ({ deliverPosCommand: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/services/access/cashReconciliationAccess.service', () => ({ isCashReconciliationEnabled: jest.fn() }))
jest.mock('@/services/dashboard/shift.dashboard.service', () => ({ resolveShiftCashDrawer: jest.fn() }))
jest.mock('@/services/shared/turnoDeCaja', () => ({
  turnoVivoWhere: (venueId: string) => ({ venueId, endTime: null, status: { in: ['OPEN', 'CLOSING'] } }),
  ESTADOS_DE_TURNO_VIVO: ['OPEN', 'CLOSING'],
  cerrarTurnoDeCaja: jest.fn(),
  esperadoDelCajonAbierto: jest.fn(),
  abrirTurnoDeCaja: jest.fn(),
}))
jest.mock('@/services/shared/parejaDeCierre', () => ({ asegurarLaLiga: jest.fn() }))
jest.mock('@/services/access/access.service', () => ({
  ...jest.requireActual('@/services/access/access.service'),
  getUserAccess: jest.fn(),
}))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as service from '@/services/tpv/shift.tpv.service'
import { isCashReconciliationEnabled } from '@/services/access/cashReconciliationAccess.service'
import { cerrarTurnoDeCaja, esperadoDelCajonAbierto } from '@/services/shared/turnoDeCaja'
import { getUserAccess } from '@/services/access/access.service'

const m = prisma as any
const V = 'cm00000000000000000000001',
  S = 'cm00000000000000000000002',
  A = 'cm00000000000000000000003'
const B = 'cm00000000000000000000004',
  SERIAL = 'AVQD-S2'
const NOW = new Date('2026-10-28T04:00:00.000Z')
let shift: any, operations: Map<string, any>, drawer: any
const requestBody = (count = '510.00') => ({ cashReconciliationAction: 'COUNTED', countedCash: count })
const context = (id = A, over: object = {}) =>
  ({
    actorStaffId: S,
    now: () => NOW,
    operation: { operationId: id, terminalSerial: SERIAL, closedAtLocal: '2026-10-27T23:00:00-06:00', isOfflineReplay: true },
    ...over,
  }) as any
const close = (id = A, body: object = requestBody(), ctx: object = {}) =>
  service.closeShiftForVenueWithResult(V, 'shift-A', body, context(id, ctx))
const get = (id = A, serial = SERIAL) => (service as any).getShiftOperationForVenue(V, id, serial)

function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, value]: any) => {
    if (value === undefined) return true
    if (key === 'resultJson') return row.resultJson?.[value.path[0]] === value.equals
    if (value instanceof Date) return row[key]?.getTime() === value.getTime()
    return row[key] === value
  })
}

beforeEach(() => {
  ;(getUserAccess as jest.Mock).mockResolvedValue({ role: 'OWNER', corePermissions: ['shifts:read', 'tpv-shifts:close'] })
  operations = new Map()
  drawer = { id: 'drawer-A', venueId: V, shiftId: 'shift-A', status: 'OPEN', actualAmount: null, overShort: null }
  shift = {
    id: 'shift-A',
    venueId: V,
    staffId: S,
    status: 'OPEN',
    endTime: null,
    startTime: new Date('2026-10-27T14:00:00Z'),
    updatedAt: new Date('2026-10-27T14:00:00Z'),
    startingCash: new Prisma.Decimal(500),
    totalSales: new Prisma.Decimal(0),
    totalTips: new Prisma.Decimal(0),
    venue: { name: 'S2 store', posType: 'NONE', posStatus: 'NOT_INTEGRATED' },
  }
  m.$transaction.mockImplementation(async (fn: any) => fn(m))
  m.$queryRaw.mockResolvedValue([])
  m.shift.findFirst.mockImplementation(async () => shift)
  m.shift.findUnique.mockImplementation(async () => shift)
  m.shift.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (!matches(shift, where)) return { count: 0 }
    shift = { ...shift, ...data }
    return { count: 1 }
  })
  m.tpvShiftOperation.findFirst.mockImplementation(async ({ where }: any) => [...operations.values()].find(o => matches(o, where)) ?? null)
  m.tpvShiftOperation.create.mockImplementation(async ({ data }: any) => {
    if (operations.has(data.id)) throw Object.assign(new Error('unique id'), { code: 'P2002' })
    const row = { ...data, createdAt: NOW, updatedAt: NOW }
    operations.set(data.id, row)
    return row
  })
  m.tpvShiftOperation.updateMany.mockImplementation(async ({ where, data }: any) => {
    const row = [...operations.values()].find(o => matches(o, where))
    if (!row) return { count: 0 }
    operations.set(row.id, { ...row, ...data })
    return { count: 1 }
  })
  m.terminal.findFirst.mockResolvedValue({ id: 'terminal', venueId: V, serialNumber: SERIAL })
  m.staffVenue.findFirst.mockResolvedValue({ staff: { firstName: 'Actual', lastName: 'Actor' } })
  m.payment.findMany.mockResolvedValue([])
  m.orderItem.findMany.mockResolvedValue([])
  m.rawMaterialMovement.findMany.mockResolvedValue([])
  m.cashDrawerSession.findFirst.mockImplementation(async ({ where }: any) => (matches(drawer, where) ? drawer : null))
  m.activityLog.create.mockResolvedValue({ id: 'audit' })
  ;(isCashReconciliationEnabled as jest.Mock).mockResolvedValue(true)
  ;(esperadoDelCajonAbierto as jest.Mock).mockResolvedValue({ sessionId: 'drawer-A', esperado: new Prisma.Decimal(500) })
  ;(cerrarTurnoDeCaja as jest.Mock).mockImplementation(async () => {
    drawer = { ...drawer, status: 'CLOSED' }
    return {}
  })
})

describe('new CLOSE operation contract', () => {
  it.each(['OWNER', 'SUPERADMIN'])('honors effective %s authority without a direct assignment in CLOSE and exact GET', async role => {
    m.staffVenue.findFirst.mockResolvedValue(null)
    ;(getUserAccess as jest.Mock).mockResolvedValue({
      role,
      corePermissions: role === 'SUPERADMIN' ? [] : ['shifts:read', 'tpv-shifts:close'],
    })
    expect(await close()).toMatchObject({ operation: { state: 'APPLIED' } })
    expect(await service.getShiftOperationForVenue(V, A, SERIAL, S)).toMatchObject({ operation: { state: 'APPLIED' } })
    expect(getUserAccess).toHaveBeenCalledWith(S, V)
  })
  it.each([
    ['inactive principal', 'OWNER', null],
    ['revoked org owner', 'OWNER', null],
    ['foreign organization', 'OWNER', null],
    ['owner PermissionSet empty', 'OWNER', []],
    ['admin wildcard removed from effective list', 'ADMIN', ['orders:read']],
  ])('rejects %s through the effective authority for CLOSE and GET, without extra effects', async (_label, role, permissions) => {
    await close()
    const audits = m.activityLog.create.mock.calls.length
    if (permissions === null) (getUserAccess as jest.Mock).mockRejectedValue(new Error(`User ${S} has no access to venue ${V}`))
    else (getUserAccess as jest.Mock).mockResolvedValue({ role, corePermissions: permissions })
    await expect(close()).rejects.toMatchObject({ statusCode: 403 })
    await expect(service.getShiftOperationForVenue(V, A, SERIAL, S)).rejects.toMatchObject({ statusCode: 403 })
    expect(m.activityLog.create).toHaveBeenCalledTimes(audits)
  })
  it('keeps access infrastructure failures retryable instead of claiming access was revoked', async () => {
    await close()
    const error = Object.assign(new Error('temporary connection failure'), { code: 'ECONNRESET' })
    ;(getUserAccess as jest.Mock).mockRejectedValue(error)
    await expect(close()).rejects.toBe(error)
    await expect(service.getShiftOperationForVenue(V, A, SERIAL, S)).rejects.toBe(error)
  })
  it('persists APPLIED and reconciliation in the same transaction that signs CLOSED, then replays without gate/calculation/audit', async () => {
    const first = await close()
    expect(operations.get(A)).toMatchObject({
      state: 'APPLIED',
      shiftId: 'shift-A',
      resultJson: { reconciliation: { outcome: 'APPLIED', countedCash: '510.00', cashDifference: '10.00' } },
    })
    expect(first).toMatchObject({ operation: { operationId: A, state: 'APPLIED', countApplied: true } })
    const calls = m.payment.findMany.mock.calls.length,
      audits = m.activityLog.create.mock.calls.length
    ;(isCashReconciliationEnabled as jest.Mock).mockRejectedValue(new Error('configuration unavailable'))
    const replay = await close(A, requestBody(), { actorStaffId: 'new-authorized-actor' })
    expect(replay.reconciliation).toEqual(first.reconciliation)
    expect(m.payment.findMany).toHaveBeenCalledTimes(calls)
    expect(m.activityLog.create).toHaveBeenCalledTimes(audits)
    expect(shift.closedById).toBe(S)
  })
  it.each(['count', 'terminal', 'kind', 'shift'])('rejects changed %s before rereading configuration or payments', async kind => {
    await close()
    if (kind === 'kind') operations.get(A).kind = 'OPEN'
    const ctx = kind === 'terminal' ? { operation: { ...context().operation, terminalSerial: 'AVQD-OTHER' } } : {}
    if (kind === 'shift') operations.get(A).shiftId = 'shift-other'
    await expect(close(A, requestBody(kind === 'count' ? '520.00' : '510.00'), ctx)).rejects.toMatchObject({
      code: 'SHIFT_OPERATION_CONTRACT_MISMATCH',
      statusCode: 409,
    })
  })
  it('a distinct gesture after A closed records CONFLICT, preserving its count and the actual winner', async () => {
    await close()
    const second = await close(B, requestBody('700.00'), { actorStaffId: 'staff-B' })
    expect(second).toMatchObject({
      shift: { cashDeclared: new Prisma.Decimal(510) },
      reconciliation: { outcome: 'CONFLICT' },
      operation: { state: 'CONFLICT', submittedCountedCash: '700.00', countApplied: false },
    })
    expect(operations.get(B).state).toBe('CONFLICT')
    const audits = m.activityLog.create.mock.calls.length
    await close(B, requestBody('700.00'))
    expect(m.activityLog.create).toHaveBeenCalledTimes(audits)
  })
  it('a live claim cannot be stolen; only its operation can recover stale CLOSING', async () => {
    m.payment.findMany.mockRejectedValueOnce(new Error('crash before final'))
    m.$transaction
      .mockImplementationOnce(async (fn: any) => fn(m))
      .mockImplementationOnce(async () => {
        throw new Error('release unavailable')
      })
    await expect(close()).rejects.toThrow('crash before final')
    expect(shift.status).toBe('CLOSING')
    await expect(close(B)).rejects.toMatchObject({ code: 'SHIFT_CLOSE_IN_PROGRESS' })
    await expect(close(B, requestBody(), { now: () => new Date(NOW.getTime() + 400_000) })).rejects.toMatchObject({
      code: 'SHIFT_CLOSE_IN_PROGRESS',
    })
    await close(A, requestBody(), { now: () => new Date(NOW.getTime() + 400_000) })
    expect(operations.get(A).state).toBe('APPLIED')
  })
  it.each(['new', 'legacy'])('after watchdog OPEN, %s may close; exact GET A materializes CONFLICT without applying A', async winner => {
    m.payment.findMany.mockRejectedValueOnce(new Error('crash'))
    await expect(close()).rejects.toThrow('crash')
    expect(shift.status).toBe('OPEN')
    // The existing watchdog has the same CAS effect as release: OPEN with a fresh timestamp.
    shift.updatedAt = new Date(NOW.getTime() + 400_000)
    if (winner === 'new') await close(B, requestBody('650.00'))
    else await service.closeShiftForVenueWithResult(V, 'shift-A', { cashDeclared: 650 }, { now: () => NOW })
    const a = await get()
    expect(a).toMatchObject({
      operation: { state: 'CONFLICT', submittedCountedCash: '510.00', countApplied: false },
      shift: { cashDeclared: '650.00' },
    })
    expect(operations.get(A).state).toBe('CONFLICT')
  })
  it('a released historic claim with the same millisecond cannot impersonate the next operation owner', async () => {
    m.payment.findMany.mockRejectedValueOnce(new Error('A failed'))
    await expect(close()).rejects.toThrow('A failed')
    let entered!: () => void, finish!: (payments: unknown[]) => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    m.payment.findMany.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
          entered()
        }),
    )
    const closingB = close(B)
    await started
    const resultA = await close(A, requestBody(), { now: () => new Date(NOW.getTime() + 400_000) }).then(
      () => 'STOLEN',
      error => error.code,
    )
    finish([])
    await closingB.catch(() => undefined)
    expect(resultA).toBe('SHIFT_CLOSE_IN_PROGRESS')
    expect(operations.get(B).state).toBe('APPLIED')
  })
  it('retains IGNORED_DISABLED count as submitted evidence and never applies it to either half', async () => {
    ;(isCashReconciliationEnabled as jest.Mock).mockResolvedValue(false)
    const r = await close()
    expect(r).toMatchObject({
      reconciliation: { outcome: 'IGNORED_DISABLED', countedCash: '510.00' },
      operation: { submittedCountedCash: '510.00', countApplied: false },
    })
    expect(shift.cashDeclared).toBeNull()
    expect(cerrarTurnoDeCaja).toHaveBeenCalledWith(expect.objectContaining({ conteo: null }))
  })
  it.each(['operation', 'legacy'])(
    'late %s process A cannot finalize or release B after watchdog reused the same timestamp',
    async kind => {
      let enterA!: () => void, finishA!: (p: unknown[]) => void, enterB!: () => void, finishB!: (p: unknown[]) => void
      const aStarted = new Promise<void>(resolve => {
        enterA = resolve
      })
      const bStarted = new Promise<void>(resolve => {
        enterB = resolve
      })
      m.payment.findMany
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              finishA = resolve
              enterA()
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              finishB = resolve
              enterB()
            }),
        )
      const closingA = kind === 'operation' ? close() : service.closeShiftForVenueWithResult(V, 'shift-A', {}, { now: () => NOW })
      await aStarted
      shift.status = 'OPEN'
      if (operations.has(A)) operations.get(A).resultJson = { claimedAt: null }
      const closingB = close(B)
      await bStarted
      finishA([])
      await expect(closingA).rejects.toMatchObject({ code: 'SHIFT_CLOSE_IN_PROGRESS' })
      expect(shift.status).toBe('CLOSING')
      finishB([])
      await closingB
      expect(operations.get(B).state).toBe('APPLIED')
    },
  )
  it.each(['2038-01-01T00:00:00Z', '2010-01-01T00:00:00Z', '2026-10-26T23:59:00-06:00'])(
    'preserves local time %s as evidence while signing server claim time',
    async closedAtLocal => {
      await close(A, requestBody(), { operation: { ...context().operation, closedAtLocal } })
      expect(shift.endTime).toEqual(NOW)
      expect(operations.get(A).requestJson.closedAtLocal).toBe(new Date(closedAtLocal).toISOString())
    },
  )
  it('drawer failure after CLOSED remains durable PENDING and exact status notices later repair', async () => {
    ;(cerrarTurnoDeCaja as jest.Mock).mockRejectedValueOnce(new Error('drawer unavailable'))
    const r = await close()
    expect(r).toMatchObject({ operation: { state: 'APPLIED', pairStatus: 'PENDING' } })
    expect(r.reconciliation).not.toHaveProperty('cashDrawer')
    drawer.status = 'CLOSED'
    expect(await get()).toMatchObject({ operation: { pairStatus: 'COMPLETE' } })
  })
  it('a failed pair-status read after commit cannot turn the signed close into an HTTP failure', async () => {
    m.cashDrawerSession.findFirst.mockImplementation(async () => {
      if (shift.status === 'CLOSED') throw new Error('pair read unavailable')
      return drawer
    })
    expect(await close()).toMatchObject({ operation: { state: 'APPLIED', pairStatus: 'UNAVAILABLE' } })
    expect(operations.get(A).state).toBe('APPLIED')
  })
  it('exact status hides request payload and refuses another venue or terminal', async () => {
    await close()
    await expect(get(A, 'AVQD-OTHER')).rejects.toMatchObject({ statusCode: 404 })
    const r = await get()
    expect(JSON.stringify(r)).not.toMatch(/requestJson|requestHash|terminalSerial|claimedAt/)
    expect(r).toMatchObject({ operation: { operationId: A }, shift: { id: 'shift-A' } })
  })
  it('invalid object-valued contract fields retain a fingerprint without persisting arbitrary secrets', async () => {
    const bad = { cashReconciliationAction: 'COUNTED', countedCash: { authorization: 'private-body-value' } }
    const result = await close(A, bad)
    expect(result.reconciliation.outcome).toBe('IGNORED_INVALID')
    expect(JSON.stringify(operations.get(A).requestJson)).not.toContain('private-body-value')
    await expect(close(A, { ...bad, countedCash: { authorization: 'different-body-value' } })).rejects.toMatchObject({
      code: 'SHIFT_OPERATION_CONTRACT_MISMATCH',
    })
  })
})

describe('legacy regression', () => {
  it('legacy closure keeps its old response with no operation row', async () => {
    const r = await service.closeShiftForVenueWithResult(V, 'shift-A', { cashDeclared: 600 }, { now: () => NOW })
    expect(r.reconciliation.outcome).toBe('LEGACY_APPLIED')
    expect(r).not.toHaveProperty('operation')
    expect(operations.size).toBe(0)
  })
})
