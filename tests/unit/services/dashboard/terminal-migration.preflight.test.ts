import prisma from '@/utils/prismaClient'
import { migratePreflight } from '@/services/dashboard/terminal-migration.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findUnique: jest.fn() },
    venue: { findUnique: jest.fn() },
    venuePaymentConfig: { findFirst: jest.fn(), findUnique: jest.fn() },
    organizationPaymentConfig: { findUnique: jest.fn() },
    merchantAccount: { findMany: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    tpvCommandQueue: { findFirst: jest.fn(), findMany: jest.fn() },
  },
}))

const m = prisma as unknown as {
  terminal: { findUnique: jest.Mock }
  venue: { findUnique: jest.Mock }
  venuePaymentConfig: { findFirst: jest.Mock; findUnique: jest.Mock }
  organizationPaymentConfig: { findUnique: jest.Mock }
  merchantAccount: { findMany: jest.Mock }
  staffVenue: { findFirst: jest.Mock }
  tpvCommandQueue: { findFirst: jest.Mock; findMany: jest.Mock }
}

const healthy = () => {
  m.terminal.findUnique.mockResolvedValue({
    id: 'term-1',
    venueId: 'venue-old',
    status: 'ACTIVE',
    brand: 'PAX',
    assignedMerchantIds: ['merch-p'],
  })
  // Dos venues distintos, misma org por defecto.
  m.venue.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(
      where.id === 'venue-old'
        ? { id: 'venue-old', name: 'Old', organizationId: 'org-1' }
        : { id: 'venue-new', name: 'New', organizationId: 'org-1' },
    ),
  )
  m.venuePaymentConfig.findFirst.mockResolvedValue({ id: 'vpc-1' })
  m.venuePaymentConfig.findUnique.mockResolvedValue({
    primaryAccountId: 'merch-p',
    secondaryAccountId: null,
    tertiaryAccountId: null,
    preferredProcessor: 'AUTO',
    routingRules: null,
  })
  m.organizationPaymentConfig.findUnique.mockResolvedValue(null)
  m.merchantAccount.findMany.mockResolvedValue([{ id: 'merch-p', displayName: 'playtelecom-p' }])
  m.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1' })
  m.tpvCommandQueue.findFirst.mockResolvedValue(null)
  m.tpvCommandQueue.findMany.mockResolvedValue([])
}

