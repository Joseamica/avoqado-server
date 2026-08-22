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

// El sincronizador resuelve el horario antes de publicar; sin esto la cascada consulta
// reservas de verdad. Se fija en ESTIMADO, que es el caso por defecto de un venue nuevo.
jest.mock('@/services/delivery-channels/core/deliveryHours.service', () => ({
  resolveDeliveryHours: jest.fn(async () => ({ horario: {}, fuente: 'ESTIMADO' })),
}))

jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(async () => true),
}))

jest.mock('@/services/delivery-channels/core/adapterRegistry', () => ({
  hasAdapter: jest.fn(() => true),
  adapterFor: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import { buildMenuSnapshot } from '@/services/delivery-channels/core/menuSnapshot.service'
import { adapterFor, hasAdapter } from '@/services/delivery-channels/core/adapterRegistry'
import { Prisma } from '@prisma/client'

import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { syncChannelAvailability, syncChannelMenu } from '@/services/delivery-channels/core/menuSync.service'

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

describe('disponibilidad — agotar y revivir productos', () => {
  const mockedFeature = venueHasFeatureAccess as jest.Mock
  const mockedProducts = (prisma as any).product.findMany as jest.Mock
  const mockedLinkUpdate = (prisma as any).deliveryChannelLink.update as jest.Mock

  const dec = (n: number) => new Prisma.Decimal(n)

  function adaptadorDisp(ok = true) {
    return { setItemSoldOut: jest.fn(async () => ({ ok, status: ok ? 200 : 400, raw: '' })) }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    ;(hasAdapter as jest.Mock).mockReturnValue(true)
    mockedFeature.mockResolvedValue(true)
    mockedLinkUpdate.mockResolvedValue({})
  })

  it('🔴 agota lo que se acabó y revive lo que volvió — sólo la DIFERENCIA', () => {
    // Repetir el estado de 96 productos cada 5 minutos serían 96 llamadas por nada.
    const a = adaptadorDisp()
    ;(adapterFor as jest.Mock).mockReturnValue(a)
    mockedProducts.mockResolvedValueOnce([{ sku: 'A' }, { sku: 'B' }]).mockResolvedValueOnce([])

    return syncChannelAvailability(link({ config: { soldOutSkus: ['B', 'C'] } })).then(r => {
      expect(r).toEqual({ agotados: 1, revividos: 1 })
      expect(a.setItemSoldOut).toHaveBeenCalledWith('A', 'store1', true) // nuevo
      expect(a.setItemSoldOut).toHaveBeenCalledWith('C', 'store1', false) // volvió
      expect(a.setItemSoldOut).not.toHaveBeenCalledWith('B', 'store1', true) // ya estaba
    })
  })

  it('🔴 agota los platillos que NO SE PUEDEN HACER por falta de ingrediente', async () => {
    // Es el caso que de verdad pasa en una cocina: no se acaba "la hamburguesa", se acaba la
    // CARNE — y entonces todos los platillos que la llevan dejan de existir. Sin esto Uber
    // los sigue vendiendo y cada uno termina en un rechazo, que cuenta contra la tasa de
    // inyección que Uber exige para no revocar el acceso.
    const a = adaptadorDisp()
    ;(adapterFor as jest.Mock).mockReturnValue(a)
    mockedProducts
      .mockResolvedValueOnce([]) // (a) nada con inventario propio agotado
      .mockResolvedValueOnce([
        {
          sku: 'HAMBURGUESA',
          recipe: { portionYield: 1, lines: [{ quantity: dec(0.2), rawMaterial: { currentStock: dec(0), name: 'Carne' } }] },
        },
        {
          sku: 'ENSALADA',
          recipe: { portionYield: 1, lines: [{ quantity: dec(0.1), rawMaterial: { currentStock: dec(5), name: 'Lechuga' } }] },
        },
      ])

    const r = await syncChannelAvailability(link({ config: {} }))

    expect(r.agotados).toBe(1)
    expect(a.setItemSoldOut).toHaveBeenCalledWith('HAMBURGUESA', 'store1', true)
    expect(a.setItemSoldOut).not.toHaveBeenCalledWith('ENSALADA', 'store1', true)
  })

  it('🔴 la receta que RINDE VARIAS porciones no se agota de más', async () => {
    // Una receta de 2 kg de carne que rinde 10 porciones necesita 0.2 kg por porción. Con
    // 0.5 kg en bodega SÍ se pueden hacer. Dividir mal aquí esconde platillos que sí hay.
    const a = adaptadorDisp()
    ;(adapterFor as jest.Mock).mockReturnValue(a)
    mockedProducts.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        sku: 'TACOS',
        recipe: { portionYield: 10, lines: [{ quantity: dec(2), rawMaterial: { currentStock: dec(0.5), name: 'Carne' } }] },
      },
    ])

    expect((await syncChannelAvailability(link({ config: {} }))).agotados).toBe(0)
    expect(a.setItemSoldOut).not.toHaveBeenCalled()
  })

  it('un ingrediente OPCIONAL que falte no agota el platillo', async () => {
    // Sale sin él. Contarlo agotaría platillos que sí se pueden preparar.
    const a = adaptadorDisp()
    ;(adapterFor as jest.Mock).mockReturnValue(a)
    // El servicio filtra `isOptional: false` en la consulta, así que un opcional NI SIQUIERA
    // llega: el test lo refleja devolviendo la receta ya sin él.
    mockedProducts.mockResolvedValueOnce([]).mockResolvedValueOnce([{ sku: 'PLATO', recipe: { portionYield: 1, lines: [] } }])

    expect((await syncChannelAvailability(link({ config: {} }))).agotados).toBe(0)
  })

  it('🔴 sin INVENTORY_TRACKING no toca NADA: los números serían basura', async () => {
    // Agotar con base en stock que nadie mantiene ESCONDE productos de la app sin motivo,
    // que es peor que venderlos de más. [mercado] Square hace lo mismo: sólo marca agotado
    // el producto que tiene el seguimiento prendido.
    const a = adaptadorDisp()
    ;(adapterFor as jest.Mock).mockReturnValue(a)
    mockedFeature.mockResolvedValue(false)

    expect(await syncChannelAvailability(link())).toEqual({ agotados: 0, revividos: 0 })
    expect(mockedProducts).not.toHaveBeenCalled()
    expect(a.setItemSoldOut).not.toHaveBeenCalled()
  })

  it('🔴 si el proveedor RECHAZA agotar uno, no se registra como hecho', async () => {
    // Registrarlo haría que la siguiente pasada creyera que ya está agotado y nunca lo
    // reintentara: el proveedor seguiría vendiendo algo que no hay, para siempre.
    ;(adapterFor as jest.Mock).mockReturnValue(adaptadorDisp(false))
    mockedProducts.mockResolvedValueOnce([{ sku: 'A' }]).mockResolvedValueOnce([])

    await syncChannelAvailability(link({ config: {} }))

    expect(mockedLinkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ config: expect.objectContaining({ soldOutSkus: [] }) }) }),
    )
  })

  it('sin cambios no gasta ni una llamada', async () => {
    const a = adaptadorDisp()
    ;(adapterFor as jest.Mock).mockReturnValue(a)
    mockedProducts.mockResolvedValueOnce([{ sku: 'A' }]).mockResolvedValueOnce([])

    expect(await syncChannelAvailability(link({ config: { soldOutSkus: ['A'] } }))).toEqual({ agotados: 0, revividos: 0 })
    expect(a.setItemSoldOut).not.toHaveBeenCalled()
    expect(mockedLinkUpdate).not.toHaveBeenCalled()
  })
})
