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
 * 1. La migración inicial NO toca las tablas del kardex (Ruling 29): crea la tabla nueva y sus llaves
 *    hacia Venue/RawMaterial/Product/Staff. Si tocara el kardex, su ACCESS EXCLUSIVE quedaría puesto
 *    mientras la misma transacción espera los candados de esas cuatro tablas.
 * 2. La siguiente migración sólo liga el kardex: `ADD COLUMN` + dos llaves movimiento → folio que nacen
 *    `NOT VALID` (no recorren la tabla) además de diferidas. Sólo toca el kardex y la tabla nueva (vacía):
 *    la retención del kardex queda en lo que tardan dos cambios de metadatos.
 * 3. La validación de esas dos llaves va en su propia migración (`VALIDATE CONSTRAINT` toma SHARE
 *    UPDATE EXCLUSIVE: no bloquea escrituras).
 * 4. Cada índice de `wasteReportId` se construye CONCURRENTLY, en una migración de UNA sentencia
 *    (CONCURRENTLY no corre dentro de la transacción implícita de un lote: SQLSTATE 25001).
 */
const migrationsRoot = path.resolve(__dirname, '../../../prisma/migrations')

const INITIAL = '20260921190000_inventory_waste'
const LINK = '20260921190050_inventory_waste_kardex_link'
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

/** Tablas de negocio que referencia la tabla nueva: sus candados NO pueden esperarse con el kardex tomado. */
const BUSINESS_TABLES = ['Venue', 'RawMaterial', 'Product', 'Staff'] as const
const quoted = (name: string) => new RegExp(`['"]${name}['"]`)

describe('migración del libro de merma sin bloquear el kardex (Rulings 27 y 29)', () => {
  it('la migración inicial no toca las tablas del kardex: ni columnas, ni llaves, ni índices', () => {
    const code = statements(readMigration(INITIAL)).join(' ; ')

    for (const table of HOT_TABLES) {
      expect(code).not.toMatch(quoted(table))
      expect(code).not.toContain(INDEXES[table])
      expect(code).not.toContain(FKS[table])
    }
    expect(code).not.toContain('wasteReportId')
  })

  it('la migración inicial crea la tabla nueva con sus llaves de negocio validadas en el acto', () => {
    const code = statements(readMigration(INITIAL)).join(' ; ')

    expect(code).toContain('CREATE TABLE IF NOT EXISTS "InventoryWasteReport"')
    for (const table of BUSINESS_TABLES) expect(code).toMatch(quoted(table))
    // La tabla está vacía: validar es instantáneo, y NOT VALID no bajaría su candado (SHARE ROW EXCLUSIVE
    // sobre las dos tablas hasta el COMMIT, medido en PG 14).
    expect(code).not.toContain('NOT VALID')
    expect(code).not.toContain('VALIDATE CONSTRAINT')
  })

  it(`${LINK} sólo liga el kardex: columnas y llaves NOT VALID diferidas hacia el folio, sin otras tablas`, () => {
    const code = statements(readMigration(LINK)).join(' ; ')

    for (const table of HOT_TABLES) {
      expect(code).toContain(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "wasteReportId" TEXT`)
      expect(code).toMatch(
        new RegExp(
          `\\('${table}', '${FKS[table]}', 'wasteReportId', 'InventoryWasteReport', 'NO ACTION', 'DEFERRABLE INITIALLY DEFERRED NOT VALID'\\)`,
        ),
      )
    }
    expect(code.match(/NOT VALID/g)).toHaveLength(2)
    for (const table of BUSINESS_TABLES) expect(code).not.toMatch(quoted(table))
    expect(code).not.toMatch(/CREATE (UNIQUE )?INDEX/)
    expect(code).not.toContain('VALIDATE CONSTRAINT')
    // Sin BEGIN/COMMIT propios (los BEGIN de los bloques DO son de PL/pgSQL): la transacción implícita
    // del lote basta, y un COMMIT a media migración soltaría el kardex sin las llaves puestas.
    expect(statements(readMigration(LINK)).filter(statement => /^(BEGIN|COMMIT)$/i.test(statement))).toEqual([])
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

  it('el orden: inicial → ligar el kardex → validar → índices → índices parciales de la merma sin folio', () => {
    const names = migrationNames()
    const order = [INITIAL, LINK, VALIDATE, RAW_INDEX, PRODUCT_INDEX, ...LEGACY_INDEXES].map(name => names.indexOf(name))

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
      { name: FKS.RawMaterialMovement, migrations: [LINK, VALIDATE] },
      { name: FKS.InventoryMovement, migrations: [LINK, VALIDATE] },
    ])
  })
})
