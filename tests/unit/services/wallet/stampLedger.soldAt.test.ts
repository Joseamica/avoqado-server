import { prismaMock } from '@tests/__helpers__/setup'
import { grantStamp } from '@/services/wallet/stampLedger.service'

jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))

const ahora = new Date('2026-11-09T18:00:00Z')
const ayer = new Date('2026-11-09T05:58:00Z') // 23:58 del día anterior en México.
const config = { active: true, stampsEnabled: true, stampsRequired: 10, maxStampsPerDay: 1 }

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers().setSystemTime(ahora)
  prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
  prismaMock.stampEvent.findFirst.mockResolvedValue(null)
  prismaMock.loyaltyTransaction.findFirst.mockResolvedValue(null)
  prismaMock.order.findFirst.mockResolvedValue({ id: 'o1', loyaltySaleAt: ayer, loyaltyEligibleAt: ahora } as any)
  prismaMock.stampCard.findFirst.mockResolvedValue({ id: 'card', stampsRequired: 10 } as any)
  prismaMock.stampCard.update.mockResolvedValue({ stampsEarned: 1, stampsRequired: 10 } as any)
  // Ya hay un sello HOY: una consulta al día equivocado lo rechaza.
  prismaMock.stampEvent.count.mockImplementation(async (args: any) => (args.where.createdAt.gte <= ayer ? 0 : 1))
})
afterEach(() => jest.useRealTimers())

describe('grantStamp · hora persistida de la venta (R-P2-S3-0)', () => {
  it.each(['loyaltySaleAt', 'loyaltyEligibleAt'] as const)('usa %s de ayer para el tope y el evento', async marca => {
    prismaMock.order.findFirst.mockResolvedValue({ id: 'o1', loyaltySaleAt: null, loyaltyEligibleAt: null, [marca]: ayer } as any)
    expect(await grantStamp('v1', 'c1', 'o1', { config: config as any })).toMatchObject({ granted: true })
    expect(prismaMock.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'o1', venueId: 'v1' } }))
    expect(prismaMock.stampEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ createdAt: ayer }) }),
    )
    expect(prismaMock.stampEvent.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gte: new Date('2026-11-08T06:00:00Z'), lte: new Date('2026-11-09T05:59:59.999Z') },
        }),
      }),
    )
  })

  it('tope0 conserva la fecha de ayer sin consultar zona ni conteo diario', async () => {
    expect(await grantStamp('v1', 'c1', 'o1', { config: { ...config, maxStampsPerDay: 0 } as any })).toMatchObject({ granted: true })
    expect(prismaMock.stampEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ createdAt: ayer }) }),
    )
    expect(prismaMock.venue.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.stampEvent.count).not.toHaveBeenCalled()
  })

  it('legacy con Order válida y ambas marcas null toma el reloj después de esperar los asesores', async () => {
    const despues = new Date('2026-11-10T06:01:00Z')
    prismaMock.order.findFirst.mockResolvedValue({ id: 'o1', loyaltySaleAt: null, loyaltyEligibleAt: null } as any)
    prismaMock.$executeRaw.mockImplementation(async () => {
      jest.setSystemTime(despues)
      return 1
    })
    prismaMock.stampEvent.count.mockResolvedValue(0)
    await grantStamp('v1', 'c1', 'o1', { config: config as any })
    expect(prismaMock.stampEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ createdAt: despues }) }),
    )
    expect(prismaMock.stampEvent.findFirst.mock.invocationCallOrder[1]).toBeLessThan(prismaMock.order.findFirst.mock.invocationCallOrder[0])
  })
})
