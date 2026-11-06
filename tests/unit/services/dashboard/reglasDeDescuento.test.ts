/**
 * D14 v2 (5-nov-2026): una sola regla para descuentos y cupones, que valida el RESULTADO (lo guardado + el cambio).
 * Cada caso cita el hallazgo de Codex (docs/audit/2026-11-05-hallazgos-videos/codex-d14-d15-rN.md) que lo motivó.
 */
import {
  CAMBIO_CRUZADO,
  dondeEscribir,
  FORMA_INVALIDA,
  LIMITE_INVALIDO,
  SIN_CATEGORIAS,
  validarCambioDeDescuento,
} from '../../../../src/services/dashboard/reglasDeDescuento'

const guardado = (o: Record<string, unknown> = {}) => ({
  scope: 'ORDER',
  targetCategoryIds: [] as string[],
  maxTotalUses: null as number | null,
  maxUsesPerCustomer: null as number | null,
  ...o,
})

describe('validarCambioDeDescuento · familia A («Categorías» sin categorías)', () => {
  it('crear «Categorías» sin lista o con lista vacía: no (panel, MCP, apps)', () => {
    expect(validarCambioDeDescuento(null, { scope: 'CATEGORY' })).toBe(SIN_CATEGORIAS)
    expect(validarCambioDeDescuento(null, { scope: 'CATEGORY', targetCategoryIds: [] })).toBe(SIN_CATEGORIAS)
    expect(validarCambioDeDescuento(null, { scope: 'CATEGORY', targetCategoryIds: ['c1'] })).toBeNull()
    expect(validarCambioDeDescuento(null, {})).toBeNull() // ORDER por default
  })

  it('🔴 r1 #1: editar parcial que vacía la lista o pone «Categorías» sin lista: no', () => {
    expect(validarCambioDeDescuento(guardado({ scope: 'CATEGORY', targetCategoryIds: ['c1'] }), { targetCategoryIds: [] })).toBe(
      SIN_CATEGORIAS,
    )
    expect(validarCambioDeDescuento(guardado(), { scope: 'CATEGORY' })).toBe(SIN_CATEGORIAS)
  })

  it('🔴 r2 #1: «Duplicar» (crear desde una copia) uno viejo sin categorías: no', () => {
    const viejo = guardado({ scope: 'CATEGORY', targetCategoryIds: [] })
    expect(validarCambioDeDescuento(null, viejo)).toBe(SIN_CATEGORIAS)
  })

  it('🔴 r2 #2 y r3 #1: formas de Prisma ({ set }) en la lista o el alcance: no', () => {
    const g = guardado({ scope: 'CATEGORY', targetCategoryIds: ['c1'] })
    expect(validarCambioDeDescuento(g, { targetCategoryIds: { set: [] } })).toBe(FORMA_INVALIDA)
    expect(validarCambioDeDescuento(guardado(), { scope: { set: 'CATEGORY' } })).toBe(FORMA_INVALIDA)
    expect(validarCambioDeDescuento(null, { scope: 'CATEGORY', targetCategoryIds: { set: [] } })).toBe(FORMA_INVALIDA)
    expect(validarCambioDeDescuento(g, { targetCategoryIds: [1] })).toBe(FORMA_INVALIDA)
    expect(validarCambioDeDescuento(g, { scope: 'NADA' })).toBe(FORMA_INVALIDA)
    expect(validarCambioDeDescuento(g, { scope: null })).toBe(FORMA_INVALIDA)
  })

  it('🔴 r3 #2, r4 #1 y r5 #4: uno VIEJO «Categorías» sin categorías se apaga o renombra reenviando su alcance igual', () => {
    const viejo = guardado({ scope: 'CATEGORY', targetCategoryIds: [] })
    expect(validarCambioDeDescuento(viejo, { active: false })).toBeNull()
    expect(validarCambioDeDescuento(viejo, { scope: 'CATEGORY', name: 'Otro' })).toBeNull() // iOS: sin lista
    expect(validarCambioDeDescuento(viejo, { scope: 'CATEGORY', targetCategoryIds: [], active: false })).toBeNull() // panel y ANDROID
  })

  it('el viejo vacío puede arreglarse (elegir categorías o cambiar de alcance)', () => {
    const viejo = guardado({ scope: 'CATEGORY', targetCategoryIds: [] })
    expect(validarCambioDeDescuento(viejo, { targetCategoryIds: ['c1'] })).toBeNull()
    expect(validarCambioDeDescuento(viejo, { scope: 'ORDER' })).toBeNull()
  })
})

