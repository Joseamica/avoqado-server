import { auditMcpWrite } from '../../../src/mcp/audit'
import { logAction } from '@/services/dashboard/activity-log.service'
import type { McpScope } from '../../../src/mcp/scope'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
const mockedLogAction = logAction as jest.Mock

const scope: McpScope = { staffId: 'staff-1', activeOrg: 'org-1', allowedVenueIds: ['v1'], perVenueAccess: new Map() }

describe('auditMcpWrite', () => {
  beforeEach(() => jest.clearAllMocks())

  it('attributes the write to the connected staff and tags source=customer-mcp', async () => {
    await auditMcpWrite(scope, {
      action: 'MENU_ITEM_PRICE_SET',
      entity: 'Product',
      entityId: 'prod-9',
      venueId: 'v1',
      data: { name: 'Carnitas', price: 120 },
    })

    expect(mockedLogAction).toHaveBeenCalledTimes(1)
    expect(mockedLogAction).toHaveBeenCalledWith({
      staffId: 'staff-1', // the human who connected their AI is accountable — not 'SYSTEM'
      venueId: 'v1',
      action: 'MENU_ITEM_PRICE_SET',
      entity: 'Product',
      entityId: 'prod-9',
      data: { name: 'Carnitas', price: 120, source: 'customer-mcp' },
    })
  })

  it('still tags source=customer-mcp when no extra data is provided', async () => {
    await auditMcpWrite(scope, { action: 'RESERVATION_CANCELLED', entity: 'Reservation', entityId: 'r-1', venueId: 'v1' })
    expect(mockedLogAction.mock.calls[0][0].data).toEqual({ source: 'customer-mcp' })
  })
})
