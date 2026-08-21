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
import { applyDeliveryRefund } from '@/services/delivery-channels/core/applyDeliveryRefund.service'
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
        items: [
          {
            externalId: 'contrato-propina',
            name: 'Platillo',
            quantity: 1,
            unitPrice: '150.00',
            total: '150.00',
            modifiers: [],
          },
        ],
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

    it('🔴 LLEGA A LA COCINA: el pedido crea su ticket de KDS', async () => {
      // Sin esto la integración es un árbol cayendo en un bosque vacío: aceptamos el pedido
      // en el marketplace —el cliente esperando comida, el reloj del proveedor corriendo—
      // y la cocina no ve NADA. Comprobado contra la base el 2026-08-20: el pedido real de
      // Uber (#77645) estaba CONFIRMED y tenía CERO filas de KDS.
      //
      // El KDS lee de su propia tabla (`KdsOrder`), no de `Order`, y hasta hoy sólo se
      // llenaba cuando un cliente llamaba el endpoint a mano. Un pedido de marketplace no
      // tiene a nadie que lo llame.
      //
      // [mercado] Square: los pedidos de apps de delivery "are all sent to and fulfilled
      // directly from the kitchen" — lo configurable es QUÉ pantalla los muestra, no si
      // llegan. Toast: los de terceros "approve automatically and skip the approval tab", y
      // el auto-firing hay que tenerlo prendido para recibir pedidos en línea. En los dos,
      // el default es que llegan.
      const { order } = await ingestDeliveryOrder(hacerPedido(), obtenerLink())

      const ticket = await prisma.kdsOrder.findFirst({ where: { orderId: order.id }, include: { items: true } })
      expect(ticket).not.toBeNull()
      expect(ticket!.orderNumber).toBe(order.orderNumber)
      expect(ticket!.items.length).toBeGreaterThan(0)
    })

    it('reingerir NO duplica el ticket de cocina: la comanda se prepara una vez', async () => {
      const p = hacerPedido()
      const { order } = await ingestDeliveryOrder(p, obtenerLink())
      await ingestDeliveryOrder(p, obtenerLink())

      expect(await prisma.kdsOrder.count({ where: { orderId: order.id } })).toBe(1)
    })

    it('🔴 LA COMISIÓN del marketplace queda registrada en el cobro', async () => {
      // Sin esto los cortes, reportes y contabilidad muestran la venta COMPLETA como
      // ingreso: $100 de Uber se ven como $100 cuando el proveedor deposita ~$70. El dueño
      // cree ganar 30% más de lo que gana, en CADA pedido, y lo descubre cuando el depósito
      // no cuadra con sus números.
      //
      // El porcentaje vive en el tipo de pago del canal (`VenueTenderType.commissionPercent`,
      // cuyo comentario en el schema dice literalmente "e.g. Uber ~30%") y el dueño lo edita
      // en la pantalla de tipos de pago. Aquí se CONGELA en el cobro: si mañana renegocia,
      // los pedidos viejos deben seguir contando lo que de verdad les costó.
      const link = obtenerLink()
      const tender = await prisma.venueTenderType.findFirstOrThrow({ where: { venueId: link.venueId } })
      await prisma.venueTenderType.update({ where: { id: tender.id }, data: { commissionPercent: '30.00' } })

      const { order } = await ingestDeliveryOrder(hacerPedido(), link)
      const pago = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } })

      expect(pago.tenderCommissionPercent?.toString()).toBe('30')
      // 30% de lo que la plataforma liquidó, redondeado al centavo.
      const esperado = pago.amount.mul(30).div(100).toDecimalPlaces(2)
      expect(pago.tenderCommissionAmount?.toString()).toBe(esperado.toString())

      await prisma.venueTenderType.update({ where: { id: tender.id }, data: { commissionPercent: null } })
    })

    it('sin comisión configurada NO se inventa un porcentaje', async () => {
      // Cada comercio negocia el suyo. Poner 30% "porque suele ser" haría que los reportes
      // mintieran en la dirección contraria, y con la misma confianza.
      const { order } = await ingestDeliveryOrder(hacerPedido(), obtenerLink())
      const pago = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } })

      expect(pago.tenderCommissionPercent).toBeNull()
      expect(pago.tenderCommissionAmount).toBeNull()
    })

    it('🔴 un REEMBOLSO del proveedor NETEA la venta, y no la borra', async () => {
      // La API de pedidos NUNCA reporta reembolsos ("Refunds/chargebacks appear only in
      // Reporting", guía de Uber): sin esto, el dinero se descuenta del depósito del comercio
      // y en Avoqado la venta sigue contando completa.
      //
      // 🔴 Y NO es una cancelación: la comida SÍ se hizo y se entregó, el cliente se quejó
      // después. La venta ocurrió —tuvo su costo, su inventario, su comisión— así que se
      // NETEA con un cobro negativo, no se borra. Borrarla escondería una venta real.
      const p = hacerPedido()
      const { order } = await ingestDeliveryOrder(p, obtenerLink())
      const antes = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id, type: 'REGULAR' } })

      const r = await applyDeliveryRefund({
        externalOrderId: p.externalId,
        provider: 'UBER_EATS',
        montoDevuelto: '40.00',
        motivo: 'prueba',
      })
      expect(r.outcome).toBe('APPLIED')

      const devolucion = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id, type: 'REFUND' } })
      expect(devolucion.amount.toString()).toBe('-40') // negativo: los reportes lo netean
      // Hereda la semántica del cobro original: este dinero TAMPOCO sale del cajón, lo
      // descuenta el proveedor de su depósito. Sin heredarlo, el arqueo pediría un efectivo
      // que nunca estuvo ahí.
      expect(devolucion.fundsFlow).toBe(antes.fundsFlow)
      expect(devolucion.tenderTypeId).toBe(antes.tenderTypeId)
      // 🔴 La comisión NO se hereda: que el proveedor devuelva el dinero al cliente no
      // significa que le regrese su 30% al comercio.
      expect(devolucion.tenderCommissionAmount).toBeNull()
      // La venta original sigue existiendo: ocurrió de verdad.
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).not.toBe('CANCELLED')
    })

    it('🔴 IDEMPOTENTE: el mismo reembolso dos veces no resta doble', async () => {
      // El reporte se pide a diario y los rangos se traslapan: el MISMO reembolso llega
      // muchas veces. Sin idempotencia, el ingreso del comercio se hundiría solo, un poco
      // cada día, sin que nada fallara.
      const p = hacerPedido()
      const { order } = await ingestDeliveryOrder(p, obtenerLink())
      const args = { externalOrderId: p.externalId, provider: 'UBER_EATS' as const, montoDevuelto: '25.00', motivo: 'x' }

      expect((await applyDeliveryRefund(args)).outcome).toBe('APPLIED')
      expect((await applyDeliveryRefund(args)).outcome).toBe('ALREADY_APPLIED')
      expect(await prisma.payment.count({ where: { orderId: order.id, type: 'REFUND' } })).toBe(1)
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
        items: [
          {
            externalId: 'contrato-descuadre',
            name: 'Platillo',
            quantity: 1,
            unitPrice: '100.00',
            total: '100.00',
            modifiers: [],
          },
        ],
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

      // El mensaje importa: un test que sólo exige `DeliveryMoneyMismatchError` pasa aunque
      // reviente por OTRA razón (así estaba: los renglones no cuadraban con la venta y el
      // reparto ni se llegaba a evaluar). Se exige el motivo, no la familia del error.
      await expect(ingestDeliveryOrder(malo, link)).rejects.toThrow(/venta no cuadra/i)
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
        items: [
          {
            externalId: 'contrato-mixto',
            name: 'Platillo',
            quantity: 1,
            unitPrice: '200.00',
            total: '200.00',
            modifiers: [],
          },
        ],
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
