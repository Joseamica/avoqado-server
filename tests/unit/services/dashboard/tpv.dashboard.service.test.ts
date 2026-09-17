import { Prisma } from '@prisma/client'

import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { getVenueTpvSettings, updateVenueTpvSettings, computeOverrides, updateTpv } from '@/services/dashboard/tpv.dashboard.service'

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

describe('trackPromoterLocation ("cambaceo") — venue-level flag', () => {
  // ─── NEW FEATURE: read ───────────────────────────────────────────────

  it('getVenueTpvSettings returns the VenueSettings value when set', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(null)
    prismaMock.venueSettings.findFirst.mockResolvedValue({
      expectedCheckInTime: null,
      latenessThresholdMinutes: null,
      geofenceRadiusMeters: null,
      trackPromoterLocation: true,
    } as any)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: orgId } as any)
    prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue(null)

    const result = await getVenueTpvSettings(venueId)

    expect(result.trackPromoterLocation).toBe(true)
  })

  it('getVenueTpvSettings defaults trackPromoterLocation to false (REGRESSION: additive, terminal branch too)', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({
      config: { settings: { enableCashPayments: false } },
    } as any)
    prismaMock.venueSettings.findFirst.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: orgId } as any)
    prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue(null)

    const result = await getVenueTpvSettings(venueId)

    expect(result.trackPromoterLocation).toBe(false)
    // Existing fields unaffected
    expect(result.enableCashPayments).toBe(false)
  })

  // ─── NEW FEATURE: write ──────────────────────────────────────────────

  it('updateVenueTpvSettings writes the flag to VenueSettings (upsert) and NOT into terminal configs', async () => {
    // El upsert del negocio viaja en la misma transacción que las terminales (4ª auditoría de Codex, C2).
    transactionRunsBothForms()
    prismaMock.terminal.findMany.mockResolvedValue([{ id: 't1', config: {}, configOverrides: {} }] as any)
    prismaMock.venueSettings.upsert.mockResolvedValue({} as any)
    // return-path read (getVenueTpvSettings)
    prismaMock.terminal.findFirst.mockResolvedValue(null)
    prismaMock.venueSettings.findFirst.mockResolvedValue({ trackPromoterLocation: true } as any)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: orgId } as any)
    prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue(null)

    const result = await updateVenueTpvSettings(venueId, { trackPromoterLocation: true })

    expect(prismaMock.venueSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId },
        update: expect.objectContaining({ trackPromoterLocation: true }),
        create: expect.objectContaining({ venueId, trackPromoterLocation: true }),
      }),
    )
    // Flag-only update must NOT cascade into Terminal.config
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
    expect(prismaMock.terminal.updateMany).not.toHaveBeenCalled()
    expect(result.trackPromoterLocation).toBe(true)
  })
})

