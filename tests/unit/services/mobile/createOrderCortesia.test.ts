import { Prisma } from '@prisma/client'
import { buildOrderItemsData, createOrderWithItems } from '@/services/mobile/order.mobile.service'
import { sincronizarRepartos } from '@/services/shared/repartoDescuentoTx'
import { BadRequestError, ForbiddenError } from '@/errors/AppError'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/services/venueSalesGuard', () => ({ assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  assertPreparationAuthoringAccess: jest.fn(),
  debeMarcarCocina: jest.fn(),
}))
jest.mock('@/services/shared/repartoDescuentoTx', () => ({
  ...jest.requireActual('@/services/shared/repartoDescuentoTx'),
  sincronizarRepartos: jest.fn(),
}))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

const venueId = 'venue-1'
const staffId = 'seller-1'
const actorId = 'manager-1'
const D = (value: number) => new Prisma.Decimal(value)
const product = { id: 'p1', name: 'Bebida', price: D(100), sku: 'BEB-1', soldByWeight: false, category: { name: 'Bebidas' } }

function input(items: any[], extra: Record<string, unknown> = {}) {
  return { staffId, items, canCompItems: true, performedBy: actorId, ...extra } as any
}

function line(externalId: string, extra: Record<string, unknown> = {}) {
  return { productId: 'p1', quantity: 1, modifierIds: ['m1'], externalId, ...extra }
}

