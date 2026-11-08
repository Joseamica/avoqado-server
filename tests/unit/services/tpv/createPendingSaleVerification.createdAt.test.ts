/** Gancho de la venta del celular: `createdAt` opcional (Cash Out paga por el día de la venta, no el de la subida). */
import { createPendingSaleVerification } from '@/services/tpv/sale-verification.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { $transaction: jest.fn() } }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

const base = {
  venueId: 'v1',
  paymentId: 'p1',
  staffId: 's1',
  isPortabilidad: false,
  serialNumbers: ['8952'],
  scannedProducts: [],
}

describe('createPendingSaleVerification · createdAt opcional', () => {
  let create: jest.Mock
  beforeEach(() => {
    create = jest.fn().mockResolvedValue({
      id: 'sv1',
      venueId: 'v1',
      paymentId: 'p1',
      staffId: 's1',
      photos: [],
      scannedProducts: [],
      status: 'PENDING',
      inventoryDeducted: false,
      isPortabilidad: false,
      serialNumbers: ['8952'],
      deviceId: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'p1', venueId: 'v1' }])
        .mockResolvedValueOnce([]),
      saleVerification: { create },
    }
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx))
  })

  it('con createdAt lo escribe', async () => {
    const createdAt = new Date('2026-11-01T10:00:00.000Z')
    await createPendingSaleVerification({ ...base, createdAt })
    expect(create.mock.calls[0][0].data.createdAt).toBe(createdAt)
  })

  it('sin createdAt el data es idéntico al de hoy (ni la llave)', async () => {
    await createPendingSaleVerification(base)
    const data = create.mock.calls[0][0].data
    expect('createdAt' in data).toBe(false)
    expect(data).toEqual({
      venueId: 'v1',
      paymentId: 'p1',
      staffId: 's1',
      photos: [],
      scannedProducts: [],
      status: 'PENDING',
      inventoryDeducted: false,
      isPortabilidad: false,
      serialNumbers: ['8952'],
      deviceId: null,
    })
  })
})
