/**
 * El portal le dice al cliente si su tarjeta de sellos existe y como va.
 *
 * 🔴 De este dato depende que el boton "Guardar mi tarjeta" APAREZCA o no en el
 * widget. Si dijera que si cuando el negocio no tiene sellos, el cliente tocaria un
 * boton que responde 403 — y el que queda mal es el negocio, no nosotros.
 */
jest.mock('@/services/wallet/stampLedger.service', () => ({
  getStampCardStatus: jest.fn(),
}))

import { getCustomerPortal } from '@/services/public/customerPortal.public.service'
import { getStampCardStatus } from '@/services/wallet/stampLedger.service'
import { prismaMock } from '../../../__helpers__/setup'

const estado = getStampCardStatus as jest.Mock

function sembrar(stampsEnabled: boolean | null) {
  prismaMock.customer.findFirst.mockResolvedValue({ id: 'c1', firstName: 'Ana', email: 'a@b.c', phone: null } as any)
  prismaMock.creditPackPurchase.findMany.mockResolvedValue([] as any)
  prismaMock.reservation.findMany.mockResolvedValue([] as any)
  prismaMock.loyaltyConfig.findUnique.mockResolvedValue(stampsEnabled === null ? null : ({ stampsEnabled } as any))
  estado.mockResolvedValue({ stampsEarned: 3, stampsRequired: 7, rewardLabel: 'Un café gratis', pendingRewards: 0 })
}

describe('getCustomerPortal — tarjeta de sellos', () => {
  beforeEach(() => jest.clearAllMocks())

  it('devuelve el avance cuando el negocio tiene sellos prendidos', async () => {
    sembrar(true)
    const r: any = await getCustomerPortal('v1', 'c1')
    expect(r.stampCard).toEqual({
      enabled: true,
      stampsEarned: 3,
      stampsRequired: 7,
      rewardLabel: 'Un café gratis',
    })
  })

  it('dice enabled:false cuando el negocio NO tiene sellos', async () => {
    sembrar(false)
    const r: any = await getCustomerPortal('v1', 'c1')
    expect(r.stampCard.enabled).toBe(false)
    // Ni siquiera se molesta en consultar el avance de una cartilla que no existe.
    expect(estado).not.toHaveBeenCalled()
  })

  it('dice enabled:false cuando el negocio ni siquiera tiene configuracion', async () => {
    sembrar(null)
    const r: any = await getCustomerPortal('v1', 'c1')
    expect(r.stampCard.enabled).toBe(false)
  })

  it('un fallo leyendo la cartilla NO tumba el portal', async () => {
    // El portal es la pantalla donde el cliente ve sus reservaciones y sus creditos.
    // Que no se pueda leer una cartilla de sellos no puede dejarlo sin nada.
    sembrar(true)
    estado.mockRejectedValue(new Error('DB caida'))
    const r: any = await getCustomerPortal('v1', 'c1')
    expect(r.stampCard.enabled).toBe(false)
    expect(r.reservations).toBeDefined()
  })
})
