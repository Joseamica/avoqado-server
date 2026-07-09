import { registerSaleVerificationTools } from '../../../src/mcp/tools/saleVerifications'
import type { McpScope } from '../../../src/mcp/scope'

const mockReview = jest.fn()
const mockReopen = jest.fn()
const mockEdit = jest.fn()
const mockFindFirst = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/services/dashboard/sale-verification.org.dashboard.service', () => ({
  __esModule: true,
  reviewOrgSaleVerification: (...a: unknown[]) => mockReview(...(a as [])),
  reopenOrgSaleVerification: (...a: unknown[]) => mockReopen(...(a as [])),
  editOrgSaleVerification: (...a: unknown[]) => mockEdit(...(a as [])),
  listOrgSaleVerifications: jest.fn(),
  getOrgSalesSummary: jest.fn(),
  getSalesByMonth: jest.fn(),
  getSalesByCity: jest.fn(),
  getSalesByStore: jest.fn(),
  getSalesBySupervisor: jest.fn(),
  getSalesByPromoter: jest.fn(),
  getSalesByPromoterDaily: jest.fn(),
  getSalesBySaleTypeWeekly: jest.fn(),
  getSalesBySimTypeWeekly: jest.fn(),
  getSalesByPromoterWeekly: jest.fn(),
  getOrgStructure: jest.fn(),
  parseRange: (a?: string, b?: string) => ({ from: a, to: b }),
}))
jest.mock('@/services/access/access.service', () => ({ hasPermission: () => true }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { saleVerification: { findFirst: (...a: unknown[]) => mockFindFirst(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map([['v1', { organizationId: 'o1' }]]),
} as unknown as McpScope
const call = (n: string, a: Record<string, unknown>) => handlers.get(n)!(a, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const PENDING = {
  id: 'sv1',
  status: 'PENDING',
  isPortabilidad: false,
  venueId: 'v1',
  staff: { firstName: 'Ana', lastName: 'León' },
  venue: { name: 'BAE Uno' },
  payment: { amount: 250 },
}

beforeAll(() =>
  registerSaleVerificationTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope),
)
beforeEach(() => jest.clearAllMocks())

describe('review_sale_verification', () => {
  it('no confirm → preview, service not called', async () => {
    mockFindFirst.mockResolvedValue(PENDING)
    const out = parse(await call('review_sale_verification', { saleVerificationId: 'sv1', decision: 'approve' }))
    expect(out.requiresConfirmation).toBe(true)
    expect(mockReview).not.toHaveBeenCalled()
  })
  it('confirm approve → calls backend with APPROVE + audits', async () => {
    mockFindFirst.mockResolvedValue(PENDING)
    mockReview.mockResolvedValue({ status: 'COMPLETED' })
    const out = parse(await call('review_sale_verification', { saleVerificationId: 'sv1', decision: 'approve', confirm: true }))
    expect(out.ok).toBe(true)
    expect(mockReview).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ saleVerificationId: 'sv1', reviewedById: 's1', decision: 'APPROVE' }),
    )
    expect(mockAudit).toHaveBeenCalled()
  })
  it('not PENDING → guides to reopen, service not called', async () => {
    mockFindFirst.mockResolvedValue({ ...PENDING, status: 'COMPLETED' })
    const out = parse(await call('review_sale_verification', { saleVerificationId: 'sv1', decision: 'approve', confirm: true }))
    expect(out.ok).toBe(false)
    expect(mockReview).not.toHaveBeenCalled()
  })
  it('reject without reason/notes → error, service not called', async () => {
    mockFindFirst.mockResolvedValue(PENDING)
    const out = parse(await call('review_sale_verification', { saleVerificationId: 'sv1', decision: 'reject', confirm: true }))
    expect(out.ok).toBe(false)
    expect(mockReview).not.toHaveBeenCalled()
  })
})

describe('reopen_sale_verification', () => {
  it('confirm → calls reopen with reason', async () => {
    mockFindFirst.mockResolvedValue({ ...PENDING, status: 'COMPLETED' })
    mockReopen.mockResolvedValue({ status: 'PENDING' })
    const out = parse(await call('reopen_sale_verification', { saleVerificationId: 'sv1', reason: 'documento incorrecto', confirm: true }))
    expect(out.ok).toBe(true)
    expect(mockReopen).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ saleVerificationId: 'sv1', reopenedById: 's1', reason: 'documento incorrecto' }),
    )
  })
})

describe('edit_sale_verification', () => {
  it('no fields → error', async () => {
    mockFindFirst.mockResolvedValue(PENDING)
    const out = parse(await call('edit_sale_verification', { saleVerificationId: 'sv1', reason: 'ajuste monto', confirm: true }))
    expect(out.ok).toBe(false)
    expect(mockEdit).not.toHaveBeenCalled()
  })
  it('confirm with amount → calls edit', async () => {
    mockFindFirst.mockResolvedValue(PENDING)
    mockEdit.mockResolvedValue({ status: 'PENDING' })
    const out = parse(
      await call('edit_sale_verification', { saleVerificationId: 'sv1', amount: 300, reason: 'ajuste monto', confirm: true }),
    )
    expect(out.ok).toBe(true)
    expect(mockEdit).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ saleVerificationId: 'sv1', editedById: 's1', amount: 300, reason: 'ajuste monto' }),
    )
  })
})
