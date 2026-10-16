// tests/unit/services/customer-display/promotionDisplay.test.ts
import {
  MAX_PRICE_COMBINATIONS,
  centavosDeLista,
  compararPresentacion,
  displayBadge,
  displayPriceCents,
  presentationRanks,
  proximaApertura,
  vigenteEn,
  zonaUtilizable,
  type GrupoParaAnuncio,
  type PromocionParaAnuncio,
} from '@/services/customer-display/promotionDisplay'

const opcion = (listPriceCents: number, over: Partial<{ quantity: number; chargedQuantity: number; priceDeltaCents: number }> = {}) => ({
  quantity: 1,
  chargedQuantity: 1,
  priceDeltaCents: 0,
  listPriceCents,
  ...over,
})
const grupo = (...options: ReturnType<typeof opcion>[]): GrupoParaAnuncio => ({ minSelect: 1, maxSelect: 1, options })
const fijo = (priceCents: number, ...groups: GrupoParaAnuncio[]): PromocionParaAnuncio => ({
  type: 'COMBO',
  pricingMode: 'FIXED_TOTAL',
  priceCents,
  groups,
})
const porUnidad = (...groups: GrupoParaAnuncio[]): PromocionParaAnuncio => ({
  type: 'BUNDLE',
  pricingMode: 'PER_UNIT',
  priceCents: 0,
  groups,
})

describe('displayPriceCents — FIXED_TOTAL', () => {
  it('el precio base cuando TODA selección cuesta en catálogo al menos eso', () => {
    expect(displayPriceCents(fijo(15000, grupo(opcion(9000), opcion(12000)), grupo(opcion(6000))))).toBe(15000)
  })

  it('null si alguna selección cuesta MENOS en catálogo (el tope min(catálogo, base) la bajaría)', () => {
    expect(displayPriceCents(fijo(15000, grupo(opcion(9000), opcion(5000)), grupo(opcion(6000))))).toBeNull()
  })

  it('null con sobreprecio en cualquier opción', () => {
    expect(displayPriceCents(fijo(15000, grupo(opcion(9000, { priceDeltaCents: 500 })), grupo(opcion(9000))))).toBeNull()
  })

  it('null si alguna opción entrega distinto de lo que cobra', () => {
    expect(displayPriceCents(fijo(15000, grupo(opcion(9000, { quantity: 2, chargedQuantity: 1 })), grupo(opcion(9000))))).toBeNull()
  })

  it('null si algún grupo no tiene opciones, o no es de exactamente una', () => {
    expect(displayPriceCents(fijo(15000, grupo(opcion(9000)), { minSelect: 1, maxSelect: 1, options: [] }))).toBeNull()
    expect(displayPriceCents(fijo(15000, { minSelect: 1, maxSelect: 2, options: [opcion(9000), opcion(9000)] }))).toBeNull()
  })

  it(`hasta ${MAX_PRICE_COMBINATIONS} combinaciones se enumeran; una más, null`, () => {
    const dieciseis = grupo(...Array.from({ length: 16 }, () => opcion(9000)))
    expect(displayPriceCents(fijo(15000, dieciseis, dieciseis))).toBe(15000) // 256
    const siete = grupo(...Array.from({ length: 7 }, () => opcion(9000)))
    expect(displayPriceCents(fijo(15000, siete, siete, siete))).toBeNull() // 343
  })

  it('null si la promoción llegó incompleta (grupos u opciones recortados al leer)', () => {
    expect(displayPriceCents({ ...fijo(15000, grupo(opcion(9000)), grupo(opcion(9000))), incompleta: true })).toBeNull()
  })

  it('DISCOUNT y PER_UNIT nunca anuncian precio', () => {
    expect(displayPriceCents({ type: 'DISCOUNT', pricingMode: 'FIXED_TOTAL', priceCents: 1000, groups: [] })).toBeNull()
    expect(displayPriceCents(porUnidad(grupo(opcion(9000, { quantity: 2 }))))).toBeNull()
  })
})

describe('displayBadge — PER_UNIT', () => {
  it('«2x1» con un solo grupo y la misma pareja en todas sus opciones', () => {
    expect(displayBadge(porUnidad(grupo(opcion(3000, { quantity: 2 }), opcion(3500, { quantity: 2 }))))).toBe('2x1')
    expect(displayBadge(porUnidad(grupo(opcion(3000, { quantity: 3, chargedQuantity: 2 }))))).toBe('3x2')
  })

  it.each([
    ['parejas mixtas', porUnidad(grupo(opcion(3000, { quantity: 2 }), opcion(3000, { quantity: 3, chargedQuantity: 2 })))],
    ['1x1 (no es rebaja)', porUnidad(grupo(opcion(3000)))],
    ['c = 0', porUnidad(grupo(opcion(3000, { quantity: 2, chargedQuantity: 0 })))],
    ['varios grupos', porUnidad(grupo(opcion(3000, { quantity: 2 })), grupo(opcion(3000, { quantity: 2 })))],
    ['FIXED_TOTAL', fijo(1000, grupo(opcion(3000, { quantity: 2 })))],
  ])('null con %s', (_caso, p) => {
    expect(displayBadge(p)).toBeNull()
  })
})

