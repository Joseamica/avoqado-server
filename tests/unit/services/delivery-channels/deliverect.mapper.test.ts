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
  // NUEVO
  it('convierte centavos a pesos según decimalDigits', () => {
    const o = parseDeliverectOrder(fixture, link)
    expect(o.items[0].unitPrice).toBe(45.0)
    expect(o.items[0].modifiers[0].unitPrice).toBe(10.0)
    expect(o.tipAmount).toBe(10.0)
    expect(o.taxAmount).toBe(19.31)
  })
  it('total = payment.amount en pesos (lo que el cliente pagó manda)', () => {
    const o = parseDeliverectOrder(fixture, link)
    expect(o.total).toBe(140.0)
  })
  it('subtotal = suma de items+modifiers en pesos', () => {
    const o = parseDeliverectOrder(fixture, link)
    // 2×45 + 1×10 (modifier) + 30 = 130
    expect(o.subtotal).toBe(130.0)
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

  // REGRESIÓN / bordes
  it('canal desconocido → DELIVERY_PLATFORM (fallback, nunca truena)', () => {
    expect(resolveOrderSource(999, link)).toBe(OrderSource.DELIVERY_PLATFORM)
  })
  it('decimalDigits ausente → asume 2', () => {
    const p = JSON.parse(fixture.toString())
    delete p.decimalDigits
    const o = parseDeliverectOrder(Buffer.from(JSON.stringify(p)), link)
    expect(o.items[0].unitPrice).toBe(45.0)
  })
  it('body inválido lanza error legible', () => {
    expect(() => parseDeliverectOrder(Buffer.from('not-json'), link)).toThrow(/payload/i)
  })

  // ============================================================
  // Fix 1 (audit, SECURITY): bounds validation de dinero/cantidad — un payload
  // malformado (aunque HMAC-autenticado) con total/unitPrice negativo crearía una
  // Order/Payment "PAID" con forma de reembolso, saltándose el flujo de refund
  // (permisos/confirm/audit). Solo total/unitPrice/quantity — NUNCA
  // discountAmount/taxAmount/serviceCharge (semántica de signo aparte).
  // ============================================================
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

    it('discountTotal negativo NO se valida (semántica de signo aparte) — payload sigue siendo válido', () => {
      const body = payloadWith(p => {
        p.discountTotal = -500
      })
      expect(() => parseDeliverectOrder(body, link)).not.toThrow()
    })

    it('payload válido (fixture original) → NO throw', () => {
      expect(() => parseDeliverectOrder(fixture, link)).not.toThrow()
    })
  })
})
