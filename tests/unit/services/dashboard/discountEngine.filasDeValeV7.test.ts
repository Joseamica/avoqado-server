/**
 * Tarjeta na24531d (fase 1, v5.1; Codex r6 #1): las filas espejo que nacen al cobrar vales V7 llevan la marca `deValeV7` y son SÓLO
 * reporte. Los usos del descuento quedan exactamente como antes del arreglo: los topes por cliente no las cuentan y el motor no las toma
 * por «ya aplicado» (la caja puede aplicar los mismos descuentos que hoy, y el motor sube `currentUses` cuando lo aplica, como hoy).
 * Una fila sin la marca (Mostrador, la TPV) sigue contando igual que siempre.
 */
import { Decimal } from '@prisma/client/runtime/library'
import { DiscountScope, DiscountType } from '@prisma/client'

import {
  applyDiscountToOrder,
  evaluateAutomaticDiscounts,
  getCustomerDiscounts,
  getEligibleDiscounts,
} from '../../../../src/services/dashboard/discountEngine.service'
import { sqlDeDescuentos } from '../../../../src/services/public/customerPortal.public.service'
import { prismaMock } from '../../../__helpers__/setup'

const MARCADA = { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones: { 'oi-1': 1000 }, deValeV7: true }
const EXCLUYE_LA_MARCA = /reparto"?\s*->>\s*'deValeV7'\)?\s+IS DISTINCT FROM 'true'/

const descuento = (overrides: Record<string, any> = {}) => ({
  id: 'd1',
  venueId: 'venue-123',
  name: '10 %',
  type: 'PERCENTAGE' as DiscountType,
  value: new Decimal(10),
  scope: 'ORDER' as DiscountScope,
  targetItemIds: [],
  targetCategoryIds: [],
  targetModifierIds: [],
  targetModifierGroupIds: [],
  customerGroupId: null,
  isAutomatic: true,
  priority: 0,
  minPurchaseAmount: null,
  maxDiscountAmount: null,
  minQuantity: null,
  buyQuantity: null,
  getQuantity: null,
  getDiscountPercent: null,
  buyItemIds: [],
  getItemIds: [],
  validFrom: null,
  validUntil: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  maxTotalUses: null,
  maxUsesPerCustomer: null,
  currentUses: 0,
  isStackable: false,
  stackPriority: 0,
  requiresApproval: false,
  compReason: null,
  applyBeforeTax: true,
  active: true,
  ...overrides,
})

const sqlDe = (llamada: any[]) => (Array.isArray(llamada[0]) ? llamada[0].join('?') : (llamada[0]?.strings ?? []).join('?'))

