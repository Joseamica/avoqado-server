import fs from 'node:fs'
import path from 'node:path'

describe('migrations on the hot Order table', () => {
  it('builds the loyalty pending index concurrently in a standalone migration', () => {
    const migrationsRoot = path.resolve(process.cwd(), 'prisma/migrations')
    const matches = fs
      .readdirSync(migrationsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => ({ directory: entry.name, sql: fs.readFileSync(path.join(migrationsRoot, entry.name, 'migration.sql'), 'utf8') }))
      .filter(({ sql }) => sql.includes('Order_loyalty_pending_idx'))

    expect(matches).toHaveLength(1)
    expect(matches[0].sql).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS "Order_loyalty_pending_idx"/)
    expect(matches[0].sql.match(/;\s*(?:--[^\n]*\s*)?/g)).toHaveLength(1)
  })
})