describe('centavosDeLista', () => {
  it('la MISMA fórmula que usa el cobro (promotion.service.ts:176)', () => {
    expect(centavosDeLista('89.90')).toBe(8990)
    expect(centavosDeLista(0.1 + 0.2)).toBe(30)
  })
})

describe('presentationRank — un solo comparador', () => {
  const item = (id: string, name: string, displayOrder = 0) => ({ id, name, displayOrder })

  it('manda el orden; después el nombre en español, sin acentos ni mayúsculas; después el id por bytes', () => {
    const rangos = presentationRanks([item('3', 'Zeta'), item('1', 'Águila'), item('2', 'aguila'), item('9', 'Primero', -1)])
    expect([...rangos.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id)).toEqual(['9', '1', '2', '3'])
  })

  it('la ñ es su propia letra: Nube < Ñandú < Oso', () => {
    const rangos = presentationRanks([item('o', 'Oso'), item('n', 'Ñandú'), item('b', 'Nube')])
    expect(rangos.get('b')! < rangos.get('n')!).toBe(true)
    expect(rangos.get('n')! < rangos.get('o')!).toBe(true)
  })

  it('nombres iguales: el id por BYTES, no por colación (B mayúscula antes que a minúscula)', () => {
    expect(compararPresentacion(item('B', 'Igual'), item('a', 'Igual'))).toBeLessThan(0)
  })

  it('los rangos son 0..n-1, sin huecos ni repetidos', () => {
    const rangos = presentationRanks([item('a', 'x'), item('b', 'x'), item('c', 'x')])
    expect([...rangos.values()].sort()).toEqual([0, 1, 2])
  })
})

