/**
 * C2 r1 (a): `NegativaDeSiembra` promete «no se escribió nada». Las negativas del tablero de precios (el producto no está en
 * el catálogo desplegado, o no admite precio) salen ANTES de escribir la fila `Feature`, también con --apply.
 */
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: jest.fn().mockResolvedValue({ id: 'st1' }), findFirst: jest.fn() },
    feature: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
  },
}))
jest.mock('@/services/launchCampaigns/hybridListPrice.service', () => ({
  listPriceBoard: jest.fn(),
  planSeedOutcome: jest.fn(),
  retryListPrice: jest.fn(),
  saveListPrice: jest.fn(),
}))
jest.mock('@/services/launchCampaigns/hybridPlanCatchUp', () => ({
  addPlanFeatureToLivePlanContracts: jest.fn(),
  staleCampaigns: jest.fn().mockResolvedValue([]),
}))

import prisma from '@/utils/prismaClient'
import { listPriceBoard } from '@/services/launchCampaigns/hybridListPrice.service'
import { addPlanFeatureToLivePlanContracts } from '@/services/launchCampaigns/hybridPlanCatchUp'
import { NegativaDeSiembra, PRODUCTO, sembrarFuncionTarjetasDeRegalo } from '../../../scripts/sembrar-funcion-tarjetas-de-regalo'

const db = prisma as any
const URL_ANTES = process.env.DATABASE_URL
const APLICAR = { apply: true, confirmHost: 'localhost', confirmDb: 'avoqado_siembra_test', staffId: 'st1' }

beforeAll(() => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/avoqado_siembra_test'
})
afterAll(() => {
  process.env.DATABASE_URL = URL_ANTES
})
beforeEach(() => jest.clearAllMocks())

describe('las negativas del tablero salen antes de escribir', () => {
  it.each([
    ['el server desplegado aún no trae GIFT_CARDS en el catálogo', [], /no está en el catálogo/],
    [
      'el producto no admite precio de lista',
      [{ productKey: PRODUCTO, editable: false, notEditableReason: 'CONTACT' }],
      /no admite precio de lista \(CONTACT\)/,
    ],
  ])('%s → NegativaDeSiembra y la fila Feature NO se escribe', async (_caso, tablero, mensaje) => {
    jest.mocked(listPriceBoard).mockResolvedValue(tablero as never)
    const error = await sembrarFuncionTarjetasDeRegalo(APLICAR, () => undefined).catch(e => e)
    expect(error).toBeInstanceOf(NegativaDeSiembra)
    expect(error.message).toMatch(mensaje)
    expect(db.feature.upsert).not.toHaveBeenCalled()
    expect(addPlanFeatureToLivePlanContracts).not.toHaveBeenCalled()
  })
})
