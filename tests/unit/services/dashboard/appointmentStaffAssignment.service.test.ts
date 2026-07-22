import type { ReservationConfig } from '@/services/dashboard/reservationSettings.service'
import {
  assertOrganizationStaffAvailability,
  assertStaffEligible,
  assertStaffEligibleForPersistedProducts,
  findEligibleStaffForDayWindows,
  isLiveSlotHold,
  lockAppointmentVenue,
  resolveStaffAssignment,
  shouldAutoAssign,
  staffScheduleAllowsWindow,
  type StaffScheduleExceptionWindow,
} from '@/services/dashboard/appointmentStaffAssignment.service'

const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

function hours(open = '09:00', close = '17:00') {
  return Object.fromEntries(weekdays.map(day => [day, { enabled: true, ranges: [{ open, close }] }])) as any
}

function settings(overrides: { capacityMode?: 'pacing' | 'per_staff'; showStaffPicker?: boolean } = {}) {
  return {
    scheduling: {
      defaultDurationMin: 60,
      capacityMode: overrides.capacityMode ?? 'pacing',
    },
    publicBooking: { showStaffPicker: overrides.showStaffPicker ?? false },
    operatingHours: hours(),
  } as ReservationConfig
}

function txMock() {
  return {
    $executeRaw: jest.fn().mockResolvedValue(0),
    staffVenue: { findFirst: jest.fn(), findMany: jest.fn() },
    product: { findMany: jest.fn() },
    productStaff: { findMany: jest.fn() },
    staffSchedule: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
    staffScheduleException: { findMany: jest.fn() },
    reservation: { findFirst: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
    classSession: { findFirst: jest.fn(), findMany: jest.fn() },
    slotHold: { findFirst: jest.fn(), findMany: jest.fn() },
    externalBusyBlock: { findFirst: jest.fn(), findMany: jest.fn() },
  } as any
}

function eligibleTx() {
  const tx = txMock()
  tx.staffVenue.findFirst.mockResolvedValue({
    id: 'sv-1',
    staffId: 'staff-1',
    startDate: new Date('2024-01-01T00:00:00Z'),
    venue: { organizationId: 'org-1', timezone: 'America/Mexico_City' },
  })
  tx.product.findMany.mockResolvedValue([{ id: 'product-1', duration: 60, durationMinutes: null }])
  tx.productStaff.findMany.mockResolvedValue([{ productId: 'product-1' }])
  tx.staffSchedule.findFirst.mockResolvedValue(null)
  tx.staffScheduleException.findMany.mockResolvedValue([])
  tx.externalBusyBlock.findFirst.mockResolvedValue(null)
  tx.staffVenue.findMany.mockResolvedValue([{ venueId: 'venue-1' }])
  tx.reservation.findFirst.mockResolvedValue(null)
  tx.classSession.findFirst.mockResolvedValue(null)
  tx.slotHold.findFirst.mockResolvedValue(null)
  return tx
}

describe('isLiveSlotHold', () => {
  const checkedAt = new Date('2026-07-21T12:00:00.000Z')

  it.each([
    ['normal live', { expiresAt: new Date('2026-07-21T12:00:01Z'), heldForReservationId: null }, true],
    ['normal at equality', { expiresAt: checkedAt, heldForReservationId: null }, false],
    ['normal expired', { expiresAt: new Date('2026-07-21T11:59:59Z'), heldForReservationId: null }, false],
    [
      'reschedule pending',
      {
        expiresAt: new Date('2026-07-21T12:00:01Z'),
        heldForReservationId: 'r1',
        heldForReservation: { status: 'PENDING' },
      },
      true,
    ],
    [
      'reschedule confirmed',
      {
        expiresAt: new Date('2026-07-21T12:00:01Z'),
        heldForReservationId: 'r1',
        heldForReservation: { status: 'CONFIRMED' },
      },
      true,
    ],
    [
      'reschedule checked in',
      {
        expiresAt: new Date('2026-07-21T12:00:01Z'),
        heldForReservationId: 'r1',
        heldForReservation: { status: 'CHECKED_IN' },
      },
      false,
    ],
    [
      'reschedule completed',
      {
        expiresAt: new Date('2026-07-21T12:00:01Z'),
        heldForReservationId: 'r1',
        heldForReservation: { status: 'COMPLETED' },
      },
      false,
    ],
    [
      'reschedule cancelled',
      {
        expiresAt: new Date('2026-07-21T12:00:01Z'),
        heldForReservationId: 'r1',
        heldForReservation: { status: 'CANCELLED' },
      },
      false,
    ],
    [
      'reschedule no-show',
      {
        expiresAt: new Date('2026-07-21T12:00:01Z'),
        heldForReservationId: 'r1',
        heldForReservation: { status: 'NO_SHOW' },
      },
      false,
    ],
    [
      'reschedule missing parent',
      { expiresAt: new Date('2026-07-21T12:00:01Z'), heldForReservationId: 'r1', heldForReservation: null },
      false,
    ],
    ['invalid expiry', { expiresAt: new Date('invalid'), heldForReservationId: null }, false],
  ])('%s', (_label, hold, expected) => {
    expect(isLiveSlotHold(hold as any, checkedAt)).toBe(expected)
  })
})

describe('staffScheduleAllowsWindow', () => {
  const timezone = 'America/Mexico_City'
  const window = (startHour: number, durationMin = 60) => ({
    startsAt: new Date(Date.UTC(2026, 6, 21, startHour + 6)),
    endsAt: new Date(Date.UTC(2026, 6, 21, startHour + 6, durationMin)),
    timezone,
    weekly: hours(),
    exceptions: [] as StaffScheduleExceptionWindow[],
    venueOperatingHours: hours(),
  })

  it('uses the explicit non-UTC venue timezone for inside/outside/cross-close windows', () => {
    expect(staffScheduleAllowsWindow(window(9))).toBe(true)
    expect(staffScheduleAllowsWindow(window(8))).toBe(false)
    expect(staffScheduleAllowsWindow(window(16, 61))).toBe(false)
  })

  it('gives OFF precedence over every applicable HOURS exception', () => {
    const args = window(11)
    args.exceptions = [
      { startDate: '2026-07-21', endDate: '2026-07-21', kind: 'HOURS', startTime: '10:00', endTime: '15:00' },
      { startDate: '2026-07-21', endDate: '2026-07-21', kind: 'OFF' },
    ]
    expect(staffScheduleAllowsWindow(args)).toBe(false)
  })

  it('normalizes overlapping and adjacent HOURS ranges into one interval', () => {
    const args = window(10, 180)
    args.exceptions = [
      { startDate: '2026-07-21', endDate: '2026-07-21', kind: 'HOURS', startTime: '09:00', endTime: '11:00' },
      { startDate: '2026-07-21', endDate: '2026-07-21', kind: 'HOURS', startTime: '10:30', endTime: '12:00' },
      { startDate: '2026-07-21', endDate: '2026-07-21', kind: 'HOURS', startTime: '12:00', endTime: '14:00' },
    ]
    expect(staffScheduleAllowsWindow(args)).toBe(true)
  })

  it('does not bridge a real gap between separated HOURS ranges', () => {
    const args = window(10, 180)
    args.exceptions = [
      { startDate: '2026-07-21', endDate: '2026-07-21', kind: 'HOURS', startTime: '09:00', endTime: '11:00' },
      { startDate: '2026-07-21', endDate: '2026-07-21', kind: 'HOURS', startTime: '12:00', endTime: '14:00' },
    ]
    expect(staffScheduleAllowsWindow(args)).toBe(false)
  })

  it('applies exception date ranges inclusively on their final local date', () => {
    const args = window(7)
    args.exceptions = [{ startDate: '2026-07-20', endDate: '2026-07-21', kind: 'HOURS', startTime: '07:00', endTime: '08:30' }]
    expect(staffScheduleAllowsWindow(args)).toBe(true)
  })

  it('applies HOURS exceptions even without a weekly row, otherwise falling back to venue hours', () => {
    const args = window(7)
    args.weekly = null
    args.exceptions = [{ startDate: '2026-07-21', endDate: '2026-07-21', kind: 'HOURS', startTime: '07:00', endTime: '08:30' }]
    expect(staffScheduleAllowsWindow(args)).toBe(true)

    args.exceptions = []
    expect(staffScheduleAllowsWindow(args)).toBe(false)
    expect(staffScheduleAllowsWindow({ ...args, startsAt: window(10).startsAt, endsAt: window(10).endsAt })).toBe(true)
  })

  it.each([
    ['reversed window', { startsAt: new Date('2026-07-21T12:00:00Z'), endsAt: new Date('2026-07-21T11:00:00Z') }],
    ['zero-length window', { startsAt: new Date('2026-07-21T12:00:00Z'), endsAt: new Date('2026-07-21T12:00:00Z') }],
    ['invalid timezone', { timezone: 'Mars/Olympus' }],
    ['malformed range', { weekly: { ...hours(), tuesday: { enabled: true, ranges: [{ open: 'bad', close: '17:00' }] } } }],
    [
      'malformed exception date',
      { exceptions: [{ startDate: '2026-02-30', endDate: '2026-02-30', kind: 'HOURS', startTime: '09:00', endTime: '10:00' }] },
    ],
    ['reversed exception dates', { exceptions: [{ startDate: '2026-07-22', endDate: '2026-07-20', kind: 'OFF' }] }],
    ['unknown exception kind', { exceptions: [{ startDate: '2026-07-21', endDate: '2026-07-21', kind: 'OPEN' }] }],
    ['HOURS exception missing times', { exceptions: [{ startDate: '2026-07-21', endDate: '2026-07-21', kind: 'HOURS' }] }],
    ['disabled day', { weekly: { ...hours(), tuesday: { enabled: false, ranges: [] } } }],
  ])('fails closed for %s', (_label, override) => {
    expect(staffScheduleAllowsWindow({ ...window(10), ...override } as any)).toBe(false)
  })
})

describe('flags and locking', () => {
  it.each([
    [false, 'pacing', false, false],
    [false, 'per_staff', true, false],
    [true, 'pacing', false, false],
    [true, 'pacing', true, true],
    [true, 'per_staff', false, true],
    [true, 'per_staff', true, true],
  ] as const)('matches the exact auto-assignment matrix', (appointment, capacityMode, picker, expected) => {
    expect(shouldAutoAssign(appointment, settings({ capacityMode, showStaffPicker: picker }))).toBe(expected)
  })

  it('executes the timeout and venue advisory lock in order', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = []
    const tx = {
      $executeRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: strings.join('?'), values })
        return Promise.resolve(0)
      }),
    } as any
    await lockAppointmentVenue(tx, 'venue-7')
    expect(calls).toEqual([
      { sql: "SET LOCAL lock_timeout = '1500ms'", values: [] },
      { sql: 'SELECT pg_advisory_xact_lock(hashtext(?))', values: ['apt-hold:venue-7'] },
    ])
  })
})

