import { validateAndResolveModifiers, UpsellModifierError } from '@/services/upsell/upsellModifiers'

const grupo = (id: string, required: boolean, mods: Array<{ id: string; name: string; price: number; active?: boolean }>) => ({
  group: { id, name: `Grupo ${id}`, required, modifiers: mods.map(m => ({ active: true, ...m })) },
})

const producto = (groups: any[], extra: Partial<any> = {}) => ({
  id: 'prod_1',
  soldByWeight: false,
  upsellEnabled: true,
  modifierGroups: groups,
  ...extra,
})

describe('validateAndResolveModifiers', () => {
  it('producto sin grupos obligatorios y sin selección → lista vacía', () => {
    expect(validateAndResolveModifiers(producto([]), null)).toEqual([])
  })

  it('ignora los grupos OPCIONALES: no hay que resolverlos', () => {
    const p = producto([grupo('g_op', false, [{ id: 'm1', name: 'Extra', price: 10 }])])
    expect(validateAndResolveModifiers(p, null)).toEqual([])
  })

  // 🔴 El caso del founder: "Agua Mineral 1L" con el grupo "Tamaño" obligatorio.
  it('grupo OBLIGATORIO sin resolver → error MISSING_REQUIRED_MODIFIER con el nombre del grupo', () => {
    const p = producto([grupo('g_tam', true, [{ id: 'm_ch', name: 'Chico', price: 0 }])])
    expect(() => validateAndResolveModifiers(p, null)).toThrow(UpsellModifierError)
    try {
      validateAndResolveModifiers(p, null)
    } catch (e: any) {
      expect(e.code).toBe('MISSING_REQUIRED_MODIFIER')
      // El mensaje va a la UI: tiene que nombrar QUÉ falta, no un id.
      expect(e.message).toContain('Grupo g_tam')
    }
  })

  it('grupo obligatorio resuelto → devuelve nombre y precio para pintar la tarjeta', () => {
    const p = producto([
      grupo('g_tam', true, [
        { id: 'm_ch', name: 'Chico', price: 0 },
        { id: 'm_gr', name: 'Grande', price: 15 },
      ]),
    ])
    expect(validateAndResolveModifiers(p, [{ groupId: 'g_tam', modifierId: 'm_gr' }])).toEqual([
      { groupId: 'g_tam', modifierId: 'm_gr', name: 'Grande', price: 15 },
    ])
  })

  // Ambigüedad del brief resuelta por ruling explícito (progress.md): unificar TODOS los
  // tests de error al patrón try/catch + expect(e.code).toBe(...), en vez de
  // `toThrow(expect.objectContaining({ code }))` (matcher asimétrico no garantizado en
  // toda versión de Jest). `expect.assertions(N)` evita que el test pase en falso si la
  // función deja de lanzar.
  it('modificador que NO pertenece al grupo → MODIFIER_NOT_IN_GROUP', () => {
    expect.assertions(1)
    const p = producto([
      grupo('g_tam', true, [{ id: 'm_ch', name: 'Chico', price: 0 }]),
      grupo('g_otro', false, [{ id: 'm_x', name: 'Ajeno', price: 5 }]),
    ])
    try {
      validateAndResolveModifiers(p, [{ groupId: 'g_tam', modifierId: 'm_x' }])
    } catch (e: any) {
      expect(e.code).toBe('MODIFIER_NOT_IN_GROUP')
    }
  })

  it('modificador INACTIVO → MODIFIER_INACTIVE (la tarjeta ofrecería algo que ya no se vende)', () => {
    expect.assertions(1)
    const p = producto([grupo('g_tam', true, [{ id: 'm_ch', name: 'Chico', price: 0, active: false }])])
    try {
      validateAndResolveModifiers(p, [{ groupId: 'g_tam', modifierId: 'm_ch' }])
    } catch (e: any) {
      expect(e.code).toBe('MODIFIER_INACTIVE')
    }
  })

  it('resuelve TODOS los obligatorios, no sólo el primero', () => {
    expect.assertions(2)
    const p = producto([grupo('g1', true, [{ id: 'a', name: 'A', price: 1 }]), grupo('g2', true, [{ id: 'b', name: 'B', price: 2 }])])
    try {
      validateAndResolveModifiers(p, [{ groupId: 'g1', modifierId: 'a' }])
    } catch (e: any) {
      expect(e.code).toBe('MISSING_REQUIRED_MODIFIER')
    }
    expect(
      validateAndResolveModifiers(p, [
        { groupId: 'g1', modifierId: 'a' },
        { groupId: 'g2', modifierId: 'b' },
      ]),
    ).toHaveLength(2)
  })

  // Estos dos NO se pueden salvar eligiendo opciones: el POS los descarta igual.
  it('producto vetado por el dueño → PRODUCT_NOT_SUGGESTABLE', () => {
    expect.assertions(1)
    const p = producto([], { upsellEnabled: false })
    try {
      validateAndResolveModifiers(p, null)
    } catch (e: any) {
      expect(e.code).toBe('PRODUCT_NOT_SUGGESTABLE')
    }
  })

  it('producto que se vende por peso → PRODUCT_NOT_SUGGESTABLE', () => {
    expect.assertions(1)
    const p = producto([], { soldByWeight: true })
    try {
      validateAndResolveModifiers(p, null)
    } catch (e: any) {
      expect(e.code).toBe('PRODUCT_NOT_SUGGESTABLE')
    }
  })

  it('el precio de Prisma (Decimal) se normaliza a número', () => {
    const p = producto([grupo('g', true, [{ id: 'm', name: 'X', price: { toString: () => '12.50' } as any }])])
    expect(validateAndResolveModifiers(p, [{ groupId: 'g', modifierId: 'm' }])[0].price).toBe(12.5)
  })
})
