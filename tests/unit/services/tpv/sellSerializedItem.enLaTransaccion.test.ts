/** Gancho `enLaTransaccion` de sellSerializedItem: corre dentro de la transacción; si lanza, no hay venta ni ORDER_CREATED. */
import { sellSerializedItem } from '@/services/tpv/order.tpv.service'
import prisma from '@/utils/prismaClient'
import socketManager from '@/communication/sockets'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { order: { count: jest.fn() }, $transaction: jest.fn() },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}))
jest.mock('@/services/venueSalesGuard', () => ({ assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  moduleService: { isModuleEnabled: jest.fn().mockResolvedValue(true) },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))
jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({
  serializedInventoryService: {
    scan: jest.fn().mockResolvedValue({ status: 'available', found: true, item: { id: 'i1' } }),
    buildOrderItemData: jest.fn().mockReturnValue({ productName: 'SIM', quantity: 1 }),
  },
}))
jest.mock('@/services/shared/turnoDeCaja', () => ({ turnoAbiertoDelNegocio: jest.fn().mockResolvedValue(null) }))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn() },
}))

const input = { serialNumber: '8952', price: 100 } as any

describe('sellSerializedItem · gancho enLaTransaccion', () => {
  let tx: any
  let broadcast: jest.Mock
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.order.count as jest.Mock).mockResolvedValue(0)
    tx = {
      order: {
        create: jest.fn().mockResolvedValue({ id: 'o1' }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: 'o1', orderNumber: 'SN00001', subtotal: 100, total: 100, version: 1, items: [], table: null }),
      },
    }
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx))
    broadcast = jest.fn()
    ;(socketManager.getBroadcastingService as jest.Mock).mockReturnValue({ broadcastToVenue: broadcast })
  })

  it('llama al gancho una vez con el tx y el id de la orden, antes del findUniqueOrThrow', async () => {
    const orden: string[] = []
    tx.order.findUniqueOrThrow.mockImplementation(async () => {
      orden.push('find')
      return { id: 'o1', orderNumber: 'SN00001', subtotal: 100, total: 100, version: 1, items: [], table: null }
    })
    const gancho = jest.fn(async () => {
      orden.push('gancho')
    })
    await sellSerializedItem('v1', input, 's1', { enLaTransaccion: gancho })
    expect(gancho).toHaveBeenCalledTimes(1)
    expect(gancho).toHaveBeenCalledWith(tx, { id: 'o1' })
    expect(orden).toEqual(['gancho', 'find'])
  })

  it('si el gancho lanza, sellSerializedItem lanza y no emite ORDER_CREATED', async () => {
    const gancho = jest.fn().mockRejectedValue(new Error('perdió'))
    await expect(sellSerializedItem('v1', input, 's1', { enLaTransaccion: gancho })).rejects.toThrow('perdió')
    expect(tx.order.findUniqueOrThrow).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('sin gancho, tx.order.create recibe lo mismo de hoy', async () => {
    await sellSerializedItem('v1', input, 's1')
    expect(tx.order.create).toHaveBeenCalledTimes(1)
    expect(tx.order.create.mock.calls[0][0]).toMatchObject({
      data: { venueId: 'v1', shiftId: null, orderNumber: 'SN00001', status: 'PENDING', total: 100, createdById: 's1', tags: [] },
      include: { items: true },
    })
    expect(broadcast).toHaveBeenCalledTimes(1)
  })
})
