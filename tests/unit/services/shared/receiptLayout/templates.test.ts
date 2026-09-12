import { CANONICAL_LAYOUT, TEMPLATES, templateHash } from '@/services/shared/receiptLayout/templates'
import { validateLayout } from '@/services/shared/receiptLayout/validateLayout'

describe('recetas semilla', () => {
  it('las cinco pasan el candado de integridad', () => {
    for (const t of Object.values(TEMPLATES)) expect({ id: t.id, problems: validateLayout(t.blocks) }).toEqual({ id: t.id, problems: [] })
  })

  it('la canónica tiene los 20 bloques del spec § 5.7 en ese orden', () => {
    expect(CANONICAL_LAYOUT.map(b => b.type)).toEqual([
      'logo',
      'businessName',
      'fiscal',
      'address',
      'phone',
      'separator',
      'orderInfo',
      'staff',
      'separator',
      'items',
      'separator',
      'totals',
      'payment',
      'areaDelivery',
      'qr',
      'fiscalNotice',
      'separator',
      'text',
      'reference',
      'signature',
    ])
  })

  it('cada receta tiene todos sus defaults explícitos (lo que las apps y el golden van a leer)', () => {
    expect(CANONICAL_LAYOUT[0]).toEqual({ type: 'logo', size: 'M', align: 'center' })
    expect(CANONICAL_LAYOUT[11]).toEqual({ type: 'totals', showSubtotal: true, showTax: true, showDiscount: true, showTip: true })
  })

  it('el hash es determinista, corto y distinto por receta', () => {
    expect(templateHash(CANONICAL_LAYOUT)).toBe(templateHash([...CANONICAL_LAYOUT]))
    expect(TEMPLATES.canonical.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(new Set(Object.values(TEMPLATES).map(t => t.hash)).size).toBe(5)
  })
})
