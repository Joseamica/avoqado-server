import { getUnsubscribePage, postUnsubscribe } from '../../../../src/controllers/public/unsubscribe.public.controller'
import * as tokenUtil from '../../../../src/utils/unsubscribeToken'
import * as svc from '../../../../src/services/notifications/emailUnsubscribe.service'

jest.mock('../../../../src/utils/unsubscribeToken')
jest.mock('../../../../src/services/notifications/emailUnsubscribe.service')

const mockVerify = tokenUtil.verifyUnsubscribeToken as jest.Mock
const mockUnsub = svc.unsubscribeFromEmailCategory as jest.Mock
const mockCtx = svc.getUnsubscribeContext as jest.Mock

function mockRes() {
  const res: any = {}
  res.statusCode = 200
  res.body = ''
  res.status = jest.fn((c: number) => {
    res.statusCode = c
    return res
  })
  res.type = jest.fn(() => res)
  res.send = jest.fn((b: string) => {
    res.body = b
    return res
  })
  return res
}

const VALID = { staffId: 's1', venueId: 'v1', category: 'INVENTORY' as const }
const CTX = { staffEmail: 'jose@example.com', staffFirstName: 'Jose', venueName: 'Mindform', categoryLabel: 'alertas de inventario' }

// asyncHandler doesn't return its promise (matches Express), so let the
// handler's async chain settle before asserting.
const flush = () => new Promise(resolve => setImmediate(resolve))

beforeEach(() => jest.clearAllMocks())

describe('GET /unsubscribe (confirm page)', () => {
  it('renders a confirm page WITHOUT mutating anything for a valid token', async () => {
    mockVerify.mockReturnValue(VALID)
    mockCtx.mockResolvedValue(CTX)
    const req: any = { query: { token: 'good' }, originalUrl: '/api/v1/public/unsubscribe?token=good' }
    const res = mockRes()

    await getUnsubscribePage(req, res, jest.fn())
    await flush()

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('¿Dejar de recibir')
    expect(res.body).toContain('jose@example.com')
    expect(res.body).toContain('<form method="POST"')
    // GET must never unsubscribe (email clients prefetch links)
    expect(mockUnsub).not.toHaveBeenCalled()
  })

  it('returns 400 invalid page for a bad token', async () => {
    mockVerify.mockReturnValue(null)
    const req: any = { query: { token: 'bad' }, originalUrl: '/x' }
    const res = mockRes()

    await getUnsubscribePage(req, res, jest.fn())
    await flush()

    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('no válido')
    expect(mockUnsub).not.toHaveBeenCalled()
  })
})

describe('POST /unsubscribe (execute + one-click)', () => {
  it('unsubscribes for a valid token and renders a success page', async () => {
    mockVerify.mockReturnValue(VALID)
    mockUnsub.mockResolvedValue({ affectedTypes: 1, alreadyUnsubscribed: false })
    mockCtx.mockResolvedValue(CTX)
    const req: any = { query: { token: 'good' }, originalUrl: '/api/v1/public/unsubscribe?token=good' }
    const res = mockRes()

    await postUnsubscribe(req, res, jest.fn())
    await flush()

    expect(mockUnsub).toHaveBeenCalledWith('s1', 'v1', 'INVENTORY')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('cancelamos tu suscripción')
  })

  it('returns 400 and does NOT unsubscribe for a bad token', async () => {
    mockVerify.mockReturnValue(null)
    const req: any = { query: { token: 'bad' }, originalUrl: '/x' }
    const res = mockRes()

    await postUnsubscribe(req, res, jest.fn())
    await flush()

    expect(res.statusCode).toBe(400)
    expect(mockUnsub).not.toHaveBeenCalled()
  })
})