describe('assertOrganizationStaffAvailability', () => {
  const args = {
    organizationId: 'org-1',
    staffId: 'staff-1',
    startsAt: new Date('2026-07-21T15:00:00Z'),
    endsAt: new Date('2026-07-21T16:00:00Z'),
    checkedAt: new Date('2026-07-21T14:00:00Z'),
  }

  function freeTx() {
    const tx = txMock()
    tx.staffVenue.findMany.mockResolvedValue([{ venueId: 'venue-active' }, { venueId: 'venue-inactive' }])
    tx.reservation.findFirst.mockResolvedValue(null)
    tx.classSession.findFirst.mockResolvedValue(null)
    tx.slotHold.findFirst.mockResolvedValue(null)
    tx.externalBusyBlock.findFirst.mockResolvedValue(null)
    return tx
  }

  it('derives organization venues without an active filter and restricts every commitment query to them', async () => {
    const tx = freeTx()
    await assertOrganizationStaffAvailability(tx, args)
    expect(tx.staffVenue.findMany).toHaveBeenCalledWith({
      where: { staffId: 'staff-1', venue: { organizationId: 'org-1' } },
      select: { venueId: true },
    })
    expect(tx.reservation.findFirst.mock.calls[0][0].where.venueId).toEqual({ in: ['venue-active', 'venue-inactive'] })
    expect(tx.classSession.findFirst.mock.calls[0][0].where.venueId).toEqual({ in: ['venue-active', 'venue-inactive'] })
    expect(tx.slotHold.findFirst.mock.calls[0][0].where.venueId).toEqual({ in: ['venue-active', 'venue-inactive'] })
    expect(tx.externalBusyBlock.findFirst.mock.calls[0][0].where).toMatchObject({ staffId: 'staff-1' })
    expect(tx.externalBusyBlock.findFirst.mock.calls[0][0].where).not.toHaveProperty('venueId')
  })

  it.each([
    ['reservation, including legacy non-appointment', 'reservation'],
    ['scheduled class', 'classSession'],
    ['normal/live-reschedule hold', 'slotHold'],
    ['platform-wide personal busy block', 'externalBusyBlock'],
  ])('rejects a %s with one generic conflict payload', async (_label, delegate) => {
    const tx = freeTx()
    tx[delegate].findFirst.mockResolvedValue({ id: 'secret-row', confirmationCode: 'SECRET', venueId: 'remote-venue' })
    await expect(assertOrganizationStaffAvailability(tx, args)).rejects.toMatchObject({
      statusCode: 409,
      message: 'El profesionista no está disponible en ese horario',
      details: undefined,
    })
  })

  it('uses only active statuses/live-parent rules, exact half-open overlap, checkedAt and every exclusion', async () => {
    const tx = freeTx()
    await assertOrganizationStaffAvailability(tx, {
      ...args,
      excludeReservationId: 'reservation-self',
      excludeHoldId: 'hold-self',
      excludeClassSessionId: 'class-self',
    })
    expect(tx.reservation.findFirst.mock.calls[0][0]).toMatchObject({
      where: {
        id: { not: 'reservation-self' },
        assignedStaffId: 'staff-1',
        status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] },
        startsAt: { lt: args.endsAt },
        endsAt: { gt: args.startsAt },
      },
      select: { id: true },
    })
    expect(tx.classSession.findFirst.mock.calls[0][0].where).toMatchObject({
      id: { not: 'class-self' },
      status: 'SCHEDULED',
    })
    expect(tx.slotHold.findFirst.mock.calls[0][0].where).toMatchObject({
      id: { not: 'hold-self' },
      expiresAt: { gt: args.checkedAt },
      OR: [{ heldForReservationId: null }, { heldForReservation: { status: { in: ['PENDING', 'CONFIRMED'] } } }],
    })
  })

  it('rejects invalid windows as a Spanish 400 without querying commitments', async () => {
    const tx = freeTx()
    await expect(assertOrganizationStaffAvailability(tx, { ...args, endsAt: args.startsAt })).rejects.toMatchObject({ statusCode: 400 })
    expect(tx.staffVenue.findMany).not.toHaveBeenCalled()
  })
})

