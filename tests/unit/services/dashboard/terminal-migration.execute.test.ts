import { migrateExecute } from '@/services/dashboard/terminal-migration.service'
import prisma from '@/utils/prismaClient'
import * as terminalsService from '@/services/dashboard/terminals.superadmin.service'
import logger from '@/config/logger'

// Mock the Prisma layer so the REAL migratePreflight (called inside migrateExecute) runs.
// Do NOT self-mock the migration module — Jest can't intercept intra-module calls, so
// migrateExecute's internal migratePreflight() would still hit the real one regardless.
// venuePaymentConfig.findUnique / organizationPaymentConfig.findUnique / merchantAccount.findMany
// are queried by resolveOriginPayment + migratePreflight's merchantMigration computation (Task 3) —
// unconditionally, even though migrateExecute always calls migratePreflight with migrateMerchant
// defaulted to false. None of these tests assert on `merchantMigration`, so no resolved-value setup
// is needed beyond making the calls not throw "not a function".
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findUnique: jest.fn() },
    venue: { findUnique: jest.fn() },
    venuePaymentConfig: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
    organizationPaymentConfig: { findUnique: jest.fn() },
    merchantAccount: { findMany: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    tpvCommandQueue: { findFirst: jest.fn(), update: jest.fn() },
  },
}))
// updateTerminal now owns the wipe-queueing ("blindar"). We mock the whole
// terminals service so migrateExecute delegates re-parent + wipe to a mock —
// the blindar logic itself is covered by its own service test.
jest.mock('@/services/dashboard/terminals.superadmin.service')
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

const m = prisma as unknown as {
  terminal: { findUnique: jest.Mock }
  venue: { findUnique: jest.Mock }
  venuePaymentConfig: { findFirst: jest.Mock; findUnique: jest.Mock; create: jest.Mock }
  organizationPaymentConfig: { findUnique: jest.Mock }
  merchantAccount: { findMany: jest.Mock }
  staffVenue: { findFirst: jest.Mock }
  tpvCommandQueue: { findFirst: jest.Mock; update: jest.Mock }
}
const mockedUpdate = terminalsService.updateTerminal as jest.Mock

const healthyPreflight = () => {
  m.terminal.findUnique.mockResolvedValue({ id: 'term-1', venueId: 'venue-old', status: 'ACTIVE', brand: 'PAX' })
  m.venue.findUnique.mockResolvedValue({ id: 'venue-new', name: 'New' })
  m.venuePaymentConfig.findFirst.mockResolvedValue({ id: 'vpc-1' })
  m.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1' })
  // Idempotency check (preflight) AND the post-reparent commandId recovery both
  // call findFirst. Default: preflight sees no in-flight wipe (null), then the
  // recovery sees the wipe blindar queued. Tests override per-call as needed.
  m.tpvCommandQueue.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: 'cmd-1', commandType: 'FACTORY_RESET' })
}

