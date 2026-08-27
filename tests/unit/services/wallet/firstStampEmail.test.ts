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

import { sendFirstStampEmailIfDue, passPublicUrl } from '../../../../src/services/wallet/firstStampEmail.service'
import emailService from '@/services/email.service'
import { env } from '@/config/env'
import { prismaMock } from '../../../__helpers__/setup'

const enviar = emailService.sendWalletPassEmail as jest.Mock

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

describe('passPublicUrl', () => {
  it('arma la ruta publica del pase', () => {
    expect(passPublicUrl('cafe-centro', 'c1')).toBe('https://api.avoqado.io/api/v1/public/venues/cafe-centro/wallet/apple/c1')
  })

  it('devuelve null contra localhost', () => {
    // Mandarle al cliente una liga a `localhost` es mandarle un correo inservible:
    // su telefono no es esta maquina. Mismo criterio que `passWebServiceURL`.
    ;(env as any).BASE_URL = 'http://localhost:3000'
    expect(passPublicUrl('cafe-centro', 'c1')).toBeNull()
    ;(env as any).BASE_URL = 'https://api.avoqado.io'
  })
})

describe('sendFirstStampEmailIfDue', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(env as any).BASE_URL = 'https://api.avoqado.io'
    enviar.mockResolvedValue(true)
  })

  it('manda el correo en el primer sello de la primera cartilla', async () => {
    sembrar()
    await sendFirstStampEmailIfDue('v1', 'c1', 'card1')
    expect(enviar).toHaveBeenCalledTimes(1)
    expect(enviar).toHaveBeenCalledWith(
      'ana@example.com',
      expect.objectContaining({
        venueName: 'Café Centro',
        customerName: 'Ana',
        passUrl: 'https://api.avoqado.io/api/v1/public/venues/cafe-centro/wallet/apple/c1',
        stampsEarned: 1,
        stampsRequired: 7,
        rewardLabel: 'Un café gratis',
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
})
