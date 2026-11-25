/**
 * Planes editables B1, Task 3: con la versión de la oferta sembrada, `scripts/seed-plan-list-prices.ts --apply` se niega con
 * `SeedRefusal` (sale con 2 y su mensaje), no con el 409 crudo del servicio.
 */
jest.mock('@/services/launchCampaigns/hybridPrices', () => ({ ensureHybridPublicationPrices: jest.fn() }))

import { SeedRefusal, seedPlanLists } from '../../../scripts/seed-plan-list-prices'
import { ensureHybridPublicationPrices } from '@/services/launchCampaigns/hybridPrices'
import { prismaMock } from '@tests/__helpers__/setup'
import { punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'

const URL_ANTES = process.env.DATABASE_URL
beforeAll(() => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/avoqado_listas_test'
})
afterAll(() => {
  process.env.DATABASE_URL = URL_ANTES
})

beforeEach(() => {
  prismaMock.staff.findUnique.mockReset().mockResolvedValue({ id: 'st1' })
  prismaMock.hybridCampaign.findMany.mockReset().mockResolvedValue([])
  prismaMock.hybridCampaign.findFirst.mockReset().mockResolvedValue(null)
  prismaMock.hybridOfferPublication.create.mockReset()
  prismaMock.$queryRaw.mockReset().mockResolvedValue([])
})

it('con versión, --apply se niega con SeedRefusal y no prepara ni escribe nada', async () => {
  prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(punteroA('cv1', 1, versionUno()))
  const lines: string[] = []
  const error = await seedPlanLists({ apply: true, confirmHost: 'localhost', confirmDb: 'avoqado_listas_test', staffId: 'st1' }, line =>
    lines.push(line),
  ).catch(e => e)

  expect(error).toBeInstanceOf(SeedRefusal)
  expect(error.message).toContain('«Planes» en el SUPERADMIN')
  expect(ensureHybridPublicationPrices).not.toHaveBeenCalled()
  expect(prismaMock.hybridOfferPublication.create).not.toHaveBeenCalled()
  expect(prismaMock.$transaction).not.toHaveBeenCalled()
})
