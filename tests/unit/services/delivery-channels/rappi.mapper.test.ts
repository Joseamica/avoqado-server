/**
 * Mapeo del pedido de Rappi.
 *
 * Tres fuentes, marcadas en cada bloque:
 *  · «sandbox»: los avisos NEW_ORDER REALES del sandbox DEV de Rappi (21-oct-2026, `recorrido-real.md`: M1, M2 y M10), sin
 *    datos personales (`fixtures/rappi/sandbox/new-order-*.json`).
 *  · «prod-doc»: el ejemplo de `GET orders` que publica la documentación (NEW_ORDER manda lo mismo) y las diferencias 3 y 6
 *    entre el sandbox y producción que publica la misma documentación (§«Las 8 diferencias»).
 *  · lo demás: payloads armados a mano para un caso borde.
 *
 * 🔴 F1 (founder, 20-oct): la venta es el precio COMPLETO de los renglones y sólo lo que pone el negocio es descuento; lo
 * que asume Rappi no baja la venta.
 */
import * as fs from 'fs'
import * as path from 'path'

import logger from '@/config/logger'
import { assertDeliveryMoneyInvariants } from '../../../../src/services/delivery-channels/core/money'
import {
  esPedidoProgramado,
  extraerStoreId,
  normalizeRappiOrder,
  tiempoDeCoccion,
  VARIANTES_CALIBRADAS,
  VariantePendienteError,
} from '../../../../src/services/delivery-channels/providers/rappi/rappi.mapper'
import {
  deRappiAPesos,
  dePesosARappi,
  FACTOR_MONEDA_RAPPI,
} from '../../../../src/services/delivery-channels/providers/rappi/rappi.unidades'

const SANDBOX = path.join(__dirname, 'fixtures/rappi/sandbox')
/** Un aviso NEW_ORDER real del sandbox, como objeto nuevo en cada llamada (las pruebas lo modifican). */
const sandbox = (archivo: string): any => JSON.parse(fs.readFileSync(path.join(SANDBOX, archivo), 'utf8'))
/** M1: repartidor de Rappi, menú DE MUESTRA de Rappi (140 + topping 5000 = 5140; envío 3000 y servicio 5900 fuera). */
const MENU_MUESTRA = 'new-order-full-delivery-menu-muestra.json'
/** M2: repartidor de Rappi, NUESTRO menú (2 × 25 + 49 = 99): de aquí sale el factor de moneda. */
const NUESTRO_MENU = 'new-order-full-delivery-nuestro-menu.json'
/** M10: repartidor propio (Agua 20, envío 35, propina 20, `total_order` 75). */
const MARKETPLACE = 'new-order-marketplace-propina.json'
/** M10: para recoger (Jugo 40, envío 35, servicio 10, propina 10, `total_order` 40). */
const PICKUP = 'new-order-pickup-propina.json'

/**
 * «prod-doc»: el ejemplo de `GET orders` de la documentación de Rappi, con su dinero tal cual (sin los datos del cliente).
 * Dos renglones con toppings que suman `total_products` 204000, un descuento de envío que paga Rappi (7600) y uno por
 * producto que paga el aliado (100).
 */