describe('computeOverrides — cascade diff computation', () => {
  const baseSettings = {
    showTipScreen: true,
    showReviewScreen: true,
    enableCashPayments: true,
    enableCardPayments: true,
    kioskDefaultMerchantId: null,
  }

  it('should return empty object when terminal matches org defaults', () => {
    const terminalSettings = { ...baseSettings }
    const overrides = computeOverrides(terminalSettings, baseSettings)
    expect(overrides).toEqual({})
  })

  it('should return only the fields that differ from base', () => {
    const terminalSettings = {
      ...baseSettings,
      showTipScreen: false, // different
      enableCashPayments: false, // different
    }
    const overrides = computeOverrides(terminalSettings, baseSettings)
    expect(overrides).toEqual({
      showTipScreen: false,
      enableCashPayments: false,
    })
  })

  it('should always include kioskDefaultMerchantId when non-null', () => {
    const terminalSettings = {
      ...baseSettings,
      kioskDefaultMerchantId: 'merchant-abc',
    }
    const overrides = computeOverrides(terminalSettings, baseSettings)
    expect(overrides).toEqual({
      kioskDefaultMerchantId: 'merchant-abc',
    })
  })

  it('should not include kioskDefaultMerchantId when null', () => {
    const terminalSettings = {
      ...baseSettings,
      kioskDefaultMerchantId: null,
    }
    const overrides = computeOverrides(terminalSettings, baseSettings)
    expect(overrides).toEqual({})
  })

  it('should detect array differences (tipSuggestions)', () => {
    const base = { ...baseSettings, tipSuggestions: [15, 18, 20, 25] }
    const terminal = { ...base, tipSuggestions: [10, 15, 20] }
    const overrides = computeOverrides(terminal, base)
    expect(overrides).toEqual({ tipSuggestions: [10, 15, 20] })
  })

  it('should not flag arrays that match', () => {
    const base = { ...baseSettings, tipSuggestions: [15, 18, 20, 25] }
    const terminal = { ...base, tipSuggestions: [15, 18, 20, 25] }
    const overrides = computeOverrides(terminal, base)
    expect(overrides).toEqual({})
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 🔴 Auditoría de Codex del spec «pantalla del cliente», 3ª ronda (2026-09-16): D1 y sus hermanos.
// ─────────────────────────────────────────────────────────────────────────────────────────────

function p2025() {
  return new Prisma.PrismaClientKnownRequestError('No record was found for an update.', { code: 'P2025', clientVersion: 'test' })
}

/** El `$transaction` global sólo entiende la forma de callback; estas funciones usan la de arreglo. */
function transactionRunsBothForms() {
  prismaMock.$transaction.mockImplementation(((ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops(prismaMock))) as any)
}

describe('updateTpv — el servicio sólo escribe los campos editables, venga de donde venga', () => {
  const terminal = { id: 'terminal-1', venueId, type: 'TPV_ANDROID', name: 'Caja 1' }

  beforeEach(() => {
    prismaMock.terminal.findFirst.mockResolvedValue(terminal as any)
    prismaMock.terminal.update.mockImplementation((({ data }: any) => Promise.resolve({ ...terminal, ...data })) as any)
  })

  it('descarta venueId, assignedMerchantIds, deviceUid y cualquier otra columna aunque se los pasen directo', async () => {
    // Defensa en profundidad: la ruta ya valida, pero cualquier otro llamador (MCP, un job) entra aquí.
    await updateTpv(venueId, 'terminal-1', {
      name: 'Caja 2',
      venueId: 'otro-venue',
      assignedMerchantIds: ['merchant-ajeno'],
      deviceUid: 'aparato-ajeno',
      lastHeartbeat: new Date(),
      customerDisplayRequest: { status: 'PENDING' },
    } as any)

    const { where, data } = prismaMock.terminal.update.mock.calls[0][0] as any
    expect(where).toEqual({ id: 'terminal-1', venueId })
    expect(Object.keys(data).sort()).toEqual(['name', 'updatedAt'])
  })

  it('una serie heredada sin prefijo que el formulario reenvía igual no se reescribe', async () => {
    // La terminal se autentica con su serie: normalizar una serie vieja al renombrar la dejaría fuera.
    prismaMock.terminal.findFirst.mockResolvedValue({ ...terminal, serialNumber: '2841548417' } as any)

    await updateTpv(venueId, 'terminal-1', { name: 'Caja 2', serialNumber: '2841548417' })

    const { data } = prismaMock.terminal.update.mock.calls[0][0] as any
    expect(data).not.toHaveProperty('serialNumber')
  })

  it('una configuración que no es JSON se rechaza en vez de guardarse como texto', async () => {
    await expect(updateTpv(venueId, 'terminal-1', { config: '{"settings": ' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(updateTpv(venueId, 'terminal-1', { config: '[1,2]' })).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
  })

  it('si la terminal ya no es del negocio al escribir, responde 404', async () => {
    prismaMock.terminal.update.mockRejectedValue(p2025())

    await expect(updateTpv(venueId, 'terminal-1', { name: 'Caja 2' })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('la bitácora lleva quién editó y los nombres de los campos, sin valores de la configuración', async () => {
    await updateTpv(venueId, 'terminal-1', { name: 'Caja 2', config: { settings: { secreto: 'x' } } }, { staffId: 'staff-9' })

    const audit = (logAction as jest.Mock).mock.calls.map(([params]) => params).find(params => params?.action === 'TPV_UPDATED')
    expect(audit).toEqual(
      expect.objectContaining({
        staffId: 'staff-9',
        venueId,
        entityId: 'terminal-1',
        data: { name: 'Caja 2', updatedFields: ['config', 'name'] },
      }),
    )
    expect(JSON.stringify(audit)).not.toContain('secreto')
  })
})

// 🔴 Auditorías de Codex del spec «pantalla del cliente» (3ª y 4ª ronda, 2026-09-16/17). Escogía las terminales del
// negocio y las escribía sólo por id; y el horario del negocio se guardaba ANTES, fuera de la transacción, así que un
// error dejaba la mitad guardada. Ahora cada terminal va acotada al negocio, una que se mudó en medio simplemente ya no
// es de este negocio y se omite, y todo lo demás se guarda junto o no se guarda.
describe('updateVenueTpvSettings — el negocio y sus terminales se guardan juntos', () => {
  const auditActions = () => (logAction as jest.Mock).mock.calls.map(([params]) => params?.action)

  beforeEach(() => {
    transactionRunsBothForms()
    prismaMock.terminal.findMany.mockResolvedValue([
      { id: 't1', config: { settings: {} }, configOverrides: null },
      { id: 't2', config: { settings: {} }, configOverrides: null },
    ] as any)
    prismaMock.terminal.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.venueSettings.upsert.mockResolvedValue({} as any)
    prismaMock.terminal.findFirst.mockResolvedValue(null)
    prismaMock.venueSettings.findFirst.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: orgId } as any)
    prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue(null)
  })

  it('acota cada terminal al negocio que la escogió', async () => {
    await updateVenueTpvSettings(venueId, { showTipScreen: false } as any)

    expect(prismaMock.terminal.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 't1', venueId } }))
    expect(prismaMock.terminal.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 't2', venueId } }))
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
  })

  it('el horario del negocio y las terminales van en UNA sola transacción', async () => {
    const upsertOp = Promise.resolve({ venueId })
    prismaMock.venueSettings.upsert.mockReturnValue(upsertOp as any)
    let batch: unknown[] = []
    prismaMock.$transaction.mockImplementation(((ops: any) => {
      batch = ops
      return Promise.all(ops)
    }) as any)

    await updateVenueTpvSettings(venueId, { showTipScreen: false, expectedCheckInTime: '09:30' } as any)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(batch).toHaveLength(3)
    expect(batch).toContain(upsertOp)
    expect(prismaMock.venueSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId }, update: expect.objectContaining({ expectedCheckInTime: '09:30' }) }),
    )
  })

  it('si la transacción falla, el error sube y no se reporta éxito', async () => {
    prismaMock.$transaction.mockRejectedValue(new Error('se cayó la base'))

    await expect(updateVenueTpvSettings(venueId, { showTipScreen: false, expectedCheckInTime: '09:30' } as any)).rejects.toThrow(
      'se cayó la base',
    )
    expect(auditActions()).not.toContain('VENUE_TPV_SETTINGS_UPDATED')
  })

  it('una terminal que se mudó a media operación se omite: no recibe los ajustes y el guardado no falla', async () => {
    prismaMock.terminal.updateMany.mockResolvedValueOnce({ count: 1 } as any).mockResolvedValueOnce({ count: 0 } as any)

    await expect(updateVenueTpvSettings(venueId, { showTipScreen: false } as any)).resolves.toBeDefined()

    expect(logger.info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ venueId, omittedTerminals: 1 }))
    expect(auditActions()).toContain('VENUE_TPV_SETTINGS_UPDATED')
  })
})
