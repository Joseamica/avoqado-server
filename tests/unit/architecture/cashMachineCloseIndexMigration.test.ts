import fs from 'node:fs'
import path from 'node:path'

/**
 * Máquina de efectivo · Codex servidor r2 #13: el MCP `cash_machine_closes` filtra, pagina y cuenta por la hora del comprobante
 * (`occurredAt`). El índice `[venueId, occurredAt]` va CONCURRENTLY y SOLO en su migración (como 20261120120001): Prisma manda el archivo
 * como un lote y Postgres rechaza CONCURRENTLY dentro de la transacción implícita de un lote de varias sentencias (SQLSTATE 25001).
 */
const ROOT = path.resolve(__dirname, '../../..')
const migrationsRoot = path.join(ROOT, 'prisma/migrations')
const statements = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map(statement => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
const folders = fs
  .readdirSync(migrationsRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)

it('🔴 r2 #13: la migración del índice [venueId, occurredAt] de CashMachineClose es UNA sola sentencia CONCURRENTLY, y nadie más lo crea', () => {
  const found = folders.filter(name => name.endsWith('_cash_machine_close_venue_occurred_at_idx_concurrently'))
  expect(found).toHaveLength(1)
  expect(statements(fs.readFileSync(path.join(migrationsRoot, found[0], 'migration.sql'), 'utf8'))).toEqual([
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS "CashMachineClose_venueId_occurredAt_idx" ON "public"."CashMachineClose"("venueId", "occurredAt")',
  ])
  const touching = folders.filter(name =>
    fs.readFileSync(path.join(migrationsRoot, name, 'migration.sql'), 'utf8').includes('"CashMachineClose_venueId_occurredAt_idx"'),
  )
  expect(touching).toEqual(found)
})

it('schema.prisma lleva el @@index([venueId, occurredAt]) en CashMachineClose', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8')
  const model = /^model CashMachineClose \{([\s\S]*?)^\}/m.exec(schema)?.[1] ?? ''
  const indexes = [...model.matchAll(/^\s*@@index\(\[([^\]]+)\]\)/gm)].map(m => m[1].replace(/\s+/g, ''))
  expect(indexes).toEqual(expect.arrayContaining(['venueId,occurredAt']))
})