describe('Filas de vales V7 (marcadas): fuera de los topes por cliente y de «ya aplicado» (na24531d)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('topes por cliente: cuentan como antes del arreglo', () => {
    it('🔴 getEligibleDiscounts cuenta los usos de la clienta SIN las filas marcadas (y una fila sin marca cuenta como hoy)', async () => {
      prismaMock.discount.findMany.mockResolvedValue([descuento({ maxUsesPerCustomer: 1 })])
      prismaMock.$queryRaw.mockResolvedValueOnce([{ n: 0 }])

      expect(await getEligibleDiscounts('venue-123', 'customer-123')).toHaveLength(1)

      const [llamada] = prismaMock.$queryRaw.mock.calls
      expect(sqlDe(llamada)).toMatch(EXCLUYE_LA_MARCA)
      expect(llamada.slice(1)).toEqual(['d1', 'customer-123'])
    })

    it('regresión: con sus usos (sin marca) en el tope, el descuento ya no se ofrece', async () => {
      prismaMock.discount.findMany.mockResolvedValue([descuento({ maxUsesPerCustomer: 3 })])
      prismaMock.$queryRaw.mockResolvedValueOnce([{ n: 3 }])

      expect(await getEligibleDiscounts('venue-123', 'customer-123')).toHaveLength(0)
    })

    it('🔴 getCustomerDiscounts (tope de la asignación) excluye las filas marcadas de sus ventas', async () => {
      prismaMock.customerDiscount.findMany.mockResolvedValue([
        {
          id: 'cd-1',
          customerId: 'customer-123',
          discountId: 'd1',
          active: true,
          validFrom: null,
          validUntil: null,
          maxUses: null,
          usageCount: 0,
          discount: descuento({ maxUsesPerCustomer: 1 }),
        },
      ])
      prismaMock.$queryRaw.mockResolvedValueOnce([])

      expect(await getCustomerDiscounts('venue-123', 'customer-123')).toHaveLength(1)
      expect(sqlDe(prismaMock.$queryRaw.mock.calls[0])).toMatch(EXCLUYE_LA_MARCA)
    })

    it('🔴 el portal de la clienta («Mis descuentos») cuenta sus usos sin las filas marcadas', () => {
      const sql = sqlDeDescuentos('venue-123', 'customer-123', new Date(), null, 20)
      expect(sql.strings.join('?')).toMatch(EXCLUYE_LA_MARCA)
    })
  })

  describe('«ya aplicado»: la caja aplica lo mismo que antes del arreglo', () => {
    const cuenta = (orderDiscounts: any[]) => ({
      id: 'order-123',
      venueId: 'venue-123',
      customerId: null,
      subtotal: new Decimal(100),
      taxAmount: new Decimal(0),
      discountAmount: new Decimal(10),
      tipAmount: new Decimal(0),
      total: new Decimal(90),
      paidAmount: new Decimal(0),
      items: [],
      orderDiscounts,
    })

    it('🔴 el motor sigue ofreciendo un descuento cuya única fila en la cuenta es la marcada del vale', async () => {
      prismaMock.order.findUnique.mockResolvedValue(
        cuenta([{ discountId: 'd1', amount: new Decimal(10), isAutomatic: false, reparto: MARCADA }]) as any,
      )
      prismaMock.discount.findMany.mockResolvedValue([descuento()])

      const resultado = await evaluateAutomaticDiscounts('order-123')

      expect(resultado.map(d => d.discountId)).toEqual(['d1'])
    })

    it('🔴 Codex r7 #1: una cortesía del vale con el motivo del folio anulado no apaga los automáticos (eso es de los folios)', async () => {
      prismaMock.order.findUnique.mockResolvedValue(
        cuenta([
          {
            discountId: 'd-cortesia',
            amount: new Decimal(10),
            isAutomatic: false,
            isComp: true,
            compReason: 'Beneficio regresado a la clienta al anular el folio',
            reparto: MARCADA,
          },
        ]) as any,
      )
      prismaMock.discount.findMany.mockResolvedValue([descuento()])

      expect((await evaluateAutomaticDiscounts('order-123')).map(d => d.discountId)).toEqual(['d1'])
    })

    it('regresión: con una fila SIN marca del mismo descuento, el motor lo da por aplicado (como siempre)', async () => {
      prismaMock.order.findUnique.mockResolvedValue(cuenta([{ discountId: 'd1', amount: new Decimal(10), isAutomatic: true }]) as any)
      prismaMock.discount.findMany.mockResolvedValue([descuento()])

      expect(await evaluateAutomaticDiscounts('order-123')).toHaveLength(0)
    })

    it('🔴 aplicar un descuento calculado no lo rechaza como «ya aplicado» por la fila marcada del vale', async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
      prismaMock.$queryRaw.mockResolvedValue([{ id: 'order-123' }]) // el candado de la cuenta
      prismaMock.order.findUnique.mockResolvedValue(cuenta([{ discountId: 'd1', amount: new Decimal(10), reparto: MARCADA }]) as any)
      prismaMock.discount.findMany.mockResolvedValue([descuento()])
      prismaMock.orderDiscount.create.mockResolvedValue({ id: 'od-2' } as any)
      prismaMock.order.update.mockResolvedValue({} as any)
      prismaMock.discount.update.mockResolvedValue({} as any)
      prismaMock.orderServiceCharge.findMany.mockResolvedValue([])
      prismaMock.orderDiscount.findMany.mockResolvedValue([])
      prismaMock.orderItem.findMany.mockResolvedValue([])

      const resultado = await applyDiscountToOrder('order-123', {
        discountId: 'd1',
        name: '10 %',
        type: 'PERCENTAGE' as DiscountType,
        value: 10,
        amount: 10,
        taxReduction: 0,
        applicableItems: [],
        isAutomatic: true,
        requiresApproval: false,
      })

      expect(resultado).toEqual(expect.objectContaining({ success: true }))
      expect(prismaMock.orderDiscount.create).toHaveBeenCalled()
    })
  })
})
