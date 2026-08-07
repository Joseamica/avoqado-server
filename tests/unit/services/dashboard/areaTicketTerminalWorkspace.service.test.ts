const mockPrisma: any = {
  terminal: {
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  fulfillmentArea: { findFirst: jest.fn() },
  scaleProfile: { findFirst: jest.fn() },
}

jest.mock('../../../../src/utils/prismaClient', () => ({ __esModule: true, default: mockPrisma }))
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn().mockResolvedValue(undefined),
}))

import { updateTerminal } from '../../../../src/services/dashboard/areaTicket.dashboard.service'

const CURRENT = {
  id: 'terminal_1',
  canIssueAreaTickets: false,
  canCheckoutAreaTickets: false,
  canDeliverAreaTickets: false,
  defaultWorkspace: 'STANDARD_POS',
}

describe('area ticket terminal default workspace', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPrisma.terminal.findFirst.mockResolvedValue(CURRENT)
    mockPrisma.terminal.update.mockResolvedValue({ id: CURRENT.id })
  })

  it('opens area operations when the dashboard enables an area-ticket capability', async () => {
    await updateTerminal('venue_1', CURRENT.id, { canIssueAreaTickets: true })

    expect(mockPrisma.terminal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          canIssueAreaTickets: true,
          defaultWorkspace: 'AREA_OPERATIONS',
        }),
      }),
    )
  })

  it('returns to standard POS when the last area-ticket capability is disabled', async () => {
    mockPrisma.terminal.findFirst.mockResolvedValue({
      ...CURRENT,
      canDeliverAreaTickets: true,
      defaultWorkspace: 'AREA_OPERATIONS',
    })

    await updateTerminal('venue_1', CURRENT.id, { canDeliverAreaTickets: false })

    expect(mockPrisma.terminal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ defaultWorkspace: 'STANDARD_POS' }),
      }),
    )
  })

  it('respects an explicitly selected workspace', async () => {
    await updateTerminal('venue_1', CURRENT.id, {
      canIssueAreaTickets: true,
      defaultWorkspace: 'STANDARD_POS',
    })

    expect(mockPrisma.terminal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ defaultWorkspace: 'STANDARD_POS' }),
      }),
    )
  })
})
