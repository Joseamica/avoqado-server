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

  // ── Promociones ───────────────────────────────────────────────────────────────────
  //
  // 🔴 Uber manda TRES cifras en el mismo mensaje: lo que valen los artículos
  // (`item_charges`), lo que valió la promoción (`promotions.total`) y lo que el cliente
  // pagó (`order_total`). El mapper sólo leía la primera y la tercera, y la resta —que sale
  // NEGATIVA cuando hay promoción, justo la señal de que algo no cuadra— se aplastaba a cero
  // con `max(0, …)`. Resultado: el pedido se registraba como si el cliente hubiera pagado el
  // precio de lista, y el reporte de ventas del negocio quedaba inflado contra su depósito.
  //
  // Se registra como lo hace el mercado (Square: ventas brutas SIN ajustar, descuentos como
  // deducción visible, netas = la resta; Fudo tiene «Descuentos ($)» como línea propia):
  // `saleAmount` sigue siendo el BRUTO —así los renglones siguen cuadrando al centavo— y el
  // descuento viaja aparte. Lo que la plataforma liquida sí baja.
  //
  // Los montos de Uber son `gross`, o sea CON IVA incluido, que es como se maneja el precio
  // en México: el descuento se aplica sobre el precio con impuesto, no sobre una base sin él.
  it('🔴 una promoción se registra como DESCUENTO, no desaparece', () => {
    const p = pedidoReal()
    // Artículos $1.00; promoción de $0.20; el cliente paga $0.80.
    p.order.payment.payment_detail.promotions.total.gross = e5(20_000)
    p.order.payment.payment_detail.order_total.gross = e5(80_000)

    const r = mapUberOrder(p)

    expect(r.payment.saleAmount).toBe('1.00') // bruto: cuadra con los renglones
    expect(r.payment.discountAmount).toBe('0.20') // la promoción, visible
    expect(r.payment.externallyPaidSale).toBe('0.80') // lo que Uber liquida
  })

  it('sin promoción nada cambia (el caso de siempre)', () => {
    const r = mapUberOrder(pedidoReal())
    expect(r.payment.saleAmount).toBe('1.00')
    expect(r.payment.discountAmount).toBe('0.00')
    expect(r.payment.externallyPaidSale).toBe('1.00')
  })

  // ── Rechazar en vez de adivinar (la política que protege el dinero) ────────────────

  it('🔴 RECHAZA un fulfillment_type distinto de DELIVERY_BY_UBER — BYOC/pickup sin pedido real que los verifique', () => {
    const p = pedidoReal()
    p.order.fulfillment_type = 'BYOC'
    expect(() => mapUberOrder(p)).toThrow(/fulfillment_type="BYOC"/)
  })

  it('🔴 dos IMPORTES para el mismo cart_item_id RECHAZAN — no se adivina cómo se reparten', () => {
    // Se probó a sumarlos (para soportar un hipotético ITEM + DISCOUNT) y salía peor: el
    // neto bajaba `item.total` pero NO `unitPrice` ni `discountAmount`, así que el dashboard
    // reportaba el precio COMPLETO sobre una venta descontada. Y era código para un payload
    // que nunca hemos visto: cero ids repetidos en los 3 pedidos reales del sandbox.
    const p = pedidoReal()
    p.order.payment.payment_detail.item_charges.price_breakdown.push({
      cart_item_id: 'd4a07394-19a7-4a4b-870c-9c00d15cda97',
      price_type: 'DISCOUNT',
      total: { gross: e5(-20_000) },
    })
    expect(() => mapUberOrder(p)).toThrow(/DOS importes para el mismo cart_item_id/)
  })

  it('…pero una segunda entrada en CERO no tumba la venta: no aporta dinero', () => {
    const p = pedidoReal()
    p.order.payment.payment_detail.item_charges.price_breakdown.push({
      cart_item_id: 'd4a07394-19a7-4a4b-870c-9c00d15cda97',
      price_type: 'CUSTOMIZATION',
      total: { gross: e5(0) },
    })
    expect(mapUberOrder(p).items[0].total).toBe('1.00')
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
      // El lint avisa justamente de esa pérdida — que es LO QUE ESTA PRUEBA DEMUESTRA que
      // Decimal evita. Silenciarlo aquí es correcto; silenciarlo en código de producción no.
      /* eslint-disable no-loss-of-precision */
      // El breakdown y el total deben moverse JUNTOS para que el pedido siga cuadrando.
      p.order.payment.payment_detail.order_total.gross = e5(9007199254740993)
      p.order.payment.payment_detail.item_charges.total.gross = e5(9007199254740993)
      p.order.payment.payment_detail.item_charges.price_breakdown[0].total.gross = e5(9007199254740993)
      /* eslint-enable no-loss-of-precision */
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
    // 🔴 Los totales suben CON las líneas. Antes se dejaban en $1.00 con $3.00 de artículos:
    // el test pasaba sobre una venta que la ingesta habría rechazado por descuadre, así que
    // no probaba nada de lo que dice probar (Codex, 2ª pasada).
    p.order.payment.payment_detail.item_charges.total.gross = e5(300_000)
    p.order.payment.payment_detail.order_total.gross = e5(300_000)

    const r = mapUberOrder(p)
    expect(r.items).toHaveLength(2)
    expect(r.items[1].total).toBe('2.00')
    // …y el pedido CUADRA, que es la única forma de que la ingesta lo acepte.
    const suma = r.items.reduce((a, i) => a + Number(i.total), 0)
    expect(suma.toFixed(2)).toBe(Number(r.payment.saleAmount).toFixed(2))
  })
})