describe('migratePreflight', () => {
  beforeEach(() => jest.clearAllMocks())

  it('canProceed=true with no blockers when destination is ready', async () => {
    healthy()
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.canProceed).toBe(true)
    expect(r.blockers).toHaveLength(0)
  })

  it('blocks when destination has no payment config', async () => {
    healthy()
    m.venuePaymentConfig.findFirst.mockResolvedValue(null)
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.canProceed).toBe(false)
    expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'NO_PAYMENT_CONFIG' }))
  })

  it('blocks when destination has no staff with a PIN', async () => {
    healthy()
    m.staffVenue.findFirst.mockResolvedValue(null)
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.canProceed).toBe(false)
    expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'NO_STAFF_PIN' }))
  })

  // FIX 1 regression: the only PIN-holder has an active StaffVenue row but a DEACTIVATED
  // Staff. The TPV login predicate (auth.tpv.service.ts) requires nested `staff.active: true`,
  // so findFirst returns null for that venue → NO_STAFF_PIN must block. We also assert the
  // preflight query mirrors the real login predicate (includes the nested staff-active filter),
  // otherwise such a venue would falsely pass preflight yet nobody could log in.
  it('blocks NO_STAFF_PIN when the only PIN holder has a deactivated Staff (nested staff.active)', async () => {
    healthy()
    // findFirst returns null specifically because the nested `staff: { active: true }` excludes it.
    m.staffVenue.findFirst.mockResolvedValue(null)

    const r = await migratePreflight('term-1', 'venue-new')

    expect(r.canProceed).toBe(false)
    expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'NO_STAFF_PIN' }))

    // The query MUST include the same nested staff-active condition as the real TPV login.
    expect(m.staffVenue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          venueId: 'venue-new',
          pin: { not: null },
          active: true,
          staff: { active: true },
        }),
      }),
    )
  })

  it('blocks when terminal is RETIRED', async () => {
    healthy()
    m.terminal.findUnique.mockResolvedValue({ id: 'term-1', venueId: 'venue-old', status: 'RETIRED', brand: 'PAX' })
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'TERMINAL_RETIRED' }))
  })

  it('blocks when a migration is already in progress', async () => {
    healthy()
    m.tpvCommandQueue.findMany.mockResolvedValue([{ id: 'cmd-x', createdAt: new Date() }])
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'MIGRATION_IN_PROGRESS' }))
  })

  // BUG #1 regression: a FACTORY_RESET never ACKs, so it lingers in a non-terminal status
  // until the 30-min expiry sweep marks it EXPIRED. A stale/expired-but-unswept command must
  // NOT falsely block a new migration — the in-flight query must exclude commands past expiresAt.
  it('MIGRATION_IN_PROGRESS query is expiry-aware (excludes already-expired FACTORY_RESET commands)', async () => {
    healthy()
    await migratePreflight('term-1', 'venue-new')
    expect(m.tpvCommandQueue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          terminalId: 'term-1',
          commandType: 'FACTORY_RESET',
          OR: expect.arrayContaining([
            { expiresAt: null },
            expect.objectContaining({ expiresAt: expect.objectContaining({ gt: expect.any(Date) }) }),
          ]),
        }),
      }),
    )
  })

  // Asana 1218069201250971 (2026-09-01): a FACTORY_RESET never ACKs, so a command with NO
  // expiresAt (hand-inserted rows, `payload.source = "MANUAL_DB"`) stays SENT forever and
  // blocked the org wizard for MONTHS on 3 PlayTelecom terminals. The 7-day migration TTL has
  // the same shape: a COMPLETED migration keeps blocking re-migration for a whole week. The
  // device's own post-wipe rebind (`Terminal.lastActivationStatusCheckAt` strictly AFTER the
  // command's createdAt) is the proof the wipe already happened — the same rule the
  // terminals-list badge (`computeTerminalMigration`) and `migrateStatus` already use.
  const terminalReboundAt = (at: Date | null) => ({
    id: 'term-1',
    venueId: 'venue-old',
    status: 'ACTIVE',
    brand: 'PAX',
    assignedMerchantIds: ['merch-p'],
    lastActivationStatusCheckAt: at,
  })

  it('does NOT block when the device already rebound AFTER the pending FACTORY_RESET (proof of wipe)', async () => {
    healthy()
    m.terminal.findUnique.mockResolvedValue(terminalReboundAt(new Date('2026-09-01T18:05:51Z')))
    m.tpvCommandQueue.findMany.mockResolvedValue([{ id: 'ghost', createdAt: new Date('2026-04-09T16:30:40Z') }])
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.blockers.map(b => b.code)).not.toContain('MIGRATION_IN_PROGRESS')
    expect(r.canProceed).toBe(true)
  })

  it('still blocks when the last rebind is BEFORE the pending FACTORY_RESET (wipe not executed yet)', async () => {
    healthy()
    m.terminal.findUnique.mockResolvedValue(terminalReboundAt(new Date('2026-08-31T23:00:00Z')))
    m.tpvCommandQueue.findMany.mockResolvedValue([{ id: 'live', createdAt: new Date('2026-08-31T23:15:03Z') }])
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.blockers.map(b => b.code)).toContain('MIGRATION_IN_PROGRESS')
  })

  it('still blocks when the device never rebound (lastActivationStatusCheckAt null)', async () => {
    healthy()
    m.terminal.findUnique.mockResolvedValue(terminalReboundAt(null))
    m.tpvCommandQueue.findMany.mockResolvedValue([{ id: 'live', createdAt: new Date('2026-04-09T16:30:40Z') }])
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.blockers.map(b => b.code)).toContain('MIGRATION_IN_PROGRESS')
  })

  it('blocks if ANY in-flight FACTORY_RESET postdates the last rebind (does not stop at the first row)', async () => {
    healthy()
    m.terminal.findUnique.mockResolvedValue(terminalReboundAt(new Date('2026-09-01T12:00:00Z')))
    m.tpvCommandQueue.findMany.mockResolvedValue([
      { id: 'ghost-survived', createdAt: new Date('2026-04-09T16:30:40Z') },
      { id: 'fresh-not-executed', createdAt: new Date('2026-09-01T12:30:00Z') },
    ])
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.blockers.map(b => b.code)).toContain('MIGRATION_IN_PROGRESS')
  })

  it('blocks when source and destination venue are the same', async () => {
    healthy()
    m.terminal.findUnique.mockResolvedValue({ id: 'term-1', venueId: 'venue-new', status: 'ACTIVE', brand: 'PAX' })
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'SAME_VENUE' }))
  })
})

