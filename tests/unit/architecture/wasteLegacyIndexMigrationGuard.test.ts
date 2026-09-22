import fs from 'node:fs'
import path from 'node:path'
import { wasteLedgerSql } from '@/services/shared/inventoryWasteRead.service'

/**
 * T9c: la rama «sin folio» de los lectores de merma (`wasteLedgerSql`) depende de dos índices
 * PARCIALES. Esta guardia fija las tres cosas que no se ven en una prueba de resultados:
 *
 * 1. Cada índice se construye CONCURRENTLY, en una migración de UNA sola sentencia.
 *    `RawMaterialMovement` e `InventoryMovement` reciben escrituras en cada venta: un CREATE INDEX
 *    normal las bloquearía mientras se construye, y Postgres rechaza CONCURRENTLY dentro de la
 *    transacción implícita de un lote de varias sentencias (SQLSTATE 25001).
 * 2. El lector escribe el tipo y el `IS NULL` LITERALES, igual que el predicado del índice: con un
 *    parámetro Postgres no puede probar la implicación y el índice parcial deja de usarse — sin que
 *    ninguna prueba de resultados falle.
 * 3. La rama de productos baja por `LATERAL … OFFSET 0`: sin la barrera, el planificador aplana la
 *    subconsulta y en ventanas largas vuelve a recorrer las `LOSS` de toda la plataforma.
 */
const migrationsRoot = path.resolve(__dirname, '../../../prisma/migrations')

const cases = [
  {
    migration: '20260921200000_index_raw_material_movement_waste_legacy_concurrently',
    index: 'RawMaterialMovement_venueId_createdAt_waste_legacy_idx',
    table: 'RawMaterialMovement',
    columns: '"venueId", "createdAt"',
    type: 'SPOILAGE',
  },
  {
    migration: '20260921200100_index_inventory_movement_waste_legacy_concurrently',
    index: 'InventoryMovement_inventoryId_createdAt_waste_legacy_idx',
    table: 'InventoryMovement',
    columns: '"inventoryId", "createdAt"',
    type: 'LOSS',
  },
]

/** Sentencias ejecutables: sin comentarios de línea, partidas por `;`, espacios colapsados. */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .map(line => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map(statement => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function readMigration(name: string): string {
  return fs.readFileSync(path.join(migrationsRoot, name, 'migration.sql'), 'utf8')
}

describe('índices de la merma sin folio (T9c)', () => {
  it.each(cases)(
    '$migration construye su índice parcial CONCURRENTLY en una sola sentencia',
    ({ migration, index, table, columns, type }) => {
      const sql = readMigration(migration)
      const found = statements(sql)

      expect(found).toHaveLength(1)
      expect(found[0]).toBe(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${index}" ON "${table}"(${columns}) WHERE "type" = '${type}' AND "wasteReportId" IS NULL`,
      )
      expect(sql).not.toMatch(/^\s*(?:BEGIN|COMMIT)\b/im)
    },
  )

  it('ninguna otra migración crea, borra ni renombra esos índices', () => {
    const touching = fs
      .readdirSync(migrationsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .filter(entry => cases.some(({ index }) => statements(readMigration(entry.name)).some(statement => statement.includes(index))))
      .map(entry => entry.name)
      .sort()

    expect(touching).toEqual(cases.map(({ migration }) => migration).sort())
  })

  it('el lector usa los predicados de los índices LITERALES y la barrera LATERAL de productos', () => {
    const sql = wasteLedgerSql('venue', new Date('2026-01-01T00:00:00.000Z'), new Date('2026-02-01T00:00:00.000Z')).sql.replace(/\s+/g, ' ')

    expect(sql).toContain(`m.type = 'SPOILAGE' AND m."wasteReportId" IS NULL`)
    expect(sql).toMatch(
      /CROSS JOIN LATERAL \( SELECT mv\.quantity, mv\."unitCost" FROM "InventoryMovement" mv WHERE mv\."inventoryId" = i\.id AND mv\.type = 'LOSS' AND mv\."wasteReportId" IS NULL AND [\s\S]*? OFFSET 0 \) m/,
    )
  })
})
