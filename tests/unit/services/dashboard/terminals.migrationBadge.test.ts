/**
 * SUPERADMIN terminals list — `migration` badge logic.
 *
 * Covers the pure `computeTerminalMigration` helper that powers the "Migrando…"
 * badge in the dashboard. The badge is computed for each terminal in the list
 * from (a) its latest in-flight migration FACTORY_RESET command and (b) the
 * device's post-wipe rebound timestamp (`Terminal.lastActivationStatusCheckAt`).
 *
 * Key rule: a migration FACTORY_RESET never ACKs (it lingers until it EXPIRES),
 * so we do NOT detect completion via the command status — we detect it via the
 * rebound. `inProgress` is true UNLESS the device already rebound after the wipe
 * (lastActivationStatusCheckAt strictly AFTER the command's createdAt). An offline
 * device (no rebound) stays inProgress=true.
 */

import { computeTerminalMigration } from '@/services/dashboard/terminals.superadmin.service'

const T0 = new Date('2026-06-02T18:00:00Z')

const migrationCommand = (overrides: Partial<{ id: string; createdAt: Date | null; payload: unknown }> = {}) => ({
  id: 'cmd-1',
  createdAt: T0,
  payload: { migration: { fromVenueId: 'venue-old', previousMerchantIds: ['m1'], toVenueId: 'venue-new' } },
  ...overrides,
})

describe('computeTerminalMigration — "Migrando…" badge logic', () => {
  // 1. NEW FEATURE TESTS
  it('inProgress=true when the device has NOT rebound after the wipe', () => {
    const result = computeTerminalMigration(migrationCommand(), null)
    expect(result).toEqual({
      inProgress: true,
      commandId: 'cmd-1',
      fromVenueId: 'venue-old',
      toVenueId: 'venue-new',
    })
  })

  it('inProgress=true when the last rebound predates the wipe (stale activation check)', () => {
    const result = computeTerminalMigration(migrationCommand(), new Date(T0.getTime() - 60_000))
    expect(result?.inProgress).toBe(true)
  })

  it('inProgress=true when an offline device never rebounds (lastActivationStatusCheckAt undefined)', () => {
    const result = computeTerminalMigration(migrationCommand(), undefined)
    expect(result?.inProgress).toBe(true)
  })

  it('inProgress=false once the device rebound AFTER the wipe (lastActivationStatusCheckAt > createdAt)', () => {
    const result = computeTerminalMigration(migrationCommand(), new Date(T0.getTime() + 60_000))
    expect(result).toEqual({
      inProgress: false,
      commandId: 'cmd-1',
      fromVenueId: 'venue-old',
      toVenueId: 'venue-new',
    })
  })

  it('migration=null when there is no migration command', () => {
    expect(computeTerminalMigration(null, new Date())).toBeNull()
    expect(computeTerminalMigration(undefined, new Date())).toBeNull()
  })

  it('migration=null when the command payload has no migration object (manual FACTORY_RESET)', () => {
    expect(computeTerminalMigration(migrationCommand({ payload: { someOtherKey: true } }), null)).toBeNull()
    expect(computeTerminalMigration(migrationCommand({ payload: null }), null)).toBeNull()
  })

  it('surfaces the migration command id + venue ids from the payload', () => {
    const result = computeTerminalMigration(
      migrationCommand({ id: 'cmd-xyz', payload: { migration: { fromVenueId: 'A', toVenueId: 'B' } } }),
      null,
    )
    expect(result).toMatchObject({ commandId: 'cmd-xyz', fromVenueId: 'A', toVenueId: 'B', inProgress: true })
  })

  // 2. REGRESSION / EDGE TESTS
  it('treats an exactly-equal rebound timestamp as NOT rebound (strict >, stays inProgress)', () => {
    // Boundary: lastActivationStatusCheckAt === command.createdAt is not "after".
    const result = computeTerminalMigration(migrationCommand(), new Date(T0.getTime()))
    expect(result?.inProgress).toBe(true)
  })

  it('migration=null when payload.migration is missing fromVenueId/toVenueId (malformed payload)', () => {
    expect(computeTerminalMigration(migrationCommand({ payload: { migration: { fromVenueId: 'only-from' } } }), null)).toBeNull()
    expect(computeTerminalMigration(migrationCommand({ payload: { migration: {} } }), null)).toBeNull()
  })

  it('stays inProgress=true when the command has no createdAt (cannot prove a rebound after it)', () => {
    const result = computeTerminalMigration(migrationCommand({ createdAt: null }), new Date(T0.getTime() + 60_000))
    expect(result?.inProgress).toBe(true)
  })
})
