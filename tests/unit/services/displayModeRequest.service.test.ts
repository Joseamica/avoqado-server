import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import {
  DISPLAY_MODE_REQUEST_TTL_MS,
  DisplayModeRequestError,
  acknowledgeDisplayModeRequest,
  cancelDisplayModeRequest,
  createDisplayModeRequest,
  decideAcknowledgeDisplayModeRequest,
  decideCancelDisplayModeRequest,
  decideCreateDisplayModeRequest,
  decideExpireDisplayModeRequest,
  expireDisplayModeRequest,
  parseDisplayModeRequest,
  updateLocalDisplayMode,
  type DisplayModeRequestRecord,
} from '@/services/display-mode-request.service'

const NOW = new Date('2026-08-30T12:00:00.000Z')
const REQUESTED_AT = '2026-08-30T11:55:00.000Z'
const EXPIRES_AT = '2026-08-30T12:10:00.000Z'

function request(overrides: Partial<DisplayModeRequestRecord> = {}): DisplayModeRequestRecord {
  return {
    requestId: 'request-a',
    desiredInverted: true,
    status: 'PENDING',
    requestedAt: REQUESTED_AT,
    requestedBy: 'staff-1',
    expiresAt: EXPIRES_AT,
    ...overrides,
  }
}

function terminalSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'terminal-1',
    venueId: 'venue-1',
    status: 'ACTIVE',
    customerDisplayRequest: null,
    customerDisplayRequestVersion: 0,
    customerDisplayRequestExpiresAt: null,
    customerDisplayInverted: false,
    ...overrides,
  }
}

