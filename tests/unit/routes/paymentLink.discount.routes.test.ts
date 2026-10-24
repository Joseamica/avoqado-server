const mockPermission = jest.fn()
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: (permission: string) => async (req: any, res: any, next: any) => {
    mockPermission(permission)
    if (req.denied?.includes(permission)) return res.status(403).json({ error: 'Sin permiso' })
    next()
  },
  resolveUserRoleForVenue: jest.fn().mockResolvedValue({ role: 'CASHIER', permissionSet: null }),
  evaluateRolePermission: jest.fn(),
}))
jest.mock('@/services/access/access.service', () => ({ getUserAccess: jest.fn().mockResolvedValue({}), hasPermission: jest.fn() }))
const mockCreate = jest.fn()
const mockUpdate = jest.fn()
jest.mock('@/services/dashboard/paymentLink.service', () => ({
  createPaymentLink: (...a: unknown[]) => mockCreate(...a),
  updatePaymentLink: (...a: unknown[]) => mockUpdate(...a),
}))
import router from '@/routes/dashboard/paymentLink.routes'
import { hasPermission } from '@/services/access/access.service'

const response = () => {
  const res: any = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res
}
const run = async (method: string, path: string, body: any = {}, denied: string[] = []) => {
  const req: any = {
    body,
    params: { venueId: 'v1', linkId: 'pl1' },
    query: {},
    denied,
    headers: {},
    get: () => undefined,
    authContext: { userId: 'staff1', role: 'CASHIER', venueId: 'v1' },
  }
  const res = response()
  const route = (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]).route
  for (const layer of route.stack) {
    let next = false
    await layer.handle(req, res, () => {
      next = true
    })
    if (!next) break
  }
  return { res }
}
const MANUAL = { mode: 'MANUAL', type: 'PERCENTAGE', value: 15 }
const CATALOG = { mode: 'CATALOG', discountId: 'cm00000000000000000000001' }
const base = { title: 'Anticipo', amountType: 'FIXED', amount: 100 }

beforeEach(() => {
  jest.clearAllMocks()
  ;(hasPermission as jest.Mock).mockResolvedValue(false)
  mockCreate.mockResolvedValue({ id: 'pl1' })
  mockUpdate.mockResolvedValue({ id: 'pl1' })
})

describe.each([
  ['post', '/'],
  ['put', '/:linkId'],
])('%s con descuento', (method, path) => {
  it('discount sin discounts:apply → 403 y no llega al servicio', async () => {
    const { res } = await run(method, path, { ...base, discount: MANUAL }, ['discounts:apply'])
    expect(res.status).toHaveBeenCalledWith(403)
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('CATALOG sin discounts:read → 403', async () => {
    const { res } = await run(method, path, { ...base, discount: CATALOG }, ['discounts:read'])
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('MANUAL no pide discounts:read; CATALOG pide los dos', async () => {
    mockPermission.mockClear()
    await run(method, path, { ...base, discount: MANUAL })
    expect(mockPermission).toHaveBeenCalledWith('discounts:apply')
    expect(mockPermission).not.toHaveBeenCalledWith('discounts:read')
    mockPermission.mockClear()
    await run(method, path, { ...base, discount: CATALOG })
    expect(mockPermission).toHaveBeenCalledWith('discounts:apply')
    expect(mockPermission).toHaveBeenCalledWith('discounts:read')
  })

  it('sin discount (o discount null para quitarlo) no pide permisos nuevos', async () => {
    mockPermission.mockClear()
    await run(method, path, { ...base }, ['discounts:apply', 'discounts:read'])
    await run(method, path, { ...base, discount: null }, ['discounts:apply', 'discounts:read'])
    const pedidos = mockPermission.mock.calls.map(c => c[0])
    expect(pedidos).not.toContain('discounts:apply')
    expect(pedidos).not.toContain('discounts:read')
  })
})
