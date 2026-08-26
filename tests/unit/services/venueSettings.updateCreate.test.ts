import { updateVenueSettings } from '../../../src/services/dashboard/venueSettings.dashboard.service'

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    venueSettings: { findUnique: jest.fn() /* el servicio lee el 'antes' para la bitácora (Codex P3-1) */, upsert: jest.fn() },
  },
}))
jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import prisma from '../../../src/utils/prismaClient'

const mockedPrisma = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  venueSettings: { upsert: jest.Mock }
}

describe('updateVenueSettings — googleReviewLink on the CREATE branch', () => {
  beforeEach(() => jest.clearAllMocks())

  it('includes googleReviewLink in the upsert CREATE payload (so a venue with no settings row still persists it)', async () => {
    mockedPrisma.venue.findUnique.mockResolvedValue({ id: 'v1' })
    mockedPrisma.venueSettings.upsert.mockResolvedValue({ id: 's1', venueId: 'v1', googleReviewLink: 'ChIJ12345abc' })

    await updateVenueSettings('v1', { googleReviewLink: 'ChIJ12345abc' } as any)

    const callArg = mockedPrisma.venueSettings.upsert.mock.calls[0][0]
    expect(callArg.create.googleReviewLink).toBe('ChIJ12345abc')
    // update branch still passes the raw updates through
    expect(callArg.update.googleReviewLink).toBe('ChIJ12345abc')
  })

  it('defaults googleReviewLink to null in CREATE when not provided', async () => {
    mockedPrisma.venue.findUnique.mockResolvedValue({ id: 'v1' })
    mockedPrisma.venueSettings.upsert.mockResolvedValue({ id: 's1', venueId: 'v1' })

    await updateVenueSettings('v1', { notifyBadReviews: false } as any)

    const callArg = mockedPrisma.venueSettings.upsert.mock.calls[0][0]
    expect(callArg.create.googleReviewLink ?? null).toBeNull()
  })
})

describe('updateVenueSettings — managerPinOverrideEnabled on the CREATE branch', () => {
  beforeEach(() => jest.clearAllMocks())

  // 🔴 Un venue SIN fila de VenueSettings toma la rama CREATE. Si el campo no
  // viaja ahí, el switch del dashboard se ve encendido y la fila nace en false:
  // el POS nunca ofrecería el PIN y nadie sabría por qué.
  it('lo incluye en el payload CREATE (un venue sin fila de settings también lo persiste)', async () => {
    mockedPrisma.venue.findUnique.mockResolvedValue({ id: 'v1' })
    mockedPrisma.venueSettings.upsert.mockResolvedValue({ id: 's1', venueId: 'v1', managerPinOverrideEnabled: true })

    await updateVenueSettings('v1', { managerPinOverrideEnabled: true } as any)

    const callArg = mockedPrisma.venueSettings.upsert.mock.calls[0][0]
    expect(callArg.create.managerPinOverrideEnabled).toBe(true)
    expect(callArg.update.managerPinOverrideEnabled).toBe(true)
  })

  it('nace apagado cuando el update no lo menciona', async () => {
    mockedPrisma.venue.findUnique.mockResolvedValue({ id: 'v1' })
    mockedPrisma.venueSettings.upsert.mockResolvedValue({ id: 's1', venueId: 'v1' })

    await updateVenueSettings('v1', { notifyBadReviews: false } as any)

    const callArg = mockedPrisma.venueSettings.upsert.mock.calls[0][0]
    expect(callArg.create.managerPinOverrideEnabled ?? false).toBe(false)
  })
})