describe('uber.mapper (uAPI) — pedido REAL con modificadores', () => {
  // Pedido real del sandbox (27-ago): Hamburguesa Doble $169 + Mediano $15 + Ranch $10.
  // 🔴 ANTES de esto el pedido se RECHAZABA ENTERO con `price_type="CUSTOMIZATION"` — o sea
  // que en producción cualquier cliente que pidiera queso extra dejaba al restaurante sin
  // la venta. Se reprodujo en vivo antes de arreglarlo.
  const CON_MODS = path.join(__dirname, '../../../fixtures/delivery/uber/pedido-con-modificadores-uapi.json')
  const conMods = () => JSON.parse(fs.readFileSync(CON_MODS, 'utf8'))

  it('🔴 NO rechaza el pedido: acepta ITEM, OPTION y CUSTOMIZATION', () => {
    expect(() => mapUberOrder(conMods())).not.toThrow()
  })

  it('🔴 los extras llegan como modificadores REALES, con su precio', () => {
    const r = mapUberOrder(conMods())
    const mods = r.items[0].modifiers ?? []
    expect(mods.map(m => m.name).sort()).toEqual(['Mediano', 'Ranch'])
    expect(mods.find(m => m.name === 'Mediano')!.price).toBe('15.00')
    expect(mods.find(m => m.name === 'Ranch')!.price).toBe('10.00')
    // El id que Avoqado publicó para esa opción. ⚠️ Hoy la ingesta NO lo resuelve contra
    // el catálogo (guarda `modifierId: null`): viaja para que la comanda y una futura
    // resolución lo tengan, no porque ya se use.
    expect(mods.find(m => m.name === 'Ranch')!.externalId).toBe('MOD-cmpe6531700y99k92gskezs5q')
  })

  it('🔴 EL DINERO CUADRA: la línea suma base + extras, y el total del pedido no se mueve', () => {
    const r = mapUberOrder(conMods())
    // 169 base + 15 + 10 = 194, que es exactamente `item_charges.total.gross` del pedido real.
    expect(r.items[0].total).toBe('194.00')
    expect(r.items[0].unitPrice).toBe('169.00')
    expect(r.payment.saleAmount).toBe('194.00')
    // Y la suma de las líneas NO puede exceder lo que Uber dice que se cobró por artículos.
    const suma = (r.items ?? []).reduce((a, i) => a + Number(i.total), 0)
    expect(suma).toBeCloseTo(Number(r.payment.saleAmount), 2)
  })

  it('🔴 un tipo NUEVO con dinero que no aterriza en ninguna línea SÍ rechaza', () => {
    // Lo que importa no es el nombre del tipo, es que quede dinero sin colocar: eso es
    // exactamente lo que haría que la comanda cobrara distinto de lo que Uber cobró.
    const p = conMods()
    const o = p.order ?? p
    o.payment.payment_detail.item_charges.price_breakdown.push({
      cart_item_id: 'huerfano-que-no-existe-en-el-carrito',
      price_type: 'ALGO_NUEVO',
      total: { gross: { amount_e5: 5_000_000, currency_code: 'MXN' } },
    })
    expect(() => mapUberOrder(p)).toThrow(/no corresponde a ningún artículo ni a ningún extra/)
  })

  it('🔴 …pero un tipo NUEVO en $0.00 NO tumba el pedido: no mueve un centavo', () => {
    // La versión anterior rechazaba por el NOMBRE y perdía la venta ENTERA — con el pedido
    // ya aceptado en Uber, o sea el cliente cobrado y la cocina sin comanda.
    const p = conMods()
    const o = p.order ?? p
    o.payment.payment_detail.item_charges.price_breakdown.push({
      cart_item_id: 'contenedor-nuevo-sin-dinero',
      price_type: 'ALGO_NUEVO',
      total: { gross: { amount_e5: 0, currency_code: 'MXN' } },
    })
    const r = mapUberOrder(p)
    expect(r.items[0].total).toBe('194.00')
  })

  // 🔴 EL CASO QUE MI PRIMERA VERSION FALLO. Pedido real: 2 hamburguesas, cada una con
  // Mediano (+$15) y Ranch (+$10). Uber cobra $388 = (169 + 15 + 10) x 2.
  // El breakdown MIENTE si se lee ingenuo: la entrada ITEM ya viene multiplicada
  // (total $338 = 169x2) pero las entradas OPTION vienen POR UNIDAD ($15 y $10), aunque
  // el cliente pague dos de cada una. Sumar los extras una sola vez daba $363 y el guard
  // de dinero rechazaba el pedido entero: venta perdida, igual que antes del arreglo.
  const CANT2 = path.join(__dirname, '../../../fixtures/delivery/uber/pedido-cantidad2-con-modificadores-uapi.json')
  const cantidad2 = () => JSON.parse(fs.readFileSync(CANT2, 'utf8'))

  it('🔴 cantidad 2 con extras: la linea cuadra contra item_charges ($388, no $363)', () => {
    const r = mapUberOrder(cantidad2())
    expect(r.items[0].quantity).toBe(2)
    expect(r.items[0].unitPrice).toBe('169.00')
    expect(r.items[0].total).toBe('388.00')
    expect(r.payment.saleAmount).toBe('388.00')
    const suma = r.items.reduce((a, i) => a + Number(i.total), 0)
    expect(suma).toBeCloseTo(Number(r.payment.saleAmount), 2)
  })

  it('🔴 el precio del modificador es POR UNIDAD del padre — la convencion del repo (ver Rappi)', () => {
    // Si aqui se guardara el precio ya multiplicado (30 y 20), la linea saldria bien pero
    // el renglon del modificador mentiria en la comanda y en cualquier reporte que lo sume.
    // 2 hamburguesas ⇒ el precio del extra ya viene multiplicado por 2, que es lo que el
    // núcleo declara y lo que hace que el reporte cuadre con la orden.
    const mods = mapUberOrder(cantidad2()).items[0].modifiers ?? []
    expect(mods.find(m => m.name === 'Mediano')!.price).toBe('30.00')
    expect(mods.find(m => m.name === 'Ranch')!.price).toBe('20.00')
  })
})

