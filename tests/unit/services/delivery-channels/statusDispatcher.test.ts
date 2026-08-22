import prisma from '../../../../src/utils/prismaClient'
import { OriginSystem, DeliveryProvider, DeliveryChannelStatus } from '@prisma/client'
import { dispatchOrderStatus, getAdapter } from '../../../../src/services/delivery-channels/core/statusDispatcher.service'
import { deliverectClient, DeliverectApiError } from '../../../../src/services/delivery-channels/providers/deliverect/deliverect.client'

// El client NO se testea aquí (frontera HTTP credential-gated) — se mockea completo
// y se ejercita el registro real (getAdapter → deliverectAdapter → deliverectClient)
// para probar el mapeo de status + el swallow de errores del dispatcher end-to-end.
jest.mock('../../../../src/services/delivery-channels/providers/deliverect/deliverect.client', () => {
  class DeliverectApiError extends Error {
    status?: number
    body?: unknown
    constructor(message: string, status?: number, body?: unknown) {
      super(message)
      this.name = 'DeliverectApiError'
      this.status = status
      this.body = body
    }
  }
  return {
    DeliverectApiError,
    deliverectClient: {
      getToken: jest.fn(),
      postOrderStatus: jest.fn(),
      pushProducts: jest.fn(),
      setBusyMode: jest.fn(),
    },
  }
})

const activeLink: any = {
  id: 'link1',
  venueId: 'venue1',
  provider: DeliveryProvider.DELIVERECT,
  status: DeliveryChannelStatus.ACTIVE,
  externalLocationId: 'loc1',
  externalAccountId: 'acct1',
  webhookSecret: 'secret',
}

// Fix B3 (audit §10.2): el vínculo Order↔link vive en el DeliveryOrderEvent que
// originó el pedido (eventType 'order') — NO en "cualquier link ACTIVE del venue".
const originEvent: any = {
  id: 'evt1',
  orderId: 'order1',
  eventType: 'order',
  channelLinkId: 'link1',
}

function makeOrder(overrides: any = {}) {
  return {
    id: 'order1',
    venueId: 'venue1',
    externalId: 'DELIV-1',
    originSystem: OriginSystem.DELIVERY_PLATFORM,
    ...overrides,
  }
}