describe('migrateExecute', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    healthyPreflight()
    m.tpvCommandQueue.update.mockResolvedValue({})
    mockedUpdate.mockResolvedValue({ id: 'term-1', venueId: 'venue-new', name: 'T1' })
  })

  it('delegates re-parent to updateTerminal (which auto-queues the wipe) and recovers the commandId', async () => {
    const r = await migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' })

    // Re-parent delegated to updateTerminal with ONLY { venueId } — the wipe is
    // queued INSIDE updateTerminal (blindar), not here, so no double-wipe.
    expect(mockedUpdate).toHaveBeenCalledWith('term-1', { venueId: 'venue-new' }, expect.objectContaining({ staffId: 'admin-1' }))
    // migrateExecute must NOT have only one updateTerminal call (no merchant arg here)
    expect(mockedUpdate).toHaveBeenCalledTimes(1)
    // commandId recovered by re-querying the latest FACTORY_RESET for the terminal
    expect(m.tpvCommandQueue.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { terminalId: 'term-1', commandType: 'FACTORY_RESET' },
        orderBy: { createdAt: 'desc' },
      }),
    )
    expect(r).toEqual(expect.objectContaining({ commandId: 'cmd-1', fromVenueId: 'venue-old', toVenueId: 'venue-new' }))
  })

  it('sets the optional destination merchant via a SECOND updateTerminal call (venue unchanged → no re-wipe)', async () => {
    await migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' }, ['ma-1', 'ma-2'])

    expect(mockedUpdate).toHaveBeenNthCalledWith(1, 'term-1', { venueId: 'venue-new' }, expect.objectContaining({ staffId: 'admin-1' }))
    expect(mockedUpdate).toHaveBeenNthCalledWith(
      2,
      'term-1',
      { assignedMerchantIds: ['ma-1', 'ma-2'] },
      expect.objectContaining({ staffId: 'admin-1' }),
    )
    expect(mockedUpdate).toHaveBeenCalledTimes(2)
  })

  // Regression (TPV migration left payment-dead): when the operator uses the
  // "Comercio por defecto de la sucursal (recomendado)" option, the wizard sends NO
  // merchant. migrateExecute MUST fall back to the destination venue's configured
  // default (VenuePaymentConfig.primaryAccountId) so the terminal can still charge —
  // otherwise it lands with assignedMerchantIds = [] and cannot process payments.
  it('falls back to the destination venue default merchant (primaryAccountId) when no merchants are provided', async () => {
    m.venuePaymentConfig.findFirst.mockResolvedValue({ id: 'vpc-1', primaryAccountId: 'ma-default' })
    await migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' })
    expect(mockedUpdate).toHaveBeenNthCalledWith(1, 'term-1', { venueId: 'venue-new' }, expect.objectContaining({ staffId: 'admin-1' }))
    expect(mockedUpdate).toHaveBeenNthCalledWith(
      2,
      'term-1',
      { assignedMerchantIds: ['ma-default'] },
      expect.objectContaining({ staffId: 'admin-1' }),
    )
    expect(mockedUpdate).toHaveBeenCalledTimes(2)
  })

  it('falls back to the venue default merchant for an empty merchant array too', async () => {
    m.venuePaymentConfig.findFirst.mockResolvedValue({ id: 'vpc-1', primaryAccountId: 'ma-default' })
    await migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' }, [])
    expect(mockedUpdate).toHaveBeenNthCalledWith(2, 'term-1', { assignedMerchantIds: ['ma-default'] }, expect.anything())
    expect(mockedUpdate).toHaveBeenCalledTimes(2)
  })

  it('does NOT make a second updateTerminal call when the venue has no default merchant configured', async () => {
    m.venuePaymentConfig.findFirst.mockResolvedValue({ id: 'vpc-1', primaryAccountId: null })
    await migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' })
    expect(mockedUpdate).toHaveBeenCalledTimes(1)
  })

  it('throws and does NOT re-parent when the destination is not ready (blocker)', async () => {
    m.staffVenue.findFirst.mockResolvedValue(null) // → NO_STAFF_PIN blocker
    await expect(migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' })).rejects.toThrow()
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  // Partial-failure window. The re-parent succeeds inside updateTerminal but the wipe
  // failed to queue (blindar logs a warning, does NOT throw), so no FACTORY_RESET exists
  // to recover. The operator MUST be told that recoverable state, not get a silent success.
  it('surfaces the recoverable re-parented state when no wipe was queued (recovery finds none)', async () => {
    // preflight findFirst → null (no in-flight wipe), recovery findFirst → null (none queued)
    m.tpvCommandQueue.findFirst.mockReset()
    m.tpvCommandQueue.findFirst.mockResolvedValue(null)
    mockedUpdate.mockResolvedValue({ id: 'term-1', venueId: 'venue-new', name: 'T1' })

    const err = await migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).toContain('reasignó')
    expect(message).toContain('reenvía')

    // the re-parent WAS performed even though the function ultimately threw
    expect(mockedUpdate).toHaveBeenCalledWith('term-1', { venueId: 'venue-new' }, expect.objectContaining({ staffId: 'admin-1' }))
  })
})

// Config del venue ORIGEN (VenuePaymentConfig), tal como la devolvería
// `venuePaymentConfig.findUnique` para 'venue-old'. Sirve de fixture compartida
// para todo `describe('migrateExecute — migrateMerchant', ...)`.
const ORIGIN_CFG = {
  primaryAccountId: 'merch-p',
  secondaryAccountId: null,
  tertiaryAccountId: null,
  preferredProcessor: 'AUTO',
  routingRules: null,
}