describe('display-mode request state machine', () => {
  describe('pure transition and parsing behavior', () => {
    it('treats null, malformed, extra-key, and invalid-date stored JSON as no current request', () => {
      expect(parseDisplayModeRequest(null)).toBeNull()
      expect(parseDisplayModeRequest({ requestId: 'incomplete' })).toBeNull()
      expect(parseDisplayModeRequest({ ...request(), unexpected: true })).toBeNull()
      expect(parseDisplayModeRequest({ ...request(), requestedAt: 'not-a-date' })).toBeNull()
    })

    it('creates a PENDING request with an exact fifteen-minute TTL without changing physical state', () => {
      const transition = decideCreateDisplayModeRequest({
        current: null,
        terminalStatus: 'ACTIVE',
        currentPhysicalValue: false,
        desiredInverted: true,
        requestedBy: 'staff-1',
        requestId: 'request-a',
        now: NOW,
      })

      expect(transition.kind).toBe('WRITE')
      expect(transition.nextRequest).toEqual({
        requestId: 'request-a',
        desiredInverted: true,
        status: 'PENDING',
        requestedAt: NOW.toISOString(),
        requestedBy: 'staff-1',
        expiresAt: new Date(NOW.getTime() + DISPLAY_MODE_REQUEST_TTL_MS).toISOString(),
      })
      expect(transition.confirmedPhysicalValue).toBeUndefined()
      expect(transition.audit).toMatchObject({
        action: 'DISPLAY_MODE_REQUESTED',
        data: { requestId: 'request-a', status: 'PENDING', requestedAt: NOW.toISOString() },
      })
    })

    it('replaces a pending request and carries bounded superseded identity in the new request audit', () => {
      const transition = decideCreateDisplayModeRequest({
        current: request(),
        terminalStatus: 'ACTIVE',
        currentPhysicalValue: false,
        desiredInverted: false,
        requestedBy: 'staff-2',
        requestId: 'request-b',
        now: NOW,
      })

      expect(transition.nextRequest).toMatchObject({ requestId: 'request-b', desiredInverted: false, status: 'PENDING' })
      expect(transition.audit.data).toEqual({
        requestId: 'request-b',
        status: 'PENDING',
        requestedAt: NOW.toISOString(),
        supersededRequestId: 'request-a',
        supersededStatus: 'SUPERSEDED',
      })
    })

    it('cancels only the current pending request and clears its expiry', () => {
      const transition = decideCancelDisplayModeRequest({ current: request(), requestId: 'request-a', now: NOW })

      expect(transition).toMatchObject({
        kind: 'WRITE',
        nextRequest: { requestId: 'request-a', status: 'CANCELLED', resolvedAt: NOW.toISOString() },
        nextExpiresAt: null,
        audit: {
          action: 'DISPLAY_MODE_RESOLVED',
          data: {
            requestId: 'request-a',
            status: 'CANCELLED',
            requestedAt: REQUESTED_AT,
            resolvedAt: NOW.toISOString(),
            latencyMs: 300_000,
          },
        },
      })
    })

    it('reports APPLIED cancellation as too late without mutating or pretending to roll back hardware', () => {
      const applied = request({ status: 'APPLIED', resolvedAt: '2026-08-30T11:58:00.000Z' })
      const transition = decideCancelDisplayModeRequest({ current: applied, requestId: 'request-a', now: NOW })

      expect(transition).toEqual({
        kind: 'NOOP',
        request: applied,
        disposition: 'TOO_LATE',
        resultCode: 'CANCEL_TOO_LATE',
      })
    })

    it('expires only a due pending request and leaves an early request unchanged', () => {
      const early = decideExpireDisplayModeRequest({
        current: request({ expiresAt: '2026-08-30T12:01:00.000Z' }),
        now: NOW,
      })
      const due = decideExpireDisplayModeRequest({ current: request({ expiresAt: NOW.toISOString() }), now: NOW })

      expect(early).toMatchObject({ kind: 'NOOP', disposition: 'NOT_DUE' })
      expect(due).toMatchObject({
        kind: 'WRITE',
        nextRequest: { status: 'EXPIRED', resolvedAt: NOW.toISOString() },
        nextExpiresAt: null,
        audit: {
          action: 'DISPLAY_MODE_EXPIRED',
          data: { requestId: 'request-a', status: 'EXPIRED', latencyMs: 300_000 },
        },
      })
    })

    it('applies a current pending ACK and updates only the confirmed physical value', () => {
      const transition = decideAcknowledgeDisplayModeRequest({
        current: request(),
        requestId: 'request-a',
        outcome: 'APPLIED',
        confirmedInverted: true,
        now: NOW,
      })

      expect(transition).toMatchObject({
        kind: 'WRITE',
        confirmedPhysicalValue: true,
        nextRequest: { status: 'APPLIED', resolvedAt: NOW.toISOString() },
        audit: { action: 'DISPLAY_MODE_RESOLVED', data: { status: 'APPLIED', latencyMs: 300_000 } },
      })
    })

    it('treats an APPLIED ACK at the exact pending TTL boundary as ACK_AFTER_EXPIRY before the sweeper runs', () => {
      const transition = decideAcknowledgeDisplayModeRequest({
        current: request({ expiresAt: NOW.toISOString() }),
        requestId: 'request-a',
        outcome: 'APPLIED',
        confirmedInverted: true,
        now: NOW,
      })

      expect(transition).toMatchObject({
        kind: 'WRITE',
        confirmedPhysicalValue: true,
        nextRequest: {
          status: 'APPLIED',
          resultCode: 'ACK_AFTER_EXPIRY',
          resolvedAt: NOW.toISOString(),
        },
      })
    })

    it('keeps a late rejected ACK rejected without inventing an applied physical state', () => {
      const transition = decideAcknowledgeDisplayModeRequest({
        current: request({ expiresAt: NOW.toISOString() }),
        requestId: 'request-a',
        outcome: 'REJECTED',
        resultCode: 'APPLY_FAILED',
        confirmedInverted: true,
        now: NOW,
      })

      expect(transition).toMatchObject({
        kind: 'WRITE',
        nextRequest: { status: 'REJECTED', resultCode: 'APPLY_FAILED' },
      })
      if (transition.kind !== 'WRITE') throw new Error('Expected a write transition for a rejected acknowledgement')
      expect(transition.confirmedPhysicalValue).toBeUndefined()
    })

    it('rejects a current request while preserving the last confirmed physical value', () => {
      const transition = decideAcknowledgeDisplayModeRequest({
        current: request(),
        requestId: 'request-a',
        outcome: 'REJECTED',
        resultCode: 'APPLY_FAILED',
        now: NOW,
      })

      expect(transition).toMatchObject({
        kind: 'WRITE',
        nextRequest: { status: 'REJECTED', resultCode: 'APPLY_FAILED' },
      })
      if (transition.kind !== 'WRITE') throw new Error('Expected a write transition for a rejected acknowledgement')
      expect(transition.confirmedPhysicalValue).toBeUndefined()
    })

    it('records LOCAL_OVERRIDE as rejected and adopts the local physical value', () => {
      const transition = decideAcknowledgeDisplayModeRequest({
        current: request(),
        requestId: 'request-a',
        outcome: 'REJECTED',
        resultCode: 'LOCAL_OVERRIDE',
        confirmedInverted: false,
        now: NOW,
      })

      expect(transition).toMatchObject({
        kind: 'WRITE',
        confirmedPhysicalValue: false,
        nextRequest: { status: 'REJECTED', resultCode: 'LOCAL_OVERRIDE' },
      })
    })

    it.each([
      ['EXPIRED', 'ACK_AFTER_EXPIRY'],
      ['CANCELLED', 'CANCEL_TOO_LATE'],
    ] as const)('accepts a proven late application after %s with %s', (status, resultCode) => {
      const transition = decideAcknowledgeDisplayModeRequest({
        current: request({ status, resolvedAt: '2026-08-30T11:59:00.000Z' }),
        requestId: 'request-a',
        outcome: 'APPLIED',
        confirmedInverted: true,
        now: NOW,
      })

      expect(transition).toMatchObject({
        kind: 'WRITE',
        confirmedPhysicalValue: true,
        nextRequest: { status: 'APPLIED', resultCode, resolvedAt: NOW.toISOString() },
      })
    })

    it('preserves the newer aggregate when an old ACK reports a confirmed physical value', () => {
      const current = request({ requestId: 'request-b', desiredInverted: false })
      const transition = decideAcknowledgeDisplayModeRequest({
        current,
        requestId: 'request-a',
        outcome: 'APPLIED',
        confirmedInverted: true,
        now: NOW,
      })

      expect(transition).toMatchObject({
        kind: 'WRITE',
        nextRequest: current,
        physicalOnly: true,
        confirmedPhysicalValue: true,
        postCommitErrorCode: 'DEVICE_REQUEST_SUPERSEDED',
        audit: {
          action: 'DISPLAY_MODE_RESOLVED',
          data: { requestId: 'request-a', status: 'SUPERSEDED', resolvedAt: NOW.toISOString() },
        },
      })
    })

    it('makes a repeated ACK of the same resolved current request idempotent', () => {
      const applied = request({ status: 'APPLIED', resolvedAt: '2026-08-30T11:58:00.000Z' })
      const transition = decideAcknowledgeDisplayModeRequest({
        current: applied,
        requestId: 'request-a',
        outcome: 'APPLIED',
        confirmedInverted: true,
        now: NOW,
      })

      expect(transition).toEqual({ kind: 'NOOP', request: applied, disposition: 'IDEMPOTENT' })
    })

    it('rejects creation for a retired terminal with a stable device code', () => {
      expect(() =>
        decideCreateDisplayModeRequest({
          current: null,
          terminalStatus: 'RETIRED',
          currentPhysicalValue: false,
          desiredInverted: true,
          requestedBy: 'staff-1',
          requestId: 'request-a',
          now: NOW,
        }),
      ).toThrow(expect.objectContaining({ code: 'DEVICE_RETIRED' }))
    })
  })

  describe('Prisma CAS and atomic audit behavior', () => {
    beforeEach(() => {
      prismaMock.terminal.findFirst.mockResolvedValue(terminalSnapshot())
      prismaMock.terminal.updateMany.mockResolvedValue({ count: 1 })
      prismaMock.activityLog.create.mockResolvedValue({ id: 'audit-1' })
      prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock))
    })

    it('persists create with tenant/version CAS, increments once, and audits inside the same transaction', async () => {
      const result = await createDisplayModeRequest({
        venueId: 'venue-1',
        terminalId: 'terminal-1',
        desiredInverted: true,
        requestedBy: 'staff-1',
        now: NOW,
      })

      expect(result).toMatchObject({ mutated: true, version: 1, request: { status: 'PENDING' }, customerDisplayInverted: false })
      expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith({
        where: { id: 'terminal-1', venueId: 'venue-1' },
        select: expect.objectContaining({
          id: true,
          venueId: true,
          status: true,
          customerDisplayRequestVersion: true,
          customerDisplayInverted: true,
        }),
      })
      expect(prismaMock.terminal.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'terminal-1',
          venueId: 'venue-1',
          status: { not: 'RETIRED' },
          customerDisplayRequestVersion: 0,
        },
        data: expect.objectContaining({
          customerDisplayRequest: expect.objectContaining({ status: 'PENDING' }),
          customerDisplayRequestVersion: { increment: 1 },
          customerDisplayRequestExpiresAt: new Date('2026-08-30T12:15:00.000Z'),
        }),
      })
      expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          staffId: 'staff-1',
          venueId: 'venue-1',
          action: 'DISPLAY_MODE_REQUESTED',
          entity: 'Terminal',
          entityId: 'terminal-1',
          data: expect.objectContaining({ status: 'PENDING' }),
        }),
      })
    })

    it('rereads and recomputes once after the first CAS loss', async () => {
      prismaMock.terminal.findFirst.mockResolvedValueOnce(terminalSnapshot()).mockResolvedValueOnce(
        terminalSnapshot({
          customerDisplayRequest: request({ requestId: 'competing-request' }),
          customerDisplayRequestVersion: 1,
          customerDisplayRequestExpiresAt: new Date(EXPIRES_AT),
        }),
      )
      prismaMock.terminal.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 })

      const result = await createDisplayModeRequest({
        venueId: 'venue-1',
        terminalId: 'terminal-1',
        desiredInverted: false,
        requestedBy: 'staff-1',
        now: NOW,
      })

      expect(result.version).toBe(2)
      expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(2)
      expect(prismaMock.terminal.updateMany).toHaveBeenCalledTimes(2)
      expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
      expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          data: expect.objectContaining({
            supersededRequestId: 'competing-request',
            supersededStatus: 'SUPERSEDED',
          }),
        }),
      })
    })

    it('throws DISPLAY_MODE_CONFLICT after a second CAS loss without writing an audit', async () => {
      prismaMock.terminal.findFirst
        .mockResolvedValueOnce(terminalSnapshot())
        .mockResolvedValueOnce(terminalSnapshot({ customerDisplayRequestVersion: 1 }))
      prismaMock.terminal.updateMany.mockResolvedValue({ count: 0 })

      const operation = createDisplayModeRequest({
        venueId: 'venue-1',
        terminalId: 'terminal-1',
        desiredInverted: true,
        requestedBy: 'staff-1',
        now: NOW,
      })
      await expect(operation).rejects.toBeInstanceOf(DisplayModeRequestError)
      await expect(operation).rejects.toMatchObject({ code: 'DISPLAY_MODE_CONFLICT', statusCode: 409 })

      expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(2)
      expect(prismaMock.terminal.updateMany).toHaveBeenCalledTimes(2)
      expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    })

    it('commits an old ACK physical correction, preserves the newer request, then returns the superseded conflict', async () => {
      const current = request({ requestId: 'request-b', desiredInverted: false })
      prismaMock.terminal.findFirst.mockResolvedValue(
        terminalSnapshot({
          customerDisplayRequest: current,
          customerDisplayRequestVersion: 4,
          customerDisplayRequestExpiresAt: new Date(EXPIRES_AT),
        }),
      )

      const operation = acknowledgeDisplayModeRequest({
        venueId: 'venue-1',
        terminalId: 'terminal-1',
        requestId: 'request-a',
        outcome: 'APPLIED',
        confirmedInverted: true,
        now: NOW,
      })
      await expect(operation).rejects.toBeInstanceOf(DisplayModeRequestError)
      await expect(operation).rejects.toMatchObject({ code: 'DEVICE_REQUEST_SUPERSEDED', statusCode: 409 })

      expect(prismaMock.terminal.updateMany).toHaveBeenCalledWith({
        where: { id: 'terminal-1', venueId: 'venue-1', customerDisplayRequestVersion: 4 },
        data: { customerDisplayInverted: true },
      })
      const writtenData = prismaMock.terminal.updateMany.mock.calls[0][0].data
      expect(writtenData).not.toHaveProperty('customerDisplayRequest')
      expect(writtenData).not.toHaveProperty('customerDisplayRequestExpiresAt')
      expect(writtenData).not.toHaveProperty('customerDisplayRequestVersion')
      expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
    })

    it('rereads and retries a physical-only old ACK after one aggregate CAS loss', async () => {
      prismaMock.terminal.findFirst
        .mockResolvedValueOnce(
          terminalSnapshot({
            customerDisplayRequest: request({ requestId: 'request-b' }),
            customerDisplayRequestVersion: 4,
            customerDisplayRequestExpiresAt: new Date(EXPIRES_AT),
          }),
        )
        .mockResolvedValueOnce(
          terminalSnapshot({
            customerDisplayRequest: request({ requestId: 'request-c', desiredInverted: false }),
            customerDisplayRequestVersion: 5,
            customerDisplayRequestExpiresAt: new Date(EXPIRES_AT),
          }),
        )
      prismaMock.terminal.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 })

      const operation = acknowledgeDisplayModeRequest({
        venueId: 'venue-1',
        terminalId: 'terminal-1',
        requestId: 'request-a',
        outcome: 'APPLIED',
        confirmedInverted: true,
        now: NOW,
      })
      await expect(operation).rejects.toMatchObject({ code: 'DEVICE_REQUEST_SUPERSEDED', statusCode: 409 })

      expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(2)
      expect(prismaMock.terminal.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'terminal-1', venueId: 'venue-1', customerDisplayRequestVersion: 4 },
        data: { customerDisplayInverted: true },
      })
      expect(prismaMock.terminal.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'terminal-1', venueId: 'venue-1', customerDisplayRequestVersion: 5 },
        data: { customerDisplayInverted: true },
      })
      expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
    })

    it('does not commit the business mutation when the atomic audit insert rejects', async () => {
      let committedRequest: unknown = null
      const tx = {
        terminal: {
          updateMany: jest.fn(async ({ data }: { data: { customerDisplayRequest: unknown } }) => {
            committedRequest = { pending: data.customerDisplayRequest }
            return { count: 1 }
          }),
        },
        activityLog: { create: jest.fn().mockRejectedValue(new Error('audit unavailable')) },
      }
      prismaMock.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => {
        const before = committedRequest
        try {
          return await callback(tx)
        } catch (error) {
          committedRequest = before
          throw error
        }
      })

      await expect(
        createDisplayModeRequest({
          venueId: 'venue-1',
          terminalId: 'terminal-1',
          desiredInverted: true,
          requestedBy: 'staff-1',
          now: NOW,
        }),
      ).rejects.toThrow('audit unavailable')

      expect(tx.terminal.updateMany).toHaveBeenCalledTimes(1)
      expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
      expect(committedRequest).toBeNull()
      expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(1)
    })

    it('updates a local physical value without changing or resolving the current request', async () => {
      const current = request()
      prismaMock.terminal.updateMany.mockResolvedValue({ count: 1 })
      prismaMock.terminal.findFirst.mockResolvedValue(
        terminalSnapshot({
          customerDisplayRequest: current,
          customerDisplayRequestVersion: 7,
          customerDisplayRequestExpiresAt: new Date(EXPIRES_AT),
          customerDisplayInverted: false,
        }),
      )

      const result = await updateLocalDisplayMode({
        venueId: 'venue-1',
        terminalId: 'terminal-1',
        confirmedInverted: true,
      })

      expect(prismaMock.terminal.updateMany).toHaveBeenCalledWith({
        where: { id: 'terminal-1', venueId: 'venue-1' },
        data: { customerDisplayInverted: true },
      })
      expect(result).toEqual({
        mutated: true,
        version: 7,
        request: current,
        customerDisplayInverted: true,
        previousCustomerDisplayInverted: false,
      })
      expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    })

    it('binds a mobile local update to the exact POS Android device in both read and write predicates', async () => {
      const current = request()
      prismaMock.terminal.findFirst.mockResolvedValue(
        terminalSnapshot({
          customerDisplayRequest: current,
          customerDisplayRequestVersion: 7,
          customerDisplayRequestExpiresAt: new Date(EXPIRES_AT),
        }),
      )

      await updateLocalDisplayMode({
        venueId: 'venue-1',
        terminalId: 'terminal-1',
        confirmedInverted: true,
        binding: { deviceUid: 'device-1', type: 'POS_ANDROID' },
      })

      expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith({
        where: { id: 'terminal-1', venueId: 'venue-1', deviceUid: 'device-1', type: 'POS_ANDROID' },
        select: expect.any(Object),
      })
      expect(prismaMock.terminal.updateMany).toHaveBeenCalledWith({
        where: { id: 'terminal-1', venueId: 'venue-1', deviceUid: 'device-1', type: 'POS_ANDROID' },
        data: { customerDisplayInverted: true },
      })
    })

    it('cannot mutate another device when the exact mobile binding is lost between snapshot and CAS', async () => {
      prismaMock.terminal.findFirst.mockResolvedValueOnce(
        terminalSnapshot({
          customerDisplayRequest: request(),
          customerDisplayRequestVersion: 2,
          customerDisplayRequestExpiresAt: new Date(EXPIRES_AT),
        }),
      )
      prismaMock.terminal.findFirst.mockResolvedValueOnce(null)
      prismaMock.terminal.updateMany.mockResolvedValueOnce({ count: 0 })

      await expect(
        acknowledgeDisplayModeRequest({
          venueId: 'venue-1',
          terminalId: 'terminal-1',
          requestId: 'request-a',
          outcome: 'APPLIED',
          confirmedInverted: true,
          binding: { deviceUid: 'device-1', type: 'POS_ANDROID' },
          now: NOW,
        }),
      ).rejects.toMatchObject({ statusCode: 403, code: 'DEVICE_BINDING_MISMATCH' })

      expect(prismaMock.terminal.findFirst).toHaveBeenNthCalledWith(1, {
        where: { id: 'terminal-1', venueId: 'venue-1', deviceUid: 'device-1', type: 'POS_ANDROID' },
        select: expect.any(Object),
      })
      expect(prismaMock.terminal.updateMany).toHaveBeenCalledTimes(1)
      expect(prismaMock.terminal.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'terminal-1',
          venueId: 'venue-1',
          deviceUid: 'device-1',
          type: 'POS_ANDROID',
          customerDisplayRequestVersion: 2,
        },
        data: expect.objectContaining({ customerDisplayInverted: true }),
      })
      expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    })

    it('persists cancel, ACK, and expiry through the shared audited CAS path', async () => {
      prismaMock.terminal.findFirst.mockResolvedValue(
        terminalSnapshot({
          customerDisplayRequest: request(),
          customerDisplayRequestVersion: 2,
          customerDisplayRequestExpiresAt: new Date(EXPIRES_AT),
        }),
      )

      await cancelDisplayModeRequest({
        venueId: 'venue-1',
        terminalId: 'terminal-1',
        requestId: 'request-a',
        cancelledBy: 'staff-2',
        now: NOW,
      })
      expect(prismaMock.activityLog.create).toHaveBeenLastCalledWith({
        data: expect.objectContaining({ staffId: 'staff-2', action: 'DISPLAY_MODE_RESOLVED' }),
      })

      jest.clearAllMocks()
      prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock))
      prismaMock.terminal.findFirst.mockResolvedValue(
        terminalSnapshot({
          customerDisplayRequest: request(),
          customerDisplayRequestVersion: 2,
          customerDisplayRequestExpiresAt: new Date(EXPIRES_AT),
        }),
      )
      prismaMock.terminal.updateMany.mockResolvedValue({ count: 1 })
      prismaMock.activityLog.create.mockResolvedValue({ id: 'audit-ack' })

      await acknowledgeDisplayModeRequest({
        venueId: 'venue-1',
        terminalId: 'terminal-1',
        requestId: 'request-a',
        outcome: 'APPLIED',
        confirmedInverted: true,
        now: NOW,
      })
      expect(prismaMock.terminal.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'terminal-1', venueId: 'venue-1', customerDisplayRequestVersion: 2 },
        data: expect.objectContaining({ customerDisplayInverted: true, customerDisplayRequestExpiresAt: null }),
      })

      jest.clearAllMocks()
      prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock))
      prismaMock.terminal.findFirst.mockResolvedValue(
        terminalSnapshot({
          customerDisplayRequest: request({ expiresAt: NOW.toISOString() }),
          customerDisplayRequestVersion: 3,
          customerDisplayRequestExpiresAt: NOW,
        }),
      )
      prismaMock.terminal.updateMany.mockResolvedValue({ count: 1 })
      prismaMock.activityLog.create.mockResolvedValue({ id: 'audit-expiry' })

      await expireDisplayModeRequest({ venueId: 'venue-1', terminalId: 'terminal-1', now: NOW })
      expect(prismaMock.activityLog.create).toHaveBeenLastCalledWith({
        data: expect.objectContaining({ staffId: null, action: 'DISPLAY_MODE_EXPIRED' }),
      })
    })

    it('retires malformed indexed expiry work atomically without leaking raw payload or changing physical state', async () => {
      const rawSecret = 'raw-request-secret-that-must-not-be-audited'
      prismaMock.terminal.findFirst.mockResolvedValue(
        terminalSnapshot({
          customerDisplayRequest: { requestId: rawSecret, arbitrary: rawSecret },
          customerDisplayRequestVersion: 7,
          customerDisplayRequestExpiresAt: NOW,
          customerDisplayInverted: true,
        }),
      )

      const result = await expireDisplayModeRequest({ venueId: 'venue-1', terminalId: 'terminal-1', now: NOW })

      expect(result).toEqual({ mutated: true, version: 8, request: null, customerDisplayInverted: true })
      expect(prismaMock.terminal.updateMany).toHaveBeenCalledWith({
        where: { id: 'terminal-1', venueId: 'venue-1', customerDisplayRequestVersion: 7 },
        data: {
          customerDisplayRequestVersion: { increment: 1 },
          customerDisplayRequest: Prisma.DbNull,
          customerDisplayRequestExpiresAt: null,
        },
      })
      expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
        data: {
          staffId: null,
          venueId: 'venue-1',
          action: 'DISPLAY_MODE_REQUEST_CORRUPT_RETIRED',
          entity: 'Terminal',
          entityId: 'terminal-1',
          data: { reasonCode: 'INVALID_REQUEST_JSON' },
          ipAddress: null,
          userAgent: null,
        },
      })
      expect(JSON.stringify(prismaMock.activityLog.create.mock.calls)).not.toContain(rawSecret)
    })

    it('retires a divergent indexed expiry mirror with a stable bounded audit reason', async () => {
      prismaMock.terminal.findFirst.mockResolvedValue(
        terminalSnapshot({
          customerDisplayRequest: request({ expiresAt: '2026-08-30T12:30:00.000Z' }),
          customerDisplayRequestVersion: 2,
          customerDisplayRequestExpiresAt: NOW,
          customerDisplayInverted: false,
        }),
      )

      await expect(expireDisplayModeRequest({ venueId: 'venue-1', terminalId: 'terminal-1', now: NOW })).resolves.toMatchObject({
        mutated: true,
        version: 3,
        request: null,
        customerDisplayInverted: false,
      })

      expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'DISPLAY_MODE_REQUEST_CORRUPT_RETIRED',
          venueId: 'venue-1',
          entityId: 'terminal-1',
          data: { reasonCode: 'EXPIRY_MIRROR_DIVERGED' },
        }),
      })
    })

    it('rereads after corrupt-work CAS loss and never clears a concurrent valid replacement', async () => {
      const replacement = request({
        requestId: 'replacement-request',
        expiresAt: '2026-08-30T12:30:00.000Z',
      })
      prismaMock.terminal.findFirst
        .mockResolvedValueOnce(
          terminalSnapshot({
            customerDisplayRequest: { malformed: true },
            customerDisplayRequestVersion: 3,
            customerDisplayRequestExpiresAt: NOW,
          }),
        )
        .mockResolvedValueOnce(
          terminalSnapshot({
            customerDisplayRequest: replacement,
            customerDisplayRequestVersion: 4,
            customerDisplayRequestExpiresAt: new Date(replacement.expiresAt),
          }),
        )
      prismaMock.terminal.updateMany.mockResolvedValueOnce({ count: 0 })

      await expect(expireDisplayModeRequest({ venueId: 'venue-1', terminalId: 'terminal-1', now: NOW })).resolves.toEqual({
        mutated: false,
        version: 4,
        request: replacement,
        customerDisplayInverted: false,
        disposition: 'NOT_DUE',
      })

      expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(2)
      expect(prismaMock.terminal.updateMany).toHaveBeenCalledTimes(1)
      expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    })

    it('rolls back corrupt retirement when its atomic audit insert fails', async () => {
      const corrupt = { malformed: 'payload-must-survive-rollback' }
      let committedRequest: unknown = corrupt
      const tx = {
        terminal: {
          updateMany: jest.fn(async ({ data }: { data: { customerDisplayRequest: unknown } }) => {
            committedRequest = data.customerDisplayRequest
            return { count: 1 }
          }),
        },
        activityLog: { create: jest.fn().mockRejectedValue(new Error('corrupt audit unavailable')) },
      }
      prismaMock.terminal.findFirst.mockResolvedValue(
        terminalSnapshot({
          customerDisplayRequest: corrupt,
          customerDisplayRequestVersion: 9,
          customerDisplayRequestExpiresAt: NOW,
        }),
      )
      prismaMock.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => {
        const before = committedRequest
        try {
          return await callback(tx)
        } catch (error) {
          committedRequest = before
          throw error
        }
      })

      await expect(expireDisplayModeRequest({ venueId: 'venue-1', terminalId: 'terminal-1', now: NOW })).rejects.toThrow(
        'corrupt audit unavailable',
      )

      expect(tx.terminal.updateMany).toHaveBeenCalledTimes(1)
      expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
      expect(committedRequest).toBe(corrupt)
    })

    it('validates identifiers and ACK physical/result combinations before any database read', async () => {
      await expect(
        createDisplayModeRequest({ venueId: '', terminalId: 'terminal-1', desiredInverted: true, requestedBy: 'staff-1' }),
      ).rejects.toMatchObject({ code: 'DISPLAY_MODE_INVALID_INPUT', statusCode: 422 })
      await expect(
        acknowledgeDisplayModeRequest({
          venueId: 'venue-1',
          terminalId: 'terminal-1',
          requestId: 'request-a',
          outcome: 'APPLIED',
        }),
      ).rejects.toMatchObject({ code: 'DISPLAY_MODE_INVALID_INPUT', statusCode: 422 })
      await expect(
        acknowledgeDisplayModeRequest({
          venueId: 'venue-1',
          terminalId: 'terminal-1',
          requestId: 'request-a',
          outcome: 'REJECTED',
          resultCode: 'LOCAL_OVERRIDE',
        }),
      ).rejects.toMatchObject({ code: 'DISPLAY_MODE_INVALID_INPUT', statusCode: 422 })
      await expect(
        acknowledgeDisplayModeRequest({
          venueId: 'venue-1',
          terminalId: 'terminal-1',
          requestId: 'request-a',
          outcome: 'REJECTED',
          resultCode: 'NOT_A_REAL_RESULT' as never,
        }),
      ).rejects.toMatchObject({ code: 'DISPLAY_MODE_INVALID_INPUT', statusCode: 422 })
      await expect(
        acknowledgeDisplayModeRequest({
          venueId: 'venue-1',
          terminalId: 'terminal-1',
          requestId: 'request-a',
          outcome: 'REJECTED',
          resultCode: 'APPLY_FAILED',
          confirmedInverted: 'true' as never,
        }),
      ).rejects.toMatchObject({ code: 'DISPLAY_MODE_INVALID_INPUT', statusCode: 422 })
      expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
    })
  })
})
