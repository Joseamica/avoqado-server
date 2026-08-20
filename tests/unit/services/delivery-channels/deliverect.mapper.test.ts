import fs from 'fs'
import path from 'path'
import { OrderSource } from '@prisma/client'
import { parseDeliverectOrder, resolveOrderSource } from '../../../../src/services/delivery-channels/providers/deliverect/deliverect.mapper'

const fixture = fs.readFileSync(path.join(__dirname, '../../../__fixtures__/deliverect/order-webhook.json'))
const link: any = {
  id: 'link1',
  venueId: 'venue1',
  provider: 'DELIVERECT',
  externalLocationId: 'loc-001',
  config: { channelSourceMap: { '7': 'UBER_EATS' } },
}

describe('parseDeliverectOrder', () => {
  // NUEVO — contrato unificado (Tarea 2/3): dinero en STRING DECIMAL, dentro de `payment`.
  it('convierte centavos a pesos según decimalDigits, como string decimal', () => {
    const o = parseDeliverectOrder(fixture, link)
    expect(o.items[0].unitPrice).toBe('45.00')
    // modifier.price ya viene multiplicado por la cantidad del padre (2): $10 × 2 = $20.
    expect(o.items[0].modifiers?.[0].price).toBe('20.00')
    expect(o.payment.tipAmount).toBe('10.00')
  })

  it('payment.saleAmount = payment.amount del canal en pesos (lo que el cliente pagó manda)', () => {
    const o = parseDeliverectOrder(fixture, link)
    expect(o.payment.saleAmount).toBe('140.00')
  })

  it('modifier × cantidad del padre: item con quantity=3, modifier quantity=2 price=$5 → item.total = 3×100 + 5×2×3 = 330 (Fix C4, spec §10.1.4)', () => {
    const p = JSON.parse(fixture.toString())
    p.items = [
      {
        plu: 'PROD-X',
        name: 'Producto X',
        price: 10000, // $100
        quantity: 3,
        subItems: [{ plu: 'MOD-Y', name: 'Modificador Y', price: 500, quantity: 2 }], // $5 c/u, 2 por producto
      },
    ]
    const o = parseDeliverectOrder(Buffer.from(JSON.stringify(p)), link)
    // El modifier de "extra queso"-equivalente aplica a CADA unidad del producto padre
    // (Deliverect: cantidad_modificador × cantidad_producto), no una sola vez.
    expect(o.items[0].modifiers?.[0].price).toBe('15.00') // $5 × 3 (cantidad del padre)
    expect(o.items[0].total).toBe('330.00') // 3×100 + (15×2)
  })

  it('externalId y displayId vienen del canal', () => {
    const o = parseDeliverectOrder(fixture, link)
    expect(o.externalId).toBe('UE-12345-A')
    expect(o.displayId).toBe('A1B2C3')
  })

  it('resuelve el canal real desde config.channelSourceMap', () => {
    const o = parseDeliverectOrder(fixture, link)
    expect(o.source).toBe(OrderSource.UBER_EATS)
  })

  it('payload crudo se preserva en raw', () => {
    const o = parseDeliverectOrder(fixture, link)
    expect((o.raw as any).channelOrderId).toBe('UE-12345-A')
  })

  it('cliente y nota se capturan', () => {
    const o = parseDeliverectOrder(fixture, link)
    expect(o.customer?.name).toBe('Juan Pérez')
    expect(o.customer?.note).toBe('Sin cebolla por favor')
  })

  // ============================================================
  // Deliverect entrega pedidos ya liquidados por la plataforma al comercio (contrato
  // unificado, Tarea 3): externallyPaidSale/Tip = el 100% del reparto; cashDue* siempre
  // '0.00'. El invariante de dinero (assertDeliveryMoneyInvariants) se cumple por
  // construcción, ya que externallyPaidSale/Tip se DERIVAN de saleAmount/merchantFees/tip,
  // no se leen de un campo independiente del proveedor.
  // ============================================================
  it('el reparto de dinero: externallyPaid* = 100%, cashDue* = 0 (Deliverect siempre liquida al comercio)', () => {
    const o = parseDeliverectOrder(fixture, link)
    expect(o.payment.currency).toBe('MXN')
    expect(o.payment.externallyPaidSale).toBe(o.payment.saleAmount)
    // merchantFees en este fixture es 0 (serviceCharge y deliveryCost ambos 0)
    expect(o.payment.merchantFees).toBe('0.00')
    expect(o.payment.externallyPaidTip).toBe(o.payment.tipAmount)
    expect(o.payment.cashDueSale).toBe('0.00')
    expect(o.payment.cashDueTip).toBe('0.00')
  })

  // REGRESIÓN / bordes
  it('canal desconocido → DELIVERY_PLATFORM (fallback, nunca truena)', () => {
    expect(resolveOrderSource(999, link)).toBe(OrderSource.DELIVERY_PLATFORM)
  })
  it('decimalDigits ausente → asume 2', () => {
    const p = JSON.parse(fixture.toString())
    delete p.decimalDigits
    const o = parseDeliverectOrder(Buffer.from(JSON.stringify(p)), link)
    expect(o.items[0].unitPrice).toBe('45.00')
  })
  it('body inválido lanza error legible', () => {
    expect(() => parseDeliverectOrder(Buffer.from('not-json'), link)).toThrow(/payload/i)
  })

  // ============================================================
  // Fix 1 (audit, SECURITY): bounds validation de dinero/cantidad — un payload
  // malformado (aunque HMAC-autenticado) con total/unitPrice negativo crearía una
  // Order/Payment "PAID" con forma de reembolso, saltándose el flujo de refund
  // (permisos/confirm/audit).
  // ============================================================
  // ============================================================
  // Los dos defectos de dinero que la auditoría externa halló el 2026-08-20. Los tests
  // anteriores no los veían: el fixture trae serviceCharge y deliveryCost en CERO, así que
  // el doble conteo era invisible, y nadie probaba un pedido no pagado.
  // ============================================================
  describe('dinero: cargos y pedido no pagado', () => {
    function conPayload(mutate: (p: any) => void): Buffer {
      const p = JSON.parse(fixture.toString())
      mutate(p)
      return Buffer.from(JSON.stringify(p))
    }

    it('🔴 los cargos NO se cuentan dos veces: viajan DENTRO del total', () => {
      // $165 de total con $25 de cargos ⇒ la venta es $140 + $25 de cargos = $165.
      // Antes: saleAmount $165 + merchantFees $25 ⇒ $190 registrados. $25 inventados.
      const body = conPayload(p => {
        p.payment.amount = 16500
        p.serviceCharge = 1000
        p.deliveryCost = 1500
        p.orderIsAlreadyPaid = true
      })
      const o = parseDeliverectOrder(body, link)

      expect(o.payment.saleAmount).toBe('140.00')
      expect(o.payment.merchantFees).toBe('25.00')
      expect(Number(o.payment.saleAmount) + Number(o.payment.merchantFees)).toBe(165)
      expect(o.payment.externallyPaidSale).toBe('165.00') // el total real, no 190
    })

    it('🔴 pedido NO pagado: el dinero queda POR COBRAR, no liquidado', () => {
      // Antes se declaraba pagado siempre ⇒ Payment COMPLETED, orden PAID e inventario
      // descontado de algo que el cliente todavía debía.
      const body = conPayload(p => {
        p.payment.amount = 10000
        p.orderIsAlreadyPaid = false
      })
      const o = parseDeliverectOrder(body, link)

      expect(o.payment.externallyPaidSale).toBe('0.00')
      expect(o.payment.cashDueSale).toBe('100.00')
    })

    it('🔴 sin el flag, se asume NO pagado — nunca al revés', () => {
      const body = conPayload(p => {
        p.payment.amount = 10000
        delete p.orderIsAlreadyPaid
      })
      const o = parseDeliverectOrder(body, link)
      expect(o.payment.cashDueSale).toBe('100.00') // conservador con el dinero
    })

    it('pedido pagado: la plataforma liquidó todo', () => {
      const body = conPayload(p => {
        p.payment.amount = 10000
        p.orderIsAlreadyPaid = true
      })
      const o = parseDeliverectOrder(body, link)
      expect(o.payment.externallyPaidSale).toBe('100.00')
      expect(o.payment.cashDueSale).toBe('0.00')
    })

    it('🔴 cargos MAYORES que el total ⇒ rechaza en vez de inventar el reparto', () => {
      const body = conPayload(p => {
        p.payment.amount = 1000
        p.deliveryCost = 5000
      })
      expect(() => parseDeliverectOrder(body, link)).toThrow(/no se puede determinar sin inventar/)
    })
  })

  describe('bounds validation (Fix 1, audit)', () => {
    function payloadWith(mutate: (p: any) => void): Buffer {
      const p = JSON.parse(fixture.toString())
      mutate(p)
      return Buffer.from(JSON.stringify(p))
    }

    it('total negativo (payment.amount < 0) → throw', () => {
      const body = payloadWith(p => {
        p.payment.amount = -14000
      })
      expect(() => parseDeliverectOrder(body, link)).toThrow(/Deliverect: payload/)
    })

    it('total no finito (payment.amount = "abc") → throw', () => {
      const body = payloadWith(p => {
        p.payment.amount = 'abc'
      })
      expect(() => parseDeliverectOrder(body, link)).toThrow(/Deliverect: payload/)
    })

    it('unitPrice de item no finito (price no numérico) → throw', () => {
      const body = payloadWith(p => {
        p.items[0].price = 'not-a-number'
      })
      expect(() => parseDeliverectOrder(body, link)).toThrow(/Deliverect: payload/)
    })

    it('unitPrice de item negativo (price < 0) → throw', () => {
      const body = payloadWith(p => {
        p.items[0].price = -4500
      })
      expect(() => parseDeliverectOrder(body, link)).toThrow(/Deliverect: payload/)
    })

    it('quantity de item = 0 → throw', () => {
      const body = payloadWith(p => {
        p.items[0].quantity = 0
      })
      expect(() => parseDeliverectOrder(body, link)).toThrow(/Deliverect: payload/)
    })

    it('quantity de item negativa → throw', () => {
      const body = payloadWith(p => {
        p.items[0].quantity = -1
      })
      expect(() => parseDeliverectOrder(body, link)).toThrow(/Deliverect: payload/)
    })

    it('unitPrice de modifier negativo → throw', () => {
      const body = payloadWith(p => {
        p.items[0].subItems[0].price = -1000
      })
      expect(() => parseDeliverectOrder(body, link)).toThrow(/Deliverect: payload/)
    })

    it('unitPrice de modifier no finito → throw', () => {
      const body = payloadWith(p => {
        p.items[0].subItems[0].price = 'not-a-number'
      })
      expect(() => parseDeliverectOrder(body, link)).toThrow(/Deliverect: payload/)
    })

    it('payload válido (fixture original) → NO throw', () => {
      expect(() => parseDeliverectOrder(fixture, link)).not.toThrow()
    })
  })
})