describe('createOrderWithItems — cortesía persistida antes del primer cobro', () => {
  let stored: any

  beforeEach(() => {
    jest.clearAllMocks()
    stored = null
    prismaMock.orderAction = { create: jest.fn() }
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.order.findUnique.mockImplementation(async () => stored)
    prismaMock.staffVenue.findFirst.mockImplementation(async ({ where }: any) => ({
      id: where.staffId === actorId ? 'actor-sv' : 'seller-sv',
      staffId: where.staffId,
      venueId,
      active: true,
    }))
    prismaMock.product.findMany.mockResolvedValue([product])
    prismaMock.modifier.findMany.mockResolvedValue([{ id: 'm1', name: 'Extra', price: D(10) }])
    prismaMock.discount.findMany.mockResolvedValue([])
    prismaMock.shift.findFirst.mockResolvedValue(null)
    prismaMock.order.create.mockImplementation(async ({ data }: any) => {
      stored = {
        ...data,
        id: 'order-1',
        createdAt: new Date(),
        items: data.items.create.map((row: any, k: number) => ({
          ...row,
          id: `oi-${k + 1}`,
          product: row.productId ? product : null,
          modifiers: row.modifiers?.create.map((m: any) => ({ ...m, id: m.modifierId })) ?? [],
        })),
        promotions: [],
      }
      return stored
    })
  })

  it('dos bebidas con extras de $220 quedan en $0 con flags, razón, espejo, acción y auditoría', async () => {
    const items = ['local-1', 'local-2'].map(id => line(id, { isCortesia: true, cortesiaReason: '  Invitación  ' }))
    const result = await createOrderWithItems(venueId, input(items))

    expect(result.total).toBe(0)
    expect(result.subtotal).toBe(220)
    expect(result.discountAmount).toBe(220)
    expect(Number(stored.remainingBalance)).toBe(0)
    expect(result.items).toEqual([
      expect.objectContaining({ externalId: 'local-1', total: 110, discountAmount: 110, isCortesia: true, cortesiaReason: 'Invitación' }),
      expect.objectContaining({ externalId: 'local-2', total: 110, discountAmount: 110, isCortesia: true, cortesiaReason: 'Invitación' }),
    ])
    expect(prismaMock.orderDiscount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        type: 'COMP',
        name: 'Cortesía',
        amount: D(220),
        isComp: true,
        appliedById: 'actor-sv',
        appliedToItemIds: ['oi-1', 'oi-2'],
        reparto: expect.objectContaining({ v: 1, alcance: 'DIRIGIDO', espejo: true }),
      }),
    })
    expect(sincronizarRepartos).toHaveBeenCalledWith(prismaMock, 'order-1')
    expect(prismaMock.orderAction.create).toHaveBeenCalledTimes(2)
    expect(prismaMock.orderAction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ performedById: actorId, actionType: 'COMP' }),
    })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ staffId: actorId, venueId, action: 'ITEM_COMPED' }),
    })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
  })

  it('cortesía parcial deja exactamente el saldo de la bebida no regalada', async () => {
    const result = await createOrderWithItems(
      venueId,
      input([line('local-1', { isCortesia: true, cortesiaReason: 'Invitación' }), line('local-2')]),
    )
    expect(result.total).toBe(110)
    expect(result.discountAmount).toBe(110)
    expect(result.items[0]).toEqual(expect.objectContaining({ isCortesia: true, discountAmount: 110 }))
    expect(result.items[1]).toEqual(expect.objectContaining({ discountAmount: 0 }))
  })

  it.each([
    { quantity: 3, expected: 330 },
    { quantity: 1, weightQuantity: 0.224, expected: 46.74 },
  ])('regala el bruto exacto con cantidad/peso y extras (%j)', async ({ expected, ...changes }) => {
    prismaMock.product.findMany.mockResolvedValue([
      { ...product, price: D(changes.weightQuantity ? 164 : 100), soldByWeight: !!changes.weightQuantity },
    ])
    const result = await createOrderWithItems(
      venueId,
      input([line('local-1', { ...changes, isCortesia: true, cortesiaReason: 'Invitación' })]),
    )
    expect(result.subtotal).toBe(expected)
    expect(result.discountAmount).toBe(expected)
    expect(result.total).toBe(0)
  })

  it('un importe libre también conserva la cortesía y su identidad local', async () => {
    const result = await createOrderWithItems(
      venueId,
      input([{ name: 'Servicio', unitPrice: 22000, quantity: 1, externalId: 'local-1', isCortesia: true, cortesiaReason: 'Invitación' }]),
    )
    expect(result.total).toBe(0)
    expect(result.items[0]).toEqual(expect.objectContaining({ externalId: 'local-1', isCortesia: true, cortesiaReason: 'Invitación' }))
  })

  it('producto e importe libre intercalados conservan la cortesía de SU línea al ordenar la creación', async () => {
    const result = await createOrderWithItems(
      venueId,
      input([
        {
          name: 'Servicio',
          unitPrice: 5000,
          quantity: 1,
          externalId: 'custom-1',
          isCortesia: true,
          cortesiaReason: 'Invitación del servicio',
        },
        line('product-1'),
      ]),
    )
    expect(result.total).toBe(110)
    expect(result.items.find(item => item.externalId === 'product-1')).toEqual(
      expect.objectContaining({ isCortesia: false, discountAmount: 0 }),
    )
    expect(result.items.find(item => item.externalId === 'custom-1')).toEqual(
      expect.objectContaining({ isCortesia: true, discountAmount: 50, cortesiaReason: 'Invitación del servicio' }),
    )
  })

  it('un fallo de auditoría después de crear orden y descuento rechaza la transacción completa', async () => {
    prismaMock.activityLog.create.mockRejectedValueOnce(new Error('audit-write-failed'))
    await expect(
      createOrderWithItems(venueId, input([line('local-1', { isCortesia: true, cortesiaReason: 'Invitación' })])),
    ).rejects.toThrow('audit-write-failed')
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.orderDiscount.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.orderAction.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.discount.updateMany).not.toHaveBeenCalled()
    // El rollback real de Postgres se verifica en QA; el mock acredita que el error no se traga ni devuelve éxito.
  })

  it('una promoción no puede eludir la validación de cortesía llamando directamente al servicio', async () => {
    await expect(
      createOrderWithItems(
        venueId,
        input([
          {
            isCortesia: true,
            cortesiaReason: 'Invitación',
            promotionRef: { promotionId: 'promo', promotionInstanceId: 'instance', selections: [] },
          },
        ]),
      ),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('rechaza cortesía más descuento de catálogo sin consumir el descuento', async () => {
    prismaMock.discount.findMany.mockResolvedValue([{ id: 'd1', venueId, name: 'Rebaja', type: 'PERCENTAGE', value: D(10), active: true }])
    await expect(
      createOrderWithItems(venueId, input([line('local-1', { isCortesia: true, cortesiaReason: 'Invitación', discountId: 'd1' })])),
    ).rejects.toThrow(/cortesía.*descuento|descuento.*cortesía/i)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.discount.updateMany).not.toHaveBeenCalled()
  })

  it.each([undefined, null, '', '   ', 123, {}])('rechaza una razón inválida antes de crear (%j)', async cortesiaReason => {
    await expect(createOrderWithItems(venueId, input([line('local-1', { isCortesia: true, cortesiaReason })]))).rejects.toBeInstanceOf(
      BadRequestError,
    )
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it.each(['true', 1, null, {}])('rechaza un flag de cortesía no booleano (%j)', async isCortesia => {
    await expect(
      createOrderWithItems(venueId, input([line('local-1', { isCortesia, cortesiaReason: 'Invitación' })])),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('una llamada directa sin la autorización de la sesión no puede regalar', async () => {
    await expect(
      createOrderWithItems(
        venueId,
        input([line('local-1', { isCortesia: true, cortesiaReason: 'Invitación' })], { canCompItems: undefined }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('el reintento por externalId acredita la cortesía persistida sin repetir acciones', async () => {
    const request = input([line('local-1', { isCortesia: true, cortesiaReason: 'Invitación' })], { externalId: 'sale-1' })
    const first = await createOrderWithItems(venueId, request)
    const second = await createOrderWithItems(venueId, request)
    expect(second).toEqual(first)
    expect(second.items[0]).toEqual(expect.objectContaining({ isCortesia: true, cortesiaReason: 'Invitación' }))
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.orderDiscount.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.orderAction.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
  })

  it('cruce D2/S3: cortesía de caja A cerrada no nace en turno B y el reintento no duplica efectos', async () => {
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'turno-B' })
    prismaMock.cashDrawerSession.findFirst.mockImplementation(async ({ where }: any) =>
      where.id === 'caja-A' && where.venueId === venueId
        ? { id: 'caja-A', status: 'CLOSED', shiftId: 'turno-A', actualAmount: D(100), closedByStaffId: actorId }
        : null,
    )
    const request = input([line('local-1', { isCortesia: true, cortesiaReason: 'Invitación' })], {
      externalId: 'sale-caja-A',
      isOfflineReplay: true,
      cashDrawerSessionId: 'caja-A',
    })
    const first = await createOrderWithItems(venueId, request)
    expect(stored.shiftId).toBeNull()
    expect(first).toMatchObject({ total: 0, subtotal: 110, discountAmount: 110 })
    expect(first.items[0]).toMatchObject({ externalId: 'local-1', isCortesia: true, cortesiaReason: 'Invitación' })

    // La respuesta perdida se vuelve a pedir cuando ya cambió la caja; el folio manda sobre el contexto del reintento.
    const second = await createOrderWithItems(venueId, { ...request, cashDrawerSessionId: 'caja-B' })
    expect(second).toEqual(first)
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.orderDiscount.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.orderAction.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
  })

  // Regresión: el dinero normal y los escritores compartidos siguen su contrato.
  it('dos bebidas normales con extras siguen costando $220', async () => {
    const result = await createOrderWithItems(venueId, input([line('local-1'), line('local-2')], { canCompItems: undefined }))
    expect(result.total).toBe(220)
    expect(result.discountAmount).toBe(0)
    expect(prismaMock.orderDiscount.create).not.toHaveBeenCalled()
    expect(prismaMock.orderAction.create).not.toHaveBeenCalled()
  })

  it('el helper que usan vales de área no habilita una cortesía recibida por accidente', async () => {
    const result = await buildOrderItemsData(venueId, [line('local-1', { isCortesia: true, cortesiaReason: 'Invitación' })] as any)
    expect(result.itemDiscountTotal).toBe(0)
    expect(result.itemsData[0].isCortesia).not.toBe(true)
  })
})
