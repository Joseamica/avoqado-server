import type { McpScope } from '@/mcp/scope'
import { registerPaymentEffectTools } from '@/mcp/tools/paymentEffects'
import { listPaymentEffects } from '@/services/tpv/paymentEffectsRead.service'

jest.mock('@/services/tpv/paymentEffectsRead.service', () => ({ listPaymentEffects: jest.fn() }))
const mockPermission = jest.fn()
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (venue: string) => {
      if (venue !== 'own') throw new Error('out of scope')
      return { venueId: { in: [venue] } }
    },
    requirePermission: (...args: unknown[]) => mockPermission(...args),
  }),
}))

const scope = { staffId: 'staff', activeOrg: 'org', allowedVenueIds: ['own'], perVenueAccess: new Map() } as McpScope
const handler = () => {
  let call: ((input: Record<string, unknown>) => Promise<any>) | undefined
  registerPaymentEffectTools(
    {
      tool: (name: string, _description: string, _schema: unknown, fn: typeof call) => {
        if (name === 'list_payment_effects') call = fn
      },
    } as never,
    scope,
  )
  expect(call).toBeDefined()
  return call!
}
beforeEach(() => {
  jest.resetAllMocks()
  ;(listPaymentEffects as jest.Mock).mockResolvedValue({ items: [], total: 0, hasMore: false, nextCursor: null })
})

describe('payment effect operator tool', () => {
  it('requires the selected venue scope and payment read permission before fetching effects', async () => {
    const call = handler()
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(listPaymentEffects).not.toHaveBeenCalled()
    mockPermission.mockImplementationOnce(() => {
      throw new Error('permission denied')
    })
    await expect(call({ venueId: 'own' })).rejects.toThrow('permission denied')
    expect(mockPermission).toHaveBeenCalledWith('payments:read', 'own')
    expect(listPaymentEffects).not.toHaveBeenCalled()
  })
  it('exposes page metadata and passes the exact status, payment and cursor filters to the bounded service', async () => {
    const input = { venueId: 'own', status: 'DEAD_LETTER', paymentId: 'payment', limit: 1000000, cursor: 'cursor' }
    const response = await handler()(input)
    expect(listPaymentEffects).toHaveBeenCalledWith(input)
    expect(JSON.parse(response.content[0].text)).toMatchObject({ items: [], total: 0, hasMore: false, nextCursor: null })
  })
})
