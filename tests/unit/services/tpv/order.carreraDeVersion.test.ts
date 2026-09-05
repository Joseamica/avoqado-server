/**
 * 🔴 MONEY — dos escrituras sobre la MISMA orden no se pisan en silencio.
 *
 * `applyDiscount` y `voidItems` leen la orden, comprueban que `order.version` es la que la
 * app esperaba, calculan… y escribían `update({ where: { id } })` — por id, SIN volver a
 * mirar la versión. `compItems` ni siquiera pedía versión. Entre la lectura y la escritura
 * otro aparato puede meterle platos a esa misma mesa: el descuento se guarda calculado sobre
 * un subtotal que ya no existe, y el último en escribir borra la cuenta del otro.
 *
 * Es como dos cajeros escribiendo el total en el mismo ticket a la vez. Hallazgo de la
 * auditoría de Codex del 2026-09-03 sobre `c0592e33`; preexistente.
 *
 * El arreglo NO cambia el contrato con las apps: la escritura lleva la versión que ESTA
 * función leyó (`where: { id, version }`), y si nadie la encuentra —porque alguien la movió
 * debajo— Prisma devuelve P2025 y se responde el MISMO 409 que las apps ya manejan. La
 * transacción se aborta entera, así que tampoco quedan filas de cargo recalculadas contra un
 * total que nunca se escribió.
 *
 * Un error visible y raro contra un número equivocado e invisible.
 */

import { Decimal } from '@prisma/client/runtime/library'

jest.mock('@/utils/prismaClient', () => {
  const mockPrismaObj: any = {
    order: { findUnique: jest.fn(), update: jest.fn() },
    orderItem: { update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
    orderAction: { create: jest.fn() },
    orderDiscount: { findMany: jest.fn() },
    orderServiceCharge: { findMany: jest.fn(), update: jest.fn() },
    orderCustomer: { deleteMany: jest.fn() },
    staff: { findUnique: jest.fn() },
  }
  mockPrismaObj.__insideTx = false
  mockPrismaObj.$transaction = jest.fn(async (callback: any) => {
    mockPrismaObj.__insideTx = true
    try {
      return await callback(mockPrismaObj)
    } finally {
      mockPrismaObj.__insideTx = false
    }
  })
  return { __esModule: true, default: mockPrismaObj }
})

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null) },
}))
jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({ serializedInventoryService: {} }))
jest.mock('@/services/serialized-inventory/simRegistration.service', () => ({ simRegistrationService: {} }))
jest.mock('@/services/modules/module.service', () => ({ moduleService: {}, MODULE_CODES: {} }))
jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  deductInventoryForProduct: jest.fn(),
  getProductInventoryMethod: jest.fn(),
}))
jest.mock('@/services/referrals/referralRefund.service', () => ({ onOrderCancelled: jest.fn() }))

import prisma from '@/utils/prismaClient'
import { ConflictError } from '@/errors/AppError'
import { compItems, applyDiscount, voidItems } from '@/services/tpv/order.tpv.service'

const mockPrisma = prisma as any
const VENUE_ID = 'venue-1'
const ORDER_ID = 'order-cas'
const STAFF_ID = 'staff-1'

/** La orden tal como la LEYÓ el servicio: versión 7. */
function orden(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    orderNumber: 'T-007',
    venueId: VENUE_ID,
    paymentStatus: 'PENDING',
    status: 'OPEN',
    subtotal: new Decimal(100),
    discountAmount: new Decimal(0),
    taxAmount: new Decimal(0),
    serviceChargeAmount: new Decimal(0),
    tipAmount: new Decimal(0),
    total: new Decimal(100),
    paidAmount: new Decimal(0),
    remainingBalance: new Decimal(100),
    version: 7,
    tableId: null,
    items: [
      { id: 'item-1', productName: 'Burger', product: { name: 'Burger' }, sentToKitchenAt: null, total: new Decimal(60) },
      { id: 'item-2', productName: 'Fries', product: { name: 'Fries' }, sentToKitchenAt: null, total: new Decimal(40) },
    ],
    ...overrides,
  }
}

function ordenActualizada() {
  return {
    id: ORDER_ID,
    orderNumber: 'T-007',
    tableId: null,
    table: null,
    items: [],
    payments: [],
    createdBy: null,
    servedBy: null,
    version: 8,
  }
}

