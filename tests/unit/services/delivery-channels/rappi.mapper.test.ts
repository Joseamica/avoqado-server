/**
 * Mapeo del pedido de Rappi.
 *
 * ⚠️ Los payloads salen del ejemplo que Rappi PUBLICA en su portal (`NEW_ORDER_SCHEDULED`),
 * con los montos rellenados a mano para simular un pedido normal. No son pedidos reales: aún
 * no hay sandbox. Prueban la implementación, NO que hayamos leído bien la especificación —
 * eso lo prueba el primer pedido real, y hay que guardarlo como fixture de contrato.
 */
import {
  esPedidoProgramado,
  extraerStoreId,
  normalizeRappiOrder,
  tiempoDeCoccion,
} from '../../../../src/services/delivery-channels/providers/rappi/rappi.mapper'

/** Copia fiel del ejemplo del portal; los montos se pasan por parámetro. */
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
        total_order: over.total ?? 100,
        total_to_pay: over.total ?? 100,
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

describe('normalizeRappiOrder', () => {
  it('mapea un pedido normal: renglones, cliente y venta', () => {
    const o = normalizeRappiOrder(pedido())

    expect(o.externalId).toBe('2150558091')
    expect(o.items).toHaveLength(1)
    expect(o.items[0]).toMatchObject({ name: 'Producto 8', quantity: 4, unitPrice: '25.00', total: '100.00' })
    expect(o.payment.saleAmount).toBe('100.00')
    expect(o.customer?.name).toBe('Ana Muñoz')
  })

  // ── El campo que evita inflar la venta ────────────────────────────────────────────
  it('🔴 usa el precio CON descuento, no el de lista', () => {
    // Cobrar el de lista descuadraría contra el total y le cobraría de más al reporte.
    const o = normalizeRappiOrder(
      pedido({
        total: 50,
        items: [{ id: '1', name: 'X', quantity: 2, sku: 'a', price: 40, unit_price_with_discount: 25, unit_price_without_discount: 40 }],
      }),
    )
    expect(o.items[0].unitPrice).toBe('25.00')
  })

  it('el sku viaja como externalData — es NUESTRO id del producto, no el de Rappi', () => {
    expect(normalizeRappiOrder(pedido()).items[0].externalData).toBe('0007')
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

  // ── La red que hace seguro publicar esto sin sandbox ──────────────────────────────
  // Es el guardrail contra los dos supuestos que no pude verificar: las unidades y cuál
  // campo de `totals` es la venta. Un factor de 100 no puede descubrirse en el corte.
  it('🔴 LANZA si los renglones no cuadran contra el total (unidades equivocadas)', () => {
    // Renglones = 100, pero Rappi dice 10000 → clásico pesos-vs-centavos.
    expect(() => normalizeRappiOrder(pedido({ total: 10000 }))).toThrow(/no cuadra/i)
  })

  it('la propina NO descuadra la venta: se resta antes de comparar', () => {
    const o = normalizeRappiOrder(pedido({ total: 115, tip: 15 }))
    expect(o.payment.saleAmount).toBe('100.00')
    expect(o.payment.tipAmount).toBe('15.00')
  })

  it('tolera el redondeo del proveedor (un centavo por renglón)', () => {
    expect(() => normalizeRappiOrder(pedido({ total: 100.01 }))).not.toThrow()
  })

  it('sin total que comparar NO inventa uno: pasa con la suma de los renglones', () => {
    const p = pedido() as Record<string, any>
    delete p.order_detail.totals.total_to_pay
    delete p.order_detail.totals.total_order
    expect(normalizeRappiOrder(p).payment.saleAmount).toBe('100.00')
  })

  // ── El efectivo de Rappi no es efectivo del comercio ──────────────────────────────
  // `payment_method: "cash"` significa que el cliente le paga al REPARTIDOR. Ese dinero
  // nunca toca el cajón: contarlo como efectivo esperado dejaría el turno con faltante
  // todos los días.
  it('🔴 un pedido en efectivo NO genera efectivo por cobrar en el cajón', () => {
    const o = normalizeRappiOrder(pedido())
    expect(o.payment.cashDueSale).toBe('0.00')
    expect(o.payment.cashDueTip).toBe('0.00')
    expect(o.payment.externallyPaidSale).toBe('100.00')
  })

  it('rechaza un pedido sin id y sin renglones, con mensaje que dice cuál falta', () => {
    expect(() => normalizeRappiOrder({ order_detail: { items: [] } })).toThrow(/order_id/)
    const p = pedido() as Record<string, any>
    p.order_detail.items = []
    expect(() => normalizeRappiOrder(p)).toThrow(/renglones/i)
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
      payment_method: 'cc',
      totals: { total_products_with_discount: 130, other_totals: { tip: 0 } },
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

  it('una fecha ilegible NUNCA tumba el pedido: cae a la de recepción', () => {
    const roto = JSON.parse(JSON.stringify(conSubitems))
    roto.order_detail.created_at = 'ayer por la tarde'
    expect(() => normalizeRappiOrder(roto)).not.toThrow()
  })

  it('el modificador multiplica por SU cantidad', () => {
    const dos = JSON.parse(JSON.stringify(conSubitems))
    dos.order_detail.items[0].subitems[0].quantity = 2
    dos.order_detail.totals.total_products_with_discount = 160
    expect(normalizeRappiOrder(dos).items[0].total).toBe('160.00')
  })

  it('cuadra contra `total_products_with_discount`, NO contra el total del pedido', () => {
    // `total_order` incluye envío y cuota de servicio: cuadrar contra él fallaría siempre.
    const conEnvio = JSON.parse(JSON.stringify(conSubitems))
    conEnvio.order_detail.totals.total_order = 999
    conEnvio.order_detail.totals.charges = { shipping: 50, service_fee: 100 }
    expect(() => normalizeRappiOrder(conEnvio)).not.toThrow()
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