describe('uber.mapper (uAPI) — bordes del dinero de los extras', () => {
  const CANT2 = path.join(__dirname, '../../../fixtures/delivery/uber/pedido-cantidad2-con-modificadores-uapi.json')
  const base = () => JSON.parse(fs.readFileSync(CANT2, 'utf8'))
  const bdDe = (p: any) => p.order.payment.payment_detail.item_charges.price_breakdown
  const ranchDe = (p: any) => bdDe(p).find((e: any) => e.total.gross.amount_e5 === 1_000_000)
  const fijarTotales = (p: any, e5v: number) => {
    p.order.payment.payment_detail.item_charges.total.gross.amount_e5 = e5v
    p.order.payment.payment_detail.order_total.gross.amount_e5 = e5v
  }

  it('🔴 un extra con CANTIDAD PROPIA >1 no se cuenta dos veces', () => {
    // 2 aderezos en cada una de 2 hamburguesas: (169 + 15 + 20) x 2 = 408.
    // `price` debe quedar UNITARIO ($10) para que `price x quantity` dé los $20 que aporta,
    // y no $40 — que es el doble conteo que señaló Codex.
    const p = base()
    const ranch = ranchDe(p)
    ranch.quantity = { amount: 2, unit: 'PIECE' }
    ranch.total.gross.amount_e5 = 2_000_000
    p.order.carts[0].items[0].selected_modifier_groups[1].selected_items[0].quantity = { amount: 2, unit: 'PIECE' }
    fijarTotales(p, 40_800_000)

    const r = mapUberOrder(p)
    expect(r.items[0].total).toBe('408.00')
    expect(r.items[0].total).toBe(r.payment.saleAmount)
    const m = (r.items[0].modifiers ?? []).find(x => x.name === 'Ranch')!
    // Contrato del núcleo: precio = unitario × cantidad del producto ($10 × 2 hamburguesas),
    // cantidad = las que pidió de ese extra por hamburguesa (2 aderezos).
    expect(m.price).toBe('20.00')
    expect(m.quantity).toBe(2)
    expect((Number(m.price) * m.quantity).toFixed(2)).toBe('40.00')
  })

  it('sin `unit` en el breakdown, el unitario se deriva de total ÷ cantidad', () => {
    const p = base()
    delete ranchDe(p).unit
    const r = mapUberOrder(p)
    expect((r.items[0].modifiers ?? []).find(x => x.name === 'Ranch')!.price).toBe('20.00')
    expect(r.items[0].total).toBe('388.00')
  })

  it('🔴 un extra GRATIS (sin entrada en el breakdown) NO tumba el pedido y sigue en la comanda', () => {
    // El cliente pidió el aderezo y la cocina tiene que verlo, aunque no cueste.
    const p = base()
    p.order.payment.payment_detail.item_charges.price_breakdown = bdDe(p).filter((e: any) => e.total.gross.amount_e5 !== 1_000_000)
    fijarTotales(p, 36_800_000)

    const r = mapUberOrder(p)
    expect(r.items[0].total).toBe('368.00')
    expect(r.items[0].total).toBe(r.payment.saleAmount)
    expect((r.items[0].modifiers ?? []).find(x => x.name === 'Ranch')!.price).toBe('0.00')
  })

  it('🔴 un extra CON precio que no aterriza en ninguna línea RECHAZA — ese dinero descuadraría', () => {
    const p = base()
    p.order.carts[0].items[0].selected_modifier_groups[1].selected_items[0].cart_item_id = 'no-existe-en-breakdown'
    expect(() => mapUberOrder(p)).toThrow(/no corresponde a ningún artículo ni a ningún extra/)
  })
})