describe('assertStaffEligible', () => {
  const args = {
    venueId: 'venue-1',
    staffId: 'staff-1',
    productIds: [' product-1 ', 'product-1'],
    startsAt: new Date('2026-07-21T15:00:00Z'),
    endsAt: new Date('2026-07-21T16:00:00Z'),
    checkedAt: new Date('2026-07-21T14:00:00Z'),
    settings: settings({ capacityMode: 'per_staff' }),
  }

  it('requires the exact active membership and active Staff and round-trips Staff.id', async () => {
    const tx = eligibleTx()
    await assertStaffEligible(tx, args)
    expect(tx.staffVenue.findFirst.mock.calls[0][0]).toEqual({
      where: { venueId: 'venue-1', staffId: 'staff-1', active: true, staff: { active: true } },
      select: {
        id: true,
        staffId: true,
        startDate: true,
        venue: { select: { organizationId: true, timezone: true } },
      },
    })
  })

  it('canonicalizes stable products and requires the mapping intersection for the exact membership', async () => {
    const tx = eligibleTx()
    tx.product.findMany.mockResolvedValue([
      { id: 'product-2', duration: 30, durationMinutes: null },
      { id: 'product-1', duration: 30, durationMinutes: null },
    ])
    tx.productStaff.findMany.mockResolvedValue([{ productId: 'product-2' }, { productId: 'product-1' }])
    await assertStaffEligible(tx, { ...args, productIds: ['product-1', 'product-2', 'product-1'] })
    expect(tx.product.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ['product-1', 'product-2'] },
      venueId: 'venue-1',
      type: 'APPOINTMENTS_SERVICE',
    })
    expect(tx.productStaff.findMany.mock.calls[0][0].where).toEqual({
      venueId: 'venue-1',
      staffVenueId: 'sv-1',
      productId: { in: ['product-1', 'product-2'] },
    })
  })

  it('validates already-persisted ordered products without consulting current Product duration or catalog rows', async () => {
    const tx = eligibleTx()
    tx.product.findMany.mockRejectedValue(new Error('current Product catalog must not participate in fixed reschedule duration'))
    tx.productStaff.findMany.mockResolvedValue([{ productId: 'product-1' }, { productId: 'product-2' }])

    await assertStaffEligibleForPersistedProducts(tx, {
      ...args,
      productIds: ['product-1', 'product-2'],
      excludeReservationId: 'reservation-self',
    })

    expect(tx.product.findMany).not.toHaveBeenCalled()
    expect(tx.productStaff.findMany).toHaveBeenCalledWith({
      where: {
        venueId: 'venue-1',
        staffVenueId: 'sv-1',
        productId: { in: ['product-1', 'product-2'] },
      },
      select: { productId: true },
    })
    expect(tx.reservation.findFirst.mock.calls[0][0].where.id).toEqual({ not: 'reservation-self' })
  })

  it('treats an explicit empty mapping as ineligible instead of falling back', async () => {
    const tx = eligibleTx()
    tx.productStaff.findMany.mockResolvedValue([])
    await expect(assertStaffEligible(tx, args)).rejects.toMatchObject({ statusCode: 409 })
    expect(tx.staffSchedule.findFirst).not.toHaveBeenCalled()
  })

  it.each([
    ['missing/inactive membership', (tx: any) => tx.staffVenue.findFirst.mockResolvedValue(null)],
    [
      'closed schedule',
      (tx: any) => tx.staffSchedule.findFirst.mockResolvedValue({ weekly: { ...hours(), tuesday: { enabled: false, ranges: [] } } }),
    ],
  ])('rejects %s as a generic Spanish 409', async (_label, mutate) => {
    const tx = eligibleTx()
    mutate(tx)
    await expect(assertStaffEligible(tx, args)).rejects.toMatchObject({
      statusCode: 409,
      message: 'El profesionista no está disponible en ese horario',
      details: undefined,
    })
  })

  it('rejects wrong-tenant/type/product-count inputs as a Spanish 400', async () => {
    const tx = eligibleTx()
    tx.product.findMany.mockResolvedValue([])
    await expect(assertStaffEligible(tx, args)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('loads only date-applicable, tenant-scoped exceptions and checks venue-master blocks before org conflicts', async () => {
    const tx = eligibleTx()
    await assertStaffEligible(tx, { ...args, excludeReservationId: 'r-self', excludeHoldId: 'h-self' })
    expect(tx.staffScheduleException.findMany.mock.calls[0][0].where).toEqual({
      staffVenueId: 'sv-1',
      venueId: 'venue-1',
      startDate: { lte: '2026-07-21' },
      endDate: { gte: '2026-07-21' },
    })
    expect(tx.staffSchedule.findFirst.mock.calls[0][0]).toEqual({
      where: { staffVenueId: 'sv-1', venueId: 'venue-1' },
      select: { weekly: true },
    })
    expect(tx.externalBusyBlock.findFirst.mock.calls[0][0].where).toMatchObject({ OR: [{ venueId: 'venue-1' }] })
    expect(tx.reservation.findFirst.mock.calls[0][0].where.id).toEqual({ not: 'r-self' })
    expect(tx.slotHold.findFirst.mock.calls[0][0].where.id).toEqual({ not: 'h-self' })
  })

  it('returns a generic 409 for an otherwise eligible busy staff member', async () => {
    const tx = eligibleTx()
    tx.reservation.findFirst.mockResolvedValue({ id: 'secret', confirmationCode: 'DO-NOT-LEAK' })
    await expect(assertStaffEligible(tx, args)).rejects.toMatchObject({
      statusCode: 409,
      message: 'El profesionista no está disponible en ese horario',
      details: undefined,
    })
  })

  it('maps an invalid persisted venue timezone to a generic Spanish 409', async () => {
    const tx = eligibleTx()
    tx.staffVenue.findFirst.mockResolvedValue({
      id: 'sv-1',
      staffId: 'staff-1',
      startDate: new Date('2024-01-01T00:00:00Z'),
      venue: { organizationId: 'org-1', timezone: 'Mars/Olympus' },
    })
    await expect(assertStaffEligible(tx, args)).rejects.toMatchObject({
      statusCode: 409,
      message: 'El profesionista no está disponible en ese horario',
      details: undefined,
    })
    expect(tx.staffSchedule.findFirst).not.toHaveBeenCalled()
  })

  it('fails generically on a current venue-master block before organization commitment reads', async () => {
    const tx = eligibleTx()
    tx.externalBusyBlock.findFirst.mockResolvedValue({ id: 'opaque-master-block' })
    await expect(assertStaffEligible(tx, args)).rejects.toMatchObject({
      statusCode: 409,
      message: 'El profesionista no está disponible en ese horario',
      details: undefined,
    })
    expect(tx.staffVenue.findMany).not.toHaveBeenCalled()
    expect(tx.reservation.findFirst).not.toHaveBeenCalled()
    expect(tx.classSession.findFirst).not.toHaveBeenCalled()
    expect(tx.slotHold.findFirst).not.toHaveBeenCalled()
  })

  it('rejects a malformed core window as 400 before any membership or schedule query', async () => {
    const tx = eligibleTx()
    await expect(assertStaffEligible(tx, { ...args, endsAt: args.startsAt })).rejects.toMatchObject({ statusCode: 400 })
    expect(tx.staffVenue.findFirst).not.toHaveBeenCalled()
    expect(tx.staffSchedule.findFirst).not.toHaveBeenCalled()
  })
})

describe('resolveStaffAssignment', () => {
  const args = {
    venueId: 'venue-1',
    productIds: ['product-1'],
    startsAt: new Date('2026-07-21T15:00:00Z'),
    endsAt: new Date('2026-07-21T16:00:00Z'),
    checkedAt: new Date('2026-07-21T14:00:00Z'),
    settings: settings({ capacityMode: 'per_staff' }),
  }

  it('uses explicit eligibility and returns the requested Staff.id, not StaffVenue.id', async () => {
    const tx = eligibleTx()
    await expect(resolveStaffAssignment(tx, { ...args, requestedStaffId: 'staff-1' })).resolves.toBe('staff-1')
    expect(tx.staffVenue.findFirst).toHaveBeenCalled()
  })

  it('returns 409 for an otherwise valid explicit request whose staff is unavailable', async () => {
    const tx = eligibleTx()
    tx.staffVenue.findFirst.mockResolvedValue(null)
    await expect(resolveStaffAssignment(tx, { ...args, requestedStaffId: 'staff-foreign' })).rejects.toMatchObject({
      statusCode: 409,
      message: 'El profesionista no está disponible en ese horario',
    })
  })

  function allocatorTx(timezone = 'America/Mexico_City') {
    const tx = txMock()
    tx.product.findMany.mockResolvedValue([{ id: 'product-1', duration: 60, durationMinutes: null }])
    tx.staffVenue.findMany
      .mockResolvedValueOnce([
        {
          id: 'sv-b',
          staffId: 'staff-b',
          startDate: new Date('2024-01-01T00:00:00Z'),
          venue: { organizationId: 'org-1', timezone },
        },
        {
          id: 'sv-a',
          staffId: 'staff-a',
          startDate: new Date('2024-01-01T00:00:00Z'),
          venue: { organizationId: 'org-1', timezone },
        },
        {
          id: 'sv-old',
          staffId: 'staff-old',
          startDate: new Date('2023-01-01T00:00:00Z'),
          venue: { organizationId: 'org-1', timezone },
        },
      ])
      .mockResolvedValueOnce([
        { staffId: 'staff-a', venueId: 'venue-1' },
        { staffId: 'staff-b', venueId: 'venue-1' },
        { staffId: 'staff-old', venueId: 'venue-1' },
        { staffId: 'staff-a', venueId: 'venue-inactive' },
        { staffId: 'staff-b', venueId: 'venue-b-only' },
      ])
    tx.productStaff.findMany.mockResolvedValue([
      { productId: 'product-1', staffVenueId: 'sv-a' },
      { productId: 'product-1', staffVenueId: 'sv-b' },
      { productId: 'product-1', staffVenueId: 'sv-old' },
    ])
    tx.staffSchedule.findMany.mockResolvedValue([])
    tx.staffScheduleException.findMany.mockResolvedValue([])
    tx.reservation.findMany.mockResolvedValue([])
    tx.classSession.findMany.mockResolvedValue([])
    tx.slotHold.findMany.mockResolvedValue([])
    tx.externalBusyBlock.findMany.mockResolvedValue([])
    tx.reservation.groupBy.mockResolvedValue([])
    return tx
  }

  it('batch-loads candidates and applies reservation count, startDate, then StaffVenue.id tie-breakers', async () => {
    const tx = allocatorTx()
    tx.reservation.groupBy.mockResolvedValue([
      { assignedStaffId: 'staff-old', _count: { _all: 2 } },
      { assignedStaffId: 'staff-b', _count: { _all: 1 } },
      { assignedStaffId: 'staff-a', _count: { _all: 1 } },
    ])
    await expect(resolveStaffAssignment(tx, args)).resolves.toBe('staff-a')
    expect(tx.staffVenue.findMany.mock.calls[0][0].where).toEqual({
      venueId: 'venue-1',
      active: true,
      staff: { active: true },
    })
    expect(tx.staffVenue.findFirst).not.toHaveBeenCalled()
    expect(tx.staffVenue.findMany).toHaveBeenCalledTimes(2)
    expect(tx.productStaff.findMany).toHaveBeenCalledTimes(1)
    expect(tx.staffSchedule.findMany).toHaveBeenCalledTimes(1)
    expect(tx.staffScheduleException.findMany).toHaveBeenCalledTimes(1)
    expect(tx.reservation.findMany).toHaveBeenCalledTimes(1)
    expect(tx.classSession.findMany).toHaveBeenCalledTimes(1)
    expect(tx.slotHold.findMany).toHaveBeenCalledTimes(1)
    expect(tx.externalBusyBlock.findMany).toHaveBeenCalledTimes(1)
    expect(tx.reservation.groupBy).toHaveBeenCalledTimes(1)
  })

  it('uses venue-local DST-safe calendar boundaries and all active statuses for load counts', async () => {
    const tx = allocatorTx()
    await resolveStaffAssignment(tx, args)
    const where = tx.reservation.groupBy.mock.calls[0][0].where
    expect(where.status).toEqual({ in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] })
    expect(where.startsAt.gte.toISOString()).toBe('2026-07-21T06:00:00.000Z')
    expect(where.startsAt.lt.toISOString()).toBe('2026-07-22T06:00:00.000Z')
  })

  it('constructs calendar midnights across a 23-hour DST day without adding 24 hours', async () => {
    const tx = allocatorTx('America/New_York')
    await resolveStaffAssignment(tx, {
      ...args,
      startsAt: new Date('2026-03-08T15:00:00.000Z'),
      endsAt: new Date('2026-03-08T16:00:00.000Z'),
      checkedAt: new Date('2026-03-08T14:00:00.000Z'),
    })
    const startsAt = tx.reservation.groupBy.mock.calls[0][0].where.startsAt
    expect(startsAt.gte.toISOString()).toBe('2026-03-08T05:00:00.000Z')
    expect(startsAt.lt.toISOString()).toBe('2026-03-09T04:00:00.000Z')
  })

  it('keeps each candidate conflict predicate inside that staff own organization venue set', async () => {
    const tx = allocatorTx()
    await resolveStaffAssignment(tx, args)
    const reservationWhere = tx.reservation.findMany.mock.calls[0][0].where
    expect(reservationWhere.OR).toEqual([
      { assignedStaffId: 'staff-b', venueId: { in: ['venue-1', 'venue-b-only'] } },
      { assignedStaffId: 'staff-a', venueId: { in: ['venue-1', 'venue-inactive'] } },
      { assignedStaffId: 'staff-old', venueId: { in: ['venue-1'] } },
    ])
  })

  it('keeps A free while B is busy in a venue owned only by B', async () => {
    const tx = allocatorTx()
    tx.staffVenue.findMany.mockReset()
    tx.staffVenue.findMany
      .mockResolvedValueOnce([
        {
          id: 'sv-b',
          staffId: 'staff-b',
          startDate: new Date('2024-01-01T00:00:00Z'),
          venue: { organizationId: 'org-1', timezone: 'America/Mexico_City' },
        },
        {
          id: 'sv-a',
          staffId: 'staff-a',
          startDate: new Date('2024-01-01T00:00:00Z'),
          venue: { organizationId: 'org-1', timezone: 'America/Mexico_City' },
        },
      ])
      .mockResolvedValueOnce([
        { staffId: 'staff-a', venueId: 'venue-1' },
        { staffId: 'staff-b', venueId: 'venue-1' },
        { staffId: 'staff-b', venueId: 'venue-b-only' },
      ])
    tx.productStaff.findMany.mockResolvedValue([
      { productId: 'product-1', staffVenueId: 'sv-a' },
      { productId: 'product-1', staffVenueId: 'sv-b' },
    ])
    const storedReservations = [
      { assignedStaffId: 'staff-a', venueId: 'venue-b-only' },
      { assignedStaffId: 'staff-b', venueId: 'venue-b-only' },
    ]
    let selectedReservations: Array<{ assignedStaffId: string }> = []
    tx.reservation.findMany.mockImplementation(({ where }: any) => {
      if (!Array.isArray(where.OR)) throw new Error('Allocator reservation query must keep candidate scopes correlated')
      selectedReservations = storedReservations
        .filter(row =>
          where.OR.some((branch: any) => branch.assignedStaffId === row.assignedStaffId && branch.venueId.in.includes(row.venueId)),
        )
        .map(row => ({ assignedStaffId: row.assignedStaffId }))
      return selectedReservations
    })

    await expect(resolveStaffAssignment(tx, args)).resolves.toBe('staff-a')
    expect(selectedReservations).toEqual([{ assignedStaffId: 'staff-b' }])
  })

  it('maps an invalid candidate venue timezone to generic allocator exhaustion', async () => {
    const tx = allocatorTx('Mars/Olympus')
    await expect(resolveStaffAssignment(tx, args)).rejects.toMatchObject({
      statusCode: 409,
      message: 'No hay profesionistas disponibles para este horario',
      details: undefined,
    })
    expect(tx.productStaff.findMany).not.toHaveBeenCalled()
  })

  it('fails generically on one venue-master block before second-stage conflict reads', async () => {
    const tx = allocatorTx()
    tx.externalBusyBlock.findFirst.mockResolvedValue({ id: 'opaque-master-block' })
    await expect(resolveStaffAssignment(tx, args)).rejects.toMatchObject({
      statusCode: 409,
      message: 'No hay profesionistas disponibles para este horario',
      details: undefined,
    })
    expect(tx.reservation.findMany).not.toHaveBeenCalled()
    expect(tx.classSession.findMany).not.toHaveBeenCalled()
    expect(tx.slotHold.findMany).not.toHaveBeenCalled()
    expect(tx.externalBusyBlock.findMany).not.toHaveBeenCalled()
    expect(tx.reservation.groupBy).not.toHaveBeenCalled()
  })

  it('combines missing mappings, closed schedules, and busy candidates without N+1', async () => {
    const tx = allocatorTx()
    tx.productStaff.findMany.mockResolvedValue([
      { productId: 'product-1', staffVenueId: 'sv-a' },
      { productId: 'product-1', staffVenueId: 'sv-b' },
    ])
    tx.staffSchedule.findMany.mockResolvedValue([{ staffVenueId: 'sv-b', weekly: { ...hours(), tuesday: { enabled: false, ranges: [] } } }])
    tx.reservation.findMany.mockResolvedValue([{ assignedStaffId: 'staff-a', venueId: 'venue-1' }])
    await expect(resolveStaffAssignment(tx, args)).rejects.toMatchObject({
      statusCode: 409,
      message: 'No hay profesionistas disponibles para este horario',
      details: undefined,
    })
    expect(tx.staffVenue.findFirst).not.toHaveBeenCalled()
  })

  it.each([
    ['reservation', (tx: any) => tx.reservation.findMany.mockResolvedValue([{ assignedStaffId: 'staff-old' }])],
    ['class', (tx: any) => tx.classSession.findMany.mockResolvedValue([{ assignedStaffId: 'staff-old' }])],
    [
      'live hold',
      (tx: any) =>
        tx.slotHold.findMany.mockResolvedValue([
          {
            staffId: 'staff-old',
            expiresAt: new Date('2026-07-21T14:10:00Z'),
            heldForReservationId: null,
            heldForReservation: null,
          },
        ]),
    ],
    ['personal busy block', (tx: any) => tx.externalBusyBlock.findMany.mockResolvedValue([{ staffId: 'staff-old' }])],
  ])('filters an allocated candidate with a batched %s conflict', async (_label, addConflict) => {
    const tx = allocatorTx()
    addConflict(tx)
    await expect(resolveStaffAssignment(tx, args)).resolves.toBe('staff-a')
    expect(tx.staffVenue.findFirst).not.toHaveBeenCalled()
  })

  it('does not count expired or cancelled-parent holds returned by a conservative batch read', async () => {
    const tx = allocatorTx()
    tx.slotHold.findMany.mockResolvedValue([
      {
        staffId: 'staff-old',
        expiresAt: new Date('2026-07-21T13:59:59Z'),
        heldForReservationId: null,
        heldForReservation: null,
      },
      {
        staffId: 'staff-old',
        expiresAt: new Date('2026-07-21T14:10:00Z'),
        heldForReservationId: 'reservation-cancelled',
        heldForReservation: { status: 'CANCELLED' },
      },
    ])
    await expect(resolveStaffAssignment(tx, args)).resolves.toBe('staff-old')
  })

  it('applies every conflict exclusion in batched allocation queries', async () => {
    const tx = allocatorTx()
    await resolveStaffAssignment(tx, { ...args, excludeReservationId: 'r-self', excludeHoldId: 'h-self' })
    expect(tx.reservation.findMany.mock.calls[0][0].where.id).toEqual({ not: 'r-self' })
    expect(tx.slotHold.findMany.mock.calls[0][0].where.id).toEqual({ not: 'h-self' })
    expect(tx.reservation.groupBy.mock.calls[0][0].where.id).toEqual({ not: 'r-self' })
  })

  it('returns Staff.id for the oldest candidate when reservation counts differ', async () => {
    const tx = allocatorTx()
    tx.reservation.groupBy.mockResolvedValue([
      { assignedStaffId: 'staff-a', _count: { _all: 2 } },
      { assignedStaffId: 'staff-b', _count: { _all: 2 } },
    ])
    await expect(resolveStaffAssignment(tx, args)).resolves.toBe('staff-old')
  })

  it('uses StaffVenue.startDate before StaffVenue.id when daily counts tie', async () => {
    const tx = allocatorTx()
    await expect(resolveStaffAssignment(tx, args)).resolves.toBe('staff-old')
  })
})

