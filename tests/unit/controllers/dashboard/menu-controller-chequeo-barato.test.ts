/**
 * Los handlers del menú verifican el venue con el chequeo BARATO.
 *
 * Los 29 handlers de menu.dashboard.controller comparten `checkVenueAccess`. Hasta el
 * 2026-09-01 ese helper llamaba a `getVenueById`, que carga el venue COMPLETO con sus
 * relaciones — pagar eso en cada petición del menú (sólo para saber si el venue existe)
 * fue la causa del incidente de ese día. Esta prueba fija que el helper usa
 * `assertVenueAccessible` (select { id }) y nunca vuelve a `getVenueById`.
 */
import { Request, Response, NextFunction } from 'express'
import * as venueService from '@/services/dashboard/venue.dashboard.service'
import * as menuCategoryService from '@/services/dashboard/menu.dashboard.service'
import { getMenusHandler, listMenuCategoriesHandler } from '@/controllers/dashboard/menu.dashboard.controller'

jest.mock('@/services/dashboard/venue.dashboard.service')
jest.mock('@/services/dashboard/menu.dashboard.service')

const assertVenueAccessible = jest.mocked(venueService.assertVenueAccessible)
const getVenueById = jest.mocked(venueService.getVenueById)

const makeReq = (role = 'OWNER') =>
  ({
    params: { venueId: 'venue-1' },
    authContext: { orgId: 'org-1', role },
  }) as unknown as Request<{ venueId: string }>

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  return res
}

beforeEach(() => {
  jest.clearAllMocks()
  assertVenueAccessible.mockResolvedValue(undefined)
  jest.mocked(menuCategoryService.getMenus).mockResolvedValue([] as never)
  jest.mocked(menuCategoryService.listMenuCategoriesForVenue).mockResolvedValue([] as never)
})

describe('menu controller — chequeo de venue barato', () => {
  it('getMenusHandler usa assertVenueAccessible y NUNCA getVenueById', async () => {
    const next = jest.fn() as NextFunction
    await getMenusHandler(makeReq(), makeRes(), next)

    expect(assertVenueAccessible).toHaveBeenCalledWith('org-1', 'venue-1', { skipOrgCheck: false })
    expect(getVenueById).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('listMenuCategoriesHandler usa assertVenueAccessible y NUNCA getVenueById', async () => {
    const next = jest.fn() as NextFunction
    await listMenuCategoriesHandler(makeReq(), makeRes(), next)

    expect(assertVenueAccessible).toHaveBeenCalledTimes(1)
    expect(getVenueById).not.toHaveBeenCalled()
  })

  it('SUPERADMIN pasa skipOrgCheck: true', async () => {
    const next = jest.fn() as NextFunction
    await getMenusHandler(makeReq('SUPERADMIN'), makeRes(), next)

    expect(assertVenueAccessible).toHaveBeenCalledWith('org-1', 'venue-1', { skipOrgCheck: true })
  })

  it('un venue inaccesible corta el handler (el error del assert viaja a next)', async () => {
    const boom = new Error('Venue with ID venue-1 not found or not accessible by your organization.')
    assertVenueAccessible.mockRejectedValue(boom)
    const next = jest.fn() as NextFunction

    await getMenusHandler(makeReq(), makeRes(), next)

    expect(next).toHaveBeenCalledWith(boom)
    expect(menuCategoryService.getMenus).not.toHaveBeenCalled()
  })
})
