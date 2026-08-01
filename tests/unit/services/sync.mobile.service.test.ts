/**
 * Reducer de intents offline (Corte D) — garantías núcleo:
 * 1. Idempotencia: intent repetido devuelve el ack guardado SIN re-aplicar.
 * 2. Determinismo: tipo desconocido / payload inválido → REJECTED estructurado.
 * 3. Identidad local: localOrderId se resuelve dentro del batch y desde BD.
 * 4. Mismas reglas que online: TABLE_SERVICE gating y propiedad de mesa.
 * 5. Carrera de persistencia (P2002) → devuelve el ack del ganador.
 */

import { processIntents, requiredPermissionForIntent } from '@/services/mobile/sync.mobile.service'
import prisma from '@/utils/prismaClient'
import * as tableService from '@/services/tpv/table.tpv.service'
import * as orderTpvService from '@/services/tpv/order.tpv.service'
import * as orderMobileService from '@/services/mobile/order.mobile.service'
import * as featureAccess from '@/middlewares/checkFeatureAccess.middleware'
import * as tableOwnership from '@/middlewares/checkTableOwnership.middleware'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    posSyncIntent: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    order: { findFirst: jest.fn() },
    orderItem: { findMany: jest.fn() },
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
  splitOrderItems: jest.fn(),
  splitOrderBySeat: jest.fn(),
  mergeOrders: jest.fn(),
}))
jest.mock('@/services/mobile/comp-item.mobile.service', () => ({ compWholeOrder: jest.fn() }))
jest.mock('@/services/mobile/service-charge.mobile.service', () => ({ applyServiceCharge: jest.fn() }))
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({ hasFeatureAccess: jest.fn() }))
jest.mock('@/middlewares/checkTableOwnership.middleware', () => ({
  isTableOwnershipEnforced: jest.fn(),
  staffCanManageAllTables: jest.fn(),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const VENUE = 'venue-1'
const STAFF = 'staff-juan'
const DEVICE = 'device-a'

const baseParams = (intents: any[]) => ({
  venueId: VENUE,
  staffId: STAFF,
  deviceId: DEVICE,
  intents,
  authorizeIntent: jest.fn(() => true),
})

describe('sync.mobile.service processIntents', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.posSyncIntent.findUnique as jest.Mock).mockResolvedValue(null)
    ;(prisma.posSyncIntent.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.posSyncIntent.create as jest.Mock).mockResolvedValue({})
    ;(prisma.posSyncIntent.update as jest.Mock).mockResolvedValue({})
    ;(prisma.posSyncIntent.delete as jest.Mock).mockResolvedValue({})
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

  it('intent PROCESSING reciente → RETRY sin volver a aplicar el efecto', async () => {
    ;(prisma.posSyncIntent.findUnique as jest.Mock).mockResolvedValue({
      venueId: VENUE,
      idempotencyKey: 'i-processing',
      status: 'PROCESSING',
      createdAt: new Date(),
    })

    const acks = await processIntents(baseParams([{ id: 'i-processing', type: 'OPEN_TABLE', payload: { tableId: 't1' } }]))

    expect(acks[0]).toMatchObject({ status: 'RETRY', errorCode: 'INTENT_IN_PROGRESS' })
    expect(tableService.assignTable).not.toHaveBeenCalled()
  })

  it('intent PROCESSING abandonado → OUTCOME_UNKNOWN visible sin repetir el efecto', async () => {
    ;(prisma.posSyncIntent.findUnique as jest.Mock).mockResolvedValue({
      venueId: VENUE,
      idempotencyKey: 'i-unknown',
      status: 'PROCESSING',
      createdAt: new Date(Date.now() - 6 * 60 * 1000),
    })

    const acks = await processIntents(baseParams([{ id: 'i-unknown', type: 'OPEN_TABLE', payload: { tableId: 't1' } }]))

    expect(acks[0]).toMatchObject({ status: 'REJECTED', errorCode: 'OUTCOME_UNKNOWN' })
    expect(tableService.assignTable).not.toHaveBeenCalled()
    expect(prisma.posSyncIntent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'REJECTED', errorCode: 'OUTCOME_UNKNOWN' } }),
    )
  })

  it('secuencia ya utilizada por el dispositivo → STALE_DEVICE_SEQUENCE sin ejecutar', async () => {
    ;(prisma.posSyncIntent.findFirst as jest.Mock).mockResolvedValue({ seq: 12 })

    const acks = await processIntents(baseParams([{ id: 'i-stale-seq', seq: 12, type: 'OPEN_TABLE', payload: { tableId: 't1' } }]))

    expect(acks[0]).toMatchObject({ status: 'REJECTED', errorCode: 'STALE_DEVICE_SEQUENCE' })
    expect(tableService.assignTable).not.toHaveBeenCalled()
    expect(prisma.posSyncIntent.create).not.toHaveBeenCalled()
  })

  it('permiso faltante → REJECTED PERMISSION_DENIED sin aplicar el efecto', async () => {
    const params = baseParams([{ id: 'i-perm', type: 'CANCEL_ORDER', payload: { orderId: 'order-1' } }])
    params.authorizeIntent.mockReturnValue(false)

    const acks = await processIntents(params)

    expect(params.authorizeIntent).toHaveBeenCalledWith(expect.objectContaining({ type: 'CANCEL_ORDER' }), 'orders:cancel')
    expect(acks[0]).toMatchObject({ status: 'REJECTED', errorCode: 'PERMISSION_DENIED' })
    expect(orderMobileService.cancelOrder).not.toHaveBeenCalled()
    expect(prisma.posSyncIntent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PROCESSING' }) }),
    )
    expect(prisma.posSyncIntent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED', errorCode: 'PERMISSION_DENIED' }) }),
    )
  })

  it('actor distinto al autenticado → REJECTED ACTOR_MISMATCH', async () => {
    const params = baseParams([
      { id: 'i-actor', type: 'PAY_CASH', staffId: 'staff-otro', payload: { orderId: 'order-1', amountCents: 100 } },
    ])

    const acks = await processIntents(params)

    expect(acks[0]).toMatchObject({ status: 'REJECTED', errorCode: 'ACTOR_MISMATCH' })
    expect(params.authorizeIntent).not.toHaveBeenCalled()
    expect(orderMobileService.payCashOrder).not.toHaveBeenCalled()
  })

  it('timeout transitorio de Prisma → RETRY y conserva el intent sin persistir rechazo', async () => {
    ;(tableService.assignTable as jest.Mock).mockRejectedValue(Object.assign(new Error('pool timeout'), { code: 'P2024' }))

    const acks = await processIntents(
      baseParams([{ id: 'i-retry-db', type: 'OPEN_TABLE', payload: { tableId: 't1', localOrderId: 'local-db' } }]),
    )

    expect(acks[0]).toMatchObject({ status: 'RETRY', errorCode: 'P2024' })
    expect(prisma.posSyncIntent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PROCESSING' }) }),
    )
    expect(prisma.posSyncIntent.delete).toHaveBeenCalled()
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
      expect.objectContaining({ data: expect.objectContaining({ idempotencyKey: 'i3', localRef: 'local-A', status: 'PROCESSING' }) }),
    )
    expect(prisma.posSyncIntent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACKED' }) }),
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
    // La reserva se elimina: un próximo replay lo re-drive.
    expect(prisma.posSyncIntent.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId_idempotencyKey: { venueId: VENUE, idempotencyKey: 'iA' } } }),
    )
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
    const acks = await processIntents(baseParams([{ id: 'i8', type: 'PAY_CASH', payload: { orderId: 'order-4', amountCents: 10000 } }]))
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

  it('PAY_CASH con tarjeta de terminal ajena conserva el método al reproducirse', async () => {
    // Sin esto, un cobro con terminal externa hecho SIN RED se replay-earía
    // como efectivo y el corte pediría dinero que nunca entró al cajón.
    ;(orderMobileService.payCashOrder as jest.Mock).mockResolvedValue({ paymentId: 'pay-2', orderNumber: 'A-5002' })
    await processIntents(
      baseParams([
        {
          id: 'i9b',
          type: 'PAY_CASH',
          payload: { orderId: 'order-5', amountCents: 10000, method: 'DEBIT_CARD', externalSource: 'Clip' },
        },
      ]),
    )
    expect(orderMobileService.payCashOrder).toHaveBeenCalledWith(
      VENUE,
      'order-5',
      expect.objectContaining({ method: 'DEBIT_CARD', externalSource: 'Clip' }),
    )
  })

  it('PAY_CASH con método inválido → REJECTED, no se cobra nada', async () => {
    ;(orderMobileService.payCashOrder as jest.Mock).mockClear()
    const acks = await processIntents(
      baseParams([{ id: 'i9c', type: 'PAY_CASH', payload: { orderId: 'order-5', amountCents: 100, method: 'BITCOIN' } }]),
    )
    expect(acks[0]).toMatchObject({ status: 'REJECTED', errorCode: 'INVALID_PAYLOAD' })
    expect(orderMobileService.payCashOrder).not.toHaveBeenCalled()
  })

  it('rechazo de negocio del delegado → REJECTED, nunca excepción del batch', async () => {
    ;(orderMobileService.payCashOrder as jest.Mock).mockRejectedValue(new Error('La orden ya está pagada'))
    const acks = await processIntents(baseParams([{ id: 'i10', type: 'PAY_CASH', payload: { orderId: 'order-6', amountCents: 100 } }]))
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

  // ─── SPLIT_ORDER / MERGE_ORDERS (Fase 3, split offline) ───────────────────

  it('SPLIT_ORDER resuelve items por externalId (offline) y mapea el cheque nuevo a newLocalOrderId', async () => {
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ version: 3, tableId: 't1', servedById: STAFF })
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([{ id: 'item-real-1' }, { id: 'item-real-2' }])
    ;(orderMobileService.splitOrderItems as jest.Mock).mockResolvedValue({
      source: { id: 'order-20', orderNumber: 'A-1', total: 100, version: 4 },
      created: { id: 'order-21', orderNumber: 'A-2', total: 60, version: 1 },
    })

    const acks = await processIntents(
      baseParams([
        {
          id: 'i20',
          seq: 1,
          type: 'SPLIT_ORDER',
          payload: {
            orderId: 'order-20',
            // El dispositivo NO conoce los ids de server: manda los externalId
            // deterministas que ADD_ITEMS inyectó cuando no había red.
            itemRefs: [{ externalId: 'sync:i19:0' }, { externalId: 'sync:i19:1' }],
            newLocalOrderId: 'local-split-B',
          },
        },
      ]),
    )

    expect(orderMobileService.splitOrderItems).toHaveBeenCalledWith(VENUE, 'order-20', ['item-real-1', 'item-real-2'], STAFF)
    expect(acks[0]).toMatchObject({
      status: 'ACKED',
      result: { createdOrderId: 'order-21', createdOrderNumber: 'A-2', newLocalOrderId: 'local-split-B' },
    })
  })

  it('🔴 SPLIT_ORDER es TODO-O-NADA: si una referencia no resuelve, NO separa a medias', async () => {
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ version: 3, tableId: 't1', servedById: STAFF })
    // Pidió separar 3 items pero solo 2 existen (uno se borró mientras estaba offline).
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([{ id: 'item-real-1' }, { id: 'item-real-2' }])

    const acks = await processIntents(
      baseParams([
        {
          id: 'i21',
          type: 'SPLIT_ORDER',
          payload: {
            orderId: 'order-22',
            itemRefs: [{ externalId: 'sync:x:0' }, { externalId: 'sync:x:1' }, { externalId: 'sync:x:2' }],
          },
        },
      ]),
    )

    expect(acks[0]).toMatchObject({ status: 'REJECTED', errorCode: 'ITEMS_NOT_RESOLVED' })
    // Lo que importa: jamás se partió el cheque con el subconjunto que sí resolvió.
    expect(orderMobileService.splitOrderItems).not.toHaveBeenCalled()
  })

  it('cadena offline completa: abrir mesa → separar cheque → cobrar el cheque SEPARADO por su id local', async () => {
    ;(tableService.assignTable as jest.Mock).mockResolvedValue({
      order: { id: 'order-30', orderNumber: 'A-9', version: 1 },
      isNewOrder: true,
    })
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ version: 2, tableId: 't1', servedById: STAFF })
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([{ id: 'item-1' }])
    ;(orderMobileService.splitOrderItems as jest.Mock).mockResolvedValue({
      source: { id: 'order-30', orderNumber: 'A-9', total: 80, version: 3 },
      created: { id: 'order-31', orderNumber: 'A-10', total: 40, version: 1 },
    })
    ;(orderMobileService.payCashOrder as jest.Mock).mockResolvedValue({ payment: { id: 'pay-1' } })

    const acks = await processIntents(
      baseParams([
        { id: 'i30', seq: 1, type: 'OPEN_TABLE', payload: { tableId: 't1', localOrderId: 'local-M' } },
        {
          id: 'i31',
          seq: 2,
          type: 'SPLIT_ORDER',
          payload: { localOrderId: 'local-M', itemRefs: [{ externalId: 'sync:i30b:0' }], newLocalOrderId: 'local-M-split' },
        },
        // El dispositivo cobra el cheque separado sin haber visto NUNCA su id real.
        { id: 'i32', seq: 3, type: 'PAY_CASH', payload: { localOrderId: 'local-M-split', amountCents: 4000 } },
      ]),
    )

    expect(acks.map(a => a.status)).toEqual(['ACKED', 'ACKED', 'ACKED'])
    // La prueba de fuego: el cobro aterrizó en el cheque NUEVO (order-31), no en el original.
    expect(orderMobileService.payCashOrder).toHaveBeenCalledWith(
      VENUE,
      'order-31',
      expect.objectContaining({ amount: 4000, idempotencyKey: 'i32', staffId: STAFF }),
    )
  })

  it('MERGE_ORDERS resuelve destino y origen (ambos pueden ser ids locales)', async () => {
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ version: 5, tableId: 't1', servedById: STAFF })
    ;(prisma.posSyncIntent.findFirst as jest.Mock)
      .mockResolvedValueOnce({ resultJson: { orderId: 'order-40' } }) // destino
      .mockResolvedValueOnce({ resultJson: { orderId: 'order-41' } }) // origen

    const acks = await processIntents(
      baseParams([{ id: 'i40', type: 'MERGE_ORDERS', payload: { localOrderId: 'local-T', sourceLocalOrderId: 'local-S' } }]),
    )

    expect(orderMobileService.mergeOrders).toHaveBeenCalledWith(VENUE, 'order-40', 'order-41', STAFF)
    expect(acks[0]).toMatchObject({ status: 'ACKED', result: { orderId: 'order-40', mergedFromOrderId: 'order-41' } })
  })

  it('SPLIT_ORDER sobre mesa de otro mesero → TABLE_OWNED_BY_OTHER (sync no es puerta trasera)', async () => {
    ;(tableOwnership.isTableOwnershipEnforced as jest.Mock).mockResolvedValue(true)
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({
      tableId: 't1',
      servedById: 'staff-maria',
      servedBy: { firstName: 'María', lastName: 'González' },
    })

    const acks = await processIntents(
      baseParams([{ id: 'i41', type: 'SPLIT_ORDER', payload: { orderId: 'order-50', itemRefs: [{ id: 'item-9' }] } }]),
    )

    expect(acks[0]).toMatchObject({ status: 'REJECTED', errorCode: 'TABLE_OWNED_BY_OTHER' })
    expect(orderMobileService.splitOrderItems).not.toHaveBeenCalled()
  })

  it('rechazo de negocio de split (cuenta con descuento) → REJECTED visible, no crash del batch', async () => {
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ version: 1, tableId: 't1', servedById: STAFF })
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([{ id: 'item-1' }])
    ;(orderMobileService.splitOrderItems as jest.Mock).mockRejectedValue(
      new Error('Quita los descuentos (o la recompensa) antes de separar la cuenta: su monto se calculó sobre la cuenta completa.'),
    )

    const acks = await processIntents(
      baseParams([{ id: 'i42', type: 'SPLIT_ORDER', payload: { orderId: 'order-60', itemRefs: [{ id: 'item-1' }] } }]),
    )

    expect(acks[0].status).toBe('REJECTED')
    expect(acks[0].message).toContain('Quita los descuentos')
  })

  it('SPLIT_BY_SEAT mapea CADA cheque creado al id local de SU asiento', async () => {
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ version: 2, tableId: 't1', servedById: STAFF })
    ;(orderMobileService.splitOrderBySeat as jest.Mock).mockResolvedValue({
      source: { id: 'order-70', orderNumber: 'A-1', total: 50, seat: 1 },
      created: [
        { id: 'order-71', orderNumber: 'A-1-S2', seat: 2, total: 30 },
        { id: 'order-72', orderNumber: 'A-1-S3', seat: 3, total: 20 },
      ],
    })

    const acks = await processIntents(
      baseParams([
        {
          id: 'i50',
          seq: 1,
          type: 'SPLIT_BY_SEAT',
          payload: {
            orderId: 'order-70',
            // El asiento 1 se queda en la cuenta original: su uuid sobra y no
            // se mapea. Sobrar es inofensivo; faltar no.
            seatLocalOrderIds: { '1': 'local-s1', '2': 'local-s2', '3': 'local-s3' },
          },
        },
        // Cada asiento se cobra por separado, cada uno por SU id local.
        { id: 'i51', seq: 2, type: 'PAY_CASH', payload: { localOrderId: 'local-s2', amountCents: 3000 } },
        { id: 'i52', seq: 3, type: 'PAY_CASH', payload: { localOrderId: 'local-s3', amountCents: 2000 } },
      ]),
    )

    expect(acks.map(a => a.status)).toEqual(['ACKED', 'ACKED', 'ACKED'])
    // Cada cobro aterrizó en el cheque de SU asiento — no se cruzaron.
    expect(orderMobileService.payCashOrder).toHaveBeenNthCalledWith(1, VENUE, 'order-71', expect.objectContaining({ amount: 3000 }))
    expect(orderMobileService.payCashOrder).toHaveBeenNthCalledWith(2, VENUE, 'order-72', expect.objectContaining({ amount: 2000 }))
  })

  it('mesa abierta OFFLINE: abrir → ronda → separar por externalId, todo por ids locales', async () => {
    ;(tableService.assignTable as jest.Mock).mockResolvedValue({
      order: { id: 'order-80', orderNumber: 'A-20', version: 1 },
      isNewOrder: true,
    })
    ;(orderTpvService.addItemsToOrder as jest.Mock).mockResolvedValue({ id: 'order-80', version: 2 })
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({ version: 2, tableId: 't9', servedById: STAFF })
    // El reducer inyectó `sync:i61:0` y `sync:i61:1` al aplicar el ADD_ITEMS;
    // el dispositivo los conoce porque son deterministas.
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([{ id: 'item-real-A' }])
    ;(orderMobileService.splitOrderItems as jest.Mock).mockResolvedValue({
      source: { id: 'order-80', orderNumber: 'A-20', total: 60, version: 3 },
      created: { id: 'order-81', orderNumber: 'A-21', total: 40, version: 1 },
    })

    const acks = await processIntents(
      baseParams([
        { id: 'i60', seq: 1, type: 'OPEN_TABLE', payload: { tableId: 't9', localOrderId: 'local-Z' } },
        { id: 'i61', seq: 2, type: 'ADD_ITEMS', payload: { localOrderId: 'local-Z', items: [{ productId: 'p1', quantity: 1 }] } },
        {
          id: 'i62',
          seq: 3,
          type: 'SPLIT_ORDER',
          payload: { localOrderId: 'local-Z', itemRefs: [{ externalId: 'sync:i61:0' }], newLocalOrderId: 'local-Z-split' },
        },
      ]),
    )

    expect(acks.map(a => a.status)).toEqual(['ACKED', 'ACKED', 'ACKED'])
    // El split resolvió el cheque por su id LOCAL (nunca existió un id de server
    // en el dispositivo) y los items por su externalId.
    expect(orderMobileService.splitOrderItems).toHaveBeenCalledWith(VENUE, 'order-80', ['item-real-A'], STAFF)
    expect(prisma.orderItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ orderId: 'order-80', OR: [{ externalId: { in: ['sync:i61:0'] } }] }),
      }),
    )
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

  describe('requiredPermissionForIntent — espejo EXACTO de la ruta online equivalente', () => {
    // Regresión: cortesía y descuento tienen permiso propio online; un genérico
    // orders:update dejaría a WAITER/CASHIER comp-ear offline lo que online
    // tienen prohibido (replay ≠ puerta trasera).
    it.each([
      ['OPEN_TABLE', 'orders:create'],
      ['ADD_ITEMS', 'orders:create'],
      ['CLEAR_TABLE', 'orders:create'],
      ['PAY_CASH', 'payments:create'],
      ['CANCEL_ORDER', 'orders:cancel'],
      ['COMP_ORDER', 'orders:comp'],
      ['APPLY_DISCOUNT', 'discounts:apply'],
      ['APPLY_SERVICE_CHARGE', 'orders:update'],
      ['UPDATE_DETAILS', 'orders:update'],
      ['MOVE_ORDER', 'orders:update'],
      ['ASSIGN_ORDER', 'orders:update'],
      ['SPLIT_ORDER', 'orders:update'],
      ['SPLIT_BY_SEAT', 'orders:update'],
      ['MERGE_ORDERS', 'orders:update'],
    ])('%s → %s', (type, permission) => {
      expect(requiredPermissionForIntent(type)).toBe(permission)
    })

    it('COMP_ORDER sin orders:comp → REJECTED PERMISSION_DENIED sin aplicar cortesía', async () => {
      const params = baseParams([{ id: 'i-comp-perm', type: 'COMP_ORDER', payload: { orderId: 'order-1' } }])
      params.authorizeIntent.mockReturnValue(false)

      const acks = await processIntents(params)

      expect(params.authorizeIntent).toHaveBeenCalledWith(expect.objectContaining({ type: 'COMP_ORDER' }), 'orders:comp')
      expect(acks[0]).toMatchObject({ status: 'REJECTED', errorCode: 'PERMISSION_DENIED' })
    })
  })
})
