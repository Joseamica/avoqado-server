/**
 * El traductor uAPI, contra el PEDIDO REAL del sandbox (`pedido-real-uapi.json`, bajado el
 * 27-ago con `?expand=carts,payment`).
 *
 * Hereda TODAS las lecciones de dinero de la API clásica — Decimal nunca float, "corrupto"
 * distinto de "ausente", reparto que cuadra al centavo, y rechazar en vez de adivinar — y
 * les suma la nueva frontera: `amount_e5`, donde 100000 = $1.00 y equivocar la división
 * multiplica cada venta por mil.
 */
import fs from 'fs'
import path from 'path'

import { mapUberOrder } from '@/services/delivery-channels/providers/uber-eats/uber.mapper'

const FIXTURE = path.join(__dirname, '../../../fixtures/delivery/uber/pedido-real-uapi.json')
const pedidoReal = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))

/** Un money e5 del uAPI. */
const e5 = (amount_e5: number) => ({ amount_e5, currency_code: 'MXN' })

describe('uber.mapper (uAPI) — contra el pedido real', () => {
  it('traduce el pedido completo', () => {
    const r = mapUberOrder(pedidoReal())
    expect(r.externalId).toBe('00012fba-ad21-4d73-a233-44522fbef5a9')
    expect(r.displayId).toBe('EF5A9')
    expect(r.items).toHaveLength(1)
    expect(r.items[0].name).toBe('Best Burger')
  })

  it('🔴 e5 → PESOS: 100000 es $1.00, no $1,000 ni $100', () => {
    const r = mapUberOrder(pedidoReal())
    expect(r.payment.saleAmount).toBe('1.00')
    expect(r.payment.externallyPaidSale).toBe('1.00')
    expect(r.items[0].unitPrice).toBe('1.00')
    expect(r.items[0].total).toBe('1.00')
  })

  it('🔴 `quantity` es un OBJETO {amount} — al revés que la API clásica', () => {
    const r = mapUberOrder(pedidoReal())
    expect(r.items[0].quantity).toBe(1)
  })

  it('✓ la nota del cliente SÍ llega en el uAPI y viaja al contrato — es lo que la cocina lee', () => {
    const r = mapUberOrder(pedidoReal())
    expect(r.items[0].notes).toBe('Sin cebolla, por favor')
  })

  it('el id del item viaja como externalData: es lo que Avoqado publicó en el menú', () => {
    const r = mapUberOrder(pedidoReal())
    expect(r.items[0].externalId).toBe('external_item_1')
    expect(r.items[0].externalData).toBe('external_item_1')
  })

  it('🔴 cuando reparte Uber NO hay propina: el reparto la deja en cero', () => {
    const r = mapUberOrder(pedidoReal())
    expect(r.payment.tipAmount).toBe('0.00')
    expect(r.payment.externallyPaidTip).toBe('0.00')
  })

  it('🔴 lo paga la plataforma: nada queda por cobrar en efectivo', () => {
    const r = mapUberOrder(pedidoReal())
    expect(r.payment.cashDueSale).toBe('0.00')
    expect(r.payment.cashDueTip).toBe('0.00')
  })

  it('el reparto cuadra al centavo, que es lo que la ingesta exige', () => {
    const r = mapUberOrder(pedidoReal())
    const suma = Number(r.payment.saleAmount) + Number(r.payment.merchantFees)
    expect(suma.toFixed(2)).toBe(Number(r.payment.externallyPaidSale).toFixed(2))
  })

  it('conserva el cliente y el JSON crudo para auditoría', () => {
    const raw = pedidoReal()
    const r = mapUberOrder(raw)
    expect(r.customer?.name).toBe('Avoqado S.')
    expect(r.customer?.phone).toContain('+52')
    expect(r.raw).toBe(raw)
  })

  it('acepta el pedido SIN el sobre {order} — por si un webhook lo trae embebido', () => {
    const r = mapUberOrder(pedidoReal().order)
    expect(r.externalId).toBe('00012fba-ad21-4d73-a233-44522fbef5a9')
  })

  it('🔴 RECHAZA un pedido sin id: mejor fallar visible que ingerir basura', () => {
    expect(() => mapUberOrder({ order: {} })).toThrow(/no trae `id`/)
  })

  it('🔴 RECHAZA una moneda que no sea MXN', () => {
    const p = pedidoReal()
    p.order.payment.payment_detail.currency_code = 'USD'
    expect(() => mapUberOrder(p)).toThrow(/Sólo MXN/)
  })

  it('un cargo extra del comercio entra como merchantFees y sigue cuadrando', () => {
    const p = pedidoReal()
    // order_total sube $10.00 por encima de los artículos → cargos del comercio.
    p.order.payment.payment_detail.order_total.gross = e5(1_100_000)
    const r = mapUberOrder(p)
    expect(r.payment.saleAmount).toBe('1.00')
    expect(r.payment.merchantFees).toBe('10.00')
    expect(r.payment.externallyPaidSale).toBe('11.00')
  })

  // ── Rechazar en vez de adivinar (la política que protege el dinero) ────────────────

  it('🔴 RECHAZA un fulfillment_type distinto de DELIVERY_BY_UBER — BYOC/pickup sin pedido real que los verifique', () => {
    const p = pedidoReal()
    p.order.fulfillment_type = 'BYOC'
    expect(() => mapUberOrder(p)).toThrow(/fulfillment_type="BYOC"/)
  })

  it('🔴 RECHAZA un price_type desconocido en el breakdown — dinero que no se sabe a qué línea sumar', () => {
    const p = pedidoReal()
    p.order.payment.payment_detail.item_charges.price_breakdown.push({
      cart_item_id: 'd4a07394-19a7-4a4b-870c-9c00d15cda97',
      price_type: 'MODIFIER',
      total: { gross: e5(20_000) },
    })
    expect(() => mapUberOrder(p)).toThrow(/price_type="MODIFIER"/)
  })

  it('🔴 RECHAZA un item que no aparece en el price_breakdown — sin precio no hay venta que ingerir', () => {
    const p = pedidoReal()
    p.order.payment.payment_detail.item_charges.price_breakdown = []
    expect(() => mapUberOrder(p)).toThrow(/no aparece en price_breakdown/)
  })

  describe('dinero: "no existe" vs. "corrupto" en amount_e5', () => {
    it('🔴 RECHAZA si order_total.gross.amount_e5 es un string — antes (clásico) esto se volvía $0 en silencio', () => {
      const p = pedidoReal()
      p.order.payment.payment_detail.order_total.gross.amount_e5 = '100000'
      expect(() => mapUberOrder(p)).toThrow(/corrupto/)
    })

    it('🔴 RECHAZA si amount_e5 es NaN', () => {
      const p = pedidoReal()
      p.order.payment.payment_detail.order_total.gross.amount_e5 = NaN
      expect(() => mapUberOrder(p)).toThrow(/corrupto/)
    })

    it('🔴 sin order_total: RECHAZA en vez de crear una venta de $0', () => {
      const p = pedidoReal()
      delete p.order.payment.payment_detail.order_total
      expect(() => mapUberOrder(p)).toThrow(/no trae "payment_detail.order_total.gross"/)
    })

    it('🔴 sin item_charges.total: tampoco adivina', () => {
      const p = pedidoReal()
      delete p.order.payment.payment_detail.item_charges.total
      expect(() => mapUberOrder(p)).toThrow(/no trae "payment_detail.item_charges.total.gross"/)
    })

    it('regresión: la propina AUSENTE sigue siendo legítima (pedido que reparte Uber), no rechaza', () => {
      const r = mapUberOrder(pedidoReal())
      expect(r.payment.tipAmount).toBe('0.00')
    })

    it('la propina PRESENTE se lee y se reparte', () => {
      const p = pedidoReal()
      p.order.payment.payment_detail.tips = { total: { gross: e5(500_000) } }
      const r = mapUberOrder(p)
      expect(r.payment.tipAmount).toBe('5.00')
      expect(r.payment.externallyPaidTip).toBe('5.00')
      // La propina NO infla los cargos del comercio.
      expect(r.payment.merchantFees).toBe('0.00')
    })
  })

  describe('dinero: Decimal, nunca float', () => {
    it('🔴 valor extremo por encima de Number.MAX_SAFE_INTEGER no pierde centavos', () => {
      const p = pedidoReal()
      // 9007199254740993 es 2^53 + 1: en `number` colapsa a ...992 y pierde 1 centavo-e5.
      // El breakdown y el total deben moverse JUNTOS para que el pedido siga cuadrando.
      p.order.payment.payment_detail.order_total.gross = e5(9007199254740993)
      p.order.payment.payment_detail.item_charges.total.gross = e5(9007199254740993)
      p.order.payment.payment_detail.item_charges.price_breakdown[0].total.gross = e5(9007199254740993)
      const r = mapUberOrder(p)
      expect(r.payment.saleAmount).toBe('90071992547.41')
      expect(r.payment.saleAmount).toBe(r.payment.externallyPaidSale)
    })
  })

  it('🔴 RECHAZA un item sin título legible', () => {
    const p = pedidoReal()
    p.order.carts[0].items[0].title = null
    expect(() => mapUberOrder(p)).toThrow(/sin título legible/)
  })

  it('un pedido con VARIOS carritos (group order) junta los items de todos', () => {
    const p = pedidoReal()
    const item2 = JSON.parse(JSON.stringify(p.order.carts[0].items[0]))
    item2.cart_item_id = 'segunda-linea'
    item2.id = 'external_item_2'
    p.order.carts.push({ items: [item2] })
    p.order.payment.payment_detail.item_charges.price_breakdown.push({
      cart_item_id: 'segunda-linea',
      price_type: 'ITEM',
      total: { gross: e5(200_000) },
      unit: { gross: e5(200_000) },
    })
    const r = mapUberOrder(p)
    expect(r.items).toHaveLength(2)
    expect(r.items[1].total).toBe('2.00')
  })
})
