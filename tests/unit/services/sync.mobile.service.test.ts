/**
 * Reducer de intents offline (Corte D) — garantías núcleo:
 * 1. Idempotencia: intent repetido devuelve el ack guardado SIN re-aplicar.
 * 2. Determinismo: tipo desconocido / payload inválido → REJECTED estructurado.
 * 3. Identidad local: localOrderId se resuelve dentro del batch y desde BD.
 * 4. Mismas reglas que online: TABLE_SERVICE gating y propiedad de mesa.
 * 5. Carrera de persistencia (P2002) → devuelve el ack del ganador.
 */

import { processIntents } from '@/services/mobile/sync.mobile.service'
import prisma from '@/utils/prismaClient'
import * as tableService from '@/services/tpv/table.tpv.service'
import * as orderTpvService from '@/services/tpv/order.tpv.service'
import * as orderMobileService from '@/services/mobile/order.mobile.service'
import * as featureAccess from '@/middlewares/checkFeatureAccess.middleware'
import * as tableOwnership from '@/middlewares/checkTableOwnership.middleware'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    posSyncIntent: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
    order: { findFirst: jest.fn() },
  },
}))

jest.mock('@/services/tpv/table.tpv.service', () => ({
  assignTable: jest.fn(),
  moveOrderToTable: jest.fn(),
  assignOrderWaiter: jest.fn(),
  clearTable: jest.fn(),
}))
jest.mock('@/services/tpv/order.tpv.service', () => ({ addItemsToOrder: jest.fn() }))
jest.mock('@/services/mobile/order.mobile.service', () => ({
  payCashOrder: jest.fn(),
  applyOrderDiscount: jest.fn(),
  updateOrderDetails: jest.fn(),
  cancelOrder: jest.fn(),
}))
jest.mock('@/services/mobile/comp-item.mobile.service', () => ({ compWholeOrder: jest.fn() }))
jest.mock('@/services/mobile/service-charge.mobile.service', () => ({ applyServiceCharge: jest.fn() }))
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({ hasFeatureAccess: jest.fn() }))
jest.mock('@/middlewares/checkTableOwnership.middleware', () => ({
  isTableOwnershipEnforced: jest.fn(),
  staffCanManageAllTables: jest.fn(),
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const VENUE = 'venue-1'
const STAFF = 'staff-juan'
const DEVICE = 'device-a'

const baseParams = (intents: any[]) => ({ venueId: VENUE, staffId: STAFF, deviceId: DEVICE, intents })

describe('sync.mobile.service processIntents', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.posSyncIntent.findUnique as jest.Mock).mockResolvedValue(null)
    ;(prisma.posSyncIntent.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.posSyncIntent.create as jest.Mock).mockResolvedValue({})
    ;(featureAccess.hasFeatureAccess as jest.Mock).mockResolvedValue({ hasAccess: true })
    ;(tableOwnership.isTableOwnershipEnforced as jest.Mock).mockResolvedValue(false)
    ;(tableOwnership.staffCanManageAllTables as jest.Mock).mockResolvedValue(false)
  })

  it('idempotencia: intent ya procesado devuelve el ack guardado sin re-aplicar', async () => {
    ;(prisma.posSyncIntent.findUnique as jest.Mock).mockResolvedValue({
      status: 'ACKED',
      errorCode: null,
      localRef: 'local-1',
      resultJson: { orderId: 'order-9', localOrderId: 'local-1' },
    })
    const acks = await processIntents(
      baseParams([{ id: 'intent-1', type: 'OPEN_TABLE', payload: { tableId: 't1', localOrderId: 'local-1' } }]),
    )
    expect(acks).toHaveLength(1)
    expect(acks[0]).toMatchObject({ id: 'intent-1', status: 'ACKED', result: { orderId: 'order-9' } })
    expect(tableService.assignTable).not.toHaveBeenCalled()
    expect(prisma.posSyncIntent.create).not.toHaveBeenCalled()
  })

  it('tipo desconocido → REJECTED UNKNOWN_INTENT_TYPE (cuarentena, no crash)', async () => {
    const acks = await processIntents(baseParams([{ id: 'i2', type: 'TELEPORT', payload: {} }]))
    expect(acks[0]).toMatchObject({ status: 'REJECTED', errorCode: 'UNKNOWN_INTENT_TYPE' })
  })

  it('OPEN_TABLE feliz: delega en assignTable y mapea localOrderId → orderId', async () => {
    ;(tableService.assignTable as jest.Mock).mockResolvedValue({
      order: { id: 'order-1', orderNumber: 'A-3001', version: 1 },
      isNewOrder: true,
    })
    const acks = await processIntents(
      baseParams([{ id: 'i3', seq: 1, type: 'OPEN_TABLE', payload: { tableId: 't1', covers: 2, localOrderId: 'local-A' } }]),
    )
    expect(tableService.assignTable).toHaveBeenCalledWith(VENUE, 't1', STAFF, 2)
    expect(acks[0]).toMatchObject({
      status: 'ACKED',
      result: { orderId: 'order-1', localOrderId: 'local-A', isNewOrder: true },
    })
    expect(prisma.posSyncIntent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ idempotencyKey: 'i3', localRef: 'local-A', status: 'ACKED' }) }),
    )
  })

  it('sin TABLE_SERVICE → REJECTED FEATURE_LOCKED (sync no es puerta trasera)', async () => {
    ;(featureAccess.hasFeatureAccess as jest.Mock).mockResolvedValue({ hasAccess: false })
    const acks = await processIntents(baseParams([{ id: 'i4', type: 'OPEN_TABLE', payload: { tableId: 't1' } }]))
    expect(acks[0]).toMatchObject({ status: 'REJECTED', errorCode: 'FEATURE_LOCKED' })
    expect(tableService.assignTable).not.toHaveBeenCalled()
  })

  it('batch OPEN_TABLE + ADD_ITEMS: el segundo resuelve el orderId del primero y usa la versión ACTUAL del server', async () => {
    ;(tableService.assignTable as jest.Mock).mockResolvedValue({
      order: { id: 'order-2', orderNumber: 'A-4001', version: 1 },
      isNewOrder: true,
    })
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ version: 7, status: 'PENDING' })
    ;(orderTpvService.addItemsToOrder as jest.Mock).mockResolvedValue({ version: 8, total: 150.0 })

    const acks = await processIntents(
      baseParams([
        { id: 'i5', seq: 1, type: 'OPEN_TABLE', payload: { tableId: 't2', localOrderId: 'local-B' } },
        { id: 'i6', seq: 2, type: 'ADD_ITEMS', payload: { localOrderId: 'local-B', items: [{ productId: 'p1', quantity: 2 }] } },
      ]),
    )
    // externalId determinista inyectado por el reducer para idempotencia de ronda.
    expect(orderTpvService.addItemsToOrder).toHaveBeenCalledWith(
      VENUE,
      'order-2',
      [{ productId: 'p1', quantity: 2, externalId: 'sync:i6:0' }],
      7,
      true,
    )
    expect(acks[1]).toMatchObject({ status: 'ACKED', result: { orderId: 'order-2', version: 8 } })
  })

  it('VERSION_CONFLICT en ADD_ITEMS → RETRY (no se pierde), corta el batch, no persiste', async () => {
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ version: 5, status: 'PENDING' })
    const conflict: any = new Error('La orden cambió en otro dispositivo')
    conflict.code = 'VERSION_CONFLICT'
    ;(orderTpvService.addItemsToOrder as jest.Mock).mockRejectedValue(conflict)

    const acks = await processIntents(
      baseParams([
        { id: 'iA', seq: 1, type: 'ADD_ITEMS', payload: { orderId: 'order-1', items: [{ productId: 'p1', quantity: 1 }] } },
        { id: 'iB', seq: 2, type: 'ADD_ITEMS', payload: { orderId: 'order-1', items: [{ productId: 'p2', quantity: 1 }] } },
      ]),
    )
    // El primero es RETRY; el batch se corta ANTES del segundo (FIFO).
    expect(acks).toHaveLength(1)
    expect(acks[0]).toMatchObject({ id: 'iA', status: 'RETRY', errorCode: 'VERSION_CONFLICT' })
    // RETRY NO se persiste — un próximo replay lo re-drive.
    expect(prisma.posSyncIntent.create).not.toHaveBeenCalled()
  })

  it('el batch se ordena por seq (defensivo): OPEN_TABLE antes que su ADD_ITEMS aunque lleguen invertidos', async () => {
    ;(tableService.assignTable as jest.Mock).mockResolvedValue({ order: { id: 'order-9', version: 1 }, isNewOrder: true })
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ version: 1, status: 'PENDING' })
    ;(orderTpvService.addItemsToOrder as jest.Mock).mockResolvedValue({ version: 2, total: 50 })
    // Llegan INVERTIDOS: ADD_ITEMS (seq 2) primero, OPEN_TABLE (seq 1) después.
    const acks = await processIntents(
      baseParams([
        { id: 'iItems', seq: 2, type: 'ADD_ITEMS', payload: { localOrderId: 'local-Z', items: [{ productId: 'p1', quantity: 1 }] } },
        { id: 'iOpen', seq: 1, type: 'OPEN_TABLE', payload: { tableId: 't1', localOrderId: 'local-Z' } },
      ]),
    )
    // El OPEN_TABLE se aplicó PRIMERO (por seq), así el ADD_ITEMS resolvió su orderId.
    expect(acks.find(a => a.id === 'iOpen')?.status).toBe('ACKED')
    expect(acks.find(a => a.id === 'iItems')?.status).toBe('ACKED')
    expect(orderTpvService.addItemsToOrder).toHaveBeenCalled()
  })

  it('ADD_ITEMS en request separado resuelve localOrderId desde PosSyncIntent', async () => {
    ;(prisma.posSyncIntent.findFirst as jest.Mock).mockResolvedValue({ resultJson: { orderId: 'order-3' } })
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ version: 2, status: 'PENDING' })
    ;(orderTpvService.addItemsToOrder as jest.Mock).mockResolvedValue({ version: 3, total: 80 })

    const acks = await processIntents(
      baseParams([{ id: 'i7', type: 'ADD_ITEMS', payload: { localOrderId: 'local-C', items: [{ productId: 'p2', quantity: 1 }] } }]),
    )
    expect(prisma.posSyncIntent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: VENUE, localRef: 'local-C', status: 'ACKED' } }),
    )
    expect(acks[0]).toMatchObject({ status: 'ACKED', result: { orderId: 'order-3' } })
  })

  it('PAY_CASH con propiedad de mesa ajena → REJECTED TABLE_OWNED_BY_OTHER', async () => {
    ;(tableOwnership.isTableOwnershipEnforced as jest.Mock).mockResolvedValue(true)
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({
      tableId: 't1',
      servedById: 'staff-otro',
      servedBy: { firstName: 'Juan', lastName: 'Pérez' },
    })
    const acks = await processIntents(
      baseParams([{ id: 'i8', type: 'PAY_CASH', payload: { orderId: 'order-4', amountCents: 10000 } }]),
    )
    expect(acks[0]).toMatchObject({ status: 'REJECTED', errorCode: 'TABLE_OWNED_BY_OTHER' })
    expect(orderMobileService.payCashOrder).not.toHaveBeenCalled()
  })

  it('PAY_CASH feliz delega en payCashOrder con centavos y staff', async () => {
    ;(orderMobileService.payCashOrder as jest.Mock).mockResolvedValue({
      paymentId: 'pay-1',
      orderNumber: 'A-5001',
      digitalReceipt: { accessKey: 'k', receiptUrl: 'u', autofacturaAvailable: false },
    })
    const acks = await processIntents(
      baseParams([{ id: 'i9', type: 'PAY_CASH', payload: { orderId: 'order-5', amountCents: 25000, tipCents: 2500 } }]),
    )
    expect(orderMobileService.payCashOrder).toHaveBeenCalledWith(VENUE, 'order-5', {
      amount: 25000,
      tip: 2500,
      staffId: STAFF,
      idempotencyKey: 'i9',
    })
    expect(acks[0]).toMatchObject({ status: 'ACKED', result: { paymentId: 'pay-1' } })
  })

  it('rechazo de negocio del delegado → REJECTED, nunca excepción del batch', async () => {
    ;(orderMobileService.payCashOrder as jest.Mock).mockRejectedValue(new Error('La orden ya está pagada'))
    const acks = await processIntents(
      baseParams([{ id: 'i10', type: 'PAY_CASH', payload: { orderId: 'order-6', amountCents: 100 } }]),
    )
    expect(acks[0]).toMatchObject({ status: 'REJECTED', message: 'La orden ya está pagada' })
  })

  it('APPLY_DISCOUNT delega con orderId resuelto y devuelve versión fresca', async () => {
    ;(prisma.posSyncIntent.findFirst as jest.Mock).mockResolvedValue({ resultJson: { orderId: 'order-10' } })
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ version: 4 })
    const acks = await processIntents(
      baseParams([{ id: 'i12', type: 'APPLY_DISCOUNT', payload: { localOrderId: 'local-D', discountId: 'disc-1' } }]),
    )
    expect(orderMobileService.applyOrderDiscount).toHaveBeenCalledWith(VENUE, 'order-10', 'disc-1', STAFF)
    expect(acks[0]).toMatchObject({ status: 'ACKED', result: { orderId: 'order-10', version: 4 } })
  })

  it('MOVE_ORDER a mesa que se ocupó mientras tanto → REJECTED de negocio, no crash', async () => {
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ version: 1, tableId: 't1', servedById: STAFF })
    const tableService = jest.requireMock('@/services/tpv/table.tpv.service')
    ;(tableService.moveOrderToTable as jest.Mock).mockRejectedValue(new Error('La mesa destino está ocupada'))
    const acks = await processIntents(
      baseParams([{ id: 'i13', type: 'MOVE_ORDER', payload: { orderId: 'order-11', targetTableId: 't9' } }]),
    )
    expect(acks[0]).toMatchObject({ status: 'REJECTED', message: 'La mesa destino está ocupada' })
  })

  it('CLEAR_TABLE de mesa ajena con propiedad encendida → TABLE_OWNED_BY_OTHER', async () => {
    ;(tableOwnership.isTableOwnershipEnforced as jest.Mock).mockResolvedValue(true)
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({
      servedById: 'staff-otro',
      servedBy: { firstName: 'Juan', lastName: 'Pérez' },
    })
    const acks = await processIntents(baseParams([{ id: 'i14', type: 'CLEAR_TABLE', payload: { tableId: 't1' } }]))
    expect(acks[0]).toMatchObject({ status: 'REJECTED', errorCode: 'TABLE_OWNED_BY_OTHER' })
  })

  it('UPDATE_DETAILS y CANCEL_ORDER delegan en el mismo servicio que online', async () => {
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ version: 2, tableId: 't1', servedById: STAFF })
    const acks = await processIntents(
      baseParams([
        { id: 'i15', seq: 1, type: 'UPDATE_DETAILS', payload: { orderId: 'order-12', name: 'Cumpleaños', covers: 6 } },
        { id: 'i16', seq: 2, type: 'CANCEL_ORDER', payload: { orderId: 'order-12', reason: 'Cliente se fue' } },
      ]),
    )
    expect(orderMobileService.updateOrderDetails).toHaveBeenCalled()
    expect(orderMobileService.cancelOrder).toHaveBeenCalledWith(VENUE, 'order-12', 'Cliente se fue', STAFF)
    expect(acks.map(a => a.status)).toEqual(['ACKED', 'ACKED'])
  })

  it('carrera P2002 al persistir → devuelve el ack del ganador', async () => {
    ;(tableService.assignTable as jest.Mock).mockResolvedValue({ order: { id: 'order-7', version: 1 }, isNewOrder: false })
    ;(prisma.posSyncIntent.create as jest.Mock).mockRejectedValue({ code: 'P2002' })
    ;(prisma.posSyncIntent.findUnique as jest.Mock)
      .mockResolvedValueOnce(null) // dedup inicial: no existe
      .mockResolvedValueOnce({ status: 'ACKED', errorCode: null, resultJson: { orderId: 'order-7' } }) // relectura tras P2002
    const acks = await processIntents(baseParams([{ id: 'i11', type: 'OPEN_TABLE', payload: { tableId: 't3' } }]))
    expect(acks).toHaveLength(1)
    expect(acks[0]).toMatchObject({ status: 'ACKED', result: { orderId: 'order-7' } })
  })
})
