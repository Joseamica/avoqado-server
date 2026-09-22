import fs from 'node:fs'
import path from 'node:path'

/**
 * Ruling 27 — la migración del libro de merma NO puede bloquear las tablas del kardex.
 *
 * `RawMaterialMovement` e `InventoryMovement` reciben un movimiento en CADA venta. Prisma manda cada
 * `migration.sql` como un solo lote, y Postgres envuelve un lote de varias sentencias en una
 * transacción implícita: el `ADD COLUMN` de la migración inicial toma ACCESS EXCLUSIVE sobre las dos
 * tablas y lo suelta hasta el COMMIT. Todo lo que recorra esas tablas dentro de ese lote alarga el
 * tiempo en que ninguna venta puede escribir su movimiento. Esta guardia fija las tres cosas que no
 * se ven en una prueba de resultados:
 *
 * 1. La migración inicial ya no construye índices sobre las tablas del kardex, y sus dos llaves
 *    movimiento → folio nacen `NOT VALID` (no recorren la tabla) además de diferidas.
 * 2. La validación de esas dos llaves va en su propia migración (`VALIDATE CONSTRAINT` toma SHARE
 *    UPDATE EXCLUSIVE: no bloquea escrituras).
 * 3. Cada índice de `wasteReportId` se construye CONCURRENTLY, en una migración de UNA sentencia
 *    (CONCURRENTLY no corre dentro de la transacción implícita de un lote: SQLSTATE 25001).
 */
const migrationsRoot = path.resolve(__dirname, '../../../prisma/migrations')

const INITIAL = '20260921190000_inventory_waste'
const VALIDATE = '20260921190100_validate_waste_report_fks'
const RAW_INDEX = '20260921190200_index_raw_material_movement_waste_report_concurrently'
const PRODUCT_INDEX = '20260921190300_index_inventory_movement_waste_report_concurrently'
const LEGACY_INDEXES = [
  '20260921200000_index_raw_material_movement_waste_legacy_concurrently',
  '20260921200100_index_inventory_movement_waste_legacy_concurrently',
]

const HOT_TABLES = ['RawMaterialMovement', 'InventoryMovement'] as const
const FKS = {
  RawMaterialMovement: 'RawMaterialMovement_wasteReportId_fkey',
  InventoryMovement: 'InventoryMovement_wasteReportId_fkey',
} as const
const INDEXES = {
  RawMaterialMovement: 'RawMaterialMovement_wasteReportId_idx',
  InventoryMovement: 'InventoryMovement_wasteReportId_idx',
} as const

/** Sentencias ejecutables: sin comentarios de línea, partidas por `;`, espacios colapsados.
 *  Un bloque `DO $$ … $$` se parte en pedazos, pero cada pedazo conserva su texto: sirve para buscar. */
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

function migrationNames(): string[] {
  return fs
    .readdirSync(migrationsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
}

describe('migración del libro de merma sin bloquear el kardex (Ruling 27)', () => {
  it('la migración inicial no crea índices sobre las tablas del kardex', () => {
    const code = statements(readMigration(INITIAL)).join(' ; ')

    for (const table of HOT_TABLES) {
      expect(code).not.toMatch(new RegExp(`CREATE (UNIQUE )?INDEX[^;]* ON "${table}"`))
      expect(code).not.toContain(INDEXES[table])
    }
  })

  it('la migración inicial crea las dos llaves movimiento → folio NOT VALID y diferidas, y nada más de ellas se aplaza', () => {
    const code = statements(readMigration(INITIAL)).join(' ; ')

    for (const table of HOT_TABLES) {
      expect(code).toMatch(
        new RegExp(
          `\\('${table}', '${FKS[table]}', 'wasteReportId', 'InventoryWasteReport', 'NO ACTION', 'DEFERRABLE INITIALLY DEFERRED NOT VALID'\\)`,
        ),
      )
    }
    // Las llaves de la tabla NUEVA hacia Venue/RawMaterial/Product/Staff validan en el acto: la tabla
    // está vacía, y NOT VALID no bajaría su candado (SHARE ROW EXCLUSIVE hasta el COMMIT, igual).
    expect(code.match(/NOT VALID/g)).toHaveLength(2)
    expect(code).not.toContain('VALIDATE CONSTRAINT')
  })

  it(`${VALIDATE} valida las dos llaves y no hace nada más`, () => {
    const sql = readMigration(VALIDATE)

    expect(statements(sql)).toEqual(HOT_TABLES.map(table => `ALTER TABLE "${table}" VALIDATE CONSTRAINT "${FKS[table]}"`))
    expect(sql).not.toMatch(/^\s*(?:BEGIN|COMMIT)\b/im)
  })

  it.each([
    [RAW_INDEX, 'RawMaterialMovement'],
    [PRODUCT_INDEX, 'InventoryMovement'],
  ] as const)('%s construye su índice CONCURRENTLY en una sola sentencia', (migration, table) => {
    const sql = readMigration(migration)

    expect(statements(sql)).toEqual([`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${INDEXES[table]}" ON "${table}"("wasteReportId")`])
    expect(sql).not.toMatch(/^\s*(?:BEGIN|COMMIT)\b/im)
  })

  it('el orden: inicial → validar → índices → índices parciales de la merma sin folio', () => {
    const names = migrationNames()
    const order = [INITIAL, VALIDATE, RAW_INDEX, PRODUCT_INDEX, ...LEGACY_INDEXES].map(name => names.indexOf(name))

    expect(order.every(position => position >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    // Nada se cuela entre la inicial y los índices parciales: son un solo despliegue.
    expect(order[order.length - 1] - order[0]).toBe(order.length - 1)
  })

  it('ninguna otra migración crea, borra ni valida esos índices y llaves', () => {
    const owners = [...Object.values(INDEXES), ...Object.values(FKS)].map(name => ({
      name,
      migrations: migrationNames().filter(migration => statements(readMigration(migration)).some(statement => statement.includes(name))),
    }))

    expect(owners).toEqual([
      { name: INDEXES.RawMaterialMovement, migrations: [RAW_INDEX] },
      { name: INDEXES.InventoryMovement, migrations: [PRODUCT_INDEX] },
      { name: FKS.RawMaterialMovement, migrations: [INITIAL, VALIDATE] },
      { name: FKS.InventoryMovement, migrations: [INITIAL, VALIDATE] },
    ])
  })
})
