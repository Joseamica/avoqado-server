/**
 * «No puedo prepararlo» sobre un pedido YA ACEPTADO (Tarea 14 del plan «Rappi fase 2», decisión F2 del founder).
 *
 * 🔴 POR QUÉ EXISTE: con el adaptador de Rappi registrado, rechazar en cocina un pedido CONFIRMED de Rappi fabricaba
 * `{ ok: true, status: 0 }` —Rappi no tiene `cancelOrder`— y lo cancelaba SÓLO de nuestro lado: la venta desaparecía y la
 * cocina dejaba de prepararlo mientras Rappi seguía mandando al repartidor (hallazgo #4 de Codex b0). Medido en el sandbox
 * (M11, 21-oct): Rappi no deja cancelar por API un pedido ya tomado (400 «Invalid transition from {TAKEN} to {REJECTED}»).
 *
 * Ahora el núcleo NO cancela nada en Avoqado cuando el proveedor no cancela por API: devuelve `PROVEEDOR_NO_CANCELA` con
 * el texto de qué hacer, que pone el ADAPTADOR (el núcleo no nombra proveedores). La venta se cancela sola cuando el
 * proveedor manda su aviso de cancelación. Uber, que sí cancela por API, sigue igual.
 */
import fs from 'fs'
import path from 'path'

import prisma from '@/utils/prismaClient'
import { adapterFor, hasAdapter } from '@/services/delivery-channels/core/adapterRegistry'
import { cancelDeliveryOrder } from '@/services/delivery-channels/core/cancelDeliveryOrder.service'
import { tomarReserva } from '@/services/delivery-channels/core/deliveryOrderLock'
import { denyDeliveryOrder } from '@/services/delivery-channels/core/respondToDeliveryOrder.service'
import { rappiAdapter } from '@/services/delivery-channels/providers/rappi/rappi.adapter'
import { uberAdapter } from '@/services/delivery-channels/providers/uber-eats/uber.adapter'
import { uberApi } from '@/services/delivery-channels/providers/uber-eats/uber.client'

jest.mock('@/services/delivery-channels/core/adapterRegistry', () => ({
  hasAdapter: jest.fn(() => true),
  adapterFor: jest.fn(),
}))

// La reserva real (spec §3.2) se prueba contra Postgres en tests/integration/delivery-channels/aceptacionAcreditada.test.ts.
jest.mock('@/services/delivery-channels/core/deliveryOrderLock', () => ({
  tomarReserva: jest.fn(async () => ({ ok: true, token: 'tok' })),
  soltarReserva: jest.fn(async () => true),
  withDeliveryOrderLock: jest.fn(async (_id: string, fn: (tx: unknown) => unknown) => fn({})),
}))

// Cancelar en Avoqado (sacar de la cocina, regresar inventario) se prueba en cancelDeliveryOrder.test.ts: aquí sólo importa SI se llama.
jest.mock('@/services/delivery-channels/core/cancelDeliveryOrder.service', () => ({
  cancelDeliveryOrder: jest.fn(async () => ({ cancelled: true })),
}))

// La red de Rappi y la de Uber, simuladas: con los adaptadores REALES, lo único falso es el HTTP.
const mockRechazarPedidoRappi = jest.fn()
jest.mock('@/services/delivery-channels/providers/rappi/rappi.client', () => ({
  rechazarPedidoRappi: (...a: unknown[]) => mockRechazarPedidoRappi(...a),
}))
jest.mock('@/services/delivery-channels/providers/uber-eats/uber.client', () => ({
  uberApi: jest.fn(),
  fetchUberOrder: jest.fn(),
}))

/** Los avisos NEW_ORDER reales del sandbox (M10), tal cual quedan en `Order.posRawData`. */
const SANDBOX = path.join(__dirname, 'fixtures/rappi/sandbox')
const sandbox = (archivo: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(SANDBOX, archivo), 'utf8'))
const AVISO_DELIVERY = 'new-order-full-delivery-menu-muestra.json'
const AVISO_MARKETPLACE = 'new-order-marketplace-propina.json'
const AVISO_PICKUP = 'new-order-pickup-propina.json'

// 🔴 Los textos son los del brief, al pie de la letra: son lo que lee la cocina.
const TEXTO_RAPPI_SOPORTE =
  'Rappi no deja cancelar por sistema un pedido ya aceptado. Pídele la cancelación al soporte de Rappi; aquí se cancela solo cuando Rappi la confirme.'
const TEXTO_RAPPI_ALIADOS = 'Cancélalo en la app de Rappi para aliados; aquí se cancela solo cuando Rappi lo confirme.'
const TEXTO_GENERICO = 'Esta app de delivery no deja cancelar por sistema un pedido ya aceptado: pídeselo a su soporte.'

