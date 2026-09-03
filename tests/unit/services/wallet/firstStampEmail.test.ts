/**
 * El correo que le lleva la tarjeta al cliente cuando gana su PRIMER sello.
 *
 * 🔴 Todo lo que se prueba aqui falla en SILENCIO si se rompe: un correo que no sale
 * no da error en ningun lado, y un correo que sale de mas es spam a un cliente real
 * del negocio. Ninguna de las dos cosas la ve nadie mirando la pantalla.
 */
jest.mock('@/config/env', () => ({ env: { BASE_URL: 'https://api.avoqado.io' } }))
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendWalletPassEmail: jest.fn().mockResolvedValue(true) },
}))
// 🔴 `passPublicUrls` decide si ofrece el boton de Android preguntandole a
// `googleWalletAvailable()` — no lo deriva de BASE_URL por su cuenta. Mockeamos el
// modulo completo para poder apagar/prender Google sin tocar credenciales reales.
jest.mock('@/services/wallet/googleWalletClient', () => ({
  googleWalletAvailable: jest.fn(() => true),
}))

import { sendFirstStampEmailIfDue, passPublicUrls } from '../../../../src/services/wallet/firstStampEmail.service'
import emailService from '@/services/email.service'
import { env } from '@/config/env'
import { googleWalletAvailable } from '@/services/wallet/googleWalletClient'
import { prismaMock } from '../../../__helpers__/setup'

const enviar = emailService.sendWalletPassEmail as jest.Mock
const googleDisponible = googleWalletAvailable as jest.Mock

function sembrar(over: Record<string, any> = {}) {
  prismaMock.stampCard.findUnique.mockResolvedValue({
    id: 'card1',
    venueId: 'v1',
    customerId: 'c1',
    stampsEarned: 1,
    stampsRequired: 7,
    cycle: 1,
    ...(over.card ?? {}),
  } as any)
  prismaMock.stampCard.count.mockResolvedValue(over.totalCartillas ?? 1)
  prismaMock.customer.findFirst.mockResolvedValue(
    over.customer === null ? null : ({ id: 'c1', email: 'ana@example.com', firstName: 'Ana', ...(over.customer ?? {}) } as any),
  )
  prismaMock.venue.findUnique.mockResolvedValue({ id: 'v1', name: 'Café Centro', slug: 'cafe-centro' } as any)
  prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ stampRewardLabel: 'Un café gratis' } as any)
}

describe('passPublicUrls', () => {
  beforeEach(() => {
    googleDisponible.mockReturnValue(true)
  })

  it('arma las DOS rutas cuando Google esta disponible', () => {
    expect(passPublicUrls('cafe-centro', 'c1')).toEqual({
      appleUrl: 'https://api.avoqado.io/api/v1/public/venues/cafe-centro/wallet/apple/c1',
      googleUrl: 'https://api.avoqado.io/api/v1/public/venues/cafe-centro/wallet/google/c1',
    })
  })

  it('omite la de Google cuando el servidor no la tiene configurada', () => {
    // 🔴 Sin issuer o sin credencial esa liga da error al tocarla — mejor no ofrecerla.
    googleDisponible.mockReturnValue(false)
    expect(passPublicUrls('cafe-centro', 'c1')).toEqual({
      appleUrl: 'https://api.avoqado.io/api/v1/public/venues/cafe-centro/wallet/apple/c1',
      googleUrl: null,
    })
  })

  it('escapa el slug y el customerId en las dos ligas', () => {
    const urls = passPublicUrls('café con leche', 'cus/raro?1')
    expect(urls?.appleUrl).toBe(
      `https://api.avoqado.io/api/v1/public/venues/${encodeURIComponent('café con leche')}/wallet/apple/${encodeURIComponent('cus/raro?1')}`,
    )
    expect(urls?.googleUrl).toBe(
      `https://api.avoqado.io/api/v1/public/venues/${encodeURIComponent('café con leche')}/wallet/google/${encodeURIComponent('cus/raro?1')}`,
    )
  })

  it('devuelve null contra localhost (ninguna de las dos ligas sirve)', () => {
    // Mandarle al cliente una liga a `localhost` es mandarle un correo inservible:
    // su telefono no es esta maquina. Mismo criterio que `passWebServiceURL`.
    ;(env as any).BASE_URL = 'http://localhost:3000'
    expect(passPublicUrls('cafe-centro', 'c1')).toBeNull()
    ;(env as any).BASE_URL = 'https://api.avoqado.io'
  })
})

