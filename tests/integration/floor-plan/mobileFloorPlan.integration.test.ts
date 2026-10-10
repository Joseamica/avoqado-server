/**
 * Plano en el POS (spec 2026-10-09 §3.2), contra Postgres real: `/floor-plan` móvil y los campos nuevos de `/tables`.
 *   TEST_DATABASE_URL='postgresql://…/avoqado_planopos_test_20261009' \
 *     npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/floor-plan/mobileFloorPlan.integration.test.ts
 * Sin limpieza a propósito: venue único por prueba en una base desechable.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { getMobileFloorPlan } from '@/services/mobile/floorPlan.mobile.service'
import { clearTablesVersionCache, readTablesVersions } from '@/services/mobile/tablesVersion.service'
import { getTablesWithStatus } from '@/services/tpv/table.tpv.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

const target = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(target.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(target.pathname)) {
  throw new Error('Exige una base de prueba local y desechable (p. ej. avoqado_planopos_test_20261009).')
}

let venueId = ''

beforeEach(async () => {
  clearTablesVersionCache()
  venueId = `planopos-fp-${randomUUID()}`
  await prisma.organization.create({ data: { id: venueId, name: 'Plano POS org', email: `${venueId}@example.test`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: 'Plano POS', slug: venueId } })
})

afterAll(() => prisma.$disconnect())

describe('getMobileFloorPlan', () => {
  it('áreas en el orden del dueño (empate por nombre) y sólo elementos activos, con la versión de la base', async () => {
    const terraza = await prisma.area.create({ data: { venueId, name: 'Terraza', floorShape: 'TALL', sortOrder: 1 } })
    const barra = await prisma.area.create({ data: { venueId, name: 'Barra', floorShape: 'SQUARE', sortOrder: 0 } })
    const azotea = await prisma.area.create({ data: { venueId, name: 'Azotea', sortOrder: 0 } })
    await prisma.floorElement.create({ data: { venueId, areaId: barra.id, type: 'WALL', positionX: 0, positionY: 0, endX: 1, endY: 0 } })
    await prisma.floorElement.create({
      data: { venueId, areaId: barra.id, type: 'LABEL', positionX: 0.5, positionY: 0.5, label: 'VIP', active: false },
    })
    const out = await getMobileFloorPlan(venueId)
    expect(out.areas.map(a => [a.name, a.floorShape, a.sortOrder])).toEqual([
      ['Azotea', null, 0],
      ['Barra', 'SQUARE', 0],
      ['Terraza', 'TALL', 1],
    ])
    expect(out.areas[0].id).toBe(azotea.id)
    expect(out.areas[2].id).toBe(terraza.id)
    expect(out.elements.map(e => e.type)).toEqual(['WALL'])
    expect(out.overLimit).toBe(false)
    clearTablesVersionCache()
    expect(out.floorPlanVersion).toBe((await readTablesVersions(venueId)).floorPlanVersion)
  })

  it('1501 elementos: devuelve los primeros 1500 en orden estable y overLimit', async () => {
    await prisma.floorElement.createMany({
      data: Array.from({ length: 1501 }, () => ({ venueId, type: 'WALL' as const, positionX: 0, positionY: 0, endX: 1, endY: 0 })),
    })
    const out = await getMobileFloorPlan(venueId)
    const esperados = await prisma.floorElement.findMany({
      where: { venueId, active: true },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 1500,
    })
    expect(out.overLimit).toBe(true)
    expect(out.elements.map(e => e.id)).toEqual(esperados.map(e => e.id))
  })
})

describe('getTablesWithStatus — campos nuevos', () => {
  it('cada mesa trae el orden y la forma de su área; sin área, null', async () => {
    const terraza = await prisma.area.create({ data: { venueId, name: 'Terraza', floorShape: 'TALL', sortOrder: 3 } })
    await prisma.table.create({ data: { venueId, number: '1', capacity: 4, qrCode: randomUUID(), areaId: terraza.id } })
    await prisma.table.create({ data: { venueId, number: '2', capacity: 2, qrCode: randomUUID() } })
    const mesas = await getTablesWithStatus(venueId)
    expect(mesas.map(m => [m.number, m.areaName, m.areaSortOrder, m.areaFloorShape])).toEqual([
      ['1', 'Terraza', 3, 'TALL'],
      ['2', null, null, null],
    ])
  })
})
