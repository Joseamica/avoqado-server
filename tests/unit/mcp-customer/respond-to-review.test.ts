import { registerReviewTools } from '../../../src/mcp/tools/reviews'
import type { McpScope } from '../../../src/mcp/scope'

const mockSubmit = jest.fn(async () => ({
  success: true,
  reviewId: 'rev-1',
  responseText: 'Gracias!',
  respondedAt: '2026-06-05T12:00:00.000Z',
  responseAutomated: true,
}))
const mockReviewFindFirst = jest.fn()
const mockLogAction = jest.fn()

jest.mock('@/services/reviewResponse.service', () => ({ submitResponse: (...a: unknown[]) => mockSubmit(...(a as [])) }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: (...a: unknown[]) => mockLogAction(...(a as [])) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (v: string) => ({ venueId: { in: [v] } }), requirePermission: jest.fn() }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { review: { findFirst: (...a: unknown[]) => mockReviewFindFirst(...(a as [])), aggregate: jest.fn(), findMany: jest.fn() } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 'staff-1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('respond_to_review')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerReviewTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('respond_to_review', () => {
  it('without confirm → preview of the public text, does NOT post', async () => {
    mockReviewFindFirst.mockResolvedValueOnce({ venueId: 'v1' })
    const out = parse(await call({ reviewId: 'rev-1', responseText: 'Gracias!' }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview).toMatchObject({ willPostPublicly: 'Gracias!' })
    expect(mockSubmit).not.toHaveBeenCalled()
  })

  it('confirm:true → submits + audits with staff attribution', async () => {
    mockReviewFindFirst.mockResolvedValueOnce({ venueId: 'v1' })
    const out = parse(await call({ reviewId: 'rev-1', responseText: 'Gracias!', confirm: true }))

    expect(mockSubmit).toHaveBeenCalledWith('rev-1', 'Gracias!')
    expect(out.ok).toBe(true)
    expect(mockLogAction.mock.calls[0][0]).toMatchObject({
      action: 'REVIEW_RESPONDED',
      entity: 'Review',
      entityId: 'rev-1',
      venueId: 'v1',
      staffId: 'staff-1',
      data: { source: 'customer-mcp' },
    })
  })

  it('rejects a review not in the caller scope — no submit (cross-tenant guard)', async () => {
    mockReviewFindFirst.mockResolvedValueOnce(null)
    const out = parse(await call({ reviewId: 'foreign-review', responseText: 'x' }))
    expect(out.ok).toBe(false)
    expect(mockSubmit).not.toHaveBeenCalled()
  })
})