function ejemploDeLaDoc(): any {
  return {
    order_detail: {
      order_id: '392625',
      delivery_operation_type: 'regular',
      cooking_time: 10,
      min_cooking_time: 5,
      max_cooking_time: 20,
      created_at: '2019-04-10T11:12:57.000Z',
      delivery_method: 'delivery',
      payment_method: 'cc',
      totals: {
        total_products: 204000,
        total_discounts: 173685,
        total_order: 204180,
        total_to_pay: 0,
        discount_by_support: 0,
        charges: { shipping: 50, service_fee: 100 },
        other_totals: { tip: 30, total_rappi_pay: 0, total_rappi_credits: 0 },
      },
      items: [
        {
          sku: '1234',
          id: '2089918083',
          name: 'Chicken and Apple Salad',
          type: 'PRODUCT',
          comments: 'No vinegar',
          price: 28900,
          quantity: 3,
          subitems: [{ sku: '11', id: '10005260', name: 'Burrata Cheese', type: 'TOPPING', price: 13500, quantity: 1 }],
        },
        {
          id: '2089918082',
          name: 'Seafood Salad',
          comments: '',
          price: 34900,
          quantity: 2,
          subitems: [
            { id: '9928277', name: 'With white vinaigrette', price: 0, quantity: 1 },
            { id: '10005257', name: 'Ricotta Cheese', price: 3500, quantity: 1 },
          ],
        },
      ],
      delivery_discount: { total_percentage_discount: 100, total_value_discount: 50 },
      discounts: [
        {
          value: 7600,
          description: 'Envío gratis',
          title: 'Envío gratis',
          product_id: null,
          sku: null,
          type: 'shipping',
          raw_value: 100,
          value_type: 'percentage',
          max_value: null,
          includes_toppings: false,
          percentage_by_rappi: 100,
          percentage_by_partners: 0,
          amount_by_rappi: 7600,
          amount_by_partner: 0,
          discount_product_units: 0,
          discount_product_unit_value: null,
        },
        {
          value: 100,
          description: 'Disfruta de 20% de descuento en productos seleccionados.',
          title: 'Disfruta de 20% de descuento en productos seleccionados.',
          product_id: 2089918082,
          sku: 2089918082,
          type: 'offer_by_product',
          raw_value: 20,
          value_type: 'percentage',
          max_value: null,
          includes_toppings: false,
          percentage_by_rappi: 0,
          percentage_by_partners: 100,
          amount_by_rappi: 0,
          amount_by_partner: 100,
          discount_product_units: 1,
          discount_product_unit_value: 100,
        },
      ],
    },
    store: { internal_id: '30000011', external_id: '123445', name: 'Store 1' },
  }
}

/** Un pedido mínimo armado a mano (repartidor de Rappi, pagado en efectivo AL REPARTIDOR); los montos por parámetro. */
function pedido(over: { total?: number; tip?: number; items?: unknown[]; action?: string } = {}) {
  const items = over.items ?? [
    {
      id: '729970',
      name: 'Producto 8',
      quantity: 4,
      sku: '0007',
      price: 25,
      unit_price_with_discount: 25,
      unit_price_without_discount: 30,
    },
  ]
  return {
    order_detail: {
      order_id: '2150558091',
      place_at: '2026-07-22 17:35:00',
      delivery_method: 'delivery',
      payment_method: 'cash',
      totals: {
        total_products: over.total ?? 100,
        total_order: over.total ?? 100,
        total_to_pay: 0,
        charges: {},
        other_totals: { tip: over.tip ?? 0, total_rappi_pay: 0, total_rappi_credits: 0 },
      },
      items,
    },
    customer: { first_name: 'Ana', last_name: 'Muñoz', phone_number: '5512345678', email: 'a@b.mx' },
    store: { internal_id: '900105814', external_id: '900105814', name: 'Taquería' },
    ...(over.action ? { action: over.action } : {}),
  }
}

/** El error de variante pendiente que lanza `fn`, o falla la prueba si no lanza ése. */
function variantePendiente(fn: () => unknown): VariantePendienteError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(VariantePendienteError)
    return err as VariantePendienteError
  }
  throw new Error('se esperaba un VariantePendienteError y no lanzó')
}

const mockLogger = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock }

beforeEach(() => {
  jest.clearAllMocks()
})

describe('las unidades de Rappi (M2)', () => {
  it('🔴 el factor medido es 1: Rappi manda PESOS (2 × $25 + $49 llegaron como 25, 49 y total_products 99)', () => {
    expect(FACTOR_MONEDA_RAPPI).toBe(1)
    expect(deRappiAPesos(99).toFixed(2)).toBe('99.00')
    expect(dePesosARappi(119)).toBe(119)
  })

  it('un monto ausente es cero, nunca NaN', () => {
    expect(deRappiAPesos(undefined).toFixed(2)).toBe('0.00')
  })

  it('al publicar no se cuela el error del punto flotante', () => {
    expect(dePesosARappi(19.99)).toBe(19.99)
  })
})

