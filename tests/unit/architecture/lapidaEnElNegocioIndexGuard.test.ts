import fs from 'node:fs'
import path from 'node:path'

/**
 * D29 (hz:0555ee15:D29): la lápida de una llave de ronda se busca en todo el negocio (`llavesAnuladasEnElNegocio`) con el índice GIN
 * PARCIAL `OrderAction_void_externalIds_idx`. Esta guardia fija lo que una prueba de resultados no ve:
 * 1. el índice se construye CONCURRENTLY, en una migración de UNA sola sentencia (Postgres rechaza CONCURRENTLY en un lote);
 * 2. el lector escribe el tipo LITERAL y la misma expresión del índice: con un parámetro, Postgres no puede probar la implicación
 *    y el índice parcial deja de usarse sin que nada falle.
 */
const ROOT = path.resolve(__dirname, '../../..')
const migrationsRoot = path.join(ROOT, 'prisma/migrations')
const INDICE = 'OrderAction_void_externalIds_idx'

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

it('la migración del índice es exactamente un CREATE INDEX CONCURRENTLY, y ninguna otra lo toca', () => {
  const found = folders.filter(name => name.endsWith('_order_action_void_external_ids_idx_concurrently'))
  expect(found).toHaveLength(1)
  expect(statements(fs.readFileSync(path.join(migrationsRoot, found[0], 'migration.sql'), 'utf8'))).toEqual([
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${INDICE}" ON "public"."OrderAction" USING GIN (("metadata" -> 'externalIds')) WITH (fastupdate = off) WHERE "actionType" = 'VOID'`,
  ])
  const touching = folders.filter(name => fs.readFileSync(path.join(migrationsRoot, name, 'migration.sql'), 'utf8').includes(`"${INDICE}"`))
  expect(touching).toEqual(found)
})

it('el lector usa la misma expresión del índice y el tipo VOID literal', () => {
  const fuente = fs.readFileSync(path.join(ROOT, 'src/services/tpv/order.tpv.service.ts'), 'utf8')
  const consulta = /export function consultaDeLapidasDelNegocio[\s\S]*?\n}\n/.exec(fuente)?.[0] ?? ''
  expect(consulta).toContain(`oa."actionType" = 'VOID'`)
  expect(consulta).toContain(`(oa."metadata" -> 'externalIds') ?| \${pedidas}::text[]`)
  expect(consulta).toContain(`o."venueId" = \${venueId}`)
  // La barrera que obliga a entrar por la llave (el índice) y no por las cuentas del negocio.
  expect(consulta).toMatch(/\?\| \$\{pedidas\}::text\[\]\s+OFFSET 0\s+\) anulada/)
  // Y el lector corre ESA consulta (la que la prueba de capacidad explica).
  const lector = /export async function llavesAnuladasEnElNegocio[\s\S]*?\n}\n/.exec(fuente)?.[0] ?? ''
  expect(lector).toContain('consultaDeLapidasDelNegocio(venueId, pedidas)')
})
