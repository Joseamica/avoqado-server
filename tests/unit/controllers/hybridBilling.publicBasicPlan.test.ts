/** Planes editables B4, Task 3: `/public/basic-plan` con una versión del editor contesta `data: null`. */
const mockVersion = jest.fn()
jest.mock('@/services/billing/planOffer', () => ({
  ...jest.requireActual('@/services/billing/planOffer'),
  versionQueCobra: (...a: unknown[]) => mockVersion(...a),
}))
const mockBasico = jest.fn()
jest.mock('@/services/launchCampaigns/hybridCampaign.service', () => ({
  ...jest.requireActual('@/services/launchCampaigns/hybridCampaign.service'),
  getPublicBasicPlan: (...a: unknown[]) => mockBasico(...a),
}))
import logger from '@/config/logger'
import { publicBasicPlan } from '@/controllers/hybridBilling.controller'

const BASICO = { slug: 'plan-basico', name: 'Básico', priceWithTax: '578.84', priceWithoutTax: '499.00' }
const llamar = async () => {
  const res = { json: jest.fn() }
  const next = jest.fn()
  await publicBasicPlan({} as never, res as never, next)
  await new Promise(resolver => setImmediate(resolver)) // asyncHandler no devuelve su promesa
  return { res, next }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockVersion.mockReset().mockResolvedValue(null)
  mockBasico.mockReset().mockResolvedValue(BASICO)
})

describe('publicBasicPlan', () => {
  it('con una versión del editor → { success: true, data: null }, sin leer el Básico', async () => {
    mockVersion.mockResolvedValue({ number: 2 })
    const { res } = await llamar()
    expect(res.json).toHaveBeenCalledWith({ success: true, data: null })
    expect(mockBasico).not.toHaveBeenCalled()
  })

  it('sin versión → el Básico de hoy', async () => {
    const { res } = await llamar()
    expect(res.json).toHaveBeenCalledWith({ success: true, data: BASICO })
  })

  it('sin versión y getPublicBasicPlan lanza → el mismo error al manejador, no un 200', async () => {
    const error = new Error('boom')
    mockBasico.mockRejectedValue(error)
    const { res, next } = await llamar()
    expect(next).toHaveBeenCalledWith(error)
    expect(res.json).not.toHaveBeenCalled()
  })

  it('versionQueCobra lanza → aviso y el Básico de hoy', async () => {
    mockVersion.mockRejectedValue(new Error('definición ilegible'))
    const { res } = await llamar()
    expect(logger.warn).toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ success: true, data: BASICO })
  })
})