describe('normalizeRappiOrder', () => {
  it('mapea un pedido normal: renglones, cliente y venta', () => {
    const o = normalizeRappiOrder(pedido())

    expect(o.externalId).toBe('2150558091')
    expect(o.items).toHaveLength(1)
    expect(o.items[0]).toMatchObject({ name: 'Producto 8', quantity: 4, unitPrice: '25.00', total: '100.00' })
    expect(o.payment.saleAmount).toBe('100.00')
    expect(o.customer?.name).toBe('Ana Muñoz')
  })

  // ── F1: el precio COMPLETO ─────────────────────────────────────────────────────────
  it('🔴 la venta es el precio COMPLETO (price + extras) × cantidad', () => {
    // «prod-doc»: (28900 + 13500) × 3 + (34900 + 0 + 3500) × 2 = 127200 + 76800 = 204000 = total_products.
    const doc = normalizeRappiOrder(ejemploDeLaDoc())
    expect(doc.payment.saleAmount).toBe(deRappiAPesos(204000).toFixed(2))
    expect(doc.items.map(i => i.total)).toEqual(['127200.00', '76800.00'])

    // «sandbox» M1: hamburguesa 140 + papas (topping) 5000 = 5140.
    const m1 = normalizeRappiOrder(sandbox(MENU_MUESTRA))
    expect(m1.payment.saleAmount).toBe('5140.00')
    expect(m1.items[0]).toMatchObject({ unitPrice: '140.00', total: '5140.00' })
  })

  it('🔴 usa `price` (el precio sin descuento) y NUNCA `unit_price_with_discount` (obsoleto desde nov-2022)', () => {
    // En producción `unit_price_with_discount` llega rebajado por la parte del aliado (diferencia 4): leerlo restaría el
    // descuento DOS veces (en el renglón y en `discountAmount`).
    const o = normalizeRappiOrder(
      pedido({
        total: 80,
        items: [{ id: '1', name: 'X', quantity: 2, sku: 'a', price: 40, unit_price_with_discount: 25, unit_price_without_discount: 40 }],
      }),
    )
    expect(o.items[0].unitPrice).toBe('40.00')
    expect(o.payment.saleAmount).toBe('80.00')
  })

  it('🔴 descuento del negocio = Σ amount_by_partner; lo de Rappi no baja la venta', () => {
    // «prod-doc»: 100 del aliado (20 % en un producto), 7600 de Rappi (envío gratis).
    const o = normalizeRappiOrder(ejemploDeLaDoc())

    expect(o.payment.saleAmount).toBe('204000.00')
    expect(o.payment.discountAmount).toBe('100.00')
    expect(o.payment.externallyPaidSale).toBe('203900.00')
    // Lo que asumió Rappi queda en el log del pedido (y en el crudo), no en la venta.
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Rappi'),
      expect.objectContaining({ orderId: '392625', asumidoPorRappi: '7600.00', descuentoDeSoporte: '0.00' }),
    )
  })

  it('descuento compartido en UNA entrada (sandbox) o en DOS (producción): lo del negocio sale igual', () => {
    // «prod-doc», diferencia 3: el sandbox junta las dos partes en una entrada; producción manda una por quien lo paga.
    const una = ejemploDeLaDoc()
    una.order_detail.discounts = [{ value: 300, type: 'offer_by_product', amount_by_rappi: 200, amount_by_partner: 100 }]
    const dos = ejemploDeLaDoc()
    dos.order_detail.discounts = [
      { value: 200, type: 'offer_by_product', amount_by_rappi: 200, amount_by_partner: 0 },
      { value: 100, type: 'offer_by_product', amount_by_rappi: 0, amount_by_partner: 100 },
    ]

    const a = normalizeRappiOrder(una).payment
    const b = normalizeRappiOrder(dos).payment
    expect(a.discountAmount).toBe('100.00')
    expect(b.discountAmount).toBe('100.00')
    expect(a.externallyPaidSale).toBe(b.externallyPaidSale)
  })

  it('total_discount_by_partner distinto (en producción incluye cupones): se loguea y no lanza', () => {
    // «prod-doc», diferencia 6: el sandbox suma sólo los descuentos por producto y de monto fijo; producción suma la parte
    // del aliado de todos, cupones incluidos. La suma de los renglones de `discounts[]` es la que manda.
    const conCupon = ejemploDeLaDoc()
    conCupon.order_detail.totals.total_discount_by_partner = 250

    const o = normalizeRappiOrder(conCupon)

    expect(o.payment.discountAmount).toBe('100.00')
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('total_discount_by_partner'),
      expect.objectContaining({ orderId: '392625', sumaDeAmountByPartner: '100.00', totalDiscountByPartner: '250.00' }),
    )
  })

  it('el nombre de la API nueva (`totals_discount_by_partner`) también se compara', () => {
    const conCupon = ejemploDeLaDoc()
    conCupon.order_detail.totals.totals_discount_by_partner = 250

    expect(() => normalizeRappiOrder(conCupon)).not.toThrow()
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ totalDiscountByPartner: '250.00' }))
  })

  it('🔴 un descuento del negocio mayor que la venta lanza AQUÍ, antes de aceptar (la ingesta no podría registrarlo)', () => {
    // P. ej. el negocio paga un envío gratis más caro que lo que vendió: lo liquidado saldría negativo. Lanzar en el traductor
    // hace que el pedido no se acepte; lanzar en la ingesta lo dejaría aceptado en Rappi y sin venta.
    const p = sandbox(NUESTRO_MENU)
    p.order_detail.discounts = [{ value: 150, type: 'shipping', amount_by_rappi: 0, amount_by_partner: 150 }]

    expect(() => normalizeRappiOrder(p)).toThrow(/negativo|excede/)
  })

  it('si total_discount_by_partner coincide, no se dice nada', () => {
    const igual = ejemploDeLaDoc()
    igual.order_detail.totals.total_discount_by_partner = 100

    normalizeRappiOrder(igual)

    expect(mockLogger.warn).not.toHaveBeenCalled()
  })

  // ── De quién son la propina y el envío, por variante ───────────────────────────────
  it('delivery: propina y envío son de Rappi ⇒ tipAmount 0 y merchantFees 0', () => {
    // «prod-doc»: tip 30 «for the courier», envío 50 y servicio 100: todo es del repartidor de Rappi y de Rappi.
    const doc = normalizeRappiOrder(ejemploDeLaDoc()).payment
    expect(doc).toMatchObject({ tipAmount: '0.00', externallyPaidTip: '0.00', merchantFees: '0.00' })

    // «sandbox» M1: envío 3000 y servicio 5900 fuera de `total_order` (5140).
    const m1 = normalizeRappiOrder(sandbox(MENU_MUESTRA)).payment
    expect(m1).toMatchObject({ saleAmount: '5140.00', merchantFees: '0.00', tipAmount: '0.00', externallyPaidSale: '5140.00' })
  })

  it('marketplace pagado en línea: envío al negocio y propina del repartidor propio', () => {
    // «sandbox» M10: Agua 20 + envío 35 + propina 20 = total_order 75.
    const o = normalizeRappiOrder(sandbox(MARKETPLACE), { calibradas: new Set(['delivery', 'marketplace']) })

    expect(o.payment).toEqual({
      currency: 'MXN',
      saleAmount: '20.00',
      merchantFees: '35.00',
      discountAmount: '0.00',
      tipAmount: '20.00',
      externallyPaidSale: '55.00',
      externallyPaidTip: '20.00',
      cashDueSale: '0.00',
      cashDueTip: '0.00',
    })
  })

  it('pickup pagado en línea: la propina NO es del negocio aunque venga en el aviso, ni el envío ni el servicio', () => {
    // «sandbox» M10: Jugo 40, envío 35, servicio 10, propina 10, y total_order 40 = sólo productos.
    const o = normalizeRappiOrder(sandbox(PICKUP))

    expect(o.payment).toMatchObject({
      saleAmount: '40.00',
      merchantFees: '0.00',
      tipAmount: '0.00',
      externallyPaidSale: '40.00',
      externallyPaidTip: '0.00',
    })
  })

  it('las tres variantes pagadas en línea ya están calibradas (M10); una que no lo esté ⇒ VARIANTE_SIN_CALIBRAR', () => {
    expect([...VARIANTES_CALIBRADAS].sort()).toEqual(['delivery', 'marketplace', 'pickup'])

    const e = variantePendiente(() => normalizeRappiOrder(sandbox(MARKETPLACE), { calibradas: new Set(['delivery']) }))
    expect(e.codigo).toBe('VARIANTE_SIN_CALIBRAR')
    expect(e.message).toMatch(/marketplace/)
  })

  it.each([
    ['marketplace', 'cash'],
    ['marketplace', 'pos_terminal'],
    ['pickup', 'cash'],
    ['pickup', 'pos_terminal'],
    ['marketplace', 'CASH'],
  ])('🔴 efectivo o terminal con repartidor propio o para recoger ⇒ VARIANTE_BLOQUE_2B (%s, %s)', (metodo, pago) => {
    // La caja tendría que cobrarlo, y eso es el bloque 2b: en la fase 2 queda FAILED visible, nunca registrado como pagado.
    const p = sandbox(metodo === 'marketplace' ? MARKETPLACE : PICKUP)
    p.order_detail.payment_method = pago

    const e = variantePendiente(() => normalizeRappiOrder(p))
    expect(e.codigo).toBe('VARIANTE_BLOQUE_2B')
    expect(e.message).toMatch(/2b/)
  })

  it('🔴 repartidor propio o para recoger con efectivo por cobrar (`total_to_pay` > 0) ⇒ VARIANTE_BLOQUE_2B aunque el método sea otro', () => {
    // `total_to_pay` es «lo que el cliente paga en efectivo al repartidor»: registrarlo como pagado dejaría ese efectivo fuera.
    const p = sandbox(MARKETPLACE)
    p.order_detail.payment_method = 'nequi'
    p.order_detail.totals.total_to_pay = 75

    expect(variantePendiente(() => normalizeRappiOrder(p)).codigo).toBe('VARIANTE_BLOQUE_2B')
  })

  it('un método de pago nuevo (p. ej. "nequi") con marketplace cuenta como pagado en línea', () => {
    // La documentación: «Rappi constantemente acepta nuevos métodos de pago… no es necesario validarla».
    const p = sandbox(MARKETPLACE)
    p.order_detail.payment_method = 'nequi'

    const o = normalizeRappiOrder(p)
    expect(o.payment).toMatchObject({ externallyPaidSale: '55.00', externallyPaidTip: '20.00', cashDueSale: '0.00' })
  })

  it('delivery pagado en efectivo al repartidor de Rappi: lo liquida Rappi, nada para la caja', () => {
    // «sandbox» M2 con `cash`: el repartidor de Rappi cobra; el efectivo nunca toca el cajón del negocio.
    const p = sandbox(NUESTRO_MENU)
    p.order_detail.payment_method = 'cash'

    const o = normalizeRappiOrder(p)
    expect(o.payment).toMatchObject({ saleAmount: '99.00', externallyPaidSale: '99.00', cashDueSale: '0.00', cashDueTip: '0.00' })
  })

  it.each([['express'], [''], [undefined]])('un delivery_method desconocido o ausente lanza (%s)', metodo => {
    const p = sandbox(NUESTRO_MENU)
    if (metodo === undefined) delete p.order_detail.delivery_method
    else p.order_detail.delivery_method = metodo

    expect(() => normalizeRappiOrder(p)).toThrow(/delivery_method/)
    expect(() => normalizeRappiOrder(p)).not.toThrow(VariantePendienteError)
  })

  // ── El cuadre contra `total_products` ───────────────────────────────────────────────
  it('🔴 unidades equivocadas (precios ×100 contra el total) ⇒ lanza; nunca se registra', () => {
    // «sandbox» M2 con los precios en centavos y el total en pesos: el clásico factor de 100.
    const centavos = sandbox(NUESTRO_MENU)
    centavos.order_detail.items[0].price = 2500
    centavos.order_detail.items[1].price = 4900
    expect(() => normalizeRappiOrder(centavos)).toThrow(/no cuadra/i)

    // Y al revés: precios en pesos y el total en centavos.
    const totalEnCentavos = sandbox(NUESTRO_MENU)
    totalEnCentavos.order_detail.totals.total_products = 9900
    expect(() => normalizeRappiOrder(totalEnCentavos)).toThrow(/no cuadra/i)
  })

  it('sin total_products ⇒ lanza', () => {
    // Sin el total de productos no hay contra qué comprobar las unidades: no se adivina con otro campo.
    const p = sandbox(NUESTRO_MENU)
    delete p.order_detail.totals.total_products
    expect(() => normalizeRappiOrder(p)).toThrow(/total_products/)
  })

  it('cuadra contra `total_products`, NO contra total_order ni contra total_products_with_discount (obsoleto)', () => {
    const p = ejemploDeLaDoc()
    p.order_detail.totals.total_products_with_discount = 1
    expect(() => normalizeRappiOrder(p)).not.toThrow()
  })

  it('tolera el redondeo del proveedor (un centavo por renglón)', () => {
    expect(() => normalizeRappiOrder(pedido({ total: 100.01 }))).not.toThrow()
  })

  // ── Lo que liquida la plataforma contra `total_order` (M10) ────────────────────────
  it.each([[MENU_MUESTRA], [NUESTRO_MENU], [MARKETPLACE], [PICKUP]])(
    '«sandbox» %s: lo que liquida la plataforma (venta y propina) es exactamente total_order',
    archivo => {
      const crudo = sandbox(archivo)
      const p = normalizeRappiOrder(crudo).payment
      const liquidado = Number(p.externallyPaidSale) + Number(p.externallyPaidTip)

      expect(liquidado.toFixed(2)).toBe(Number(crudo.order_detail.totals.total_order).toFixed(2))
      expect(mockLogger.error).not.toHaveBeenCalled()
    },
  )

  it('🔴 si lo liquidado no es total_order se grita (🚨) con los dos números, y el pedido se registra igual', () => {
    // «prod-doc»: su `total_order` (204180) suma envío, servicio y propina sin restar descuentos, aunque es `delivery`: la
    // propia documentación no cuadra con su definición. No se lanza (el pedido ya se cocina), pero una persona lo revisa.
    const o = normalizeRappiOrder(ejemploDeLaDoc())

    expect(o.payment.externallyPaidSale).toBe('203900.00')
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('🚨'),
      expect.objectContaining({ orderId: '392625', totalOrder: '204180.00', liquidaLaPlataforma: '203900.00' }),
    )
  })

  it('el efectivo al repartidor de Rappi no se compara contra total_order (sólo lo pagado en línea)', () => {
    const p = ejemploDeLaDoc()
    p.order_detail.payment_method = 'cash'

    normalizeRappiOrder(p)

    expect(mockLogger.error).not.toHaveBeenCalled()
  })

  // ── Nada para la caja en la fase 2 ─────────────────────────────────────────────────
  it.each([[MENU_MUESTRA], [NUESTRO_MENU], [MARKETPLACE], [PICKUP], ['prod-doc']])(
    '🔴 ninguna variante de la fase 2 deja efectivo por cobrar ⇒ la ingesta la marca PAID y el cancelar genérico la rechaza (%s)',
    archivo => {
      // `cashDue*` = 0 es lo que la ingesta lee como PAID, y un pedido pagado por la plataforma es lo que el cancelar
      // genérico del POS y del panel rechaza (eso lo prueba `orderCancelGuard`). El reparto cuadra al centavo.
      const o = normalizeRappiOrder(archivo === 'prod-doc' ? ejemploDeLaDoc() : sandbox(archivo))

      expect(o.payment.cashDueSale).toBe('0.00')
      expect(o.payment.cashDueTip).toBe('0.00')
      expect(() => assertDeliveryMoneyInvariants(o.payment, o.items)).not.toThrow()
    },
  )

  it('el sku viaja como externalData — es NUESTRO id del producto, no el de Rappi', () => {
    expect(normalizeRappiOrder(pedido()).items[0].externalData).toBe('0007')
    expect(normalizeRappiOrder(sandbox(NUESTRO_MENU)).items[0].externalData).toBe('BEBIDAS-001')
  })

  // ── La trampa documentada del proveedor ───────────────────────────────────────────
  // Los programados llegan con TODOS los montos en cero, a propósito (son provisionales).
  // Dejarlos pasar escribiría una venta de $0 marcada como pagada — el mismo bug que ya
  // ocurrió una vez con Uber.
  it('🔴 RECHAZA un pedido programado — sus montos vienen en cero por diseño', () => {
    expect(() => normalizeRappiOrder(pedido({ action: 'scheduled', total: 0 }))).toThrow(/PROGRAMADO/i)
  })

  it('esPedidoProgramado los distingue por `action`', () => {
    expect(esPedidoProgramado(pedido({ action: 'scheduled' }) as never)).toBe(true)
    expect(esPedidoProgramado(pedido() as never)).toBe(false)
  })

  it('rechaza un pedido sin id y sin renglones, con mensaje que dice cuál falta', () => {
    expect(() => normalizeRappiOrder({ order_detail: { items: [] } })).toThrow(/order_id/)
    const p = pedido() as Record<string, any>
    p.order_detail.items = []
    expect(() => normalizeRappiOrder(p)).toThrow(/renglones/i)
  })
})