/** Lo que Prisma devuelve cuando el `where` del update no encuentra la fila. */
const prismaNoEncontroLaFila = () => Object.assign(new Error('Record to update not found.'), { code: 'P2025' })

/** El `where` de la ÚLTIMA escritura en `Order`. */
function whereDelUpdate(): Record<string, any> {
  const calls = mockPrisma.order.update.mock.calls
  return calls[calls.length - 1][0].where
}

const descuento = { type: 'FIXED_AMOUNT' as const, value: 20, reason: 'Promo', staffId: STAFF_ID, expectedVersion: 7 }
const anular = (ids: string[]) => ({ itemIds: ids, reason: 'Plato equivocado', staffId: STAFF_ID, expectedVersion: 7 })
const cortesia = { itemIds: ['item-1'], reason: 'Comida fría', staffId: STAFF_ID }

beforeEach(() => {
  jest.clearAllMocks()
  mockPrisma.order.findUnique.mockResolvedValue(orden())
  mockPrisma.order.update.mockResolvedValue(ordenActualizada())
  mockPrisma.orderAction.create.mockResolvedValue({})
  mockPrisma.orderItem.update.mockResolvedValue({})
  mockPrisma.orderItem.deleteMany.mockResolvedValue({ count: 1 })
  mockPrisma.orderCustomer.deleteMany.mockResolvedValue({ count: 0 })
  mockPrisma.staff.findUnique.mockResolvedValue({ id: STAFF_ID })
  mockPrisma.orderServiceCharge.findMany.mockResolvedValue([])
  mockPrisma.orderServiceCharge.update.mockResolvedValue({})
})

describe.each([
  ['applyDiscount', () => applyDiscount(VENUE_ID, ORDER_ID, descuento)],
  ['voidItems', () => voidItems(VENUE_ID, ORDER_ID, anular(['item-1']))],
  ['compItems', () => compItems(VENUE_ID, ORDER_ID, cortesia)],
])('%s — la escritura exige la versión que se LEYÓ', (_nombre, ejecutar) => {
  it('escribe con `where: { id, version }`, no sólo por id', async () => {
    await ejecutar()

    // La versión 7 es la que la función leyó al inicio. Sin ella en el where, otra escritura
    // que entre entre la lectura y ésta se pisa en silencio.
    expect(whereDelUpdate()).toEqual({ id: ORDER_ID, version: 7 })
  })

  it('🔴 si alguien movió la orden debajo, responde 409 — nunca sobrescribe', async () => {
    mockPrisma.order.update.mockRejectedValue(prismaNoEncontroLaFila())

    await expect(ejecutar()).rejects.toBeInstanceOf(ConflictError)
  })

  it('un error de Prisma que NO es «fila no encontrada» se propaga tal cual (no se disfraza de 409)', async () => {
    const otroError = Object.assign(new Error('unique constraint'), { code: 'P2002' })
    mockPrisma.order.update.mockRejectedValue(otroError)

    await expect(ejecutar()).rejects.toBe(otroError)
  })

  it('regresión: el camino normal sigue escribiendo una sola vez y devolviendo la orden', async () => {
    const resultado = await ejecutar()

    expect(mockPrisma.order.update).toHaveBeenCalledTimes(1)
    expect(resultado.id).toBe(ORDER_ID)
  })
})

describe('voidItems — la eliminación de platos entra a la MISMA transacción', () => {
  /**
   * Antes, `orderItem.deleteMany` corría ANTES de abrir la transacción: si el CAS de la
   * orden fallaba, los platos ya estaban borrados y los totales quedaban viejos — un estado
   * a medias en el dinero. Ahora un 409 deja los platos donde estaban.
   */
  it('borra los platos DENTRO de la transacción, no antes', async () => {
    let borradoDentro: boolean | undefined
    mockPrisma.orderItem.deleteMany.mockImplementation(async () => {
      borradoDentro = mockPrisma.__insideTx
      return { count: 1 }
    })

    await voidItems(VENUE_ID, ORDER_ID, anular(['item-1']))

    expect(borradoDentro).toBe(true)
  })
})
