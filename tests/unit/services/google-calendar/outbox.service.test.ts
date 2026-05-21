/**
 * outbox.service unit tests (Phase 2 — Section C).
 *
 * Covers:
 *   • resolveReservationPushTargets — push disabled, single-target staff/venue
 *     fallback, dual-write fan-out.
 *   • resolveClassSessionPushTargets — same semantics, instructor preferred.
 *   • buildSyncKey — formatter contract.
 *   • enqueuePush — XOR validation + per-target row insert + returned ids.
 *   • collapseSupersededOps — selectivity rules.
 */
import { prismaMock } from '@tests/__helpers__/setup'

import {
  buildSyncKey,
  collapseSupersededOps,
  enqueuePush,
  resolveClassSessionPushTargets,
  resolveReservationPushTargets,
} from '@/services/google-calendar/outbox.service'
import { ValidationError } from '@/errors/AppError'

describe('outbox.service', () => {
  // ============================================================
  // resolveReservationPushTargets
  // ============================================================
  describe('resolveReservationPushTargets', () => {
    it('treats missing ReservationSettings row as schema defaults (pushEnabled=true)', async () => {
      // GET /reservation-settings returns defaults without persisting them, so
      // a venue can connect a calendar without ever materializing the settings
      // row. Push must still work in that case — fall back to the schema
      // default (pushEnabled=true, dualWrite=false) instead of silently no-op.
      ;(prismaMock.reservationSettings.findUnique as jest.Mock).mockResolvedValue(null)
      ;(prismaMock.googleCalendarConnection.findFirst as jest.Mock)
        .mockResolvedValueOnce(null) // staff lookup → none
        .mockResolvedValueOnce({ id: 'conn-venue' }) // venue lookup

      const targets = await resolveReservationPushTargets(prismaMock, {
        venueId: 'venue-1',
        assignedStaffId: 'staff-1',
      })

      expect(targets).toEqual([{ id: 'conn-venue', scope: 'VENUE' }])
    })

    it('returns [] when googleCalendarPushEnabled=false', async () => {
      ;(prismaMock.reservationSettings.findUnique as jest.Mock).mockResolvedValue({
        googleCalendarPushEnabled: false,
        googleCalendarDualWrite: false,
      })

      const targets = await resolveReservationPushTargets(prismaMock, {
        venueId: 'venue-1',
        assignedStaffId: 'staff-1',
      })

      expect(targets).toEqual([])
      expect(prismaMock.googleCalendarConnection.findFirst).not.toHaveBeenCalled()
    })

    it('single-target mode: staff connection exists → returns staff only', async () => {
      ;(prismaMock.reservationSettings.findUnique as jest.Mock).mockResolvedValue({
        googleCalendarPushEnabled: true,
        googleCalendarDualWrite: false,
      })
      ;(prismaMock.googleCalendarConnection.findFirst as jest.Mock)
        .mockResolvedValueOnce({ id: 'conn-staff' }) // staff lookup
        .mockResolvedValueOnce({ id: 'conn-venue' }) // venue lookup

      const targets = await resolveReservationPushTargets(prismaMock, {
        venueId: 'venue-1',
        assignedStaffId: 'staff-1',
      })

      expect(targets).toEqual([{ id: 'conn-staff', scope: 'STAFF_PERSONAL' }])
    })

    it('single-target mode: no staff connection → falls back to venue', async () => {
      ;(prismaMock.reservationSettings.findUnique as jest.Mock).mockResolvedValue({
        googleCalendarPushEnabled: true,
        googleCalendarDualWrite: false,
      })
      ;(prismaMock.googleCalendarConnection.findFirst as jest.Mock)
        .mockResolvedValueOnce(null) // staff lookup → none
        .mockResolvedValueOnce({ id: 'conn-venue' }) // venue lookup

      const targets = await resolveReservationPushTargets(prismaMock, {
        venueId: 'venue-1',
        assignedStaffId: 'staff-1',
      })

      expect(targets).toEqual([{ id: 'conn-venue', scope: 'VENUE' }])
    })

    it('single-target mode: no staff + no venue → returns []', async () => {
      ;(prismaMock.reservationSettings.findUnique as jest.Mock).mockResolvedValue({
        googleCalendarPushEnabled: true,
        googleCalendarDualWrite: false,
      })
      ;(prismaMock.googleCalendarConnection.findFirst as jest.Mock).mockResolvedValue(null)

      const targets = await resolveReservationPushTargets(prismaMock, {
        venueId: 'venue-1',
        assignedStaffId: 'staff-1',
      })

      expect(targets).toEqual([])
    })

    it('single-target mode: assignedStaffId=null → only venue lookup runs', async () => {
      ;(prismaMock.reservationSettings.findUnique as jest.Mock).mockResolvedValue({
        googleCalendarPushEnabled: true,
        googleCalendarDualWrite: false,
      })
      ;(prismaMock.googleCalendarConnection.findFirst as jest.Mock).mockResolvedValue({ id: 'conn-venue' })

      const targets = await resolveReservationPushTargets(prismaMock, {
        venueId: 'venue-1',
        assignedStaffId: null,
      })

      expect(targets).toEqual([{ id: 'conn-venue', scope: 'VENUE' }])
      // Only ONE findFirst call — the staff lookup is short-circuited.
      expect(prismaMock.googleCalendarConnection.findFirst).toHaveBeenCalledTimes(1)
    })

    it('dual-write mode: both connections exist → returns both, staff first', async () => {
      ;(prismaMock.reservationSettings.findUnique as jest.Mock).mockResolvedValue({
        googleCalendarPushEnabled: true,
        googleCalendarDualWrite: true,
      })
      ;(prismaMock.googleCalendarConnection.findFirst as jest.Mock)
        .mockResolvedValueOnce({ id: 'conn-staff' })
        .mockResolvedValueOnce({ id: 'conn-venue' })

      const targets = await resolveReservationPushTargets(prismaMock, {
        venueId: 'venue-1',
        assignedStaffId: 'staff-1',
      })

      expect(targets).toEqual([
        { id: 'conn-staff', scope: 'STAFF_PERSONAL' },
        { id: 'conn-venue', scope: 'VENUE' },
      ])
    })

    it('dual-write mode: only venue → returns [venue]', async () => {
      ;(prismaMock.reservationSettings.findUnique as jest.Mock).mockResolvedValue({
        googleCalendarPushEnabled: true,
        googleCalendarDualWrite: true,
      })
      ;(prismaMock.googleCalendarConnection.findFirst as jest.Mock)
        .mockResolvedValueOnce(null) // staff
        .mockResolvedValueOnce({ id: 'conn-venue' })

      const targets = await resolveReservationPushTargets(prismaMock, {
        venueId: 'venue-1',
        assignedStaffId: 'staff-1',
      })

      expect(targets).toEqual([{ id: 'conn-venue', scope: 'VENUE' }])
    })
  })

  // ============================================================
  // resolveClassSessionPushTargets — same logic, just confirm wiring
  // ============================================================
  describe('resolveClassSessionPushTargets', () => {
    it('uses instructor staff connection as preferred target', async () => {
      ;(prismaMock.reservationSettings.findUnique as jest.Mock).mockResolvedValue({
        googleCalendarPushEnabled: true,
        googleCalendarDualWrite: false,
      })
      ;(prismaMock.googleCalendarConnection.findFirst as jest.Mock)
        .mockResolvedValueOnce({ id: 'conn-instructor' })
        .mockResolvedValueOnce({ id: 'conn-venue' })

      const targets = await resolveClassSessionPushTargets(prismaMock, {
        venueId: 'venue-1',
        assignedStaffId: 'instructor-staff',
      })

      expect(targets).toEqual([{ id: 'conn-instructor', scope: 'STAFF_PERSONAL' }])
    })

    it('respects master push toggle for class sessions too', async () => {
      ;(prismaMock.reservationSettings.findUnique as jest.Mock).mockResolvedValue({
        googleCalendarPushEnabled: false,
        googleCalendarDualWrite: true,
      })

      const targets = await resolveClassSessionPushTargets(prismaMock, {
        venueId: 'venue-1',
        assignedStaffId: 'instructor-staff',
      })

      expect(targets).toEqual([])
    })
  })

  // ============================================================
  // buildSyncKey
  // ============================================================
  describe('buildSyncKey', () => {
    it('formats reservation key', () => {
      expect(buildSyncKey({ kind: 'reservation', reservationId: 'res-1', connectionId: 'conn-1' })).toBe('reservation:res-1:conn-1')
    })

    it('formats class key', () => {
      expect(buildSyncKey({ kind: 'class', classSessionId: 'class-1', connectionId: 'conn-1' })).toBe('class:class-1:conn-1')
    })
  })

  // ============================================================
  // enqueuePush
  // ============================================================
  describe('enqueuePush', () => {
    beforeEach(() => {
      ;(prismaMock.calendarSyncOutbox.create as jest.Mock).mockImplementation((args: any) =>
        Promise.resolve({ id: `outbox-${args.data.targetConnectionId}` }),
      )
    })

    it('throws ValidationError when reservationId is empty', async () => {
      await expect(
        enqueuePush(prismaMock, {
          source: { kind: 'reservation', reservationId: '' },
          venueId: 'venue-1',
          operation: 'CREATE',
          targetConnectionIds: ['conn-1'],
        }),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('throws ValidationError when classSessionId is empty', async () => {
      await expect(
        enqueuePush(prismaMock, {
          source: { kind: 'class', classSessionId: '' },
          venueId: 'venue-1',
          operation: 'CREATE',
          targetConnectionIds: ['conn-1'],
        }),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('returns [] for empty target list without touching DB', async () => {
      const ids = await enqueuePush(prismaMock, {
        source: { kind: 'reservation', reservationId: 'res-1' },
        venueId: 'venue-1',
        operation: 'CREATE',
        targetConnectionIds: [],
      })

      expect(ids).toEqual([])
      expect(prismaMock.calendarSyncOutbox.create).not.toHaveBeenCalled()
    })

    it('returns N row IDs for N targets and writes correct fields', async () => {
      const ids = await enqueuePush(prismaMock, {
        source: { kind: 'reservation', reservationId: 'res-1' },
        venueId: 'venue-1',
        operation: 'CREATE',
        targetConnectionIds: ['conn-a', 'conn-b'],
      })

      expect(ids).toEqual(['outbox-conn-a', 'outbox-conn-b'])
      expect(prismaMock.calendarSyncOutbox.create).toHaveBeenCalledTimes(2)

      const firstCall = (prismaMock.calendarSyncOutbox.create as jest.Mock).mock.calls[0][0]
      expect(firstCall.data).toMatchObject({
        venueId: 'venue-1',
        reservationId: 'res-1',
        classSessionId: null,
        operation: 'CREATE',
        targetConnectionId: 'conn-a',
        syncKey: 'reservation:res-1:conn-a',
        status: 'PENDING',
        attempts: 0,
      })
      // idempotencyKey starts with the syncKey + operation prefix
      expect(firstCall.data.idempotencyKey).toMatch(/^reservation:res-1:conn-a:CREATE:\d+$/)
    })

    it('writes classSessionId / null reservationId for class kind', async () => {
      await enqueuePush(prismaMock, {
        source: { kind: 'class', classSessionId: 'class-1' },
        venueId: 'venue-1',
        operation: 'UPDATE_ROSTER',
        targetConnectionIds: ['conn-x'],
        debounceUntil: new Date('2026-05-20T00:00:00Z'),
      })

      const call = (prismaMock.calendarSyncOutbox.create as jest.Mock).mock.calls[0][0]
      expect(call.data).toMatchObject({
        reservationId: null,
        classSessionId: 'class-1',
        operation: 'UPDATE_ROSTER',
        syncKey: 'class:class-1:conn-x',
        debounceUntil: new Date('2026-05-20T00:00:00Z'),
      })
    })
  })

  // ============================================================
  // collapseSupersededOps
  // ============================================================
  describe('collapseSupersededOps', () => {
    it('marks PENDING/FAILED CREATE/UPDATE/UPDATE_ROSTER rows as SKIPPED', async () => {
      ;(prismaMock.calendarSyncOutbox.updateMany as jest.Mock).mockResolvedValue({ count: 3 })

      const beforeCreatedAt = new Date('2026-05-15T12:00:00Z')
      const count = await collapseSupersededOps(prismaMock, 'reservation:res-1:conn-1', beforeCreatedAt)

      expect(count).toBe(3)
      const call = (prismaMock.calendarSyncOutbox.updateMany as jest.Mock).mock.calls[0][0]
      expect(call.where).toMatchObject({
        syncKey: 'reservation:res-1:conn-1',
        status: { in: ['PENDING', 'FAILED'] },
        operation: { in: ['CREATE', 'UPDATE', 'UPDATE_ROSTER'] },
        createdAt: { lt: beforeCreatedAt },
      })
      expect(call.data).toMatchObject({
        status: 'SKIPPED',
        lastError: 'superseded_by_cancel',
      })
    })

    it('does NOT include IN_PROGRESS or SUCCESS in the where clause', async () => {
      ;(prismaMock.calendarSyncOutbox.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
      await collapseSupersededOps(prismaMock, 'reservation:res-1:conn-1', new Date())

      const call = (prismaMock.calendarSyncOutbox.updateMany as jest.Mock).mock.calls[0][0]
      expect(call.where.status.in).not.toContain('IN_PROGRESS')
      expect(call.where.status.in).not.toContain('SUCCESS')
      expect(call.where.status.in).not.toContain('SKIPPED')
      expect(call.where.status.in).not.toContain('DEAD_LETTER')
    })

    it('does NOT collapse CANCEL operations (so multiple cancels stay)', async () => {
      ;(prismaMock.calendarSyncOutbox.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
      await collapseSupersededOps(prismaMock, 'reservation:res-1:conn-1', new Date())

      const call = (prismaMock.calendarSyncOutbox.updateMany as jest.Mock).mock.calls[0][0]
      expect(call.where.operation.in).not.toContain('CANCEL')
    })
  })
})