// ── La hora del pedido (hallazgo del recorrido: `created_at` llega SIN zona, en la de la tienda) ──
describe('placedAt', () => {
  it('🔴 una fecha SIN zona se lee en la zona de la tienda («sandbox»: 22:15:46 en Bogotá = 03:15:46Z)', () => {
    const o = normalizeRappiOrder(sandbox(MENU_MUESTRA), { zonaHoraria: 'America/Bogota' })
    expect(o.placedAt.toISOString()).toBe('2026-10-22T03:15:46.000Z')
  })

  it('sin zona del negocio se lee en la de México (no en la del servidor)', () => {
    expect(normalizeRappiOrder(sandbox(MENU_MUESTRA)).placedAt.toISOString()).toBe('2026-10-22T04:15:46.000Z')
  })

  it('una zona inválida cae a la de México y el pedido entra igual', () => {
    expect(normalizeRappiOrder(sandbox(MENU_MUESTRA), { zonaHoraria: 'GMT-6' }).placedAt.toISOString()).toBe('2026-10-22T04:15:46.000Z')
  })

  it.each([
    ['2019-04-10T11:12:57.000Z', '2019-04-10T11:12:57.000Z'],
    ['2026-10-21T22:15:46-05:00', '2026-10-22T03:15:46.000Z'],
    ['2026-10-21T22:15:46+0000', '2026-10-21T22:15:46.000Z'],
  ])('una fecha CON offset (%s) se respeta tal cual, sin importar la zona', (creada, esperada) => {
    const p = ejemploDeLaDoc()
    p.order_detail.created_at = creada
    expect(normalizeRappiOrder(p, { zonaHoraria: 'Asia/Tokyo' }).placedAt.toISOString()).toBe(esperada)
  })

  it('una fecha ilegible NUNCA tumba el pedido: cae a la de recepción', () => {
    const p = ejemploDeLaDoc()
    p.order_detail.created_at = 'ayer por la tarde'
    const antes = Date.now()
    const o = normalizeRappiOrder(p, { zonaHoraria: 'America/Mexico_City' })
    expect(o.placedAt.getTime()).toBeGreaterThanOrEqual(antes)
  })
})