describe('migrateExecute — migrateMerchant', () => {
  const actor = { staffId: 'admin-1' }

  beforeEach(() => {
    jest.clearAllMocks()
    // Origen: terminal con un merchant asignado (merch-p) y su propia VenuePaymentConfig.
    // Destino: sin VenuePaymentConfig propia — el caso que este flujo existe para desbloquear.
    m.terminal.findUnique.mockResolvedValue({
      id: 'term-1',
      venueId: 'venue-old',
      status: 'ACTIVE',
      brand: 'PAX',
      assignedMerchantIds: ['merch-p'],
    })
    m.venue.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        where.id === 'venue-old'
          ? { id: 'venue-old', name: 'Old', organizationId: 'org-1' }
          : { id: 'venue-new', name: 'New', organizationId: 'org-1' },
      ),
    )
    m.venuePaymentConfig.findFirst.mockResolvedValue(null) // destino sin config propia (preflight)
    m.venuePaymentConfig.findUnique.mockImplementation(({ where }: { where: { venueId: string } }) =>
      Promise.resolve(where.venueId === 'venue-new' ? null : ORIGIN_CFG),
    )
    m.organizationPaymentConfig.findUnique.mockResolvedValue(null)
    m.merchantAccount.findMany.mockResolvedValue([{ id: 'merch-p', displayName: 'playtelecom-p' }])
    m.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1' })
    // Preflight's in-flight check (1st call) → sin migración en curso; la recuperación del
    // wipe (2nd call, en migrateExecute) → el FACTORY_RESET recién encolado.
    m.tpvCommandQueue.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: 'cmd-1', commandType: 'FACTORY_RESET', payload: null })
    m.tpvCommandQueue.update.mockResolvedValue({})
    m.venuePaymentConfig.create.mockResolvedValue({ id: 'vpc-nueva' })
    mockedUpdate.mockResolvedValue({ id: 'term-1', venueId: 'venue-new', name: 'T1' })
  })

  it('la terminal conserva los merchants del origen', async () => {
    await migrateExecute('term-1', 'venue-new', actor, undefined, true)
    expect(mockedUpdate).toHaveBeenCalledWith('term-1', { assignedMerchantIds: ['merch-p'] }, actor)
  })

  it('crea la VenuePaymentConfig del destino copiada del origen', async () => {
    await migrateExecute('term-1', 'venue-new', actor, undefined, true)
    expect(m.venuePaymentConfig.create).toHaveBeenCalledWith({
      data: {
        venueId: 'venue-new',
        primaryAccountId: 'merch-p',
        secondaryAccountId: null,
        tertiaryAccountId: null,
        preferredProcessor: 'AUTO',
        routingRules: null,
      },
    })
  })

  it('I1: NO sobrescribe una config preexistente del destino', async () => {
    m.venuePaymentConfig.findUnique.mockImplementation(({ where }: { where: { venueId: string } }) =>
      Promise.resolve(where.venueId === 'venue-new' ? { id: 'vpc-destino-ya-existe' } : ORIGIN_CFG),
    )
    await migrateExecute('term-1', 'venue-new', actor, undefined, true)
    expect(m.venuePaymentConfig.create).not.toHaveBeenCalled()
  })

  it('graba createdVenuePaymentConfigId en el payload del wipe (para el cancel)', async () => {
    m.venuePaymentConfig.create.mockResolvedValue({ id: 'vpc-nueva' })
    await migrateExecute('term-1', 'venue-new', actor, undefined, true)
    expect(m.tpvCommandQueue.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            migration: expect.objectContaining({ createdVenuePaymentConfigId: 'vpc-nueva' }),
          }),
        }),
      }),
    )
  })

  it('REGRESIÓN: sin migrateMerchant no crea config ni toca el payload', async () => {
    // Sin migrateMerchant, NO_PAYMENT_CONFIG exige que el destino YA tenga su propia
    // config (Task 3) — a diferencia del resto de este describe, que prueba el caso
    // "destino sin config" que migrateMerchant existe para desbloquear.
    m.venuePaymentConfig.findFirst.mockResolvedValue({ id: 'vpc-existente', primaryAccountId: 'merch-existente' })
    await migrateExecute('term-1', 'venue-new', actor)
    expect(m.venuePaymentConfig.create).not.toHaveBeenCalled()
    expect(m.tpvCommandQueue.update).not.toHaveBeenCalled()
  })

  it('REGRESIÓN: se encola exactamente UN factory reset (anti doble-wipe)', async () => {
    await migrateExecute('term-1', 'venue-new', actor, undefined, true)
    const venueChanges = (mockedUpdate as jest.Mock).mock.calls.filter(c => 'venueId' in c[1])
    expect(venueChanges).toHaveLength(1)
  })

  it('assignedMerchantIds explícitos ganan sobre el acarreo automático', async () => {
    await migrateExecute('term-1', 'venue-new', actor, ['merch-elegido'], true)
    expect(mockedUpdate).toHaveBeenCalledWith('term-1', { assignedMerchantIds: ['merch-elegido'] }, actor)
  })

  // Required addition (money-safety, review finding): `resolveOriginPayment`'s `copyable`
  // is NOT filtered by MerchantAccount.active. Here the terminal carries TWO merchants —
  // 'merch-inactivo' becomes copyable.primaryAccountId (it's merchantIds[0]) but is
  // deactivated (fraud/compliance); 'merch-activo' is merchantIds[1] and IS active. Preflight
  // only requires SOME origin merchant to be active (satisfied by merch-activo) so it does
  // NOT block — but writing 'merch-inactivo' as the destination's new primaryAccountId would
  // leave it "migrated but can't charge". Must skip the create (not throw), warn, and still
  // let the terminal carry both merchant ids (that write is separately guarded: the TPV
  // filters assignedMerchantIds to active:true at read time).
  it('origen: primaryAccountId inactivo (secondary activo) → NO crea VenuePaymentConfig, loguea warning, sí asigna merchants a la terminal', async () => {
    m.terminal.findUnique.mockResolvedValue({
      id: 'term-1',
      venueId: 'venue-old',
      status: 'ACTIVE',
      brand: 'PAX',
      assignedMerchantIds: ['merch-inactivo', 'merch-activo'],
    })
    m.merchantAccount.findMany.mockResolvedValue([{ id: 'merch-activo', displayName: 'Activo' }])
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger)

    await migrateExecute('term-1', 'venue-new', actor, undefined, true)

    expect(m.venuePaymentConfig.create).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('merch-inactivo'))
    expect(mockedUpdate).toHaveBeenCalledWith('term-1', { assignedMerchantIds: ['merch-inactivo', 'merch-activo'] }, actor)
  })
})
