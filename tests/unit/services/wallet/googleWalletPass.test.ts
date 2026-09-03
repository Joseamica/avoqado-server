/**
 * Emitir la tarjeta de Google de un cliente.
 *
 * 🔴 Idempotente por (venueId, customerId, GOOGLE), igual que `issueApplePass`. El
 * cliente va a tocar "guardar mi tarjeta" más de una vez —desde el recibo, desde un
 * correo, por curiosidad— y no puede terminar con tres tarjetas del mismo café.
 */
const insertClass = jest.fn().mockResolvedValue({ data: {} })
const getClass = jest.fn()
const insertObject = jest.fn().mockResolvedValue({ data: {} })
const getObject = jest.fn()

jest.mock('@/services/wallet/googleWalletClient', () => ({
  googleWalletAvailable: jest.fn(() => true),
  googleWalletCredentials: jest.fn(() => ({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: 'k' })),
  issuerId: jest.fn(() => '338'),
  walletClient: jest.fn(async () => ({
    loyaltyclass: { insert: insertClass, get: getClass },
    loyaltyobject: { insert: insertObject, get: getObject },
  })),
}))
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 'JWT-FALSO') }))

import { ensureLoyaltyClass, issueGooglePass, buildSaveJwt } from '@/services/wallet/googleWalletPass.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = { id: 'v1', name: 'Testarudo Café', logo: null, primaryColor: null, secondaryColor: null }

describe('googleWalletPass', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getClass.mockRejectedValue({ code: 404 })
    getObject.mockRejectedValue({ code: 404 })
    prismaMock.venue.findFirst.mockResolvedValue(VENUE as any)
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'c1' } as any)
    prismaMock.walletCardDesign.findUnique.mockResolvedValue(null)
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ stampsRequired: 7, stampRewardLabel: 'Un café gratis' })
    prismaMock.stampCard.findFirst.mockResolvedValue({ stampsEarned: 3, stampsRequired: 7 })
    prismaMock.stampReward.count.mockResolvedValue(0)
  })

  it('crea la clase del negocio si no existe', async () => {
    const id = await ensureLoyaltyClass('v1')
    expect(id).toBe('338.venue-v1')
    expect(insertClass).toHaveBeenCalledWith(expect.objectContaining({ requestBody: expect.objectContaining({ id: '338.venue-v1' }) }))
  })

  it('🔴 si la clase YA existe no la vuelve a crear: insertar dos veces es un error de la API', async () => {
    getClass.mockResolvedValue({ data: { id: '338.venue-v1' } })
    await ensureLoyaltyClass('v1')
    expect(insertClass).not.toHaveBeenCalled()
  })

  it('emite el pase y guarda el googleObjectId', async () => {
    prismaMock.walletPass.findFirst.mockResolvedValue(null)
    prismaMock.walletPass.create.mockResolvedValue({ id: 'wp-1', serialNumber: 'AVQ-1', qrToken: 'q'.repeat(48), revision: 1 } as any)
    prismaMock.walletPass.update.mockResolvedValue({} as any)

    const r = await issueGooglePass('v1', 'c1')

    expect(r.googleObjectId).toBe('338.pass-wp-1')
    expect(prismaMock.walletPass.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ platform: 'GOOGLE' }) }),
    )
    expect(insertObject).toHaveBeenCalledWith(expect.objectContaining({ requestBody: expect.objectContaining({ id: '338.pass-wp-1' }) }))
  })

  it('🔴 idempotente: un pase que ya existe se devuelve, no se crea otro', async () => {
    prismaMock.walletPass.findFirst.mockResolvedValue({
      id: 'wp-1',
      serialNumber: 'AVQ-1',
      qrToken: 'q'.repeat(48),
      googleObjectId: '338.pass-wp-1',
      revision: 1,
    } as any)

    const r = await issueGooglePass('v1', 'c1')

    expect(r.googleObjectId).toBe('338.pass-wp-1')
    expect(prismaMock.walletPass.create).not.toHaveBeenCalled()
  })

  it('el JWT de guardar se firma con la clave de la cuenta de servicio', async () => {
    prismaMock.walletPass.findFirst.mockResolvedValue({
      id: 'wp-1',
      serialNumber: 'AVQ-1',
      qrToken: 'q'.repeat(48),
      googleObjectId: '338.pass-wp-1',
      revision: 1,
    } as any)
    await expect(buildSaveJwt('v1', 'c1')).resolves.toBe('JWT-FALSO')
  })

  it('sin negocio o sin cliente devuelve null en vez de lanzar', async () => {
    prismaMock.venue.findFirst.mockResolvedValue(null)
    await expect(buildSaveJwt('v-no', 'c1')).resolves.toBeNull()
  })
})