describe('extraerStoreId', () => {
  it('prefiere external_id — es NUESTRO id de la tienda, el que mapea al venue', () => {
    expect(extraerStoreId({ store: { internal_id: '900', external_id: 'avq-42' } })).toBe('avq-42')
  })

  it('cae a internal_id cuando no configuramos el nuestro (default de Rappi)', () => {
    expect(extraerStoreId({ store: { internal_id: '900105814' } })).toBe('900105814')
  })

  it('devuelve null si no hay tienda — sin ella no se puede resolver el venue', () => {
    expect(extraerStoreId({})).toBeNull()
  })
})

// ── Lo que la REFERENCIA de API reveló y el ejemplo del webhook escondía ──────────────
// El ejemplo de `NEW_ORDER_SCHEDULED` que publica el portal NO trae modificadores ni notas.
// La referencia de `getOrders` sí — y la primera versión de este mapeo los tiraba a la basura.
describe('lo que trae el pedido REAL y no el ejemplo del webhook', () => {
  const conSubitems = {
    order_detail: {
      order_id: '392625',
      created_at: '2026-04-10T11:12:57.000Z',
      cooking_time: 10,
      min_cooking_time: 5,
      max_cooking_time: 20,
      delivery_method: 'delivery',
      payment_method: 'cc',
      totals: { total_products: 130, total_order: 130, other_totals: { tip: 0 } },
      items: [
        {
          sku: '1234',
          id: '2089918083',
          name: 'Ensalada',
          comments: 'Sin vinagre',
          price: 100,
          quantity: 1,
          subitems: [{ sku: '11', id: '10005260', name: 'Queso burrata', price: 30, quantity: 1 }],
        },
      ],
    },
    store: { internal_id: '30000011', external_id: '123445' },
  }

  it('🔴 los MODIFICADORES no se pierden — se llaman `subitems`, no `modifiers`', () => {
    const o = normalizeRappiOrder(conSubitems)
    expect(o.items[0].modifiers).toEqual([{ externalId: '11', name: 'Queso burrata', quantity: 1, price: '30.00' }])
  })

  it('🔴 el modificador va DENTRO del total del renglón, o el cuadre falla con cada extra', () => {
    const o = normalizeRappiOrder(conSubitems)
    expect(o.items[0].unitPrice).toBe('100.00')
    expect(o.items[0].total).toBe('130.00')
    expect(o.payment.saleAmount).toBe('130.00')
  })

  it('🔴 la nota del cliente sobrevive — es lo que separa servir bien de servir mal', () => {
    expect(normalizeRappiOrder(conSubitems).items[0].notes).toBe('Sin vinagre')
  })

  it('usa la fecha REAL del pedido (`created_at`), no la de recepción', () => {
    expect(normalizeRappiOrder(conSubitems).placedAt.toISOString()).toBe('2026-04-10T11:12:57.000Z')
  })

  it('el modificador multiplica por SU cantidad', () => {
    const dos = JSON.parse(JSON.stringify(conSubitems))
    dos.order_detail.items[0].subitems[0].quantity = 2
    dos.order_detail.totals.total_products = 160
    expect(normalizeRappiOrder(dos).items[0].total).toBe('160.00')
  })
})