// Founder decision (2026-09-01, Asana 1218069201250971): a MIGRATION_IN_PROGRESS blocker
// must never be a dead end. The preflight now describes the pending wipe (`pendingWipe`)
// so the wizard can say WHEN it was queued, WHERE it came from, and offer the way out:
// "cancel" while the device hasn't received it, "discard" once it's been silent 24 h.
describe('migratePreflight — pendingWipe (the way out of MIGRATION_IN_PROGRESS)', () => {
  beforeEach(() => jest.clearAllMocks())

  const HOUR = 60 * 60 * 1000
  const wipe = (over: Partial<{ id: string; createdAt: Date; status: string; payload: unknown; venueId: string }>) => ({
    id: 'cmd-1',
    createdAt: new Date(Date.now() - 2 * HOUR),
    status: 'SENT',
    payload: null,
    venueId: 'venue-old',
    ...over,
  })

  it('is null when nothing is pending', async () => {
    healthy()
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.pendingWipe).toBeNull()
  })

  it('a QUEUED wipe is cancellable (device has not received it) and never discardable', async () => {
    healthy()
    m.tpvCommandQueue.findMany.mockResolvedValue([wipe({ status: 'QUEUED' })])
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.blockers.map(b => b.code)).toContain('MIGRATION_IN_PROGRESS')
    expect(r.pendingWipe).toEqual(
      expect.objectContaining({
        commandId: 'cmd-1',
        status: 'QUEUED',
        cancellable: true,
        discardable: false,
        origin: 'MANUAL',
        toVenueId: null,
      }),
    )
  })

  it('a migration wipe carries its origin and destination so the UI can name them', async () => {
    healthy()
    m.tpvCommandQueue.findMany.mockResolvedValue([
      wipe({ status: 'PENDING', payload: { migration: { fromVenueId: 'venue-old', toVenueId: 'venue-x' } } }),
    ])
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.pendingWipe).toEqual(expect.objectContaining({ origin: 'MIGRATION', toVenueId: 'venue-x', cancellable: true }))
  })

  it('a SENT wipe silent for more than 24 h is discardable (and not cancellable)', async () => {
    healthy()
    const queuedAt = new Date(Date.now() - 25 * HOUR)
    m.tpvCommandQueue.findMany.mockResolvedValue([wipe({ status: 'SENT', createdAt: queuedAt })])
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.pendingWipe).toEqual(
      expect.objectContaining({
        status: 'SENT',
        queuedAt,
        cancellable: false,
        discardable: true,
        discardableAt: new Date(queuedAt.getTime() + 24 * HOUR),
      }),
    )
  })

  it('a SENT wipe younger than 24 h is neither cancellable nor discardable yet — but says WHEN it will be', async () => {
    healthy()
    const queuedAt = new Date(Date.now() - 2 * HOUR)
    m.tpvCommandQueue.findMany.mockResolvedValue([wipe({ status: 'SENT', createdAt: queuedAt })])
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.pendingWipe).toEqual(
      expect.objectContaining({ cancellable: false, discardable: false, discardableAt: new Date(queuedAt.getTime() + 24 * HOUR) }),
    )
  })

  // P2 #1 de Codex: `commandId`/`status`/`origin` describen el MÁS NUEVO, así que
  // `cancellable` tiene que describir al mismo. Mirando "cualquiera", un SENT nuevo con un
  // QUEUED viejo detrás salía como `status: SENT, cancellable: true` — y al cancelar,
  // `migrateCancel` soltaba el QUEUED viejo, dejando el bloqueo intacto y al operador sin
  // entender qué pasó.
  it('cancellable describe al MÁS NUEVO, no a cualquiera de los pendientes', async () => {
    healthy()
    m.tpvCommandQueue.findMany.mockResolvedValue([
      wipe({ id: 'viejo-cancelable', status: 'QUEUED', createdAt: new Date(Date.now() - 100 * HOUR) }),
      wipe({ id: 'nuevo-enviado', status: 'SENT', createdAt: new Date(Date.now() - 30 * HOUR) }),
    ])
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.pendingWipe).toEqual(
      expect.objectContaining({ commandId: 'nuevo-enviado', status: 'SENT', cancellable: false, discardable: true }),
    )
  })

  it('describes the NEWEST still-pending wipe when there are several', async () => {
    healthy()
    m.tpvCommandQueue.findMany.mockResolvedValue([
      wipe({ id: 'old', status: 'SENT', createdAt: new Date(Date.now() - 100 * HOUR) }),
      wipe({ id: 'new', status: 'SENT', createdAt: new Date(Date.now() - 30 * HOUR) }),
    ])
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.pendingWipe?.commandId).toBe('new')
  })

  it('a wipe the device already rebound after is NOT pending → null, no blocker', async () => {
    healthy()
    m.terminal.findUnique.mockResolvedValue({
      id: 'term-1',
      venueId: 'venue-old',
      status: 'ACTIVE',
      brand: 'PAX',
      assignedMerchantIds: ['merch-p'],
      lastActivationStatusCheckAt: new Date(Date.now() - 1 * HOUR),
    })
    m.tpvCommandQueue.findMany.mockResolvedValue([wipe({ status: 'SENT', createdAt: new Date(Date.now() - 48 * HOUR) })])
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.pendingWipe).toBeNull()
    expect(r.blockers.map(b => b.code)).not.toContain('MIGRATION_IN_PROGRESS')
  })
})

