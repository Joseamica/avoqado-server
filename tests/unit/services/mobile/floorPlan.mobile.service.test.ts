/**
 * Plano en el POS (spec 2026-10-09 §3.2): `/floor-plan` móvil — áreas + elementos activos, acotado, con su versión
 * calculada ANTES de leer.
 *   npx jest --selectProjects=unit --runTestsByPath tests/unit/services/mobile/floorPlan.mobile.service.test.ts
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { clearTablesVersionCache, versionsFromRow } from '@/services/mobile/tablesVersion.service'
import { getMobileFloorPlan } from '@/services/mobile/floorPlan.mobile.service'

const fila = {
  tableCount: 1,
  tableSum: '1791547200000',
  orderCount: 0,
  orderSum: '0',
  areaCount: 1,
  areaSum: '1791543600000',
  elementCount: 1,
  elementSum: '1791545400000',
  ownershipRule: false,
}
const area = { id: 'a1', name: 'Salón', floorShape: 'WIDE', sortOrder: 0 }
const pared = (id: string) => ({
  id,
  type: 'WALL',
  areaId: 'a1',
  positionX: 0,
  positionY: 0,
  width: null,
  height: null,
  rotation: 0,
  endX: 1,
  endY: 0,
  label: null,
  color: null,
})

beforeEach(() => {
  clearTablesVersionCache()
  // El mock global de Prisma no trae `floorElement`: se pone aquí, sólo para esta suite.
  ;(prismaMock as any).floorElement = { findMany: jest.fn().mockResolvedValue([pared('e1')]) }
  prismaMock.area.findMany.mockResolvedValue([area])
  prismaMock.$queryRaw.mockReset()
  prismaMock.$queryRaw.mockResolvedValue([fila])
})

describe('getMobileFloorPlan', () => {
  it('devuelve la versión del plano, las áreas y los elementos activos', async () => {
    const out = await getMobileFloorPlan('venue-1')
    expect(out).toEqual({
      floorPlanVersion: versionsFromRow(fila).floorPlanVersion,
      areas: [area],
      elements: [pared('e1')],
      overLimit: false,
    })
    expect(prismaMock.area.findMany).toHaveBeenCalledWith({
      where: { venueId: 'venue-1' },
      select: { id: true, name: true, floorShape: true, sortOrder: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      take: 31,
    })
    expect((prismaMock as any).floorElement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'venue-1', active: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1501 }),
    )
  })

  it('la versión se calcula ANTES de leer el plano', async () => {
    await getMobileFloorPlan('venue-1')
    const version = prismaMock.$queryRaw.mock.invocationCallOrder[0]
    expect(version).toBeLessThan(prismaMock.area.findMany.mock.invocationCallOrder[0])
    expect(version).toBeLessThan((prismaMock as any).floorElement.findMany.mock.invocationCallOrder[0])
  })

  it('más de 1500 elementos: trunca a 1500 con overLimit, nunca en silencio', async () => {
    ;(prismaMock as any).floorElement.findMany.mockResolvedValue(Array.from({ length: 1501 }, (_, i) => pared(`e${i}`)))
    const out = await getMobileFloorPlan('venue-1')
    expect(out.elements).toHaveLength(1500)
    expect(out.elements[1499].id).toBe('e1499')
    expect(out.overLimit).toBe(true)
  })

  it('más de 30 áreas: trunca a 30 con overLimit', async () => {
    prismaMock.area.findMany.mockResolvedValue(Array.from({ length: 31 }, (_, i) => ({ ...area, id: `a${i}`, name: `Área ${i}` })))
    const out = await getMobileFloorPlan('venue-1')
    expect(out.areas).toHaveLength(30)
    expect(out.overLimit).toBe(true)
  })
})
