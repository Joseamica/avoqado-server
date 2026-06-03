import prisma from '@/utils/prismaClient'
import { checkTerminalActivationStatus } from '@/services/dashboard/terminal-activation.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findFirst: jest.fn(), update: jest.fn() },
  },
}))

const mockedPrisma = prisma as unknown as {
  terminal: { findFirst: jest.Mock; update: jest.Mock }
}

describe('checkTerminalActivationStatus — stamps lastActivationStatusCheckAt', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedPrisma.terminal.update.mockResolvedValue({})
  })

  it('updates lastActivationStatusCheckAt for the resolved terminal', async () => {
    mockedPrisma.terminal.findFirst.mockResolvedValue({
      id: 'term-1',
      serialNumber: 'AVQD-123',
      status: 'ACTIVE',
      activatedAt: new Date('2026-01-01T00:00:00Z'),
      venueId: 'venue-new',
      venue: { id: 'venue-new', name: 'New', slug: 'new' },
    })

    await checkTerminalActivationStatus('AVQD-123')

    expect(mockedPrisma.terminal.update).toHaveBeenCalledWith({
      where: { id: 'term-1' },
      data: { lastActivationStatusCheckAt: expect.any(Date) },
    })
  })

  it('does NOT stamp when the terminal is not found', async () => {
    mockedPrisma.terminal.findFirst.mockResolvedValue(null)
    await expect(checkTerminalActivationStatus('AVQD-missing')).rejects.toThrow()
    expect(mockedPrisma.terminal.update).not.toHaveBeenCalled()
  })
})