describe('findEligibleStaffForDayWindows', () => {
  const checkedAt = new Date('2026-07-21T14:00:00.000Z')
  const windows = [
    { startsAt: new Date('2026-07-21T15:00:00.000Z'), endsAt: new Date('2026-07-21T16:00:00.000Z') },
    { startsAt: new Date('2026-07-21T16:00:00.000Z'), endsAt: new Date('2026-07-21T17:00:00.000Z') },
  ]

  function dayReadTx() {
    const tx = txMock()
    tx.staffVenue.findMany
      .mockResolvedValueOnce([
        {
          id: 'sv-b',
          staffId: 'staff-b',
          startDate: new Date('2024-01-01T00:00:00.000Z'),
          venue: { organizationId: 'org-1', timezone: 'UTC' },
          staff: { id: 'staff-b', firstName: 'Beto', lastName: 'Bravo' },
        },
        {
          id: 'sv-a',
          staffId: 'staff-a',
          startDate: new Date('2024-01-01T00:00:00.000Z'),
          venue: { organizationId: 'org-1', timezone: 'UTC' },
          staff: { id: 'staff-a', firstName: 'Ana', lastName: 'Alfa' },
        },
      ])
      .mockResolvedValueOnce([
        { staffId: 'staff-a', venueId: 'venue-1' },
        { staffId: 'staff-b', venueId: 'venue-1' },
        { staffId: 'staff-b', venueId: 'venue-b-only' },
      ])
    tx.productStaff.findMany.mockResolvedValue([
      { productId: 'product-1', staffVenueId: 'sv-a' },
      { productId: 'product-1', staffVenueId: 'sv-b' },
    ])
    tx.staffSchedule.findMany.mockResolvedValue([])
    tx.staffScheduleException.findMany.mockResolvedValue([])
    tx.reservation.findMany.mockResolvedValue([])
    tx.classSession.findMany.mockResolvedValue([])
    tx.slotHold.findMany.mockResolvedValue([])
    tx.externalBusyBlock.findMany.mockResolvedValue([])
    tx.reservation.groupBy.mockResolvedValue([])
    return tx
  }

  const args = {
    venueId: 'venue-1',
    canonicalProductIds: ['product-1'],
    windows,
    checkedAt,
    settings: settings({ capacityMode: 'per_staff' }),
  }

  it('returns aligned Staff.id summaries in allocator order and requires active membership plus active Staff', async () => {
    const tx = dayReadTx()
    await expect(findEligibleStaffForDayWindows(tx, args)).resolves.toEqual([
      [
        { id: 'staff-a', firstName: 'Ana', lastName: 'Alfa' },
        { id: 'staff-b', firstName: 'Beto', lastName: 'Bravo' },
      ],
      [
        { id: 'staff-a', firstName: 'Ana', lastName: 'Alfa' },
        { id: 'staff-b', firstName: 'Beto', lastName: 'Bravo' },
      ],
    ])
    expect(tx.staffVenue.findMany.mock.calls[0][0].where).toEqual({
      venueId: 'venue-1',
      active: true,
      staff: { active: true },
    })
  })

  it('requires the complete multi-product mapping and uses venue hours when no staff weekly row exists', async () => {
    const tx = dayReadTx()
    tx.productStaff.findMany.mockResolvedValue([
      { productId: 'product-1', staffVenueId: 'sv-a' },
      { productId: 'product-2', staffVenueId: 'sv-a' },
      { productId: 'product-1', staffVenueId: 'sv-b' },
    ])

    const result = await findEligibleStaffForDayWindows(tx, { ...args, canonicalProductIds: ['product-1', 'product-2'] })

    expect(result).toEqual([
      [{ id: 'staff-a', firstName: 'Ana', lastName: 'Alfa' }],
      [{ id: 'staff-a', firstName: 'Ana', lastName: 'Alfa' }],
    ])
  })

  it('applies an OFF exception per window without marking the candidate unavailable for the whole day', async () => {
    const tx = dayReadTx()
    tx.staffScheduleException.findMany.mockResolvedValue([
      { staffVenueId: 'sv-a', startDate: '2026-07-21', endDate: '2026-07-21', kind: 'OFF', startTime: null, endTime: null },
    ])

    const result = await findEligibleStaffForDayWindows(tx, { ...args, requestedStaffId: 'staff-a' })

    expect(result).toEqual([[], []])
  })

  it.each([
    [
      'Reservation',
      (tx: any) =>
        tx.reservation.findMany.mockResolvedValue([
          { assignedStaffId: 'staff-a', venueId: 'venue-1', startsAt: windows[0].startsAt, endsAt: windows[0].endsAt },
        ]),
    ],
    [
      'live hold',
      (tx: any) =>
        tx.slotHold.findMany.mockResolvedValue([
          {
            staffId: 'staff-a',
            venueId: 'venue-1',
            startsAt: windows[0].startsAt,
            endsAt: windows[0].endsAt,
            expiresAt: new Date('2026-07-21T14:10:00.000Z'),
            heldForReservationId: null,
            heldForReservation: null,
          },
        ]),
    ],
    [
      'ClassSession',
      (tx: any) =>
        tx.classSession.findMany.mockResolvedValue([
          { assignedStaffId: 'staff-a', venueId: 'venue-1', startsAt: windows[0].startsAt, endsAt: windows[0].endsAt },
        ]),
    ],
    [
      'personal ExternalBusyBlock',
      (tx: any) =>
        tx.externalBusyBlock.findMany.mockResolvedValue([
          { staffId: 'staff-a', venueId: null, startsAt: windows[0].startsAt, endsAt: windows[0].endsAt },
        ]),
    ],
  ])('applies a %s conflict only to overlapping windows', async (_label, addConflict) => {
    const tx = dayReadTx()
    addConflict(tx)

    const result = await findEligibleStaffForDayWindows(tx, { ...args, requestedStaffId: 'staff-a' })

    expect(result).toEqual([[], [{ id: 'staff-a', firstName: 'Ana', lastName: 'Alfa' }]])
  })

  it('applies venue-master blocks per window before returning candidates', async () => {
    const tx = dayReadTx()
    tx.externalBusyBlock.findMany.mockResolvedValue([
      { staffId: null, venueId: 'venue-1', startsAt: windows[0].startsAt, endsAt: windows[0].endsAt },
    ])

    const result = await findEligibleStaffForDayWindows(tx, args)

    expect(result[0]).toEqual([])
    expect(result[1]).toHaveLength(2)
  })

  it('ignores expired and cancelled-parent holds while live normal/PENDING/CONFIRMED holds block', async () => {
    const makeTx = (hold: Record<string, unknown>) => {
      const tx = dayReadTx()
      tx.slotHold.findMany.mockResolvedValue([
        { staffId: 'staff-a', venueId: 'venue-1', startsAt: windows[0].startsAt, endsAt: windows[0].endsAt, ...hold },
      ])
      return tx
    }
    const base = { expiresAt: new Date('2026-07-21T14:10:00.000Z') }

    for (const hold of [
      { ...base, heldForReservationId: null, heldForReservation: null },
      { ...base, heldForReservationId: 'pending', heldForReservation: { status: 'PENDING' } },
      { ...base, heldForReservationId: 'confirmed', heldForReservation: { status: 'CONFIRMED' } },
    ]) {
      const result = await findEligibleStaffForDayWindows(makeTx(hold), { ...args, requestedStaffId: 'staff-a' })
      expect(result[0]).toEqual([])
    }

    for (const hold of [
      { expiresAt: checkedAt, heldForReservationId: null, heldForReservation: null },
      { ...base, heldForReservationId: 'cancelled', heldForReservation: { status: 'CANCELLED' } },
    ]) {
      const result = await findEligibleStaffForDayWindows(makeTx(hold), { ...args, requestedStaffId: 'staff-a' })
      expect(result[0]).toEqual([{ id: 'staff-a', firstName: 'Ana', lastName: 'Alfa' }])
    }
  })

  it('keeps candidate venue scopes correlated and isolates other-organization conflicts behaviorally', async () => {
    const tx = dayReadTx()
    const storedRows = [
      { assignedStaffId: 'staff-a', venueId: 'venue-b-only', startsAt: windows[0].startsAt, endsAt: windows[0].endsAt },
      { assignedStaffId: 'staff-a', venueId: 'other-org', startsAt: windows[0].startsAt, endsAt: windows[0].endsAt },
      { assignedStaffId: 'staff-b', venueId: 'venue-b-only', startsAt: windows[0].startsAt, endsAt: windows[0].endsAt },
    ]
    tx.reservation.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(
        storedRows.filter(row =>
          where.OR.some((branch: any) => branch.assignedStaffId === row.assignedStaffId && branch.venueId.in.includes(row.venueId)),
        ),
      ),
    )

    const result = await findEligibleStaffForDayWindows(tx, args)

    expect(result[0]).toEqual([{ id: 'staff-a', firstName: 'Ana', lastName: 'Alfa' }])
    expect(tx.reservation.findMany.mock.calls[0][0].where.OR).toEqual([
      { assignedStaffId: 'staff-b', venueId: { in: ['venue-1', 'venue-b-only'] } },
      { assignedStaffId: 'staff-a', venueId: { in: ['venue-1'] } },
    ])
  })

  it('returns aligned empty lists instead of throwing when requested staff is absent', async () => {
    const tx = dayReadTx()
    await expect(findEligibleStaffForDayWindows(tx, { ...args, requestedStaffId: 'missing' })).resolves.toEqual([[], []])
  })

  it('uses bounded delegate calls for 27 windows', async () => {
    const tx = dayReadTx()
    const manyWindows = Array.from({ length: 27 }, (_, index) => ({
      startsAt: new Date(Date.UTC(2026, 6, 21, 8, index * 30)),
      endsAt: new Date(Date.UTC(2026, 6, 21, 9, index * 30)),
    }))
    const openAllDay = settings({ capacityMode: 'per_staff' })
    openAllDay.operatingHours = hours('00:00', '23:59')

    const result = await findEligibleStaffForDayWindows(tx, { ...args, windows: manyWindows, settings: openAllDay })

    expect(result).toHaveLength(27)
    expect(tx.staffVenue.findMany).toHaveBeenCalledTimes(2)
    expect(tx.productStaff.findMany).toHaveBeenCalledTimes(1)
    expect(tx.staffSchedule.findMany).toHaveBeenCalledTimes(1)
    expect(tx.staffScheduleException.findMany).toHaveBeenCalledTimes(1)
    expect(tx.reservation.findMany).toHaveBeenCalledTimes(1)
    expect(tx.classSession.findMany).toHaveBeenCalledTimes(1)
    expect(tx.slotHold.findMany).toHaveBeenCalledTimes(1)
    expect(tx.externalBusyBlock.findMany).toHaveBeenCalledTimes(1)
    expect(tx.reservation.groupBy).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid windows as Spanish 400 before querying candidates', async () => {
    const tx = dayReadTx()
    await expect(
      findEligibleStaffForDayWindows(tx, { ...args, windows: [{ startsAt: windows[0].startsAt, endsAt: windows[0].startsAt }] }),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(tx.staffVenue.findMany).not.toHaveBeenCalled()
  })
})
