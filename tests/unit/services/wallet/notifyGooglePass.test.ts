/**
 * Cuando sube un sello, la tarjeta del cliente se actualiza sola — en las DOS carteras.
 *
 * 🔴 Defecto latente que este archivo guarda: `notifyCustomerPassUpdated` buscaba el
 * pase SIN filtrar por plataforma. Con un pase de Google en la base, ese findFirst podía
 * devolverlo, APNs no encontraba aparatos y devolvía 0 en silencio: el iPhone del
 * cliente dejaba de recibir sus sellos y NADA fallaba.
 */
const patchObject = jest.fn().mockResolvedValue({ data: {} })

jest.mock('@/services/wallet/apnsClient', () => ({
  sendSilentPush: jest.fn().mockResolvedValue({ ok: true }),
  apnsAvailable: jest.fn().mockReturnValue(true),
}))
jest.mock('@/services/wallet/googleWalletClient', () => ({
  googleWalletAvailable: jest.fn(() => true),
  issuerId: jest.fn(() => '338'),
  // 🔴 `notifyGooglePass` ya no lee `env.BASE_URL` directo — pasa por `walletBaseUrl()`
  // (googleWalletClient), y este módulo está mockeado completo aquí. Sin esto, el mock
  // deja `walletBaseUrl` en `undefined`: "is not a function" cae dentro del try/catch
  // de `notifyGooglePass` y `patchObject` nunca se llama, con las mismas 3 pruebas
  // "reventando en silencio" que destapó el Alienware (sin .env, `env.BASE_URL as
  // string` producía el mismo TypeError vía un camino distinto).
  walletBaseUrl: jest.fn(() => 'https://api.avoqado.io'),
  walletClient: jest.fn(async () => ({ loyaltyobject: { patch: patchObject } })),
}))

import { notifyCustomerPassUpdated } from '@/services/wallet/notifyPassUpdated.service'
import { sendSilentPush } from '@/services/wallet/apnsClient'
import { googleWalletAvailable, walletBaseUrl } from '@/services/wallet/googleWalletClient'
import { prismaMock } from '../../../__helpers__/setup'

const APPLE = { id: 'wp-a', platform: 'APPLE', serialNumber: 'AVQ-A', qrToken: 'a'.repeat(48), revision: 1, venueId: 'v1', customerId: 'c1', googleObjectId: null }
const GOOGLE = { id: 'wp-g', platform: 'GOOGLE', serialNumber: 'AVQ-G', qrToken: 'g'.repeat(48), revision: 3, venueId: 'v1', customerId: 'c1', googleObjectId: '338.pass-wp-g' }

describe('notifyCustomerPassUpdated con las dos plataformas', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.walletPass.update.mockResolvedValue({} as any)
    prismaMock.walletPassRegistration.findMany.mockResolvedValue([{ id: 'r1', pushToken: 't', deviceLibraryIdentifier: 'd' }] as any)
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ stampsRequired: 7, stampRewardLabel: 'Un café gratis' })
    prismaMock.stampCard.findFirst.mockResolvedValue({ stampsEarned: 4, stampsRequired: 7 })
    prismaMock.stampReward.count.mockResolvedValue(0)
  })

  it('🔴 con las DOS tarjetas, avisa a las dos', async () => {
    prismaMock.walletPass.findMany.mockResolvedValue([APPLE, GOOGLE] as any)
    await notifyCustomerPassUpdated('v1', 'c1')
    expect(sendSilentPush).toHaveBeenCalled()
    expect(patchObject).toHaveBeenCalledWith(expect.objectContaining({ resourceId: '338.pass-wp-g' }))
  })

  it('🔴 la revisión sube: sin eso Google serviría la franja vieja', async () => {
    prismaMock.walletPass.findMany.mockResolvedValue([GOOGLE] as any)
    await notifyCustomerPassUpdated('v1', 'c1')
    expect(prismaMock.walletPass.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'wp-g' }, data: expect.objectContaining({ revision: { increment: 1 } }) }),
    )
  })

  it('la franja que se manda a Google trae la revisión NUEVA, no la vieja', async () => {
    prismaMock.walletPass.findMany.mockResolvedValue([GOOGLE] as any)
    // 🔴 Simula lo que Prisma de verdad devuelve tras el `increment`: la fila YA con el
    // número nuevo. Confiar en un valor calculado a mano (viejo + 1) en vez de leer la
    // respuesta de la base es justo el descuido que produce la colisión que este test
    // guarda — dos sellos casi simultáneos podrían calcular el mismo número viejo y
    // pisarse la URL.
    prismaMock.walletPass.update.mockResolvedValue({ revision: GOOGLE.revision + 1 } as any)
    await notifyCustomerPassUpdated('v1', 'c1')
    const body = patchObject.mock.calls[0][0].requestBody
    expect(body.heroImage.sourceUri.uri).toContain('/AVQ-G/4.png')
  })

  it('con sólo el pase de Apple, Google ni se toca', async () => {
    prismaMock.walletPass.findMany.mockResolvedValue([APPLE] as any)
    await notifyCustomerPassUpdated('v1', 'c1')
    expect(patchObject).not.toHaveBeenCalled()
  })

  it('🔴 si Google truena, el sello NO se cae: nunca lanza', async () => {
    patchObject.mockRejectedValueOnce(new Error('Google caído'))
    prismaMock.walletPass.findMany.mockResolvedValue([GOOGLE] as any)
    await expect(notifyCustomerPassUpdated('v1', 'c1')).resolves.toEqual(expect.objectContaining({ notified: expect.any(Number) }))
  })

  it('🔴 sin BASE_URL configurado, Google ni se toca (el caso que el Alienware destapó)', async () => {
    // Un servidor recién desplegado sin BASE_URL: `googleWalletAvailable()` real ya
    // devolvería false por esto mismo (ver googleWalletClient.test.ts), pero aquí el
    // módulo está mockeado completo — así que se prueba el guard de `notifyGooglePass`
    // directamente, pisando SÓLO `walletBaseUrl` y dejando `googleWalletAvailable` en
    // true, para aislar que el guard nuevo es el que lo detiene.
    ;(walletBaseUrl as jest.Mock).mockReturnValueOnce(null)
    prismaMock.walletPass.findMany.mockResolvedValue([GOOGLE] as any)
    const r = await notifyCustomerPassUpdated('v1', 'c1')
    expect(patchObject).not.toHaveBeenCalled()
    // Tampoco se gastó el `update` que sube la revisión: si Google no puede recibir el
    // objeto, no tiene sentido haber subido la revisión igual.
    expect(prismaMock.walletPass.update).not.toHaveBeenCalled()
    expect(r).toEqual(expect.objectContaining({ notified: 0 }))
    expect(googleWalletAvailable).toHaveBeenCalled()
  })
})
