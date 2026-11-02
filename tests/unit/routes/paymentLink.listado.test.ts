// La lista del dashboard pagina, filtra por pestaña y cuenta en el servidor: antes llegaban sólo 20 ligas y el
// navegador filtraba y contaba esas 20 (las más viejas no salían en ninguna pestaña).
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: () => async (_req: any, _res: any, next: any) => next(),
  resolveUserRoleForVenue: jest.fn().mockResolvedValue({ role: 'OWNER', permissionSet: null }),
  evaluateRolePermission: jest.fn(),
}))
jest.mock('@/services/access/access.service', () => ({ getUserAccess: jest.fn().mockResolvedValue({}), hasPermission: jest.fn() }))
const mockList = jest.fn()
jest.mock('@/services/dashboard/paymentLink.service', () => ({
  getPaymentLinks: (...a: unknown[]) => mockList(...a),
  cambiaBaseDeLigaConDescuento: async () => false,
}))
import router from '@/routes/dashboard/paymentLink.routes'
import { hasPermission } from '@/services/access/access.service'

const response = () => {
  const res: any = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res
}
const listar = async (query: Record<string, string>) => {
  const req: any = { body: {}, params: { venueId: 'v1' }, query, headers: {}, get: () => undefined, authContext: { userId: 'staff1', role: 'OWNER', venueId: 'v1' } }
  const res = response()
  const route = (router as any).stack.find((l: any) => l.route?.path === '/' && l.route.methods.get).route
  for (const layer of route.stack) {
    let next = false
    let err: any
    await layer.handle(req, res, (e?: any) => {
      next = true
      err = e
    })
    // validateRequest no responde: pasa un BadRequestError a next() y el manejador global lo vuelve 400.
    if (err) return { res, err }
    if (!next) break
  }
  return { res, err: undefined }
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(hasPermission as jest.Mock).mockResolvedValue(true)
  mockList.mockResolvedValue({ paymentLinks: [], total: 0, limit: 20, offset: 0, hasMore: false })
})

it('pasa pestaña, varios estados, página y pide los contadores', async () => {
  const { err } = await listar({ view: 'used', statuses: 'ACTIVE,PAUSED', search: 'clase', limit: '50', offset: '100' })
  expect(err).toBeUndefined()
  expect(mockList).toHaveBeenCalledWith('v1', {
    status: undefined,
    statuses: ['ACTIVE', 'PAUSED'],
    view: 'used',
    search: 'clase',
    limit: 50,
    offset: 100,
    withCounts: true,
  })
})

it('sin parámetros nuevos sigue como antes (y pide los contadores)', async () => {
  await listar({})
  expect(mockList).toHaveBeenCalledWith('v1', expect.objectContaining({ statuses: undefined, view: undefined, withCounts: true }))
})

it.each<Record<string, string>>([{ view: 'borradas' }, { statuses: 'ACTIVE,NO_EXISTE' }])('rechaza un valor inválido %o con 400', async query => {
  const { err } = await listar(query)
  expect(err?.statusCode).toBe(400)
  expect(mockList).not.toHaveBeenCalled()
})
