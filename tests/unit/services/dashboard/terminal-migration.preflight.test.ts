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
    tpvCommandQueue: { findFirst: jest.fn() },
  },
}))

const m = prisma as unknown as {
  terminal: { findUnique: jest.Mock }
  venue: { findUnique: jest.Mock }
  venuePaymentConfig: { findFirst: jest.Mock; findUnique: jest.Mock }
  organizationPaymentConfig: { findUnique: jest.Mock }
  merchantAccount: { findMany: jest.Mock }
  staffVenue: { findFirst: jest.Mock }
  tpvCommandQueue: { findFirst: jest.Mock }
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
    m.tpvCommandQueue.findFirst.mockResolvedValue({ id: 'cmd-x' })
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'MIGRATION_IN_PROGRESS' }))
  })

  // BUG #1 regression: a FACTORY_RESET never ACKs, so it lingers in a non-terminal status
  // until the 30-min expiry sweep marks it EXPIRED. A stale/expired-but-unswept command must
  // NOT falsely block a new migration — the in-flight query must exclude commands past expiresAt.
  it('MIGRATION_IN_PROGRESS query is expiry-aware (excludes already-expired FACTORY_RESET commands)', async () => {
    healthy()
    await migratePreflight('term-1', 'venue-new')
    expect(m.tpvCommandQueue.findFirst).toHaveBeenCalledWith(
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

  it('blocks when source and destination venue are the same', async () => {
    healthy()
    m.terminal.findUnique.mockResolvedValue({ id: 'term-1', venueId: 'venue-new', status: 'ACTIVE', brand: 'PAX' })
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'SAME_VENUE' }))
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

  it('el checkbox no se ofrece si el destino ya tiene su propia config', async () => {
    healthy() // findFirst devuelve vpc-1 → destino ya configurado
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.merchantMigration.available).toBe(false)
    expect(r.merchantMigration.reason).toBe('DESTINATION_ALREADY_CONFIGURED')
  })
})