describe('vigencia y próxima apertura', () => {
  const MX = 'America/Mexico_City'
  const horario = (
    over: Partial<{
      validFrom: Date | null
      validUntil: Date | null
      daysOfWeek: number[]
      timeFrom: string | null
      timeUntil: string | null
    }> = {},
  ) => ({
    validFrom: null,
    validUntil: null,
    daysOfWeek: [],
    timeFrom: null,
    timeUntil: null,
    ...over,
  })
  // Jueves 24-sep-2026, 15:00 en CDMX (21:00 UTC)
  const AHORA = new Date('2026-09-24T21:00:00.000Z')
  const H24 = 24 * 60 * 60 * 1000

  it('vigenteEn = fechas ∧ horario, con el minuto final INCLUSIVO', () => {
    expect(vigenteEn(horario({ timeFrom: '14:00', timeUntil: '15:00' }), new Date('2026-09-24T21:00:59.999Z'), MX)).toBe(true)
    expect(vigenteEn(horario({ timeFrom: '14:00', timeUntil: '15:00' }), new Date('2026-09-24T21:01:00.000Z'), MX)).toBe(false)
    expect(vigenteEn(horario({ validUntil: new Date('2026-09-24T20:00:00Z') }), AHORA, MX)).toBe(false)
  })

  it('vigenteEn: las dos fechas son INCLUSIVAS, como isLiveAt del catálogo del POS', () => {
    expect(vigenteEn(horario({ validUntil: AHORA }), AHORA, MX)).toBe(true)
    expect(vigenteEn(horario({ validFrom: AHORA }), AHORA, MX)).toBe(true)
  })

  it('abre hoy más tarde: hoy a su hora de apertura', () => {
    expect(proximaApertura(horario({ timeFrom: '18:00', timeUntil: '20:00' }), AHORA, MX, H24)).toEqual(
      new Date('2026-09-25T00:00:00.000Z'),
    )
  })

  it('ventana que cruza la medianoche: abre a las 22:00 de hoy', () => {
    expect(proximaApertura(horario({ timeFrom: '22:00', timeUntil: '02:00' }), AHORA, MX, H24)).toEqual(
      new Date('2026-09-25T04:00:00.000Z'),
    )
  })

  it('sin ventana, sólo por día: abre mañana a las 00:00 si mañana aplica (domingo = 0)', () => {
    // mañana es viernes (5)
    expect(proximaApertura(horario({ daysOfWeek: [5] }), AHORA, MX, H24)).toEqual(new Date('2026-09-25T06:00:00.000Z'))
    expect(proximaApertura(horario({ daysOfWeek: [0] }), AHORA, MX, H24)).toBeNull() // el domingo cae fuera de 24 h
  })

  it('por fecha futura: abre en validFrom si a esa hora el horario ya está abierto', () => {
    const validFrom = new Date('2026-09-25T01:00:00.000Z') // 19:00 CDMX
    expect(proximaApertura(horario({ validFrom, timeFrom: '18:00', timeUntil: '20:00' }), AHORA, MX, H24)).toEqual(validFrom)
  })

  it('por fecha futura con el horario cerrado a esa hora: null, porque la siguiente ventana cae fuera del horizonte', () => {
    const validFrom = new Date('2026-09-25T03:00:00.000Z') // 21:00 CDMX, después de la ventana 18-20
    expect(proximaApertura(horario({ validFrom, timeFrom: '18:00', timeUntil: '20:00' }), AHORA, MX, H24)).toBeNull() // mañana 18:00 > 24 h
  })

  // 🔴 Codex r1 #5: el cambio de horario de Tijuana, con el instante EXACTO (no «algo que esté vigente»).
  describe('cambio de horario en America/Tijuana', () => {
    const TJ = 'America/Tijuana'

    it('primavera (8-mar-2026, 02:00 → 03:00): la ventana 02:30-04:00 abre en el salto, a las 03:00 (10:00Z)', () => {
      const ahora = new Date('2026-03-08T04:00:00.000Z') // 20:00 del 7-mar
      expect(proximaApertura(horario({ timeFrom: '02:30', timeUntil: '04:00' }), ahora, TJ, H24)).toEqual(
        new Date('2026-03-08T10:00:00.000Z'),
      )
    })

    it('primavera: una ventana entera dentro de la hora que no existe ese día no abre (y mañana cae fuera de 24 h)', () => {
      const ahora = new Date('2026-03-08T04:00:00.000Z')
      expect(proximaApertura(horario({ timeFrom: '02:15', timeUntil: '02:45' }), ahora, TJ, H24)).toBeNull()
    })

    it('otoño (1-nov-2026, 01:00-01:59 dos veces): antes de la primera, abre en la PRIMERA 01:30 (08:30Z)', () => {
      const ahora = new Date('2026-11-01T07:00:00.000Z') // 00:00, todavía en horario de verano
      expect(proximaApertura(horario({ timeFrom: '01:30', timeUntil: '01:45' }), ahora, TJ, H24)).toEqual(
        new Date('2026-11-01T08:30:00.000Z'),
      )
    })

    it('otoño: pasada la primera 01:30-01:45, abre en la SEGUNDA 01:30 (09:30Z)', () => {
      const ahora = new Date('2026-11-01T08:50:00.000Z') // 01:50 de la primera vuelta
      expect(proximaApertura(horario({ timeFrom: '01:30', timeUntil: '01:45' }), ahora, TJ, H24)).toEqual(
        new Date('2026-11-01T09:30:00.000Z'),
      )
    })

    it('otoño: el salto hacia atrás REABRE la ventana 01:00-01:20 justo en el salto (09:00Z)', () => {
      const ahora = new Date('2026-11-01T08:30:00.000Z') // 01:30 de la primera vuelta: ya cerró
      expect(proximaApertura(horario({ timeFrom: '01:00', timeUntil: '01:20' }), ahora, TJ, H24)).toEqual(
        new Date('2026-11-01T09:00:00.000Z'),
      )
    })
  })

  it('una zona inválida se evalúa con la de México (como el servidor hoy)', () => {
    expect(zonaUtilizable('Marte/Olympus')).toBe('America/Mexico_City')
    expect(zonaUtilizable('America/Tijuana')).toBe('America/Tijuana')
    expect(zonaUtilizable(null)).toBe('America/Mexico_City')
  })

  it('nunca devuelve una apertura en el pasado ni pasado el horizonte', () => {
    const abre = proximaApertura(horario({ timeFrom: '14:00', timeUntil: '14:30' }), AHORA, MX, H24)
    expect(abre).toEqual(new Date('2026-09-25T20:00:00.000Z')) // mañana 14:00: hoy ya pasó
  })

  it('un horizonte de más de 24 h lanza en vez de contestar null a medias (el domingo a 7 días sí abría)', () => {
    expect(() => proximaApertura(horario({ daysOfWeek: [0] }), AHORA, MX, 7 * H24)).toThrow(RangeError)
    expect(() => proximaApertura(horario({ daysOfWeek: [0] }), AHORA, MX, H24 + 1)).toThrow(RangeError)
    expect(proximaApertura(horario({ daysOfWeek: [5] }), AHORA, MX, H24)).toEqual(new Date('2026-09-25T06:00:00.000Z')) // 24 h justas
  })
})
