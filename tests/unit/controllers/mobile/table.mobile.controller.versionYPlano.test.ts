/**
 * Plano en el POS (spec 2026-10-09 §3.2): forma de las respuestas de `/tables/version`, `/floor-plan` y los campos
 * nuevos de `/tables`, y el orden «versión ANTES de leer».
 *   npx jest --selectProjects=unit --runTestsByPath tests/unit/controllers/mobile/table.mobile.controller.versionYPlano.test.ts
 */
const VERSIONES = { tablesVersion: 'mesas-v1', floorPlanVersion: 'plano-v1' }

function respuesta() {
  const json = jest.fn()
  const res: any = { status: jest.fn().mockReturnValue({ json }) }
  return { res, json }
}

function montar(orden: string[], versiones: () => Promise<typeof VERSIONES>) {
  jest.doMock('@/services/mobile/tablesVersion.service', () => ({
    computeTablesVersions: jest.fn(async () => {
      orden.push('version')
      return versiones()
    }),
  }))
  jest.doMock('@/services/mobile/floorPlan.mobile.service', () => ({
    getMobileFloorPlan: jest.fn(async () => ({ floorPlanVersion: 'plano-v1', areas: [], elements: [], overLimit: false })),
  }))
  jest.doMock('@/services/tpv/table.tpv.service', () => ({
    getTablesWithStatus: jest.fn(async () => {
      orden.push('mesas')
      return [{ id: 't1', number: '1', status: 'AVAILABLE', areaSortOrder: 2, areaFloorShape: 'TALL' }]
    }),
  }))
  jest.doMock('@/middlewares/checkTableOwnership.middleware', () => ({
    isTableOwnershipEnforced: jest.fn().mockResolvedValue(false),
    staffCanManageAllTables: jest.fn().mockResolvedValue(true),
  }))
  jest.doMock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
}

beforeEach(() => {
  jest.resetModules()
  jest.clearAllMocks()
})

describe('GET /tables — campos nuevos y orden', () => {
  it('agrega tablesVersion y floorPlanVersion sin quitar nada', async () => {
    montar([], async () => VERSIONES)
    const { getTables } = await import('@/controllers/mobile/table.mobile.controller')
    const { res, json } = respuesta()
    await getTables({ params: { venueId: 'venue-1' }, authContext: { userId: 's1', venueId: 'venue-1' } } as any, res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(json).toHaveBeenCalledWith({
      success: true,
      data: [{ id: 't1', number: '1', status: 'AVAILABLE', areaSortOrder: 2, areaFloorShape: 'TALL' }],
      settings: { enforceTableOwnership: false },
      viewer: { staffId: 's1', canManageAllTables: true },
      tablesVersion: 'mesas-v1',
      floorPlanVersion: 'plano-v1',
    })
  })

  it('la versión se calcula ANTES de leer las mesas', async () => {
    const orden: string[] = []
    montar(orden, async () => VERSIONES)
    const { getTables } = await import('@/controllers/mobile/table.mobile.controller')
    await getTables({ params: { venueId: 'venue-1' }, authContext: { userId: 's1' } } as any, respuesta().res)
    expect(orden).toEqual(['version', 'mesas'])
  })

  it('si la versión falla, /tables contesta como siempre (sin los campos nuevos)', async () => {
    montar([], async () => {
      throw new Error('base lenta')
    })
    const { getTables } = await import('@/controllers/mobile/table.mobile.controller')
    const { res, json } = respuesta()
    await getTables({ params: { venueId: 'venue-1' }, authContext: { userId: 's1' } } as any, res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(json.mock.calls[0][0]).not.toHaveProperty('tablesVersion')
    expect(json.mock.calls[0][0]).not.toHaveProperty('floorPlanVersion')
  })
})

describe('GET /tables/version y GET /floor-plan', () => {
  it('/tables/version contesta { success, data: { tablesVersion, floorPlanVersion } }', async () => {
    montar([], async () => VERSIONES)
    const { getTablesVersion } = await import('@/controllers/mobile/table.mobile.controller')
    const { res, json } = respuesta()
    const next = jest.fn()
    await getTablesVersion({ params: { venueId: 'venue-1' } } as any, res, next)
    expect(json).toHaveBeenCalledWith({ success: true, data: VERSIONES })
    expect(next).not.toHaveBeenCalled()
  })

  it('/floor-plan contesta { success, data } con el plano del servicio', async () => {
    montar([], async () => VERSIONES)
    const { getFloorPlan } = await import('@/controllers/mobile/table.mobile.controller')
    const { res, json } = respuesta()
    await getFloorPlan({ params: { venueId: 'venue-1' } } as any, res, jest.fn())
    expect(json).toHaveBeenCalledWith({ success: true, data: { floorPlanVersion: 'plano-v1', areas: [], elements: [], overLimit: false } })
  })

  it('un error pasa a next (lo contesta el manejador global)', async () => {
    montar([], async () => {
      throw new Error('base caída')
    })
    const { getTablesVersion } = await import('@/controllers/mobile/table.mobile.controller')
    const next = jest.fn()
    await getTablesVersion({ params: { venueId: 'venue-1' } } as any, respuesta().res, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'base caída' }))
  })
})