const api = uberApi as jest.MockedFunction<typeof uberApi>

/**
 * La venta tal como la ve `contexto`. 🔴 El simulacro de `findFirst` respeta el `select`: si `contexto` no pidiera
 * `posRawData`, el adaptador no recibiría el aviso y las pruebas de la variante de entrega fallarían (como en la base real).
 */
function venta(campos: Record<string, unknown>) {
  const fila: Record<string, unknown> = {
    id: 'order1',
    externalId: 'RAPPI:722609056',
    status: 'CONFIRMED',
    orderNumber: 'R-1',
    deliveryChannelLinkId: 'link1',
    providerAcceptedAt: new Date('2026-10-21T21:15:00Z'),
    readyReportedAt: null,
    posRawData: sandbox(AVISO_DELIVERY),
    ...campos,
  }
  ;(prisma.order.findFirst as jest.Mock).mockImplementation(async (args: { select?: Record<string, boolean> }) =>
    args?.select ? Object.fromEntries(Object.keys(args.select).map(k => [k, fila[k]])) : fila,
  )
}

function canal(provider: string, externalLocationId: string) {
  ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({ provider, externalLocationId })
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma as any).deliveryLineAction = { count: jest.fn().mockResolvedValue(0) }
  ;(hasAdapter as jest.Mock).mockReturnValue(true)
  ;(adapterFor as jest.Mock).mockReturnValue(rappiAdapter)
  venta({})
  canal('RAPPI', '900175625')
  mockRechazarPedidoRappi.mockResolvedValue({ traduccion: { rechazable: true }, http: { ok: true, status: 200, raw: '{}' } })
  api.mockResolvedValue({ status: 200, json: {}, text: '{}' })
})

describe('denyDeliveryOrder — un pedido YA ACEPTADO (F2)', () => {
  it('🔴 aceptado y el proveedor no cancela por API: NO se cancela en Avoqado y devuelve qué hacer', async () => {
    const r = await denyDeliveryOrder('venue1', 'order1', 'OUT_OF_ITEMS', 'staff1')

    expect(r).toEqual({ outcome: 'PROVEEDOR_NO_CANCELA', mensaje: TEXTO_RAPPI_SOPORTE })
    // 🔴 Lo que antes pasaba a escondidas: la venta se cancelaba sólo de nuestro lado.
    expect(cancelDeliveryOrder).not.toHaveBeenCalled()
    // Sin reserva y sin red: no hay nada que mandarle al proveedor.
    expect(tomarReserva).not.toHaveBeenCalled()
    expect(mockRechazarPedidoRappi).not.toHaveBeenCalled()
    expect((prisma as any).deliveryLineAction.count).not.toHaveBeenCalled()
  })

  describe('con repartidor de Rappi el texto manda al soporte; con repartidor propio, a la app de aliados', () => {
    it.each([
      ['delivery (repartidor de Rappi)', AVISO_DELIVERY, TEXTO_RAPPI_SOPORTE],
      ['marketplace (repartidor del negocio)', AVISO_MARKETPLACE, TEXTO_RAPPI_ALIADOS],
      ['pickup (el cliente recoge)', AVISO_PICKUP, TEXTO_RAPPI_ALIADOS],
    ])('🔴 %s', async (_variante, aviso, texto) => {
      venta({ posRawData: sandbox(aviso) })

      const r = await denyDeliveryOrder('venue1', 'order1', 'OUT_OF_ITEMS')

      expect(r).toEqual({ outcome: 'PROVEEDOR_NO_CANCELA', mensaje: texto })
      expect(cancelDeliveryOrder).not.toHaveBeenCalled()
    })

    it.each([
      ['sin crudo guardado', null],
      ['crudo vacío', {}],
      ['crudo que no es un objeto', 'texto'],
      ['sin delivery_method', { order_detail: {} }],
      ['delivery_method desconocido', { order_detail: { delivery_method: 'drone' } }],
      ['order_detail nulo', { order_detail: null }],
    ])('%s ⇒ el texto del soporte (nunca uno que mande a una app que quizá no aplica)', async (_caso, crudo) => {
      venta({ posRawData: crudo })

      const r = await denyDeliveryOrder('venue1', 'order1', 'OUT_OF_ITEMS')

      expect(r).toEqual({ outcome: 'PROVEEDOR_NO_CANCELA', mensaje: TEXTO_RAPPI_SOPORTE })
    })

    it('el delivery_method se lee sin importar mayúsculas ni espacios, como en la ingesta', () => {
      expect(rappiAdapter.instruccionesParaCancelar({ order_detail: { delivery_method: ' Marketplace ' } })).toBe(TEXTO_RAPPI_ALIADOS)
      expect(rappiAdapter.instruccionesParaCancelar({ order_detail: { delivery_method: 'PICKUP' } })).toBe(TEXTO_RAPPI_ALIADOS)
      expect(rappiAdapter.instruccionesParaCancelar({ order_detail: { delivery_method: 'Delivery' } })).toBe(TEXTO_RAPPI_SOPORTE)
    })
  })

  it('un proveedor sin cancelación por API y sin instrucciones propias ⇒ el texto genérico, sin cancelar', async () => {
    const denyOrder = jest.fn()
    ;(adapterFor as jest.Mock).mockReturnValue({ provider: 'DIDI_FOOD', denyOrder })
    venta({ externalId: 'DIDI_FOOD:abc' })
    canal('DIDI_FOOD', 'tienda-didi')

    const r = await denyDeliveryOrder('venue1', 'order1', 'OUT_OF_ITEMS')

    expect(r).toEqual({ outcome: 'PROVEEDOR_NO_CANCELA', mensaje: TEXTO_GENERICO })
    expect(denyOrder).not.toHaveBeenCalled()
    expect(cancelDeliveryOrder).not.toHaveBeenCalled()
    expect(tomarReserva).not.toHaveBeenCalled()
  })

  it('🔴 un aceptado de Uber (sí cancela por API) se cancela como hoy: primero en Uber, después en Avoqado', async () => {
    ;(adapterFor as jest.Mock).mockReturnValue(uberAdapter)
    venta({ externalId: 'UBER_EATS:uuid-uber-1', posRawData: { id: 'uuid-uber-1' } })
    canal('UBER_EATS', 'store-uber')

    const r = await denyDeliveryOrder('venue1', 'order1', 'OUT_OF_ITEMS', 'staff1')

    expect(r).toEqual({ outcome: 'CANCELLED' })
    expect(tomarReserva).toHaveBeenCalledWith('order1', 'DENY')
    expect(api).toHaveBeenCalledTimes(1)
    expect(api.mock.calls[0][0]).toMatchObject({ method: 'POST', path: '/v1/delivery/order/uuid-uber-1/cancel', storeId: 'store-uber' })
    expect(cancelDeliveryOrder).toHaveBeenCalledWith('uuid-uber-1', 'UBER_EATS', 'el negocio no pudo prepararlo: OUT_OF_ITEMS')
  })

  it('Uber que rechaza la cancelación ⇒ FAILED y NO se cancela en Avoqado (como hoy)', async () => {
    ;(adapterFor as jest.Mock).mockReturnValue(uberAdapter)
    venta({ externalId: 'UBER_EATS:uuid-uber-1' })
    canal('UBER_EATS', 'store-uber')
    api.mockResolvedValue({ status: 400, json: {}, text: '{"message":"no"}' })

    const r = await denyDeliveryOrder('venue1', 'order1', 'OUT_OF_ITEMS')

    expect(r).toEqual({ outcome: 'FAILED', error: 'HTTP 400' })
    expect(cancelDeliveryOrder).not.toHaveBeenCalled()
  })
})