describe('validarCambioDeDescuento · familia B (límites de uso)', () => {
  it('crear: 1 o más, o null/vacío; 0, negativos y decimales no', () => {
    expect(validarCambioDeDescuento(null, { maxTotalUses: 1, maxUsesPerCustomer: 5 })).toBeNull()
    expect(validarCambioDeDescuento(null, { maxTotalUses: null })).toBeNull()
    expect(validarCambioDeDescuento(null, { maxTotalUses: 0 })).toBe(LIMITE_INVALIDO)
    expect(validarCambioDeDescuento(null, { maxUsesPerCustomer: -1 })).toBe(LIMITE_INVALIDO)
    expect(validarCambioDeDescuento(null, { maxUses: 2.5 })).toBe(LIMITE_INVALIDO) // cupones
    expect(validarCambioDeDescuento(null, { maxUses: '3' })).toBe(LIMITE_INVALIDO)
  })

  it('🔴 r5 #2: «Duplicar» uno con límites 0 o negativos: no', () => {
    expect(validarCambioDeDescuento(null, guardado({ maxTotalUses: 0 }))).toBe(LIMITE_INVALIDO)
    expect(validarCambioDeDescuento(null, guardado({ maxUsesPerCustomer: -1 }))).toBe(LIMITE_INVALIDO)
  })

  it('🔴 r5 #3: editar uno con un 0 viejo reenviándolo igual: sí; cambiarlo a 0 o negativo: no', () => {
    const viejo = guardado({ maxTotalUses: 0 })
    expect(validarCambioDeDescuento(viejo, { maxTotalUses: 0, name: 'Otro' })).toBeNull()
    expect(validarCambioDeDescuento(viejo, { maxTotalUses: -1 })).toBe(LIMITE_INVALIDO)
    expect(validarCambioDeDescuento(guardado({ maxTotalUses: 5 }), { maxTotalUses: 0 })).toBe(LIMITE_INVALIDO)
  })

  it('🔴 r4 #3: null al editar = sin límite (vale)', () => {
    expect(validarCambioDeDescuento(guardado({ maxTotalUses: 5 }), { maxTotalUses: null })).toBeNull()
  })

  it('🔴 r4 #2: cupones de las apps con 0 o -1 al crear: no', () => {
    const cupon = { maxUses: null, maxUsesPerCustomer: null }
    expect(validarCambioDeDescuento(null, { maxUses: 0 })).toBe(LIMITE_INVALIDO)
    expect(validarCambioDeDescuento(cupon, { maxUsesPerCustomer: -1 })).toBe(LIMITE_INVALIDO)
    expect(validarCambioDeDescuento({ maxUses: 0, maxUsesPerCustomer: null }, { maxUses: 0 })).toBeNull() // ANDROID reenvía el 0 viejo
  })
})

describe('dondeEscribir · dos ediciones a la vez', () => {
  const g = guardado({ scope: 'CATEGORY', targetCategoryIds: ['c1'], maxTotalUses: 3 })

  it('🔴 r5 #1 y r2 #3: si el cambio MANDA un campo de la regla (aunque sea igual), escribe sólo si siguen como se leyeron', () => {
    expect(dondeEscribir('d1', g, { scope: 'CATEGORY', name: 'A' })).toEqual({
      id: 'd1',
      scope: 'CATEGORY',
      targetCategoryIds: { equals: ['c1'] },
      maxTotalUses: 3,
      maxUsesPerCustomer: null,
    })
    expect(dondeEscribir('d1', g, { maxTotalUses: null })).toHaveProperty('scope', 'CATEGORY')
  })

  it('🔴 diseño #1: lista vacía guardada acepta [] o NULL en la base (Prisma lee NULL como [])', () => {
    expect(dondeEscribir('d1', guardado({ scope: 'CATEGORY' }), { scope: 'CATEGORY' })).toEqual(
      expect.objectContaining({ OR: [{ targetCategoryIds: { equals: [] } }, { targetCategoryIds: { equals: null } }] }),
    )
  })

  it('un cambio que no manda la regla (prender, apagar, nombre) escribe sólo por id', () => {
    expect(dondeEscribir('d1', g, { active: false, name: 'B' })).toEqual({ id: 'd1' })
  })

  it('cupones: compara sus límites', () => {
    expect(dondeEscribir('k1', { maxUses: 0, maxUsesPerCustomer: null }, { maxUses: 0 })).toEqual({
      id: 'k1',
      maxUses: 0,
      maxUsesPerCustomer: null,
    })
  })

  it('el mensaje del 409 va en español', () => {
    expect(CAMBIO_CRUZADO).toMatch(/^Alguien más lo cambió/)
  })
})
