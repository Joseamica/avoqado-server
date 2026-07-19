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
    ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue(activeLink)
    ;(deliverectClient.postOrderStatus as jest.Mock).mockResolvedValue(undefined)
  })

  // ============================================================
  // 1. REGRESIÓN CRÍTICA: órdenes TPV/QR jamás llaman a Deliverect
  // ============================================================
  it('REGRESIÓN: no-op si order.originSystem !== DELIVERY_PLATFORM (TPV/QR jamás dispara Deliverect)', async () => {
    await dispatchOrderStatus(makeOrder({ originSystem: OriginSystem.AVOQADO }), 'ACCEPTED')

    expect(prisma.deliveryChannelLink.findFirst).not.toHaveBeenCalled()
    expect(deliverectClient.postOrderStatus).not.toHaveBeenCalled()
  })

  it('REGRESIÓN: no-op para órdenes POS_SOFTRESTAURANT', async () => {
    await dispatchOrderStatus(makeOrder({ originSystem: OriginSystem.POS_SOFTRESTAURANT }), 'PREPARING')

    expect(deliverectClient.postOrderStatus).not.toHaveBeenCalled()
  })

  // ============================================================
  // 2. Resolución de link ACTIVE del venue
  // ============================================================
  it('busca el DeliveryChannelLink ACTIVE del venue de la orden', async () => {
    await dispatchOrderStatus(makeOrder(), 'ACCEPTED')

    expect(prisma.deliveryChannelLink.findFirst).toHaveBeenCalledWith({
      where: { venueId: 'venue1', status: DeliveryChannelStatus.ACTIVE },
    })
  })

  it('no-op si no existe ningún link ACTIVE para el venue (PAUSED/DISABLED quedan fuera del filtro)', async () => {
    ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue(null)

    await dispatchOrderStatus(makeOrder(), 'ACCEPTED')

    expect(deliverectClient.postOrderStatus).not.toHaveBeenCalled()
  })

  it('no-op si la orden no tiene externalId (no hay id remoto que notificar)', async () => {
    await dispatchOrderStatus(makeOrder({ externalId: null }), 'ACCEPTED')

    expect(prisma.deliveryChannelLink.findFirst).not.toHaveBeenCalled()
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
    ['PREPARING', 30],
    ['READY', 40],
    ['PICKED_UP', 50],
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
    ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({ ...activeLink, provider: DeliveryProvider.UBER_EATS })

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
})
