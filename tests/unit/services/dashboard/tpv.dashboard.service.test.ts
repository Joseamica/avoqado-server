import { prismaMock } from '@tests/__helpers__/setup'
import { getVenueTpvSettings } from '@/services/dashboard/tpv.dashboard.service'

const venueId = 'venue-123'
const orgId = 'org-456'

describe('getVenueTpvSettings — inheritance tests', () => {
  // ─── Tier 1: No terminal, no org config → hardcoded defaults ─────────

  it('should return hardcoded defaults when no terminal and no org config', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(null)
    prismaMock.venueSettings.findFirst.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: orgId } as any)
    prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue(null)

    const result = await getVenueTpvSettings(venueId)

    // All values should be system defaults
    expect(result.attendanceTracking).toBe(false)
    expect(result.enableCashPayments).toBe(true)
    expect(result.enableCardPayments).toBe(true)
    expect(result.enableBarcodeScanner).toBe(true)
    expect(result.requireDepositPhoto).toBe(false)
    expect(result.requireFacadePhoto).toBe(false)
    expect(result.expectedCheckInTime).toBe('09:00')
    expect(result.latenessThresholdMinutes).toBe(30)
    expect(result.geofenceRadiusMeters).toBe(500)
  })

  // ─── Tier 2: No terminal → falls back to org config JSON ────────────

  it('should use org config settings JSON when no terminal exists', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(null)
    prismaMock.venueSettings.findFirst.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: orgId } as any)
    prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue({
      organizationId: orgId,
      settings: {
        attendanceTracking: true,
        enableCashPayments: false,
        enableBarcodeScanner: false,
      },
      // Individual columns (should be overridden by JSON)
      attendanceTracking: false,
      enableCashPayments: true,
    } as any)

    const result = await getVenueTpvSettings(venueId)

    // JSON settings take priority over individual columns
    expect(result.attendanceTracking).toBe(true) // JSON says true
    expect(result.enableCashPayments).toBe(false) // JSON says false
    expect(result.enableBarcodeScanner).toBe(false) // JSON says false
    // Fields not in JSON → fall through to individual columns or defaults
    expect(result.enableCardPayments).toBe(true) // default
  })

  // ─── Tier 2b: No terminal, org config has individual columns only ───

  it('should fall back to org config individual columns when no JSON', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(null)
    prismaMock.venueSettings.findFirst.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: orgId } as any)
    prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue({
      organizationId: orgId,
      settings: null, // No JSON — backward compat mode
      attendanceTracking: true,
      enableCashPayments: false,
      enableCardPayments: false,
      enableBarcodeScanner: true,
      requireDepositPhoto: true,
      requireFacadePhoto: true,
      expectedCheckInTime: '08:00',
      latenessThresholdMinutes: 15,
      geofenceRadiusMeters: 200,
    } as any)

    const result = await getVenueTpvSettings(venueId)

    // Individual columns used as fallback
    expect(result.attendanceTracking).toBe(true)
    expect(result.enableCashPayments).toBe(false)
    expect(result.enableCardPayments).toBe(false)
    expect(result.requireDepositPhoto).toBe(true)
    expect(result.requireFacadePhoto).toBe(true)
    expect(result.expectedCheckInTime).toBe('08:00')
    expect(result.latenessThresholdMinutes).toBe(15)
    expect(result.geofenceRadiusMeters).toBe(200)
  })

  // ─── Tier 3: Terminal config overrides org config ───────────────────

  it('should use terminal settings when they exist, overriding org config', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({
      config: {
        settings: {
          enableCashPayments: false,
          enableCardPayments: false,
          requireClockInPhoto: true, // source of truth for attendanceTracking
        },
      },
    } as any)
    prismaMock.venueSettings.findFirst.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: orgId } as any)
    prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue({
      organizationId: orgId,
      settings: {
        enableCashPayments: true, // org says true, terminal says false
        enableCardPayments: true, // org says true, terminal says false
        attendanceTracking: false, // org says false
      },
    } as any)

    const result = await getVenueTpvSettings(venueId)

    // Terminal overrides org
    expect(result.enableCashPayments).toBe(false)
    expect(result.enableCardPayments).toBe(false)
    // attendanceTracking comes from terminal's requireClockInPhoto
    expect(result.attendanceTracking).toBe(true)
  })

  // ─── Key scenario: Terminal has partial config → org fills gaps ─────

  it('should use org config for fields not present in terminal config', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({
      config: {
        settings: {
          enableCashPayments: false,
          // enableCardPayments NOT set → should fall through to org/defaults
          // requireClockInPhoto NOT set → should fall through to org/defaults
        },
      },
    } as any)
    prismaMock.venueSettings.findFirst.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: orgId } as any)
    prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue({
      organizationId: orgId,
      settings: {
        enableCardPayments: false, // org overrides default (true)
        attendanceTracking: true, // org enables attendance
      },
    } as any)

    const result = await getVenueTpvSettings(venueId)

    // Terminal explicitly set this
    expect(result.enableCashPayments).toBe(false)
    // Terminal didn't set this → org config used
    expect(result.enableCardPayments).toBe(false) // org says false
    // Terminal has no requireClockInPhoto → falls to org attendanceTracking
    expect(result.attendanceTracking).toBe(true) // org says true
  })

  // ─── Scenario: Global applied AFTER terminal already has config ─────

  it('after org push, terminal config reflects merged org settings', async () => {
    // Simulates what happens after upsertOrgTpvDefaults pushes to terminals:
    // Terminal config has been overwritten with org settings
    prismaMock.terminal.findFirst.mockResolvedValue({
      config: {
        settings: {
          showTipScreen: false, // from org push
          showReviewScreen: true, // from org push
          enableCashPayments: false, // from org push
          enableCardPayments: true, // from org push
          requireClockInPhoto: true, // from org push (attendanceTracking)
          kioskDefaultMerchantId: 'merchant-abc', // preserved per-terminal
        },
      },
    } as any)
    prismaMock.venueSettings.findFirst.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: orgId } as any)
    prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue({
      organizationId: orgId,
      settings: {
        showTipScreen: false,
        showReviewScreen: true,
        enableCashPayments: false,
        attendanceTracking: true,
      },
    } as any)

    const result = await getVenueTpvSettings(venueId)

    // All values come from terminal (which was pushed from org)
    expect(result.enableCashPayments).toBe(false)
    expect(result.enableCardPayments).toBe(true)
    expect(result.attendanceTracking).toBe(true)
  })

  // ─── Scenario: Venue with no org → only terminal + hardcoded defaults ─

  it('should work when venue has no organization', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({
      config: {
        settings: {
          enableCashPayments: false,
        },
      },
    } as any)
    prismaMock.venueSettings.findFirst.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: null } as any)

    const result = await getVenueTpvSettings(venueId)

    expect(result.enableCashPayments).toBe(false) // terminal
    expect(result.enableCardPayments).toBe(true) // hardcoded default
    expect(result.attendanceTracking).toBe(false) // hardcoded default
    // org config should NOT be queried
    expect(prismaMock.organizationAttendanceConfig.findUnique).not.toHaveBeenCalled()
  })

  // ─── VenueSettings overrides for time/attendance fields ─────────────

  it('should use venueSettings for time fields over org config', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(null)
    prismaMock.venueSettings.findFirst.mockResolvedValue({
      expectedCheckInTime: '10:30',
      latenessThresholdMinutes: 45,
      geofenceRadiusMeters: 100,
    } as any)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: orgId } as any)
    prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue({
      organizationId: orgId,
      settings: {
        expectedCheckInTime: '08:00', // org says 08:00, venue overrides to 10:30
        latenessThresholdMinutes: 15,
        geofenceRadiusMeters: 300,
      },
    } as any)

    const result = await getVenueTpvSettings(venueId)

    // venueSettings takes priority for these fields
    expect(result.expectedCheckInTime).toBe('10:30')
    expect(result.latenessThresholdMinutes).toBe(45)
    expect(result.geofenceRadiusMeters).toBe(100)
  })

  // ─── Edge: Terminal config exists but settings is empty object ──────

  it('should fall through to org config when terminal settings is empty', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({
      config: { settings: {} },
    } as any)
    prismaMock.venueSettings.findFirst.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: orgId } as any)
    prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue({
      organizationId: orgId,
      settings: {
        enableCashPayments: false,
        attendanceTracking: true,
      },
    } as any)

    const result = await getVenueTpvSettings(venueId)

    // All nullish → fall to org defaults
    expect(result.enableCashPayments).toBe(false) // from org
    expect(result.attendanceTracking).toBe(true) // from org
    expect(result.enableCardPayments).toBe(true) // from system default
  })

  // ─── Edge: Terminal config exists but config.settings is undefined ──

  it('should handle terminal with config but no settings key', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({
      config: { someOtherKey: 'value' }, // no "settings" key
    } as any)
    prismaMock.venueSettings.findFirst.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: orgId } as any)
    prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue({
      organizationId: orgId,
      settings: {
        enableCashPayments: false,
      },
    } as any)

    const result = await getVenueTpvSettings(venueId)

    // Falls through to org defaults
    expect(result.enableCashPayments).toBe(false) // org
    expect(result.enableCardPayments).toBe(true) // system default
  })

  // ─── Error: empty venueId ──────────────────────────────────────────

  it('should throw NotFoundError when venueId is empty', async () => {
    await expect(getVenueTpvSettings('')).rejects.toThrow('El ID del Venue es requerido.')
  })
})
