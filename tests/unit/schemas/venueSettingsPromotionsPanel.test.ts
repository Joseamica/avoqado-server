import { UpdateVenueSettingsSchema } from '@/schemas/dashboard/venueSettings.schema'

describe('VenueSettings acepta los ajustes de panel de promociones', () => {
  it('🔴 promotionsPanelCashier/Customer sobreviven el parse (sin esto se pierden en silencio)', () => {
    const parsed = UpdateVenueSettingsSchema.parse({
      body: { promotionsPanelCashier: 'SIDE_PANEL', promotionsPanelCustomer: 'HIDDEN' },
      params: { venueId: 'venue-1' },
    })

    expect(parsed.body).toMatchObject({ promotionsPanelCashier: 'SIDE_PANEL', promotionsPanelCustomer: 'HIDDEN' })
  })

  it('un valor fuera del enum se rechaza con mensaje en español', () => {
    expect(() => UpdateVenueSettingsSchema.parse({ body: { promotionsPanelCashier: 'GIGANTE' }, params: { venueId: 'venue-1' } })).toThrow()
  })
})

// El createData del upsert (venueSettings.dashboard.service.ts) es una lista de campos
// enumerados a mano: agregar un campo al schema de Zod NO basta, hay que agregarlo también
// ahí o el PRIMER PUT de un venue sin fila de VenueSettings lo pierde en silencio (entra por
// `create`, no por `update`). Mismo patrón que tests/unit/services/venueSettings.updateCreate.test.ts
// (caso ya resuelto para googleReviewLink).
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    venueSettings: { upsert: jest.fn() },
  },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import prisma from '@/utils/prismaClient'

const mockedPrisma = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  venueSettings: { upsert: jest.Mock }
}

describe('updateVenueSettings — paneles de promociones en el CREATE branch del upsert', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 el PRIMER PUT (venue sin fila) también persiste los paneles — el create del upsert los lleva', async () => {
    mockedPrisma.venue.findUnique.mockResolvedValue({ id: 'venue-1' }) // el service valida el venue primero (:131-137)
    mockedPrisma.venueSettings.upsert.mockResolvedValue({})
    const { updateVenueSettings } = await import('@/services/dashboard/venueSettings.dashboard.service')

    await updateVenueSettings('venue-1', { promotionsPanelCashier: 'SIDE_PANEL' } as any, 'staff-1')

    const args = mockedPrisma.venueSettings.upsert.mock.calls[0][0]
    expect(args.create).toMatchObject({ promotionsPanelCashier: 'SIDE_PANEL' })
    expect(args.update).toMatchObject({ promotionsPanelCashier: 'SIDE_PANEL' })
  })
})