describe('dispatchOrderStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.deliveryOrderEvent.findFirst as jest.Mock).mockResolvedValue(originEvent)
    ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(activeLink)
    ;(deliverectClient.postOrderStatus as jest.Mock).mockResolvedValue(undefined)
  })

  // ============================================================
  // 1. REGRESIÓN CRÍTICA: órdenes TPV/QR jamás llaman a Deliverect
  // ============================================================
  it('REGRESIÓN: no-op si order.originSystem !== DELIVERY_PLATFORM (TPV/QR jamás dispara Deliverect)', async () => {
    await dispatchOrderStatus(makeOrder({ originSystem: OriginSystem.AVOQADO }), 'ACCEPTED')

    expect(prisma.deliveryOrderEvent.findFirst).not.toHaveBeenCalled()
    expect(prisma.deliveryChannelLink.findUnique).not.toHaveBeenCalled()
    expect(deliverectClient.postOrderStatus).not.toHaveBeenCalled()
  })

  it('REGRESIÓN: no-op para órdenes POS_SOFTRESTAURANT', async () => {
    await dispatchOrderStatus(makeOrder({ originSystem: OriginSystem.POS_SOFTRESTAURANT }), 'PREPARING')

    expect(deliverectClient.postOrderStatus).not.toHaveBeenCalled()
  })

  // ============================================================
  // 2. Fix B3: rutea por el link ORIGINADOR del pedido, no por "cualquier link ACTIVE"
  // ============================================================
  it('Fix B3: sin link a la mano, busca el evento originador y despacha por SU channelLinkId', async () => {
    // 🔴 SIN filtro de `eventType`. Este test antes exigía `eventType: 'order'` y con eso
    // CODIFICABA UN BUG: 'order' es el vocabulario de Deliverect, y los eventos de Uber
    // (`orders.notification`) nunca coincidían — el despacho de todo proveedor directo
    // caía en el warning "sin evento originador", en cada pedido. El evento originador es
    // el PRIMERO ligado a esta orden, se llame como se llame en el protocolo de cada uno.
    await dispatchOrderStatus(makeOrder(), 'ACCEPTED')

    expect(prisma.deliveryOrderEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: 'order1', channelLinkId: { not: null } } }),
    )
    expect(prisma.deliveryChannelLink.findUnique).toHaveBeenCalledWith({ where: { id: 'link1' } })
  })

  it('Fix B3: venue con 2 canales ACTIVE — un pedido originado por el canal B usa el link B, NUNCA el A ni "cualquier activo"', async () => {
    const linkA = { ...activeLink, id: 'linkA', externalLocationId: 'locA' }
    const linkB = { ...activeLink, id: 'linkB', externalLocationId: 'locB' }
    ;(prisma.deliveryOrderEvent.findFirst as jest.Mock).mockResolvedValue({ ...originEvent, channelLinkId: 'linkB' })
    ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockImplementation(({ where: { id } }: any) =>
      Promise.resolve(id === 'linkB' ? linkB : linkA),
    )

    await dispatchOrderStatus(makeOrder(), 'ACCEPTED')

    expect(prisma.deliveryChannelLink.findUnique).toHaveBeenCalledWith({ where: { id: 'linkB' } })
    expect(prisma.deliveryChannelLink.findUnique).not.toHaveBeenCalledWith({ where: { id: 'linkA' } })
    expect(deliverectClient.postOrderStatus).toHaveBeenCalledWith('DELIV-1', 20)
    // Nunca debe existir una llamada "cualquier link activo del venue" (findFirst sobre deliveryChannelLink)
    expect(prisma.deliveryChannelLink.findFirst).not.toHaveBeenCalled()
  })

  it('Fix B3: sin DeliveryOrderEvent originador → no-op con log, NUNCA adivina otro link', async () => {
    ;(prisma.deliveryOrderEvent.findFirst as jest.Mock).mockResolvedValue(null)

    await dispatchOrderStatus(makeOrder(), 'ACCEPTED')

    expect(prisma.deliveryChannelLink.findUnique).not.toHaveBeenCalled()
    expect(prisma.deliveryChannelLink.findFirst).not.toHaveBeenCalled()
    expect(deliverectClient.postOrderStatus).not.toHaveBeenCalled()
  })

  it('el link originador existe pero no está ACTIVE (PAUSED/DISABLED) → no-op, nunca cae a otro link del venue', async () => {
    ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({ ...activeLink, status: DeliveryChannelStatus.PAUSED })

    await dispatchOrderStatus(makeOrder(), 'ACCEPTED')

    expect(deliverectClient.postOrderStatus).not.toHaveBeenCalled()
    expect(prisma.deliveryChannelLink.findFirst).not.toHaveBeenCalled()
  })

  it('no-op si la orden no tiene externalId (no hay id remoto que notificar)', async () => {
    await dispatchOrderStatus(makeOrder({ externalId: null }), 'ACCEPTED')

    expect(prisma.deliveryOrderEvent.findFirst).not.toHaveBeenCalled()
    expect(deliverectClient.postOrderStatus).not.toHaveBeenCalled()
  })

  // ============================================================
  // 3. Mapeo de status → adapter real → client (DELIVERECT_STATUS_MAP)
  // ============================================================
  it('ACCEPTED se mapea a 20 vía DELIVERECT_STATUS_MAP y llama al client con el externalId de la orden', async () => {
    await dispatchOrderStatus(makeOrder(), 'ACCEPTED')

    expect(deliverectClient.postOrderStatus).toHaveBeenCalledWith('DELIV-1', 20)
  })

  it.each([
    // Fix C2 (audit, spec §10.1.6): documented prep/ready/final = 50/70/90 (was 30/40/50).
    ['PREPARING', 50],
    ['READY', 70],
    ['PICKED_UP', 90],
    ['CANCELLED', 110],
    ['FAILED', 120],
  ])('%s se mapea a %i', async (status, code) => {
    await dispatchOrderStatus(makeOrder(), status as any)

    expect(deliverectClient.postOrderStatus).toHaveBeenCalledWith('DELIV-1', code)
  })

  // ============================================================
  // 4. Errores del client se loguean y NO lanzan
  // ============================================================
  it('si el client lanza DeliverectApiError, el dispatcher lo traga (no lanza, no tumba el flujo del POS)', async () => {
    ;(deliverectClient.postOrderStatus as jest.Mock).mockRejectedValue(new DeliverectApiError('boom', 500, { error: 'down' }))

    await expect(dispatchOrderStatus(makeOrder(), 'ACCEPTED')).resolves.toBeUndefined()
  })

  it('si el client lanza un error genérico de red, el dispatcher tampoco lanza', async () => {
    ;(deliverectClient.postOrderStatus as jest.Mock).mockRejectedValue(new Error('ECONNRESET'))

    await expect(dispatchOrderStatus(makeOrder(), 'ACCEPTED')).resolves.toBeUndefined()
  })

  // ============================================================
  // 5. Provider sin adapter implementado → log + no-op
  // ============================================================
  it('provider sin adapter implementado (registry getAdapter) → no lanza, no-op', async () => {
    ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({ ...activeLink, provider: DeliveryProvider.UBER_EATS })

    await expect(dispatchOrderStatus(makeOrder(), 'ACCEPTED')).resolves.toBeUndefined()
    expect(deliverectClient.postOrderStatus).not.toHaveBeenCalled()
  })
})

