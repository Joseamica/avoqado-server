jest.mock('@/services/b4bit/b4bit.service', () => ({ getCryptoOperationForVenue: jest.fn() }))
jest.mock('@/mcp/guard', () => ({ createGuard: jest.fn() }))
import { registerCryptoOperationTools } from '@/mcp/tools/cryptoOperations'
import { getCryptoOperationForVenue } from '@/services/b4bit/b4bit.service'
import { createGuard } from '@/mcp/guard'

let handler: any
const venueFilter = jest.fn(),
  requirePermission = jest.fn()
beforeEach(() => {
  ;(createGuard as jest.Mock).mockReturnValue({ venueFilter, requirePermission })
  registerCryptoOperationTools(
    {
      tool: (...args: any[]) => {
        handler = args.at(-1)
      },
    } as any,
    { staffId: 'staff' } as any,
  )
  ;(getCryptoOperationForVenue as jest.Mock).mockResolvedValue({
    operation: { financialStatus: 'PENDING', providerStatus: 'CO', financialRecorded: false, requiresReview: true },
    amount: 150.5,
  })
})
describe('exact operation read', () => {
  it('requires venue scope and payments:read before the exact service; serial cannot be supplied by model', async () => {
    const result = await handler({ venueId: 'venue', idempotencyKey: 'cm00000000000000000000001', terminalSerial: 'other' })
    expect(venueFilter).toHaveBeenCalledWith('venue')
    expect(requirePermission).toHaveBeenCalledWith('payments:read', 'venue')
    expect(getCryptoOperationForVenue).toHaveBeenCalledWith('venue', 'cm00000000000000000000001', undefined, 'staff')
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      operation: { financialStatus: 'PENDING', providerStatus: 'CO', financialRecorded: false, requiresReview: true },
      amount: 150.5,
    })
  })
  it('refuses foreign venue before reading', async () => {
    venueFilter.mockImplementationOnce(() => {
      throw new Error('foreign venue')
    })
    await expect(handler({ venueId: 'foreign', idempotencyKey: 'op' })).rejects.toThrow('foreign venue')
    expect(getCryptoOperationForVenue).not.toHaveBeenCalled()
  })
  it('refuses missing current permission before reading', async () => {
    requirePermission.mockImplementationOnce(() => {
      throw new Error('missing payments:read')
    })
    await expect(handler({ venueId: 'venue', idempotencyKey: 'op' })).rejects.toThrow('missing payments:read')
    expect(getCryptoOperationForVenue).not.toHaveBeenCalled()
  })
})
