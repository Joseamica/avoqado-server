import { StaffRole, PlanTier, VenueType } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import { resolveAudience, countAudience, staffMatchesAudience } from '../../../../src/services/announcements/audience.service'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { staffVenue: { findMany: jest.fn(), groupBy: jest.fn(), findFirst: jest.fn() } },
}))

const mockFindMany = prisma.staffVenue.findMany as unknown as jest.Mock
const mockGroupBy = prisma.staffVenue.groupBy as unknown as jest.Mock
const mockFindFirst = prisma.staffVenue.findFirst as unknown as jest.Mock

const sinFiltros = {
  audienceRoles: [StaffRole.OWNER],
  targetPlanTiers: [],
  targetCategories: [],
  targetVenueIds: [],
}

describe('audience.service', () => {
  beforeEach(() => jest.clearAllMocks())

  // ===== CASOS NUEVOS =====
  it('exige que la persona Y su vinculo esten activos', async () => {
    mockFindMany.mockResolvedValue([])
    await resolveAudience(sinFiltros)
    const where = mockFindMany.mock.calls[0][0].where
    expect(where.active).toBe(true)
    expect(where.staff.active).toBe(true)
  })

  it('filtra por rol, plan, giro y venues elegidos a mano', async () => {
    mockFindMany.mockResolvedValue([])
    await resolveAudience({
      audienceRoles: [StaffRole.OWNER, StaffRole.ADMIN],
      targetPlanTiers: [PlanTier.PRO],
      targetCategories: ['SERVICES'],
      targetVenueIds: ['v1'],
    })
    const where = mockFindMany.mock.calls[0][0].where
    expect(where.role).toEqual({ in: [StaffRole.OWNER, StaffRole.ADMIN] })
    expect(where.venue.planTier).toEqual({ in: [PlanTier.PRO] })
    expect(where.venue.id).toEqual({ in: ['v1'] })
    expect(where.venue.type.in).toEqual(expect.arrayContaining([VenueType.SALON, VenueType.SPA]))
    expect(where.venue.type.in).not.toContain(VenueType.RESTAURANT)
  })

  it('una lista de filtro vacia NO agrega esa condicion', async () => {
    mockFindMany.mockResolvedValue([])
    await resolveAudience(sinFiltros)
    const where = mockFindMany.mock.calls[0][0].where
    expect(where.venue?.planTier).toBeUndefined()
    expect(where.venue?.type).toBeUndefined()
    expect(where.venue?.id).toBeUndefined()
  })

  it('cuenta negocios y personas por separado cuando alguien administra varios', async () => {
    // s1 administra v1 y v2; s2 solo v1  =>  2 negocios, 2 personas
    mockGroupBy.mockResolvedValueOnce([{ venueId: 'v1' }, { venueId: 'v2' }]).mockResolvedValueOnce([{ staffId: 's1' }, { staffId: 's2' }])
    await expect(countAudience(sinFiltros)).resolves.toEqual({ venues: 2, people: 2 })
  })

  // 🔴 groupBy y NO distinct: el distinct de Prisma se resuelve EN MEMORIA del cliente
  // salvo con nativeDistinct, que este schema no activa. Usarlo no ahorraba nada.
  it('el conteo agrupa en SQL, no deduplica en memoria', async () => {
    mockGroupBy.mockResolvedValue([])
    await countAudience(sinFiltros)
    expect(mockGroupBy.mock.calls[0][0].by).toEqual(['venueId'])
    expect(mockGroupBy.mock.calls[1][0].by).toEqual(['staffId'])
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  // ===== REGRESION / RIESGO DE NEGOCIO =====
  it('un venue SIN plan nunca cae en un filtro por plan', async () => {
    mockFindMany.mockResolvedValue([])
    await resolveAudience({ ...sinFiltros, targetPlanTiers: [PlanTier.GRATIS] })
    const where = mockFindMany.mock.calls[0][0].where
    expect(where.venue.planTier).toEqual({ in: [PlanTier.GRATIS] })
    expect(JSON.stringify(where)).not.toContain('null')
  })
})

describe('staffMatchesAudience — la autoridad de lectura', () => {
  beforeEach(() => jest.clearAllMocks())

  it('usa EXACTAMENTE el mismo filtro que el reparto, mas el staffId', async () => {
    mockFindFirst.mockResolvedValue({ id: 'sv1' })
    await staffMatchesAudience('s1', { ...sinFiltros, targetPlanTiers: [PlanTier.PRO] })
    const where = mockFindFirst.mock.calls[0][0].where
    expect(where.staffId).toBe('s1')
    expect(where.active).toBe(true)
    expect(where.staff.active).toBe(true)
    expect(where.venue.planTier).toEqual({ in: [PlanTier.PRO] })
  })

  it('sin vinculo que cumpla, NO pertenece', async () => {
    mockFindFirst.mockResolvedValue(null)
    await expect(staffMatchesAudience('atacante', sinFiltros)).resolves.toBe(false)
  })
})
