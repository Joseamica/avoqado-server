// Mock the Prisma client before importing the service under test.
jest.mock('../../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminalOrder: {
      count: jest.fn(),
    },
  },
}))

import prisma from '../../../../../src/utils/prismaClient'
import { generateOrderNumber } from '../../../../../src/services/dashboard/terminalOrder/orderNumber.service'

describe('generateOrderNumber', () => {
  const mockCount = prisma.terminalOrder.count as jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('starts at AVO-0001 when there are zero orders', async () => {
    mockCount.mockResolvedValue(0)
    const result = await generateOrderNumber()
    expect(result).toBe('AVO-0001')
  })

  it('increments past existing orders', async () => {
    mockCount.mockResolvedValue(1234)
    const result = await generateOrderNumber()
    expect(result).toBe('AVO-1235')
  })

  it('pads to 4 digits minimum', async () => {
    mockCount.mockResolvedValue(8)
    const result = await generateOrderNumber()
    expect(result).toBe('AVO-0009')
  })

  it('does not pad past 4 digits', async () => {
    mockCount.mockResolvedValue(99999)
    const result = await generateOrderNumber()
    expect(result).toBe('AVO-100000')
  })
})
