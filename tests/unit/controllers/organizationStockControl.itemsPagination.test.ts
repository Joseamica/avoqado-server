import type { NextFunction, Request, Response } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'
import {
  getOrgStockBulkGroups,
  getOrgStockCustody,
  getOrgStockItems,
  getOrgStockSummary,
} from '@/controllers/dashboard/organizationStockControl.controller'
import { orgStockControlService } from '@/services/organization-dashboard/orgStockControl.service'

function responseMock() {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}

describe('getOrgStockItems', () => {
  it('normaliza la paginación y conserva los filtros del usuario', async () => {
    prismaMock.organizationModule.findFirst.mockResolvedValue({ id: 'module-1' } as any)
    const page = { items: [], pagination: { page: 2, pageSize: 100, total: 0, totalPages: 0 } }
    const pageSpy = jest.spyOn(orgStockControlService, 'getOrgItemsPage').mockResolvedValue(page)
    const req = {
      params: { orgId: 'org-1' },
      query: {
        page: '2',
        pageSize: '500',
        search: ' 895214 ',
        status: 'AVAILABLE',
        custodyState: 'PROMOTER_HELD',
        categoryId: 'cat-1',
        registeredFromVenueId: 'venue-1',
        dateFrom: '2025-09-01T00:00:00.000Z',
        dateTo: '2026-09-01T23:59:59.999Z',
      },
    } as unknown as Request
    const res = responseMock()
    const next = jest.fn() as NextFunction

    await getOrgStockItems(req, res, next)

    expect(pageSpy).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({
        page: 2,
        pageSize: 100,
        search: '895214',
        status: 'AVAILABLE',
        custodyState: 'PROMOTER_HELD',
        categoryId: 'cat-1',
        registeredFromVenueId: 'venue-1',
      }),
    )
    expect(res.json).toHaveBeenCalledWith({ success: true, data: page })
    expect(next).not.toHaveBeenCalled()
  })

  it('rechaza un estado desconocido antes de consultar inventario', async () => {
    prismaMock.organizationModule.findFirst.mockResolvedValue({ id: 'module-1' } as any)
    const pageSpy = jest.spyOn(orgStockControlService, 'getOrgItemsPage')
    const req = {
      params: { orgId: 'org-1' },
      query: { status: 'LOST' },
    } as unknown as Request
    const res = responseMock()

    await getOrgStockItems(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(pageSpy).not.toHaveBeenCalled()
  })
})

describe('getOrgStockSummary', () => {
  it('expone el resumen agregado con el mismo rango de fechas', async () => {
    prismaMock.organizationModule.findFirst.mockResolvedValue({ id: 'module-1' } as any)
    const summaryData = {
      summary: { totalSims: 0 },
      aggregatesBySucursal: [],
      aggregatesByCategoria: [],
    } as any
    const summarySpy = jest.spyOn(orgStockControlService, 'getOrgSummary').mockResolvedValue(summaryData)
    const req = {
      params: { orgId: 'org-1' },
      query: {
        dateFrom: '2025-09-01T00:00:00.000Z',
        dateTo: '2026-09-01T23:59:59.999Z',
      },
    } as unknown as Request
    const res = responseMock()

    await getOrgStockSummary(req, res, jest.fn())

    expect(summarySpy).toHaveBeenCalledWith('org-1', {
      dateFrom: new Date('2025-09-01T00:00:00.000Z'),
      dateTo: new Date('2026-09-01T23:59:59.999Z'),
    })
    expect(res.json).toHaveBeenCalledWith({ success: true, data: summaryData })
  })
})

describe('getOrgStockBulkGroups', () => {
  it('normaliza la búsqueda y pagina los grupos desde el servidor', async () => {
    prismaMock.organizationModule.findFirst.mockResolvedValue({ id: 'module-1' } as any)
    const groupsPage = { groups: [], pagination: { page: 2, pageSize: 20, total: 0, totalPages: 0 } }
    const groupsSpy = jest.spyOn(orgStockControlService, 'getOrgBulkGroupsPage').mockResolvedValue(groupsPage)
    const req = {
      params: { orgId: 'org-1' },
      query: { page: '2', pageSize: '20', search: ' 895-214 ', categoryId: 'cat-1', registeredFromVenueId: 'venue-1' },
    } as unknown as Request
    const res = responseMock()

    await getOrgStockBulkGroups(req, res, jest.fn())

    expect(groupsSpy).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({
        page: 2,
        pageSize: 20,
        search: '895214',
        categoryId: 'cat-1',
        registeredFromVenueId: 'venue-1',
      }),
    )
    expect(res.json).toHaveBeenCalledWith({ success: true, data: groupsPage })
  })
})

describe('getOrgStockCustody', () => {
  it('usa al actor autenticado y limita la pagina sin perder filtros', async () => {
    prismaMock.organizationModule.findFirst.mockResolvedValue({ id: 'module-1' } as any)
    const custodyPage = {
      summary: { total: 0, almacen: 0, pendientes: 0, aceptados: 0, rechazados: 0, vendidos: 0, estancados: 0 },
      promoterRanking: [],
      items: [],
      pagination: { page: 1, pageSize: 100, total: 0, totalPages: 0 },
    }
    const pageSpy = jest.spyOn(orgStockControlService, 'getOrgCustodyPage').mockResolvedValue(custodyPage as any)
    const req = {
      params: { orgId: 'org-1' },
      query: {
        venueId: 'venue-1',
        page: '1',
        pageSize: '500',
        search: ' 895214 ',
        filter: 'estancados',
      },
      authContext: { userId: 'supervisor-1' },
    } as unknown as Request
    const res = responseMock()

    await getOrgStockCustody(req, res, jest.fn())

    expect(pageSpy).toHaveBeenCalledWith(
      'org-1',
      'supervisor-1',
      expect.objectContaining({
        targetVenueId: 'venue-1',
        page: 1,
        pageSize: 100,
        search: '895214',
        filter: 'estancados',
      }),
    )
    expect(res.json).toHaveBeenCalledWith({ success: true, data: custodyPage })
  })
})
