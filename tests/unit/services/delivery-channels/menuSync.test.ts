/**
 * El menú del proveedor no se puede quedar viejo.
 *
 * 🔴 Un menú desactualizado en Uber cuesta dinero de dos formas y ninguna FALLA: el cliente
 * paga el precio viejo (la diferencia la come el negocio), o pide algo que ya no existe y
 * hay que rechazar — y Uber revoca el acceso por debajo del 99% de inyección.
 */
jest.mock('@/services/delivery-channels/core/menuSnapshot.service', () => ({
  buildMenuSnapshot: jest.fn(),
}))

jest.mock('@/services/delivery-channels/core/adapterRegistry', () => ({
  hasAdapter: jest.fn(() => true),
  adapterFor: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import { buildMenuSnapshot } from '@/services/delivery-channels/core/menuSnapshot.service'
import { adapterFor, hasAdapter } from '@/services/delivery-channels/core/adapterRegistry'
import { syncChannelMenu } from '@/services/delivery-channels/core/menuSync.service'

const mockedSnapshot = buildMenuSnapshot as jest.Mock
const mockedAdapterFor = adapterFor as jest.Mock
const mockedHasAdapter = hasAdapter as jest.Mock
const mockedUpdate = (prisma as any).deliveryChannelLink.update as jest.Mock

const link = (overrides: any = {}): any => ({
  id: 'link1',
  venueId: 'venue1',
  provider: 'UBER_EATS',
  externalLocationId: 'store1',
  status: 'ACTIVE',
  autoSyncMenu: true,
  lastMenuHash: null,
  ...overrides,
})

/** El payload traducido: es lo que se hashea. */
const PAYLOAD = { items: [{ id: 'SKU-1', price_info: { price: 8950 } }] }

function adapter(publishOk = true) {
  return {
    buildMenuPayload: jest.fn(() => PAYLOAD),
    publishMenu: jest.fn(async () => ({ ok: publishOk, status: publishOk ? 204 : 400, raw: publishOk ? '' : 'menu rejected' })),
  }
}

describe('menuSync — el menú del proveedor sigue al de Avoqado', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedHasAdapter.mockReturnValue(true)
    mockedSnapshot.mockResolvedValue({ venueId: 'venue1', generatedAt: 'x', categories: [] })
    mockedUpdate.mockResolvedValue({})
  })

  it('🔴 publica cuando el menú cambió, y GUARDA la huella', async () => {
    const a = adapter()
    mockedAdapterFor.mockReturnValue(a)

    const r = await syncChannelMenu(link())

    expect(r.outcome).toBe('PUBLISHED')
    expect(a.publishMenu).toHaveBeenCalled()
    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastMenuHash: expect.any(String), lastMenuSyncAt: expect.any(Date) }) }),
    )
  })

  it('🔴 NO publica si nada cambió: `PUT /menus` reemplaza el menú entero', async () => {
    // Republicar cada 5 minutos un menú idéntico es tirar la escritura más peligrosa de la
    // integración contra el proveedor, gratis y sin motivo.
    const a = adapter()
    mockedAdapterFor.mockReturnValue(a)
    const primera = await syncChannelMenu(link())
    const hash = mockedUpdate.mock.calls[0][0].data.lastMenuHash
    expect(primera.outcome).toBe('PUBLISHED')

    const r = await syncChannelMenu(link({ lastMenuHash: hash }))

    expect(r.outcome).toBe('UNCHANGED')
    expect(a.publishMenu).toHaveBeenCalledTimes(1) // la primera, no la segunda
  })

  it('🔴 si el proveedor RECHAZA el menú, la huella NO se guarda', async () => {
    // Guardarla haría que la siguiente pasada creyera que el proveedor ya lo tiene, y el
    // menú se quedaría viejo PARA SIEMPRE sin volver a intentarlo. Es el peor final posible:
    // silencioso y permanente.
    mockedAdapterFor.mockReturnValue(adapter(false))

    const r = await syncChannelMenu(link())

    expect(r.outcome).toBe('FAILED')
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('🔴 `force` publica aunque la huella coincida — es para cuando el proveedor lo PIDE', async () => {
    // Si Uber manda `store.menu_refresh_request` es porque algo se le perdió. Discutirle con
    // nuestro registro sería confiar en él justo en el caso donde está mal.
    const a = adapter()
    mockedAdapterFor.mockReturnValue(a)
    await syncChannelMenu(link())
    const hash = mockedUpdate.mock.calls[0][0].data.lastMenuHash

    const r = await syncChannelMenu(link({ lastMenuHash: hash }), { force: true })

    expect(r.outcome).toBe('PUBLISHED')
    expect(a.publishMenu).toHaveBeenCalledTimes(2)
  })

  it('un proveedor que no sabe publicar menú no es un error', async () => {
    mockedHasAdapter.mockReturnValue(false)
    expect((await syncChannelMenu(link({ provider: 'DELIVERECT' }))).outcome).toBe('NO_PUBLISHER')
  })

  it('🔴 la huella se saca del menú TRADUCIDO, no del snapshot interno', async () => {
    // Así, arreglar un bug del traductor republica el menú solo. Con el snapshot, el
    // proveedor se quedaría con el menú mal traducido hasta que alguien editara un producto
    // por casualidad — y nadie relacionaría una cosa con la otra.
    const a = adapter()
    mockedAdapterFor.mockReturnValue(a)
    await syncChannelMenu(link())
    const hash1 = mockedUpdate.mock.calls[0][0].data.lastMenuHash

    // Mismo snapshot, traductor distinto (como si se hubiera corregido un precio mal mapeado)
    jest.clearAllMocks()
    mockedHasAdapter.mockReturnValue(true)
    mockedUpdate.mockResolvedValue({})
    const b = adapter()
    b.buildMenuPayload = jest.fn(() => ({ items: [{ id: 'SKU-1', price_info: { price: 9950 } }] })) as any
    mockedAdapterFor.mockReturnValue(b)

    const r = await syncChannelMenu(link({ lastMenuHash: hash1 }))

    expect(r.outcome).toBe('PUBLISHED') // detectó el cambio del TRADUCTOR
  })
})