describe('getAdapter (registry)', () => {
  it('devuelve el adapter de Deliverect para DELIVERECT', () => {
    const adapter = getAdapter(DeliveryProvider.DELIVERECT)
    expect(adapter.provider).toBe('DELIVERECT')
  })

  it('lanza para un provider sin adapter implementado todavía', () => {
    expect(() => getAdapter(DeliveryProvider.UBER_EATS)).toThrow()
  })
  // ── Falsa alarma + bug de ruteo, hallados con pedidos REALES de Uber (2026-08-20) ────
  describe('proveedor que gestiona el estado por su cuenta (Uber)', () => {
    const uberLink: any = { id: 'link_u', venueId: 'venue1', provider: DeliveryProvider.UBER_EATS, status: DeliveryChannelStatus.ACTIVE }

    it('🔴 NO consulta la base cuando el llamador YA sabe el canal', async () => {
      // El warning "sin DeliveryOrderEvent originador" salía en CADA pedido de Uber. Dos
      // causas encadenadas:
      //   1. el lookup filtraba `eventType: 'order'` — vocabulario de DELIVERECT. Los de
      //      Uber son `orders.notification`, así que NUNCA coincidía.
      //   2. aunque coincidiera, el evento se liga a la orden DESPUÉS de ingerir, así que
      //      en ese instante todavía no hay `orderId`. Es una carrera, no un dato faltante.
      // Un warning que sale siempre y nunca importa entrena a la gente a ignorar el log.
      // El llamador (la ingesta) SIEMPRE tiene el link en la mano: pasárselo elimina las
      // dos causas de golpe.
      const order = makeOrder({ id: 'ord_u', externalId: 'UBER_EATS:abc' })

      await dispatchOrderStatus(order as any, 'ACCEPTED', uberLink)

      expect((prisma as any).deliveryOrderEvent.findFirst).not.toHaveBeenCalled()
    })

    it('un proveedor sin sendStatusUpdate no es un error: él mismo acepta el pedido', async () => {
      // Uber acepta con `accept_pos_order` en su propio procesador. Pedirle además un
      // "status update" es pedirle algo que su API no tiene — no es una falla, es que no
      // aplica. Antes esto reventaba en `getAdapter` y el error se tragaba en silencio.
      const order = makeOrder({ id: 'ord_u2', externalId: 'UBER_EATS:def' })

      await expect(dispatchOrderStatus(order as any, 'ACCEPTED', uberLink)).resolves.toBeUndefined()
      expect(deliverectClient.postOrderStatus).not.toHaveBeenCalled() // ni se cruza de proveedor
    })

    it('🔴 el link que se pasa MANDA: sigue sin adivinar otro canal del venue', async () => {
      // La protección original (rutear por el link originador y jamás por "el primer
      // ACTIVE del venue") se conserva: con >1 canal activo, mandar el status al proveedor
      // equivocado con un id ajeno es peor que no mandarlo.
      const order = makeOrder({ id: 'ord_d', externalId: 'DELIV-9' })

      await dispatchOrderStatus(order as any, 'ACCEPTED', activeLink)

      expect(deliverectClient.postOrderStatus).toHaveBeenCalled()
    })
  })
})
