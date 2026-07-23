import prisma from '@/utils/prismaClient'
import { assertVenueSalesEnabled } from '@/services/venueSalesGuard'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn() } },
}))

describe('assertVenueSalesEnabled', () => {
  beforeEach(() => jest.clearAllMocks())

  it('permite ventas en una sucursal normal', async () => {
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ id: 'v1', name: 'Centro', salesEnabled: true })
    await expect(assertVenueSalesEnabled('v1')).resolves.toBeUndefined()
  })

  it('bloquea cualquier creación de venta en un CEDIS sin ventas', async () => {
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ id: 'v1', name: 'CEDIS Norte', salesEnabled: false })
    await expect(assertVenueSalesEnabled('v1')).rejects.toMatchObject({ statusCode: 403 })
  })
})
