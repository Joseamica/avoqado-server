/**
 * D14 v2 (5-nov-2026): una sola regla para descuentos y cupones, que valida el RESULTADO (lo guardado + el cambio).
 * Cada caso cita el hallazgo de Codex (docs/audit/2026-11-05-hallazgos-videos/codex-d14-d15-rN.md) que lo motivó.
 */
import {
  CAMBIO_CRUZADO,
  dondeEscribir,
  FORMA_INVALIDA,
  LIMITE_INVALIDO,
  RANGO_AL_REVES,
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

describe('validarCambioDeDescuento · familia C (vigencia, D37)', () => {
  const d = (iso: string) => new Date(iso)
  const del18al20 = guardado({ validFrom: d('2026-12-18T06:00:00.000Z'), validUntil: d('2026-12-21T05:59:59.999Z') })

  it('crear con «desde» después de «hasta»: no; igual, antes o con una sola fecha: sí', () => {
    expect(validarCambioDeDescuento(null, { validFrom: d('2026-12-20T06:00:00Z'), validUntil: d('2026-12-13T05:59:59Z') })).toBe(
      RANGO_AL_REVES,
    )
    expect(validarCambioDeDescuento(null, { validFrom: d('2026-12-01T06:00:00Z'), validUntil: d('2026-12-02T05:59:59Z') })).toBeNull()
    expect(validarCambioDeDescuento(null, { validUntil: d('2026-12-02T05:59:59Z') })).toBeNull()
    expect(validarCambioDeDescuento(null, {})).toBeNull()
  })

  it('🔴 Codex D37 r1 #3 y r2 #2: editar SÓLO una fecha mira el resultado con la otra guardada (dos encargados a la vez)', () => {
    // A ya movió el inicio al 18; B, con su formulario viejo, adelanta el fin al 12 → quedaría del 18 al 12: no.
    expect(validarCambioDeDescuento(del18al20, { validUntil: d('2026-12-13T05:59:59.999Z') })).toBe(RANGO_AL_REVES)
    expect(validarCambioDeDescuento(del18al20, { validFrom: d('2026-12-25T06:00:00.000Z') })).toBe(RANGO_AL_REVES)
    expect(validarCambioDeDescuento(del18al20, { validUntil: d('2026-12-30T05:59:59.999Z') })).toBeNull()
  })

  it('las apps mandan texto: se lee igual; vacío o null quita la fecha', () => {
    expect(validarCambioDeDescuento(del18al20, { validUntil: '2026-12-12' })).toBe(RANGO_AL_REVES)
    expect(validarCambioDeDescuento(del18al20, { validFrom: null, validUntil: '2026-12-12' })).toBeNull()
    expect(validarCambioDeDescuento(del18al20, { validFrom: '', validUntil: '2026-12-12' })).toBeNull()
  })

  it('uno viejo que YA está al revés: editar otra cosa sí; mandarle fechas que lo dejan al revés, no', () => {
    const alReves = guardado({ validFrom: d('2026-12-20T06:00:00Z'), validUntil: d('2026-12-13T05:59:59Z') })
    expect(validarCambioDeDescuento(alReves, { maxTotalUses: 5 })).toBeNull()
    expect(validarCambioDeDescuento(alReves, { validUntil: d('2026-12-14T05:59:59Z') })).toBe(RANGO_AL_REVES)
    expect(validarCambioDeDescuento(alReves, { validUntil: d('2026-12-31T05:59:59Z') })).toBeNull()
  })

  it('🔴 Codex D37 r3 #2: se lee igual que lo guardan las apps: 0 quita la fecha y un número son milisegundos', () => {
    // Antes del arreglo, `validUntil: 0` se leía como el año 2000 y daba 400; ahora es «sin fecha», como lo guarda el controlador.
    expect(validarCambioDeDescuento(del18al20, { validUntil: 0 })).toBeNull()
    // Un fin anterior al inicio mandado como número de ms: se rechaza (antes pasaba la regla y se guardaba).
    expect(validarCambioDeDescuento(del18al20, { validUntil: new Date('2026-12-13T05:59:59.999Z').getTime() })).toBe(RANGO_AL_REVES)
  })

  it('«Duplicar» (crear desde una copia) uno al revés: no', () => {
    const alReves = guardado({ validFrom: d('2026-12-20T06:00:00Z'), validUntil: d('2026-12-13T05:59:59Z') })
    expect(validarCambioDeDescuento(null, alReves)).toBe(RANGO_AL_REVES)
  })
})

describe('dondeEscribir · dos ediciones a la vez', () => {
  it('🔴 Codex D37 r3 #1: si el cambio trae una fecha, se escribe sólo si las dos fechas siguen como se leyeron (dos guardados a la vez)', () => {
    const leido = guardado({ validFrom: new Date('2026-12-10T06:00:00.000Z'), validUntil: new Date('2026-12-21T05:59:59.999Z') })
    expect(dondeEscribir('k1', leido, { validUntil: new Date('2026-12-13T05:59:59.999Z') })).toEqual({
      id: 'k1',
      validFrom: new Date('2026-12-10T06:00:00.000Z'),
      validUntil: new Date('2026-12-21T05:59:59.999Z'),
    })
    // Sin fechas ni regla en el cambio: sólo por id (no hay 409 falso).
    expect(dondeEscribir('k1', leido, { active: false })).toEqual({ id: 'k1' })
  })

  it('🔴 Codex D37 r4 #2: guardar un límite o el alcance NO se condiciona a las fechas (otra persona que sólo movió una fecha no da 409)', () => {
    const leido = guardado({ maxTotalUses: 3, validFrom: new Date('2026-12-10T06:00:00.000Z'), validUntil: null })
    expect(dondeEscribir('d1', leido, { maxTotalUses: 5 })).toEqual({
      id: 'd1',
      scope: 'ORDER',
      OR: [{ targetCategoryIds: { equals: [] } }, { targetCategoryIds: { equals: null } }],
      maxTotalUses: 3,
      maxUsesPerCustomer: null,
    })
  })

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