describe('🔴 el REPORTE no puede contradecir a la orden', () => {
  // `lineRevenue.ts` (dashboard) calcula el ingreso de una línea con esta MISMA fórmula,
  // en SQL: unitPrice × cantidad + Σ(modificador.price × modificador.quantity). Si no
  // coincide con `item.total`, el dueño ve un número y el banco otro. Se descubrió porque
  // Codex leyó `lineGrossSql` y detectó que reportaría $363 sobre una venta de $388.
  const lineGross = (it: { unitPrice: string; quantity: number; modifiers?: Array<{ price: string; quantity: number }> }) =>
    Number(it.unitPrice) * it.quantity + (it.modifiers ?? []).reduce((a, m) => a + Number(m.price) * m.quantity, 0)

  const FIXTURES = ['pedido-real-uapi', 'pedido-con-modificadores-uapi', 'pedido-cantidad2-con-modificadores-uapi']

  it.each(FIXTURES)('%s: lineGross == item.total == saleAmount', nombre => {
    const p = JSON.parse(fs.readFileSync(path.join(__dirname, `../../../fixtures/delivery/uber/${nombre}.json`), 'utf8'))
    const r = mapUberOrder(p)
    let suma = 0
    for (const it of r.items) {
      expect(lineGross(it).toFixed(2)).toBe(Number(it.total).toFixed(2))
      suma += Number(it.total)
    }
    expect(suma.toFixed(2)).toBe(Number(r.payment.saleAmount).toFixed(2))
  })
})

describe('uber.mapper (uAPI) — cantidades imposibles', () => {
  const conCantidad = (v: unknown) => {
    const p = pedidoReal()
    p.order.carts[0].items[0].quantity = { amount: v, unit: 'PIECE' }
    return p
  }

  it.each([0, -1, 0.5])('🔴 RECHAZA quantity=%s en vez de convertirla en 1 a la callada', v => {
    expect(() => mapUberOrder(conCantidad(v))).toThrow(/no es un entero positivo/)
  })

  it('sin `quantity` sigue asumiendo 1 — eso sí es legítimo', () => {
    const p = pedidoReal()
    delete p.order.carts[0].items[0].quantity
    expect(mapUberOrder(p).items[0].quantity).toBe(1)
  })
})

describe('uber.mapper (uAPI) — cantidad IMPOSIBLE en un modificador', () => {
  const CANT2 = path.join(__dirname, '../../../fixtures/delivery/uber/pedido-cantidad2-con-modificadores-uapi.json')
  const conCantidadMod = (v: unknown) => {
    const p = JSON.parse(fs.readFileSync(CANT2, 'utf8'))
    p.order.carts[0].items[0].selected_modifier_groups[1].selected_items[0].quantity = { amount: v, unit: 'PIECE' }
    return p
  }

  it.each([0, -2, 1.5])('🔴 RECHAZA quantity=%s del modificador en vez de volverla 1', v => {
    expect(() => mapUberOrder(conCantidadMod(v))).toThrow(/modificador .* no es un entero positivo/)
  })
})
