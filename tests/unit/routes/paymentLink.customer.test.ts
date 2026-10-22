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
const mockList = jest.fn()
const mockGet = jest.fn()
const mockUpdate = jest.fn()
jest.mock('@/services/dashboard/paymentLink.service', () => ({
  createPaymentLink: (...a: unknown[]) => mockCreate(...a),
  getPaymentLinks: (...a: unknown[]) => mockList(...a),
  getPaymentLinkById: (...a: unknown[]) => mockGet(...a),
  updatePaymentLink: (...a: unknown[]) => mockUpdate(...a),
}))
import router from '@/routes/dashboard/paymentLink.routes'
import { hasPermission } from '@/services/access/access.service'
import { createPaymentLinkBodySchema, updatePaymentLinkBodySchema } from '@/schemas/dashboard/paymentLink.schema'
const CUSTOMER = 'cm00000000000000000000001'
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
    headers: { 'idempotency-key': 'attempt1' },
    get: (k: string) => (k.toLowerCase() === 'idempotency-key' ? 'attempt1' : undefined),
    authContext: { userId: 'staff1', role: 'CASHIER', venueId: 'v1' },
  }
  const res = response()
  const route = (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]).route
  for (const layer of route.stack) {
    let next = false
    let err: any
    await layer.handle(req, res, (e?: any) => {
      next = true
      err = e
    })
    if (err) return { req, res, err }
    if (!next) break
  }
  return { req, res, err: undefined }
}
beforeEach(() => {
  jest.clearAllMocks()
  ;(hasPermission as jest.Mock).mockResolvedValue(false)
})
it('create conserva customerId validado y exige customers:read sin bloquear anónimos', async () => {
  const body = { title: 'Anticipo', amountType: 'FIXED', amount: 100, customerId: CUSTOMER }
  expect(createPaymentLinkBodySchema.parse(body).customerId).toBe(CUSTOMER)
  const denied = await run('post', '/', body, ['customers:read'])
  expect(denied.res.status).toHaveBeenCalledWith(403)
  expect(mockCreate).not.toHaveBeenCalled()
  mockCreate.mockResolvedValue({ id: 'pl1' })
  await run('post', '/', { title: 'Anticipo', amountType: 'FIXED', amount: 100 }, ['customers:read'])
  expect(mockCreate).toHaveBeenCalledWith('v1', expect.anything(), 'staff1', 'attempt1')
})
it('update rechaza intento explícito en lugar de quitarlo silenciosamente', () => {
  expect(updatePaymentLinkBodySchema.safeParse({ customerId: CUSTOMER }).success).toBe(false)
  expect(updatePaymentLinkBodySchema.safeParse({ customerId: null }).success).toBe(false)
})
it.each([false, true])('respuestas privadas redactan id y contactos cuando read=%s', async allowed => {
  ;(hasPermission as jest.Mock).mockResolvedValue(allowed)
  const link = {
    id: 'pl1',
    customerId: CUSTOMER,
    customer: { id: CUSTOMER, email: 'fixture@example.test' },
    creationKey: 'attempt1',
    creationHash: 'hash',
  }
  mockList.mockResolvedValue({ paymentLinks: [link], total: 1 })
  mockGet.mockResolvedValue(link)
  mockUpdate.mockResolvedValue(link)
  mockCreate.mockResolvedValue(link)
  for (const [method, path, body] of [
    ['get', '/', {}],
    ['get', '/:linkId', {}],
    ['put', '/:linkId', { title: 'X' }],
    ['post', '/', { title: 'X', amountType: 'FIXED', amount: 100 }],
  ] as const) {
    const { res } = await run(method, path, body)
    const data = res.json.mock.calls[0][0].data
    const item = path === '/' && method === 'get' ? data.paymentLinks[0] : data
    expect(item.id).toBe('pl1')
    if (allowed) expect(item.customer).toEqual(link.customer)
    else {
      expect(item).not.toHaveProperty('customer')
      expect(item).not.toHaveProperty('customerId')
    }
    expect(item).not.toHaveProperty('creationKey')
    expect(item).not.toHaveProperty('creationHash')
  }
})
