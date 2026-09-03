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

jest.mock('@/services/wallet/googleWalletClient', () => ({
  googleWalletAvailable: jest.fn(() => true),
  googleWalletCredentials: jest.fn(() => ({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: 'k' })),
  issuerId: jest.fn(() => '338'),
  walletClient: jest.fn(async () => ({
    loyaltyclass: { insert: insertClass, get: getClass },
    // 🔴 Sin `get`: `issueGooglePass` decide si ya existe el pase por la BASE (el
    // `WalletPass.googleObjectId`), nunca preguntándole a Google. Nadie en producción
    // llama a `loyaltyobject.get`, así que un mock aquí quedaba sin usar.
    loyaltyobject: { insert: insertObject },
  })),
}))
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 'JWT-FALSO') }))

import { ensureLoyaltyClass, issueGooglePass, buildSaveJwt } from '@/services/wallet/googleWalletPass.service'
import { prismaMock } from '../../../__helpers__/setup'
import jwt from 'jsonwebtoken'

const VENUE = { id: 'v1', name: 'Testarudo Café', logo: null, primaryColor: null, secondaryColor: null }

describe('googleWalletPass', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getClass.mockRejectedValue({ code: 404 })
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
    // 🔴 Sin esto, la prueba pasaría igual aunque `get()` preguntara por la clase de OTRO
    // venue: `getClass` siempre rechaza en este `beforeEach` sin importar qué resourceId
    // reciba, así que sólo comprobar que insertó no demuestra que preguntó por la correcta.
    expect(getClass).toHaveBeenCalledWith({ resourceId: '338.venue-v1' })
    expect(insertClass).toHaveBeenCalledWith(expect.objectContaining({ requestBody: expect.objectContaining({ id: '338.venue-v1' }) }))
  })

  it('🔴 si la clase YA existe no la vuelve a crear: insertar dos veces es un error de la API', async () => {
    getClass.mockResolvedValue({ data: { id: '338.venue-v1' } })
    await ensureLoyaltyClass('v1')
    // 🔴 Misma razón que arriba: confirma que el "ya existe" que evitó el insert vino de
    // preguntar por LA CLASE DE ESTE VENUE, no de una llamada con un id distinto que por
    // casualidad resolvió.
    expect(getClass).toHaveBeenCalledWith({ resourceId: '338.venue-v1' })
    expect(insertClass).not.toHaveBeenCalled()
  })

  it('🔴 un 403 (o cualquier error que no sea 404) al preguntar por la clase se propaga, no se confunde con "no existe"', async () => {
    // Un 403 significa "no pudimos SABER si existe" (casi siempre, permisos del service
    // account). Confundirlo con 404 dispara un insert a ciegas que Google rechaza con un
    // 409 cuyo mensaje apunta al lugar equivocado y esconde el problema real.
    getClass.mockRejectedValue({ code: 403 })
    await expect(ensureLoyaltyClass('v1')).rejects.toEqual({ code: 403 })
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
    // 🔴 El nombre de la prueba promete "guarda el googleObjectId", pero sin esta
    // aserción nada obliga a que se persista: el valor devuelto se arma en memoria y la
    // prueba pasaría igual aunque se borrara el `prisma.walletPass.update` de producción.
    expect(prismaMock.walletPass.update).toHaveBeenCalledWith({
      where: { id: 'wp-1' },
      data: { googleObjectId: '338.pass-wp-1' },
    })
  })

  it('🔴 el objeto ya existe en Google (409): se trata como éxito, no como error', async () => {
    // El id es determinista (`<issuer>.pass-<walletPassId>`): un intento anterior pudo crear
    // el objeto en Google y morir ANTES de guardar el id en la base. El objeto que Google
    // dice que ya existe es exactamente el que queríamos crear — reusarlo es lo correcto.
    prismaMock.walletPass.findFirst.mockResolvedValue(null)
    prismaMock.walletPass.create.mockResolvedValue({ id: 'wp-1', serialNumber: 'AVQ-1', qrToken: 'q'.repeat(48), revision: 1 } as any)
    prismaMock.walletPass.update.mockResolvedValue({} as any)
    insertObject.mockRejectedValueOnce({ code: 409 })

    const r = await issueGooglePass('v1', 'c1')

    expect(r.googleObjectId).toBe('338.pass-wp-1')
    // Sin esto el cliente se queda sin poder guardar su tarjeta nunca: el id no se persiste
    // y el siguiente intento vuelve a chocar con el mismo 409, para siempre.
    expect(prismaMock.walletPass.update).toHaveBeenCalledWith({
      where: { id: 'wp-1' },
      data: { googleObjectId: '338.pass-wp-1' },
    })
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
    // 🔴 La aserción que da sentido a la prueba: sin `platform` en el where, `findFirst`
    // devolvería el pase de APPLE del mismo cliente y lo trataríamos como si fuera el de
    // Google. Con `prismaMock` el resultado lo controlamos nosotros, así que lo único que
    // prueba algo es CÓMO se consultó.
    expect(prismaMock.walletPass.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          venueId: 'v1',
          customerId: 'c1',
          platform: 'GOOGLE',
          active: true,
        }),
      }),
    )
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
    // 🔴 `jwt.sign` está mockeado para devolver 'JWT-FALSO' SIN IMPORTAR los argumentos —
    // así que comprobar sólo el valor de retorno pasaría igual si el código nunca llamara
    // a `jwt.sign`, o lo llamara con la llave de OTRO negocio. Lo que prueba algo es que
    // se firmó con la llave privada de la cuenta de servicio y el id del pase correcto.
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        iss: 'sa@x.iam.gserviceaccount.com',
        payload: { loyaltyObjects: [{ id: '338.pass-wp-1' }] },
      }),
      'k',
      expect.objectContaining({ algorithm: 'RS256' }),
    )
  })

  it('sin negocio o sin cliente devuelve null en vez de lanzar', async () => {
    prismaMock.venue.findFirst.mockResolvedValue(null)
    await expect(buildSaveJwt('v-no', 'c1')).resolves.toBeNull()
  })
})
