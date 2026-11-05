import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/mobile/creditPack.mobile.service')

import * as mobileController from '@/controllers/mobile/creditPack.mobile.controller'
import * as dashboardController from '@/controllers/dashboard/creditPack.dashboard.controller'
import * as mobileService from '@/services/mobile/creditPack.mobile.service'
import { leerFotoDelPaquete, firmarFotoDelPaquete } from '@/services/shared/creditPacksOnPaidOrder'

/**
 * D4 — lo que entra y sale por el POS: la llave y la foto firmada. La foto sale en las dos listas de paquetes (ANDROID lee la de
 * `/dashboard`) y sólo se cree con llave; la llave se valida en el borde.
 */
describe('Paquetes del POS: llave y foto en el borde', () => {
  const pack = {
    id: 'pack-1',
    venueId: 'venue-1',
    name: '10 clases',
    price: new Prisma.Decimal(1500),
    currency: 'MXN',
    active: true,
    validityDays: 30,
    items: [{ id: 'i-1', productId: 'prod-1', quantity: 10 }],
  }

  const res = () => {
    const r: any = {}
    r.status = jest.fn(() => r)
    r.json = jest.fn(() => r)
    return r
  }

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.staffVenue.findUnique.mockResolvedValue({ id: 'sv-1' } as any)
    ;(mobileService.sellPackInPerson as jest.Mock).mockResolvedValue({ id: 'purchase-1' })
  })

  const vender = async (body: Record<string, unknown>) => {
    const r = res()
    const next = jest.fn()
    await mobileController.sellPack(
      { params: { venueId: 'venue-1', packId: 'pack-1' }, body, authContext: { userId: 'staff-1' } } as any,
      r,
      next,
    )
    return { r, next }
  }

  it('la lista del POS lleva la foto firmada de cada paquete', async () => {
    prismaMock.creditPack.findMany.mockResolvedValue([pack] as any)
    const r = res()

    await mobileController.listPacks({ params: { venueId: 'venue-1' }, query: {} } as any, r, jest.fn())

    const enviado = r.json.mock.calls[0][0].packs[0]
    expect(leerFotoDelPaquete(enviado.saleProof)).toMatchObject({ creditPackId: 'pack-1', price: '1500.00' })
  })

  it('🔴 la lista que lee ANDROID (/dashboard) también la lleva, y un paquete apagado no', async () => {
    prismaMock.creditPack.findMany.mockResolvedValue([pack, { ...pack, id: 'pack-2', active: false }] as any)
    const r = res()

    await dashboardController.getCreditPacks({ params: { venueId: 'venue-1' } } as any, r, jest.fn())

    const [activo, apagado] = r.json.mock.calls[0][0]
    expect(leerFotoDelPaquete(activo.saleProof)).toMatchObject({ creditPackId: 'pack-1' })
    expect(apagado.saleProof).toBeNull()
  })

  it('pasa la llave y la foto que SÍ firmó el servidor', async () => {
    const saleProof = firmarFotoDelPaquete(pack)
    const { r } = await vender({ customerId: 'cust-1', deliveryKey: 'llave-1', saleProof })

    expect(r.status).toHaveBeenCalledWith(201)
    const opts = (mobileService.sellPackInPerson as jest.Mock).mock.calls[0][4]
    expect(opts.deliveryKey).toBe('llave-1')
    expect(opts.foto).toMatchObject({ creditPackId: 'pack-1', price: '1500.00' })
  })

  it('🔴 una foto escrita a mano por quien llama no vale: se ignora', async () => {
    const foto = {
      v: 1,
      creditPackId: 'pack-1',
      name: 'x',
      price: '1.00',
      currency: 'MXN',
      validityDays: null,
      items: [{ productId: 'prod-1', quantity: 999 }],
    }
    await vender({ customerId: 'cust-1', deliveryKey: 'llave-1', saleProof: foto })
    await vender({ customerId: 'cust-1', deliveryKey: 'llave-2', saleProof: 'a.b' })

    const llamadas = (mobileService.sellPackInPerson as jest.Mock).mock.calls
    expect(llamadas[0][4].foto).toBeNull()
    expect(llamadas[1][4].foto).toBeNull()
  })

  it('🔴 sin llave la foto no cuenta: un reintento crearía otra compra por lo vendido hace días', async () => {
    await vender({ customerId: 'cust-1', saleProof: firmarFotoDelPaquete(pack) })

    expect((mobileService.sellPackInPerson as jest.Mock).mock.calls[0][4].foto).toBeNull()
  })

  it.each([[123], [''], ['   '], ['x'.repeat(65)], [{}]])('una llave inválida (%p) es un 400 y no vende nada', async deliveryKey => {
    const { r } = await vender({ customerId: 'cust-1', deliveryKey })

    expect(r.status).toHaveBeenCalledWith(400)
    expect(mobileService.sellPackInPerson).not.toHaveBeenCalled()
  })

  it('apps viejas: sin llave ni foto pasa como hoy', async () => {
    const { r } = await vender({ customerId: 'cust-1', note: 'hola' })

    expect(r.status).toHaveBeenCalledWith(201)
    const opts = (mobileService.sellPackInPerson as jest.Mock).mock.calls[0][4]
    expect(opts).toMatchObject({ note: 'hola', foto: null })
    expect(opts.deliveryKey).toBeUndefined()
  })
})
