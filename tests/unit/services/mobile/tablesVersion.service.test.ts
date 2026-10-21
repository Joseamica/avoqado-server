/**
 * Plano en el POS (spec 2026-10-09 §3.1): la versión barata de mesas y plano.
 *   npx jest --selectProjects unit --runTestsByPath tests/unit/services/mobile/tablesVersion.service.test.ts
 */
import { prismaMock } from '@tests/__helpers__/setup'
import {
  ESTADOS_EN_LA_MESA,
  TABLES_VERSION_CACHE_MS,
  clearTablesVersionCache,
  computeTablesVersions,
  readTablesVersions,
  tablesVersionSql,
  versionHash,
  versionsFromRow,
  type TablesVersionRow,
} from '@/services/mobile/tablesVersion.service'

const fila = (extra: Partial<TablesVersionRow> = {}): TablesVersionRow => ({
  tableCount: 3,
  tableSum: '5381234567000',
  orderCount: 1,
  orderSum: '1791234567890',
  areaCount: 2,
  areaSum: '3581234560000',
  elementCount: 4,
  elementSum: '7161234560000',
  ownershipRule: false,
  ...extra,
})

beforeEach(() => {
  clearTablesVersionCache()
  prismaMock.$queryRaw.mockReset()
  prismaMock.$queryRaw.mockResolvedValue([fila()])
})

describe('versionsFromRow — cada pieza mueve SU versión', () => {
  const base = versionsFromRow(fila())

  it('las dos versiones son 16 hex y son estables', () => {
    expect(base.tablesVersion).toMatch(/^[0-9a-f]{16}$/)
    expect(base.floorPlanVersion).toMatch(/^[0-9a-f]{16}$/)
    expect(versionsFromRow(fila())).toEqual(base)
  })

  it.each([
    ['tableCount', { tableCount: 2 }],
    ['tableSum', { tableSum: '5381234567001' }],
    ['orderCount', { orderCount: 0 }],
    ['orderSum', { orderSum: '1791234567891' }],
    ['ownershipRule', { ownershipRule: true }],
  ] as const)('cambiar %s mueve tablesVersion y NO floorPlanVersion', (_campo, cambio) => {
    const otra = versionsFromRow(fila(cambio))
    expect(otra.tablesVersion).not.toBe(base.tablesVersion)
    expect(otra.floorPlanVersion).toBe(base.floorPlanVersion)
  })

  it.each([
    ['areaCount', { areaCount: 1 }],
    ['areaSum', { areaSum: '3581234561000' }],
    ['elementCount', { elementCount: 5 }],
    ['elementSum', { elementSum: '0' }],
  ] as const)('cambiar %s mueve floorPlanVersion y NO tablesVersion', (_campo, cambio) => {
    const otra = versionsFromRow(fila(cambio))
    expect(otra.floorPlanVersion).not.toBe(base.floorPlanVersion)
    expect(otra.tablesVersion).toBe(base.tablesVersion)
  })

  it('un venue vacío también tiene versión (sin mesas, sin cuentas, sin plano)', () => {
    const vacio = versionsFromRow({
      tableCount: 0,
      tableSum: '0',
      orderCount: 0,
      orderSum: '0',
      areaCount: 0,
      areaSum: '0',
      elementCount: 0,
      elementSum: '0',
      ownershipRule: false,
    })
    expect(vacio.tablesVersion).toMatch(/^[0-9a-f]{16}$/)
  })

  it('versionHash depende del orden de las piezas (no confunde mesas con cuentas)', () => {
    expect(versionHash(['mesas', 1, null, 'cuentas', 2, null])).not.toBe(versionHash(['mesas', 2, null, 'cuentas', 1, null]))
  })
})

describe('la consulta', () => {
  it('es UNA sola, filtra por el venue y sólo cuenta las cuentas vivas (IN, para usar el índice)', async () => {
    await readTablesVersions('venue-1')
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
    const sql = tablesVersionSql('venue-1')
    expect(sql.sql).toContain('"Table"')
    expect(sql.sql).toContain('"Order"')
    expect(sql.sql).toContain('"tableId" IS NOT NULL')
    expect(sql.sql).toContain('"currentOrderId"')
    expect(sql.sql).toContain('UNION')
    expect(sql.sql).toContain('"Area"')
    expect(sql.sql).toContain('"FloorElement"')
    expect(sql.sql).toContain('"VenueSettings"')
    expect(sql.sql).toContain('SUM(')
    expect(sql.sql).not.toContain('MAX(')
    expect(sql.sql).not.toContain('NOT IN')
    expect(ESTADOS_EN_LA_MESA).toEqual(['PENDING', 'CONFIRMED', 'PREPARING', 'READY'])
    expect(sql.values).toEqual(expect.arrayContaining(['venue-1', ...ESTADOS_EN_LA_MESA]))
    expect(sql.values).not.toEqual(expect.arrayContaining(['COMPLETED']))
    expect(sql.values.filter(v => v === 'venue-1')).toHaveLength(6)
  })

  it('una respuesta vacía da la versión del venue vacío, no truena', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([])
    await expect(readTablesVersions('venue-1')).resolves.toEqual(
      versionsFromRow({
        tableCount: 0,
        tableSum: '0',
        orderCount: 0,
        orderSum: '0',
        areaCount: 0,
        areaSum: '0',
        elementCount: 0,
        elementSum: '0',
        ownershipRule: false,
      }),
    )
  })
})

describe('computeTablesVersions — caché de 1.5 s por venue', () => {
  it('dos llamadas seguidas del mismo venue consultan la base UNA vez', async () => {
    const a = await computeTablesVersions('venue-1', 1_000)
    const b = await computeTablesVersions('venue-1', 1_000 + TABLES_VERSION_CACHE_MS - 1)
    expect(b).toEqual(a)
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('pasados 1.5 s vuelve a la base', async () => {
    await computeTablesVersions('venue-1', 1_000)
    prismaMock.$queryRaw.mockResolvedValueOnce([fila({ tableCount: 9 })])
    const nueva = await computeTablesVersions('venue-1', 1_000 + TABLES_VERSION_CACHE_MS)
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2)
    expect(nueva).toEqual(versionsFromRow(fila({ tableCount: 9 })))
  })

  it('cuatro aparatos en el mismo instante comparten UNA consulta', async () => {
    let soltar!: (v: TablesVersionRow[]) => void
    prismaMock.$queryRaw.mockReturnValueOnce(new Promise<TablesVersionRow[]>(r => (soltar = r)))
    const pendientes = [1, 2, 3, 4].map(() => computeTablesVersions('venue-1', 5_000))
    soltar([fila()])
    const respuestas = await Promise.all(pendientes)
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
    expect(new Set(respuestas.map(r => r.tablesVersion)).size).toBe(1)
  })

  it('un venue nunca reusa la versión de otro', async () => {
    await computeTablesVersions('venue-1', 1_000)
    await computeTablesVersions('venue-2', 1_000)
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2)
  })

  it('un fallo de la base no se queda guardado: la siguiente pregunta vuelve a intentar', async () => {
    prismaMock.$queryRaw.mockRejectedValueOnce(new Error('base caída'))
    await expect(computeTablesVersions('venue-1', 1_000)).rejects.toThrow('base caída')
    await expect(computeTablesVersions('venue-1', 1_001)).resolves.toEqual(versionsFromRow(fila()))
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2)
  })
})
