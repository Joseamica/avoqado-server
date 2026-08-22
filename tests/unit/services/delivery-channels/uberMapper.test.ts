/**
 * Traductor de Uber → contrato interno, probado contra un PEDIDO REAL.
 *
 * El fixture `pedido-real-delivery-by-uber.json` salió de un pedido de verdad hecho el
 * 2026-08-20 contra la tienda de prueba "Avoqado Sandbox 1". No está inventado: corrigió
 * tres suposiciones que traía la spec y que habrían roto este mapper en producción.
 */
import fixture from '../../../fixtures/delivery/uber/pedido-real-delivery-by-uber.json'
import { mapUberOrder } from '@/services/delivery-channels/providers/uber-eats/uber.mapper'

describe('uber.mapper — contra el pedido real', () => {
  it('traduce el pedido completo', () => {
    const o = mapUberOrder(fixture)

    expect(o.externalId).toBe('dbe79abc-5a6a-4b3d-85fb-cb7b15e77645')
    expect(o.displayId).toBe('77645')
    expect(o.items).toHaveLength(1)
    expect(o.placedAt.toISOString()).toBe('2026-08-20T20:05:55.000Z') // -06:00 → UTC
  })

  it('🔴 `title` es un STRING plano en el pedido, no `title.translations.en`', () => {
    // La spec decía translations. Eso es del MENÚ; el PEDIDO manda texto plano.
    expect(mapUberOrder(fixture).items[0].name).toBe('Best Burger')
  })

  it('🔴 `quantity` es un entero, no un objeto con `.amount`', () => {
    expect(mapUberOrder(fixture).items[0].quantity).toBe(1)
  })

  it('🔴 convierte centavos a PESOS: 100 → "1.00"', () => {
    const item = mapUberOrder(fixture).items[0]
    expect(item.unitPrice).toBe('1.00')
    expect(item.total).toBe('1.00')
  })

  it('el id del item viaja como externalData: es lo que Avoqado publicó en el menú', () => {
    const item = mapUberOrder(fixture).items[0]
    expect(item.externalId).toBe('external_item_1')
    expect(item.externalData).toBe('external_item_1')
  })

  it('🔴 `selected_modifier_groups: null` no revienta ni inventa modificadores', () => {
    expect(mapUberOrder(fixture).items[0].modifiers).toEqual([])
  })

  it('🔴 cuando reparte Uber NO hay propina: el reparto la deja en cero', () => {
    // Verificado con el pedido real: `payment.charges` sólo trae total y sub_total.
    const p = mapUberOrder(fixture).payment
    expect(p.tipAmount).toBe('0.00')
    expect(p.externallyPaidTip).toBe('0.00')
    expect(p.cashDueTip).toBe('0.00')
  })

  it('🔴 lo paga la plataforma: nada queda por cobrar en efectivo', () => {
    const p = mapUberOrder(fixture).payment
    expect(p.saleAmount).toBe('1.00')
    expect(p.externallyPaidSale).toBe('1.00')
    expect(p.cashDueSale).toBe('0.00')
    expect(p.currency).toBe('MXN')
  })

  it('el reparto cuadra al centavo, que es lo que la ingesta exige', () => {
    const p = mapUberOrder(fixture).payment
    const venta = Number(p.saleAmount) + Number(p.merchantFees)
    expect(venta.toFixed(2)).toBe((Number(p.externallyPaidSale) + Number(p.cashDueSale)).toFixed(2))
  })

  it('conserva el cliente y el JSON crudo para auditoría', () => {
    const o = mapUberOrder(fixture)
    expect(o.customer?.name).toContain('Avoqado')
    expect(o.customer?.phone).toBe('+52 33 1930 9789')
    expect(o.raw).toBe(fixture)
  })

  it('🔴 RECHAZA un pedido sin id: mejor fallar visible que ingerir basura', () => {
    expect(() => mapUberOrder({ ...fixture, id: undefined })).toThrow(/id/i)
  })

  it('🔴 RECHAZA una moneda que no sea MXN', () => {
    const otra = JSON.parse(JSON.stringify(fixture))
    otra.payment.charges.total.currency_code = 'USD'
    expect(() => mapUberOrder(otra)).toThrow(/MXN|moneda/i)
  })

  it('un cargo extra del comercio entra como merchantFees y sigue cuadrando', () => {
    const conCargo = JSON.parse(JSON.stringify(fixture))
    conCargo.payment.charges.total.amount = 150 // total > sub_total ⇒ 0.50 de cargos
    const p = mapUberOrder(conCargo).payment
    expect(p.saleAmount).toBe('1.00')
    expect(p.merchantFees).toBe('0.50')
    expect(p.externallyPaidSale).toBe('1.50')
  })

  // ============================================================
  // HALLAZGO 1 (auditoría externa, 2026-08-20): el mapper hacía la aritmética interna con
  // `number` (Number(), restas, multiplicaciones) antes de producir el string decimal —
  // viola `.claude/rules/critical-warnings.md` ("Money = Decimal, Never Float") y permite
  // redondeos silenciosos del estilo `0.1 + 0.2 !== 0.3`.
  // ============================================================
  describe('dinero: Decimal, nunca float (Hallazgo 1)', () => {
    it('🔴 valor extremo: unitario × cantidadPadre en `number` pierde 1 centavo al cruzar Number.MAX_SAFE_INTEGER; con Decimal no', () => {
      // Caso deliberadamente extremo (nadie vende una hamburguesa en $90 billones de pesos) —
      // existe para forzar la frontera exacta donde `number` deja de ser exacto (2^53) y
      // probar que Decimal no hereda el error. En `number`: 3002399751580331 × 3 =
      // 9007199254740992 (equivocado por 1 centavo). En Decimal: 9007199254740993 (exacto).
      // Verificado con Prisma.Decimal directo antes de escribir este test.
      const conModificadorExtremo = JSON.parse(JSON.stringify(fixture))
      conModificadorExtremo.cart.items[0].quantity = 3
      conModificadorExtremo.cart.items[0].selected_modifier_groups = [
        {
          selected_items: [
            {
              id: 'mod-extremo',
              title: 'Modificador extremo',
              quantity: 1,
              price: { unit_price: { amount: 3002399751580331 } },
            },
          ],
        },
      ]
      const modifier = mapUberOrder(conModificadorExtremo).items[0].modifiers?.[0]
      expect(modifier?.price).toBe('90071992547409.93')
    })
  })

  // ============================================================
  // HALLAZGO 3 (auditoría externa, 2026-08-20): `montoDe` no distinguía "el cargo no existe"
  // (legítimamente ausente, p.ej. `charges.tip` sin propina) de "el cargo existe pero
  // `.amount` no es un número" (payload corrupto) — ambos colapsaban a $0 en silencio. Un
  // `charges.total.amount` corrupto producía un pedido de $0 que el núcleo marca PAID y
  // descuenta inventario de comida jamás cobrada.
  // ============================================================
  describe('dinero: "no existe" vs. "corrupto" en charges.total.amount (Hallazgo 3)', () => {
    it('🔴 RECHAZA si charges.total.amount existe pero NO es un número (string) — antes se volvía $0 en silencio', () => {
      const corrupto = JSON.parse(JSON.stringify(fixture))
      corrupto.payment.charges.total.amount = 'gratis'
      expect(() => mapUberOrder(corrupto)).toThrow(/corrupto/i)
    })

    it('🔴 RECHAZA si charges.total.amount es un objeto en vez de un número', () => {
      const corrupto = JSON.parse(JSON.stringify(fixture))
      corrupto.payment.charges.total.amount = { no: 'es un número' }
      expect(() => mapUberOrder(corrupto)).toThrow(/corrupto/i)
    })

    it('🔴 RECHAZA si charges.total.amount es NaN', () => {
      const corrupto = JSON.parse(JSON.stringify(fixture))
      corrupto.payment.charges.total.amount = NaN
      expect(() => mapUberOrder(corrupto)).toThrow(/corrupto/i)
    })

    it('🔴 RECHAZA si charges.sub_total.amount es un booleano', () => {
      const corrupto = JSON.parse(JSON.stringify(fixture))
      corrupto.payment.charges.sub_total.amount = true
      expect(() => mapUberOrder(corrupto)).toThrow(/corrupto/i)
    })

    it('regresión: el cargo entero AUSENTE (p.ej. sin propina) sigue siendo legítimo, no rechaza', () => {
      // `charges.tip` no existe del todo en el pedido real: no es corrupción, es que no hubo
      // propina. Esto ya funcionaba antes del fix y debe seguir funcionando igual.
      expect(mapUberOrder(fixture).payment.tipAmount).toBe('0.00')
    })
  })

  // ============================================================
  // HALLAZGO 4 (auditoría externa, 2026-08-20): el mapper fijaba cashDueSale/cashDueTip en
  // '0.00' SIEMPRE — válido sólo para pedidos que Uber liquida 100% en su app. Un pedido BYOC
  // (`type: DELIVERY_BY_RESTAURANT`) con efectivo contra entrega (`cash_amount_due`) quedaría
  // falsamente marcado PAID: Payment externo creado, inventario descontado, sin que el cobro
  // real haya ocurrido nunca.
  //
  // NO tenemos un pedido BYOC real para verificar el reparto exacto de `cash_amount_due`
  // entre "efectivo que se queda el comercio" y "efectivo que el comercio cobra EN NOMBRE de
  // Uber" (documentado como riesgo abierto en
  // docs/superpowers/specs/2026-08-17-delivery-uber-eats-ANEXO-investigacion.md §5.1, campo
  // `cashPassThroughToPlatform` — el contrato NormalizedDeliveryPayment todavía no lo tiene).
  // Mientras tanto: RECHAZA en vez de adivinar ese reparto.
  // ============================================================
  describe('dinero: BYOC / cash_amount_due se rechaza, nunca se adivina (Hallazgo 4)', () => {
    it('🔴 RECHAZA un pedido con cash_amount_due > 0 — antes se ingería como si Uber lo hubiera liquidado todo', () => {
      const byoc = JSON.parse(JSON.stringify(fixture))
      byoc.type = 'DELIVERY_BY_RESTAURANT'
      byoc.payment.charges.cash_amount_due = { amount: 100, currency_code: 'MXN', formatted_amount: 'MX$1.00' }
      expect(() => mapUberOrder(byoc)).toThrow(/cash_amount_due/i)
    })

    it('🔴 RECHAZA cash_amount_due > 0 aunque `type` no sea DELIVERY_BY_RESTAURANT (combinación no documentada)', () => {
      const raro = JSON.parse(JSON.stringify(fixture)) // type sigue siendo DELIVERY_BY_UBER
      raro.payment.charges.cash_amount_due = { amount: 50 }
      expect(() => mapUberOrder(raro)).toThrow(/cash_amount_due/i)
    })

    it('acepta cash_amount_due presente pero en CERO — nada que repartir, sigue pagado por la plataforma', () => {
      const sinAmbiguedad = JSON.parse(JSON.stringify(fixture))
      sinAmbiguedad.type = 'DELIVERY_BY_RESTAURANT'
      sinAmbiguedad.payment.charges.cash_amount_due = { amount: 0 }
      const p = mapUberOrder(sinAmbiguedad).payment
      expect(p.cashDueSale).toBe('0.00')
      expect(p.cashDueTip).toBe('0.00')
    })

    it('regresión: el pedido real (DELIVERY_BY_UBER, sin cash_amount_due) no lo toca este hallazgo', () => {
      const p = mapUberOrder(fixture).payment
      expect(p.cashDueSale).toBe('0.00')
      expect(p.cashDueTip).toBe('0.00')
    })
  })
  it('🔴 sin `total` ni `sub_total`: RECHAZA en vez de crear una venta de $0', () => {
    // El hueco que quedaba: `montoDe` devolvía 0 ante un cargo ausente, así que un pedido
    // sin bloque de cobros producía una venta de cero pesos, ingerida como legítima y
    // pagada. Para un PEDIDO esos dos campos no son opcionales — que falten es corrupción,
    // no gratuidad. (`tip` y `cash_amount_due` sí faltan de verdad: el pedido real no los
    // trae, y por eso ésos siguen resolviendo a 0.)
    const sinCobros = { ...fixture, payment: { charges: {} } }
    expect(() => mapUberOrder(sinCobros)).toThrow(/total/i)
  })

  it('🔴 con `sub_total` pero sin `total`: tampoco adivina', () => {
    // Peor que el anterior porque parece sano: la venta entraría al subtotal y los cargos
    // que el comercio SÍ cobró se perderían en silencio.
    const sinTotal = { ...fixture, payment: { charges: { sub_total: { amount: 100, currency_code: 'MXN' } } } }
    expect(() => mapUberOrder(sinTotal)).toThrow(/total/i)
  })
  it('🔴 la nota del cliente viaja al contrato: es lo que la cocina lee', () => {
    // "sin cebolla" no es un adorno: sin ella la comanda sale mal y el cliente devuelve el
    // plato. Es el único dato del pedido que no se puede reconstruir de ningún otro lado.
    const conNota = {
      ...fixture,
      cart: { ...fixture.cart, items: [{ ...fixture.cart.items[0], special_instructions: '  Sin cebolla, por favor  ' }] },
    }
    expect(mapUberOrder(conNota).items[0].notes).toBe('Sin cebolla, por favor') // recortada
  })

  it('una nota vacía o mal formada no rompe el pedido: queda en null', () => {
    // Un pedido perdido por una nota con basura sería el peor intercambio posible.
    for (const basura of ['   ', 42, null, { texto: 'x' }]) {
      const raro = { ...fixture, cart: { ...fixture.cart, items: [{ ...fixture.cart.items[0], special_instructions: basura }] } }
      expect(mapUberOrder(raro).items[0].notes).toBeNull()
    }
  })
})
