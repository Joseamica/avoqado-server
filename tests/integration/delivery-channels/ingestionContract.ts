/**
 * EL CONTRATO DE INGESTA: lo que TODO proveedor de delivery debe cumplir.
 *
 * No es un test más — es la definición de "integrado". Un adaptador nuevo (Rappi, DiDi,
 * Deliverect migrado) está terminado cuando pasa esta suite completa, y no antes. Eso es lo
 * que convierte "agregar un proveedor" en una semana en vez de tres: no hay que re-descubrir
 * qué probar ni re-escribir los casos.
 *
 * Se invoca desde el test de cada proveedor, con SU forma de construir un pedido:
 *
 *     runIngestionContract('Rappi', hacerPedidoRappi, () => link)
 *
 * No es un archivo `.test.ts` a propósito: exporta una función, no corre solo.
 */
import { PaymentFundsFlow, type DeliveryChannelLink } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { DeliveryMoneyMismatchError } from '@/services/delivery-channels/core/money'
import type { NormalizedDeliveryOrder } from '@/services/delivery-channels/core/types'

/**
 * @param nombre        Cómo se llama el proveedor en la salida de los tests.
 * @param hacerPedido   Construye un pedido normalizado de ESE proveedor. Debe aceptar
 *                      overrides para que el contrato pueda torcerlo (dinero que no cuadra,
 *                      producto inexistente…). Cada llamada debe producir un `externalId`
 *                      distinto, o la idempotencia haría fallar los casos siguientes.
 * @param obtenerLink   El `DeliveryChannelLink` del proveedor, ya creado por el `beforeAll`
 *                      del test que invoca. Se pasa como función porque en ese momento
 *                      todavía no existe.
 */
export function runIngestionContract(
  nombre: string,
  hacerPedido: (overrides?: Partial<NormalizedDeliveryOrder>) => NormalizedDeliveryOrder,
  obtenerLink: () => DeliveryChannelLink,
): void {
  describe(`CONTRATO de ingesta — ${nombre}`, () => {
    it('el folio lleva el prefijo del proveedor: dos marketplaces pueden repetir número', async () => {
      const p = hacerPedido()
      const { order } = await ingestDeliveryOrder(p, obtenerLink())
      expect(order.externalId).toBe(`${obtenerLink().provider}:${p.externalId}`)
    })

    it('sin mesero y sin turno: nadie atendió esta venta en persona', async () => {
      const { order } = await ingestDeliveryOrder(hacerPedido(), obtenerLink())
      expect(order.servedById).toBeNull()
      expect(order.shiftId).toBeNull()
    })

    it('🔴 la propina NO entra en el total ni en Payment.amount', async () => {
      const p = hacerPedido({
        payment: {
          currency: 'MXN',
          saleAmount: '150.00',
          merchantFees: '0.00',
          tipAmount: '25.00',
          externallyPaidSale: '150.00',
          externallyPaidTip: '25.00',
          cashDueSale: '0.00',
          cashDueTip: '0.00',
        },
      })
      const { order } = await ingestDeliveryOrder(p, obtenerLink())

      expect(order.total.toString()).toBe('150') // venta, SIN propina
      expect(order.tipAmount.toString()).toBe('25')

      const pago = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } })
      expect(pago.amount.toString()).toBe('150')
      expect(pago.tipAmount.toString()).toBe('25')
    })

    it('🔴 el dinero de la plataforma NO cuenta como efectivo del cajón', async () => {
      // `fundsFlow` es la única autoridad de "¿lo deposita Avoqado?" (tenderSemantics).
      // Sin él, cada pedido de delivery inflaría el efectivo que el cajero debe entregar.
      const { order } = await ingestDeliveryOrder(hacerPedido(), obtenerLink())
      const pago = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } })
      expect(pago.fundsFlow).toBe(PaymentFundsFlow.EXTERNAL_RECORDED)
      expect(pago.tenderTypeId).not.toBeNull() // tender del canal, auto-provisionado
    })

    it('IDEMPOTENTE: el mismo pedido dos veces no duplica venta ni cobro', async () => {
      const p = hacerPedido()
      const a = await ingestDeliveryOrder(p, obtenerLink())
      const b = await ingestDeliveryOrder(p, obtenerLink())

      expect(b.order.id).toBe(a.order.id)
      expect(b.created).toBe(false)
      expect(await prisma.payment.count({ where: { orderId: a.order.id } })).toBe(1)
    })

    it('🔴 RECHAZA el dinero que no cuadra, sin escribir nada', async () => {
      const link = obtenerLink()
      const antes = await prisma.order.count({ where: { venueId: link.venueId } })
      const malo = hacerPedido({
        payment: {
          currency: 'MXN',
          saleAmount: '100.00',
          merchantFees: '0.00',
          tipAmount: '0.00',
          externallyPaidSale: '90.00', // no cuadra: faltan $10
          externallyPaidTip: '0.00',
          cashDueSale: '0.00',
          cashDueTip: '0.00',
        },
      })

      await expect(ingestDeliveryOrder(malo, link)).rejects.toThrow(DeliveryMoneyMismatchError)
      expect(await prisma.order.count({ where: { venueId: link.venueId } })).toBe(antes)
    })

    it('un producto que no resuelve entra igual: el pedido NUNCA se pierde', async () => {
      const p = hacerPedido({
        items: [
          {
            externalId: `fantasma-${Date.now()}`,
            name: 'Producto Fantasma',
            quantity: 1,
            unitPrice: '50.00',
            total: '50.00',
            modifiers: [],
          },
        ],
        payment: {
          currency: 'MXN',
          saleAmount: '50.00',
          merchantFees: '0.00',
          tipAmount: '0.00',
          externallyPaidSale: '50.00',
          externallyPaidTip: '0.00',
          cashDueSale: '0.00',
          cashDueTip: '0.00',
        },
      })
      const { order } = await ingestDeliveryOrder(p, obtenerLink())
      const items = await prisma.orderItem.findMany({ where: { orderId: order.id } })

      expect(items).toHaveLength(1)
      expect(items[0].productName).toBe('Producto Fantasma')
    })

    it('la cuenta queda cuadrada: lo pagado y lo pendiente coinciden con el reparto', async () => {
      const p = hacerPedido({
        payment: {
          currency: 'MXN',
          saleAmount: '200.00',
          merchantFees: '0.00',
          tipAmount: '0.00',
          externallyPaidSale: '120.00',
          externallyPaidTip: '0.00',
          cashDueSale: '80.00', // pago mixto: parte plataforma, parte contra entrega
          cashDueTip: '0.00',
        },
      })
      const { order } = await ingestDeliveryOrder(p, obtenerLink())

      expect(order.paidAmount.toString()).toBe('120')
      expect(order.remainingBalance.toString()).toBe('80')
      expect(order.paymentStatus).toBe('PARTIAL') // ni PAID ni PENDING: debe algo
    })
  })
}
