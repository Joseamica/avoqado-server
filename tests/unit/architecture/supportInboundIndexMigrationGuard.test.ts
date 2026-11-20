import fs from 'node:fs'
import path from 'node:path'

/**
 * WhatsApp support: its three retention indexes on `WhatsappInboundEvent`. That table has existed since May and gets a
 * write for every inbound message, so a plain CREATE INDEX would block those writes while it builds. Each index is built
 * CONCURRENTLY and alone in its file: Prisma sends a migration file as one batch, and Postgres rejects CONCURRENTLY inside
 * the implicit transaction of a multi-statement batch (SQLSTATE 25001). Same shape as hotOrderIndexMigrationGuard.
 */
const migrationsRoot = path.resolve(__dirname, '../../../prisma/migrations')

/** Executable statements: line comments removed, split on `;`, whitespace collapsed. */
const statements = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map(statement => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

const migrations = fs
  .readdirSync(migrationsRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => ({ name: entry.name, found: statements(fs.readFileSync(path.join(migrationsRoot, entry.name, 'migration.sql'), 'utf8')) }))

describe('support indexes on the live WhatsappInboundEvent table', () => {
  it.each([
    ['WhatsappInboundEvent_routedAs_receivedAt_id_idx', '"routedAs", "receivedAt", "id"'],
    ['WhatsappInboundEvent_supportTombstoneUntil_id_idx', '"supportTombstoneUntil", "id"'],
    ['WhatsappInboundEvent_receiverId_replyWamid_idx', '"receiverId", "replyWamid"'],
  ])('%s is built concurrently, alone in its own migration', (index, columns) => {
    const touching = migrations.filter(({ found }) => found.some(statement => statement.includes(`"${index}"`)))

    expect(touching.map(({ name }) => name)).toEqual([expect.stringMatching(/_idx_concurrently$/)])
    expect(touching[0].found).toEqual([`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${index}" ON "WhatsappInboundEvent"(${columns})`])
  })
})