describe('migratePreflight — migrateMerchant', () => {
  beforeEach(() => jest.clearAllMocks())

  it('con migrateMerchant, un destino sin merchant deja de estar bloqueado', async () => {
    healthy()
    m.venuePaymentConfig.findFirst.mockResolvedValue(null) // destino sin config
    const r = await migratePreflight('term-1', 'venue-new', true)
    expect(r.canProceed).toBe(true)
    expect(r.blockers.map(b => b.code)).not.toContain('NO_PAYMENT_CONFIG')
  })

  it('REGRESIÓN: sin migrateMerchant, un destino sin merchant sigue bloqueado', async () => {
    healthy()
    m.venuePaymentConfig.findFirst.mockResolvedValue(null)
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.canProceed).toBe(false)
    expect(r.blockers.map(b => b.code)).toContain('NO_PAYMENT_CONFIG')
  })

  it('bloquea cross-org: el dinero caería en la cuenta de otra entidad legal', async () => {
    healthy()
    m.venuePaymentConfig.findFirst.mockResolvedValue(null)
    m.venue.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        where.id === 'venue-old'
          ? { id: 'venue-old', name: 'Old', organizationId: 'org-1' }
          : { id: 'venue-new', name: 'New', organizationId: 'org-OTRA' },
      ),
    )
    const r = await migratePreflight('term-1', 'venue-new', true)
    expect(r.canProceed).toBe(false)
    expect(r.blockers.map(b => b.code)).toContain('CROSS_ORG_MERCHANT')
    expect(r.merchantMigration.available).toBe(false)
    expect(r.merchantMigration.reason).toBe('CROSS_ORG')
  })

  it('bloquea si el origen no tiene merchant que llevar', async () => {
    healthy()
    m.venuePaymentConfig.findFirst.mockResolvedValue(null)
    m.venuePaymentConfig.findUnique.mockResolvedValue(null)
    m.terminal.findUnique.mockResolvedValue({
      id: 'term-1',
      venueId: 'venue-old',
      status: 'ACTIVE',
      brand: 'PAX',
      assignedMerchantIds: [],
    })
    const r = await migratePreflight('term-1', 'venue-new', true)
    expect(r.canProceed).toBe(false)
    expect(r.blockers.map(b => b.code)).toContain('ORIGIN_HAS_NO_MERCHANT')
  })

  it('expone los merchants para etiquetar el checkbox', async () => {
    healthy()
    m.venuePaymentConfig.findFirst.mockResolvedValue(null)
    const r = await migratePreflight('term-1', 'venue-new', true)
    expect(r.merchantMigration.available).toBe(true)
    expect(r.merchantMigration.merchants).toEqual([{ id: 'merch-p', displayName: 'playtelecom-p' }])
  })

  // Bug fix (post-review): MerchantAccount.active is a real enable/disable flag (fraud/
  // compliance) — a deactivated merchant's id can still linger in VenuePaymentConfig or
  // assignedMerchantIds. `merch-p` referenced by the origin exists but is INACTIVE, so the
  // DB query (`where: { id: { in: [...] }, active: true }`) returns nothing for it — the
  // origin must be treated as having NO usable merchant, same as if merchantIds were empty.
  it('el único merchant del origen está inactivo → ORIGIN_HAS_NO_MERCHANT (existir el id no basta)', async () => {
    healthy()
    m.venuePaymentConfig.findFirst.mockResolvedValue(null) // destino sin config
    m.merchantAccount.findMany.mockResolvedValue([]) // merch-p existe pero active:false → excluido por la query
    const r = await migratePreflight('term-1', 'venue-new', true)
    expect(r.canProceed).toBe(false)
    expect(r.blockers.map(b => b.code)).toContain('ORIGIN_HAS_NO_MERCHANT')
    expect(r.merchantMigration.available).toBe(false)
    expect(r.merchantMigration.reason).toBe('ORIGIN_HAS_NO_MERCHANT')
  })

  it('origen con un merchant activo y uno inactivo → merchantMigration.merchants sólo incluye el activo', async () => {
    healthy()
    m.venuePaymentConfig.findFirst.mockResolvedValue(null) // destino sin config
    m.terminal.findUnique.mockResolvedValue({
      id: 'term-1',
      venueId: 'venue-old',
      status: 'ACTIVE',
      brand: 'PAX',
      assignedMerchantIds: ['merch-p', 'merch-inactive'],
    })
    // La query real filtraría active:true — el mock simula que sólo merch-p sobrevive ese filtro.
    m.merchantAccount.findMany.mockResolvedValue([{ id: 'merch-p', displayName: 'playtelecom-p' }])
    const r = await migratePreflight('term-1', 'venue-new', true)
    expect(r.merchantMigration.available).toBe(true)
    expect(r.merchantMigration.merchants).toEqual([{ id: 'merch-p', displayName: 'playtelecom-p' }])
    expect(m.merchantAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['merch-p', 'merch-inactive'] }, active: true }),
      }),
    )
  })

  it('el checkbox no se ofrece si el destino ya tiene su propia config', async () => {
    healthy() // findFirst devuelve vpc-1 → destino ya configurado
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.merchantMigration.available).toBe(false)
    expect(r.merchantMigration.reason).toBe('DESTINATION_ALREADY_CONFIGURED')
  })

  // Finding 2 (final whole-branch review, defense-in-depth): the UI already hides the
  // checkbox when the destination has its own config (merchantMigration.reason ===
  // 'DESTINATION_ALREADY_CONFIGURED'), but per critical-warnings.md the backend must not
  // trust the client to hide a control — a caller bypassing the UI could still send
  // migrateMerchant: true here. Without a hard blocker, migrateExecute's Step 2 auto-carry
  // would silently override the destination's OWN configured default merchant with the
  // origin's, corrupting a venue that already charges correctly.
  it('bloquea forzar el comercio del origen si el destino ya tiene su propia config (DESTINATION_ALREADY_CONFIGURED_MERCHANT)', async () => {
    healthy() // findFirst devuelve vpc-1 → destino ya configurado
    const r = await migratePreflight('term-1', 'venue-new', true)
    expect(r.canProceed).toBe(false)
    expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'DESTINATION_ALREADY_CONFIGURED_MERCHANT' }))
  })

  // Regresión: el mismo escenario (destino con su propia config) SIN migrateMerchant debe
  // quedar exactamente como hoy — canProceed=true, sin el nuevo blocker. El nuevo blocker
  // sólo debe activarse cuando el operador realmente pide forzar el comercio del origen.
  it('REGRESIÓN: destino con su propia config + migrateMerchant ausente no bloquea (comportamiento sin cambios)', async () => {
    healthy() // findFirst devuelve vpc-1 → destino ya configurado
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.canProceed).toBe(true)
    expect(r.blockers).toHaveLength(0)
    expect(r.blockers.map(b => b.code)).not.toContain('DESTINATION_ALREADY_CONFIGURED_MERCHANT')
  })
})