// ── El "dato que Avoqado no tiene" resultó que Rappi lo manda ─────────────────────────
describe('tiempoDeCoccion', () => {
  const rango = { cooking_time: 10, min_cooking_time: 5, max_cooking_time: 20 }

  it('🔴 por default devuelve el que RAPPI sugiere — no hay que inventar nada', () => {
    expect(tiempoDeCoccion(rango)).toBe(10)
  })

  it('recorta al rango permitido: fuera de él, Rappi rechaza la llamada', () => {
    expect(tiempoDeCoccion(rango, 99)).toBe(20)
    expect(tiempoDeCoccion(rango, 1)).toBe(5)
  })

  it('respeta un tiempo propio si cae dentro del rango', () => {
    expect(tiempoDeCoccion(rango, 15)).toBe(15)
  })

  it('sin datos de Rappi usa un default sensato en vez de reventar', () => {
    expect(tiempoDeCoccion({})).toBe(15)
  })
})

// ── La invariante que ata la ORDEN con el REPORTE ─────────────────────────────────────
describe('🔴 el REPORTE no puede contradecir a la orden', () => {
  // `lineRevenue.ts` (dashboard) calcula el ingreso de UNA línea con esta MISMA fórmula,
  // en SQL: unitPrice × cantidad + Σ(modificador.price × modificador.quantity). NO
  // multiplica los modificadores por la cantidad del producto padre. Si el mapeo no
  // respeta eso, `item.total` (lo que se cobra) y el reporte dicen números distintos:
  // el dueño ve uno y el banco otro. Es el mismo agujero que Uber cerró el 27-ago.
  const lineGross = (it: { unitPrice: string; quantity: number; modifiers?: Array<{ price: string; quantity: number }> }) =>
    Number(it.unitPrice) * it.quantity + (it.modifiers ?? []).reduce((a, m) => a + Number(m.price) * m.quantity, 0)

  /** Ensalada de $100 con "Queso burrata" de $30. Las dos cantidades se pasan aparte. */
  const pedido = (cantidad: number, cantidadDelExtra: number, total: number) => ({
    order_detail: {
      order_id: '392625',
      delivery_method: 'delivery',
      payment_method: 'cc',
      totals: { total_products: total, total_order: total, other_totals: { tip: 0 } },
      items: [
        {
          sku: '1234',
          id: '2089918083',
          name: 'Ensalada',
          price: 100,
          quantity: cantidad,
          subitems: [{ sku: '11', id: '10005260', name: 'Queso burrata', price: 30, quantity: cantidadDelExtra }],
        },
      ],
    },
    store: { internal_id: '30000011', external_id: '123445' },
  })

  it.each([
    ['2 ensaladas, 1 burrata en cada una', 2, 1, 260],
    ['1 ensalada con 2 burratas', 1, 2, 160],
    ['3 ensaladas con 2 burratas cada una', 3, 2, 480],
    ['1 ensalada, 1 burrata (el caso que ya cuadraba)', 1, 1, 130],
  ])('%s: lineGross == item.total == saleAmount', (_caso, cantidad, cantidadDelExtra, total) => {
    const o = normalizeRappiOrder(pedido(cantidad, cantidadDelExtra, total))
    const renglon = o.items[0]

    expect(lineGross(renglon).toFixed(2)).toBe(Number(renglon.total).toFixed(2))
    expect(Number(renglon.total).toFixed(2)).toBe(Number(o.payment.saleAmount).toFixed(2))
  })

  // El contrato está escrito en `core/types.ts`: «`price` — ya multiplicado por la cantidad
  // del padre», `quantity` = la cantidad PROPIA del extra. Repartirlo al revés daría el
  // mismo producto pero rompería la comanda: el KDS imprime "2x Queso burrata" leyendo
  // `quantity`, y en una línea de 2 ensaladas con una burrata cada una eso es mentira.
  it('🔴 reparte precio y cantidad como manda el contrato: precio × cantidad del padre, cantidad PROPIA', () => {
    const o = normalizeRappiOrder(pedido(2, 1, 260))
    expect(o.items[0].modifiers).toEqual([{ externalId: '11', name: 'Queso burrata', quantity: 1, price: '60.00' }])
  })

  it('«prod-doc»: el reporte de cada renglón con toppings dice lo mismo que la orden', () => {
    const o = normalizeRappiOrder(ejemploDeLaDoc())
    for (const r of o.items) expect(lineGross(r).toFixed(2)).toBe(Number(r.total).toFixed(2))
  })
})
