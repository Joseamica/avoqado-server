import { SetRawMaterialPresentationsSchema, UpdatePurchaseOrderSchema } from '@/schemas/dashboard/inventory.schema'

/**
 * El nombre de la presentación se congela en `PurchaseOrderItem.presentationName`
 * y está pensado para imprimirse después en la orden de compra / remisión, donde
 * ya no lo protege el escapado de React. Por eso el nombre se valida en el borde:
 * empaques reales sí, marcado no.
 */

const params = { venueId: 'cmpe64yq2001f9k92m0lbhmf4', rawMaterialId: 'cmpe652d500qh9k920gxsqhp6' }
const parse = (name: string) =>
  SetRawMaterialPresentationsSchema.safeParse({
    params,
    body: { presentations: [{ name, factorToBase: 12 }] },
  })

describe('SetRawMaterialPresentationsSchema — nombre de la presentación', () => {
  describe('acepta nombres de empaque reales', () => {
    it.each(['caja', 'cono', 'costal', 'bolsa 5 kg', 'media-caja', '1/2 tarima', 'caja (chica)', 'paca 20 pz', 'kilogramo', 'garrafón'])(
      '%s',
      name => {
        expect(parse(name).success).toBe(true)
      },
    )

    it('acepta acentos y ñ (los insumos se capturan en español)', () => {
      expect(parse('cajón pequeño').success).toBe(true)
    })
  })

  describe('REGRESIÓN de seguridad: rechaza marcado', () => {
    it.each([
      ['<script>alert(1)</script>', 'script tag'],
      ['<img src=x onerror=window.__XSS__=1>', 'img onerror'],
      ['caja<br>', 'tag suelto'],
      ['caja"onmouseover="x', 'atributo inyectado'],
    ])('rechaza %s (%s)', name => {
      const result = parse(name)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/sólo puede tener letras/i)
      }
    })

    it("el nombre con comilla simple SÍ pasa (Prisma parametriza; \"1/2 pieza' \" es legítimo)", () => {
      expect(parse("caja 'chica'").success).toBe(true)
    })
  })

  describe('límites que ya existían (no romper)', () => {
    it('rechaza nombre vacío', () => {
      expect(parse('   ').success).toBe(false)
    })

    it('rechaza más de 40 caracteres', () => {
      expect(parse('A'.repeat(41)).success).toBe(false)
    })

    it('rechaza factor cero', () => {
      const r = SetRawMaterialPresentationsSchema.safeParse({
        params,
        body: { presentations: [{ name: 'caja', factorToBase: 0 }] },
      })
      expect(r.success).toBe(false)
    })

    it('un set vacío es válido (limpia las presentaciones)', () => {
      const r = SetRawMaterialPresentationsSchema.safeParse({ params, body: { presentations: [] } })
      expect(r.success).toBe(true)
    })
  })
})

describe('UpdatePurchaseOrderSchema — el snapshot NO se puede perder al editar', () => {
  // Bug real: `presentationName` estaba sólo en el schema de CREAR. Zod lo tiraba
  // del payload de actualizar, y como el update BORRA y recrea los renglones, la
  // orden quedaba sin factor: al recibirla el stock entraba ÷12 y el costo ×12.
  const params = { venueId: 'cmpe64yq2001f9k92m0lbhmf4', purchaseOrderId: 'cmpe652d500qh9k920gxsqhp6' }

  it('conserva presentationName al actualizar renglones', () => {
    const r = UpdatePurchaseOrderSchema.safeParse({
      params,
      body: {
        items: [{ rawMaterialId: 'cmpe652d500qh9k920gxsqhp6', quantityOrdered: 30, unit: 'KILOGRAM', unitPrice: 360, presentationName: 'caja' }],
      },
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.body.items?.[0].presentationName).toBe('caja')
  })

  it('sigue aceptando un renglón SIN presentación (comportamiento de siempre)', () => {
    const r = UpdatePurchaseOrderSchema.safeParse({
      params,
      body: { items: [{ rawMaterialId: 'cmpe652d500qh9k920gxsqhp6', quantityOrdered: 8, unit: 'KILOGRAM', unitPrice: 25 }] },
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.body.items?.[0].presentationName).toBeUndefined()
  })
})