describe('sendFirstStampEmailIfDue', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(env as any).BASE_URL = 'https://api.avoqado.io'
    enviar.mockResolvedValue(true)
    googleDisponible.mockReturnValue(true)
  })

  it('manda el correo con las DOS ligas cuando Google esta configurado', async () => {
    sembrar()
    await sendFirstStampEmailIfDue('v1', 'c1', 'card1')
    expect(enviar).toHaveBeenCalledTimes(1)
    expect(enviar).toHaveBeenCalledWith(
      'ana@example.com',
      expect.objectContaining({
        venueName: 'Café Centro',
        customerName: 'Ana',
        applePassUrl: 'https://api.avoqado.io/api/v1/public/venues/cafe-centro/wallet/apple/c1',
        googlePassUrl: 'https://api.avoqado.io/api/v1/public/venues/cafe-centro/wallet/google/c1',
        stampsEarned: 1,
        stampsRequired: 7,
        rewardLabel: 'Un café gratis',
      }),
    )
  })

  it('manda el correo solo con la liga de Apple cuando Google NO esta configurado', async () => {
    googleDisponible.mockReturnValue(false)
    sembrar()
    await sendFirstStampEmailIfDue('v1', 'c1', 'card1')
    expect(enviar).toHaveBeenCalledTimes(1)
    expect(enviar).toHaveBeenCalledWith(
      'ana@example.com',
      expect.objectContaining({
        applePassUrl: 'https://api.avoqado.io/api/v1/public/venues/cafe-centro/wallet/apple/c1',
        googlePassUrl: null,
      }),
    )
  })

  it('NO manda en el segundo sello', async () => {
    sembrar({ card: { stampsEarned: 2 } })
    await sendFirstStampEmailIfDue('v1', 'c1', 'card1')
    expect(enviar).not.toHaveBeenCalled()
  })

  it('NO manda al empezar una cartilla NUEVA', async () => {
    // 🔴 El caso que se escapa: la segunda cartilla tambien arranca en 1 de 7. Sin
    // mirar cuantas cartillas lleva, el cliente recibiria el mismo correo cada vez
    // que completa una — justo al cliente mas fiel del negocio.
    sembrar({ card: { stampsEarned: 1, cycle: 2 }, totalCartillas: 2 })
    await sendFirstStampEmailIfDue('v1', 'c1', 'card1')
    expect(enviar).not.toHaveBeenCalled()
  })

  it('NO manda si el cliente no dejo correo', async () => {
    sembrar({ customer: { email: null } })
    await sendFirstStampEmailIfDue('v1', 'c1', 'card1')
    expect(enviar).not.toHaveBeenCalled()
  })

  it('NO manda sin una URL publica configurada', async () => {
    ;(env as any).BASE_URL = 'http://localhost:3000'
    sembrar()
    await sendFirstStampEmailIfDue('v1', 'c1', 'card1')
    expect(enviar).not.toHaveBeenCalled()
  })

  it('NUNCA lanza: un correo caido no puede tumbar un cobro', async () => {
    // Corre dentro del camino del dinero. Si esto propagara, el cobro se veria
    // fallido aunque el dinero ya entro — mucho peor que no mandar un correo.
    prismaMock.stampCard.findUnique.mockRejectedValue(new Error('DB caida'))
    await expect(sendFirstStampEmailIfDue('v1', 'c1', 'card1')).resolves.toBeUndefined()
    expect(enviar).not.toHaveBeenCalled()
  })

  it('tampoco lanza si el envio del correo falla', async () => {
    sembrar()
    enviar.mockRejectedValue(new Error('Resend caido'))
    await expect(sendFirstStampEmailIfDue('v1', 'c1', 'card1')).resolves.toBeUndefined()
  })

  it('tampoco lanza si googleWalletAvailable() revienta', async () => {
    // 🔴 Este correo cuelga de un cobro (`stampLedger.service.ts`): si el chequeo de
    // Google truena, la venta no se puede ver afectada — el correo simplemente no sale.
    sembrar()
    googleDisponible.mockImplementation(() => {
      throw new Error('credencial ilegible')
    })
    await expect(sendFirstStampEmailIfDue('v1', 'c1', 'card1')).resolves.toBeUndefined()
    expect(enviar).not.toHaveBeenCalled()
  })
})
