import fs from 'node:fs'
import path from 'node:path'

/**
 * C8 de la B («quién abrió o cerró la caja»): los dos índices de `CashDrawerSession` (ronda 1: el de `[venueId, status]` se quitó, porque
 * la rama «sigue abierta» ya la sirve el único parcial `CashDrawerSession_venueId_open_key`, de la migración 20260827151634). La tabla recibe una escritura por cada apertura,
 * cierre y cobro en efectivo, así que un CREATE INDEX normal frenaría esas escrituras mientras se construye. Cada índice va
 * CONCURRENTLY y SOLO en su migración: Prisma manda el archivo como un solo lote, y Postgres rechaza CONCURRENTLY dentro de la
 * transacción implícita de un lote de varias sentencias (SQLSTATE 25001). Cada archivo se ubica por el final de su nombre, no por su fecha.
 */
const ROOT = path.resolve(__dirname, '../../..')
const migrationsRoot = path.join(ROOT, 'prisma/migrations')

/** Las sentencias ejecutables: sin comentarios de línea, partidas por `;`, con el espacio en blanco colapsado. */
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

it.each([
  ['_cash_drawer_session_venue_opened_at_idx_concurrently', 'CashDrawerSession_venueId_openedAt_idx', '"venueId", "openedAt"'],
  ['_cash_drawer_session_venue_closed_at_idx_concurrently', 'CashDrawerSession_venueId_closedAt_idx', '"venueId", "closedAt"'],
])('the migration ending in %s is exactly one CREATE INDEX CONCURRENTLY IF NOT EXISTS of %s', (suffix, index, columns) => {
  const found = folders.filter(name => name.endsWith(suffix))
  expect(found).toHaveLength(1)
  expect(statements(fs.readFileSync(path.join(migrationsRoot, found[0], 'migration.sql'), 'utf8'))).toEqual([
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${index}" ON "public"."CashDrawerSession"(${columns})`,
  ])
  // y ninguna otra migración lo crea
  const touching = folders.filter(name => fs.readFileSync(path.join(migrationsRoot, name, 'migration.sql'), 'utf8').includes(`"${index}"`))
  expect(touching).toEqual(found)
})

it('the two migrations come in this order, one right after the other, and the [venueId, status] one is gone (r1)', () => {
  const ours = folders.filter(name => /_cash_drawer_session_venue_(opened_at|closed_at|status)_idx_concurrently$/.test(name)).sort()
  expect(ours.map(name => name.replace(/^\d{14}/, ''))).toEqual([
    '_cash_drawer_session_venue_opened_at_idx_concurrently',
    '_cash_drawer_session_venue_closed_at_idx_concurrently',
  ])
  // nadie más entre las dos: son consecutivas en el orden en que Prisma aplica (por nombre)
  const all = [...folders].sort()
  expect(all.indexOf(ours[1]) - all.indexOf(ours[0])).toBe(1)
  // y ninguna migración crea el de [venueId, status]: la rama «sigue abierta» va por el único parcial de la caja abierta
  const status = folders.filter(name =>
    fs.readFileSync(path.join(migrationsRoot, name, 'migration.sql'), 'utf8').includes('"CashDrawerSession_venueId_status_idx"'),
  )
  expect(status).toEqual([])
})

it('schema.prisma has the two @@index of C8 on CashDrawerSession, and no [venueId, status]', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8')
  const model = /^model CashDrawerSession \{([\s\S]*?)^\}/m.exec(schema)?.[1] ?? ''
  const indexes = [...model.matchAll(/^\s*@@index\(\[([^\]]+)\]\)/gm)].map(m => m[1].replace(/\s+/g, ''))
  expect(indexes).toEqual(expect.arrayContaining(['venueId,openedAt', 'venueId,closedAt']))
  expect(indexes).not.toContain('venueId,status')
})
