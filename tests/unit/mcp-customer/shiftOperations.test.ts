jest.mock('@/services/tpv/shift.tpv.service', () => ({ getShiftOperationForVenue: jest.fn() }))
jest.mock('@/mcp/guard', () => ({ createGuard: jest.fn() }))
import { registerShiftOperationTools } from '@/mcp/tools/shiftOperations'
import { getShiftOperationForVenue } from '@/services/tpv/shift.tpv.service'
import { createGuard } from '@/mcp/guard'

let handler: any
const venueFilter = jest.fn(),
  requirePermission = jest.fn()
beforeEach(() => {
  ;(createGuard as jest.Mock).mockReturnValue({ venueFilter, requirePermission })
  registerShiftOperationTools(
    {
      tool: (...args: any[]) => {
        handler = args.at(-1)
      },
    } as any,
    { staffId: 'staff' } as any,
  )
  ;(getShiftOperationForVenue as jest.Mock).mockResolvedValue({
    operation: { state: 'CONFLICT', submittedCountedCash: '100.00', countApplied: false },
    shift: { cashDeclared: '200.00' },
  })
})
describe('exact operation read', () => {
  it('requires venue scope and shifts:read before the exact service; serial cannot be supplied by model', async () => {
    const result = await handler({ venueId: 'venue', operationId: 'cm00000000000000000000001', terminalSerial: 'other' })
    expect(venueFilter).toHaveBeenCalledWith('venue')
    expect(requirePermission).toHaveBeenCalledWith('shifts:read', 'venue')
    expect(getShiftOperationForVenue).toHaveBeenCalledWith('venue', 'cm00000000000000000000001', undefined, 'staff')
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      operation: { state: 'CONFLICT', countApplied: false },
      shift: { cashDeclared: '200.00' },
    })
  })
  it('refuses foreign venue before reading', async () => {
    venueFilter.mockImplementationOnce(() => {
      throw new Error('foreign venue')
    })
    await expect(handler({ venueId: 'foreign', operationId: 'op' })).rejects.toThrow('foreign venue')
    expect(getShiftOperationForVenue).not.toHaveBeenCalled()
  })
  it('refuses missing current permission before reading', async () => {
    requirePermission.mockImplementationOnce(() => {
      throw new Error('missing shifts:read')
    })
    await expect(handler({ venueId: 'venue', operationId: 'op' })).rejects.toThrow('missing shifts:read')
    expect(getShiftOperationForVenue).not.toHaveBeenCalled()
  })
})
