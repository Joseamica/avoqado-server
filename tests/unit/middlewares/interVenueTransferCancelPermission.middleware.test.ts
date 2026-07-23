const mockFindFirst = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { interVenueTransfer: { findFirst: mockFindFirst } },
}))

jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: (permission: string) => (req: any, _res: any, next: any) => {
    req.delegatedPermission = permission
    next()
  },
}))

import { checkInterVenueTransferCancelPermission } from '@/middlewares/interVenueTransferCancelPermission.middleware'

describe('checkInterVenueTransferCancelPermission', () => {
  beforeEach(() => jest.clearAllMocks())

  it('requires approve permission when the active venue is the source', async () => {
    mockFindFirst.mockResolvedValue({ sourceVenueId: 'venue-source' })
    const req = { params: { venueId: 'venue-source', transferId: 'transfer-1' } } as any
    const next = jest.fn()

    await checkInterVenueTransferCancelPermission(req, {} as any, next)

    expect(req.delegatedPermission).toBe('inventory-transfers:approve')
    expect(next).toHaveBeenCalledWith()
  })

  it('requires request permission when the active venue is the destination', async () => {
    mockFindFirst.mockResolvedValue({ sourceVenueId: 'venue-source' })
    const req = { params: { venueId: 'venue-destination', transferId: 'transfer-1' } } as any
    const next = jest.fn()

    await checkInterVenueTransferCancelPermission(req, {} as any, next)

    expect(req.delegatedPermission).toBe('inventory-transfers:request')
    expect(next).toHaveBeenCalledWith()
  })

  it('returns not found without delegating when the transfer is outside the venue', async () => {
    mockFindFirst.mockResolvedValue(null)
    const req = { params: { venueId: 'venue-other', transferId: 'transfer-1' } } as any
    const json = jest.fn()
    const status = jest.fn(() => ({ json }))
    const next = jest.fn()

    await checkInterVenueTransferCancelPermission(req, { status } as any, next)

    expect(status).toHaveBeenCalledWith(404)
    expect(json).toHaveBeenCalledWith({ success: false, message: 'Traslado no encontrado' })
    expect(next).not.toHaveBeenCalled()
  })
})
