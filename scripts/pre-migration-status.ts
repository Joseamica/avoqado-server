export interface MigrationStatusRow {
  migration_name: string
  finished_at: Date | null
  rolled_back_at: Date | null
}

export function unresolvedMigrationNames(migrations: readonly MigrationStatusRow[]): string[] {
  return migrations
    .filter(migration => migration.finished_at === null && migration.rolled_back_at === null)
    .map(migration => migration.migration_name)
}