describe('REGRESIÓN — lo que no cambia', () => {
  it('un pedido de Rappi TODAVÍA NO aceptado se rechaza en Rappi y después en Avoqado (DENIED)', async () => {
    venta({ status: 'PENDING', providerAcceptedAt: null })

    const r = await denyDeliveryOrder('venue1', 'order1', 'OUT_OF_ITEMS', 'staff1')

    expect(r).toEqual({ outcome: 'DENIED' })
    expect(mockRechazarPedidoRappi).toHaveBeenCalledWith('722609056', '900175625', 'OUT_OF_ITEMS')
    expect(cancelDeliveryOrder).toHaveBeenCalledWith('722609056', 'RAPPI', 'rechazado por el negocio: OUT_OF_ITEMS')
  })

  it('un pedido ya cancelado ⇒ ALREADY_DONE, sin hablarle a nadie', async () => {
    venta({ status: 'CANCELLED' })

    const r = await denyDeliveryOrder('venue1', 'order1')

    expect(r).toEqual({ outcome: 'ALREADY_DONE' })
    expect(tomarReserva).not.toHaveBeenCalled()
    expect(cancelDeliveryOrder).not.toHaveBeenCalled()
  })

  it('una venta que no es de delivery ⇒ NOT_A_DELIVERY_ORDER', async () => {
    venta({ externalId: null })

    expect(await denyDeliveryOrder('venue1', 'order1')).toEqual({ outcome: 'NOT_A_DELIVERY_ORDER' })
    expect(cancelDeliveryOrder).not.toHaveBeenCalled()
  })

  it('tenant isolation: la venta se busca con el venueId de la llamada', async () => {
    await denyDeliveryOrder('venue-otro', 'order1')

    expect((prisma.order.findFirst as jest.Mock).mock.calls[0][0].where).toEqual({ id: 'order1', venueId: 'venue-otro' })
  })
})
