import { unresolvedMigrationNames } from '../../../scripts/pre-migration-status'

describe('pre-migration status', () => {
  it('blocks only unfinished migrations that were not rolled back', () => {
    const rows = [
      { migration_name: 'applied', finished_at: new Date('2026-09-02T00:00:00.000Z'), rolled_back_at: null },
      { migration_name: 'rolled-back', finished_at: null, rolled_back_at: new Date('2026-09-02T00:01:00.000Z') },
      { migration_name: 'actually-pending', finished_at: null, rolled_back_at: null },
    ]

    expect(unresolvedMigrationNames(rows)).toEqual(['actually-pending'])
  })
})
