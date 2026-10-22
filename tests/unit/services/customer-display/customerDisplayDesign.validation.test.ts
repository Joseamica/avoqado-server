// tests/unit/services/customer-display/customerDisplayDesign.validation.test.ts
import {
  FACTORY_DESIGN,
  MAX_TEXT_CODE_POINTS,
  cleanText,
  validateDesignDraft,
} from '@/services/customer-display/customerDisplayDesign.validation'

const ACTUAL = { ...FACTORY_DESIGN }
const CON_PROMOS = { puedeUsarPromos: true }
const SIN_PROMOS = { puedeUsarPromos: false }
const CAMPANA = String.fromCharCode(7) // carácter de control, construido para no meterlo al archivo

describe('cleanText — la ÚNICA limpieza de textos del módulo', () => {
  it('recorta, colapsa espacios y quita caracteres de control', () => {
    expect(cleanText(`  Bienvenido   a${CAMPANA}  Café  `)).toBe('Bienvenido a Café')
  })

  it('un texto vacío o de puros espacios queda vacío (qué significa lo decide quien llama)', () => {
    expect(cleanText('   ')).toBe('')
    expect(cleanText('')).toBe('')
  })

  it('un texto hecho SÓLO de caracteres de control queda vacío, no «demasiado largo»', () => {
    expect(cleanText(CAMPANA.repeat(3))).toBe('')
  })
})

describe('validateDesignDraft — textos (limpia con cleanText y mide sobre el texto LIMPIO)', () => {
  it('guarda el texto ya limpio, en los DOS campos de texto', () => {
    expect(
      validateDesignDraft(
        { welcomeText: `  Bienvenido   a${CAMPANA}  Café  `, thanksText: `  Gracias${CAMPANA}${CAMPANA} por venir ` },
        ACTUAL,
        CON_PROMOS,
      ),
    ).toMatchObject({ ok: true, value: { welcomeText: 'Bienvenido a Café', thanksText: 'Gracias por venir' } })
  })

  it('un texto vacío, de puros espacios o null se guarda como null, no como cadena vacía', () => {
    const conTextos = { ...FACTORY_DESIGN, welcomeText: 'Hola', thanksText: 'Gracias' }
    expect(validateDesignDraft({ welcomeText: '   ', thanksText: '' }, conTextos, CON_PROMOS)).toMatchObject({
      ok: true,
      value: { welcomeText: null, thanksText: null },
    })
    expect(validateDesignDraft({ welcomeText: null }, conTextos, CON_PROMOS)).toMatchObject({ ok: true, value: { welcomeText: null } })
  })

  it('cuenta CODE POINTS, no unidades UTF-16: 40 emojis caben, 41 no', () => {
    expect(MAX_TEXT_CODE_POINTS).toBe(40)
    expect(validateDesignDraft({ welcomeText: '🎉'.repeat(40) }, ACTUAL, CON_PROMOS)).toMatchObject({
      ok: true,
      value: { welcomeText: '🎉'.repeat(40) },
    })
    expect(validateDesignDraft({ welcomeText: '🎉'.repeat(41) }, ACTUAL, CON_PROMOS)).toMatchObject({ ok: false, code: 'TEXT_TOO_LONG' })
  })

  it('el límite se mide DESPUÉS de limpiar: 40 letras con espacios de sobra alrededor caben', () => {
    const cuarenta = 'a'.repeat(40)
    expect(validateDesignDraft({ thanksText: `     ${cuarenta}     ` }, ACTUAL, CON_PROMOS)).toMatchObject({
      ok: true,
      value: { thanksText: cuarenta },
    })
  })

  it('un texto de más de 40 caracteres se rechaza; NO se recorta en silencio', () => {
    expect(validateDesignDraft({ welcomeText: 'a'.repeat(41) }, ACTUAL, CON_PROMOS)).toMatchObject({ ok: false, code: 'TEXT_TOO_LONG' })
    expect(validateDesignDraft({ thanksText: 'a'.repeat(41) }, ACTUAL, CON_PROMOS)).toMatchObject({ ok: false, code: 'TEXT_TOO_LONG' })
  })

  // Auditoría de Codex, 7ª ronda (P3-19): en la v1 esto salía TEXT_TOO_LONG, porque `trim()` no quita controles.
  it('un texto hecho sólo de caracteres de control se guarda como null (vacío), no como «demasiado largo»', () => {
    expect(validateDesignDraft({ welcomeText: CAMPANA.repeat(3) }, ACTUAL, CON_PROMOS)).toMatchObject({
      ok: true,
      value: { welcomeText: null },
    })
  })
})

describe('validateDesignDraft — reglas de cada campo', () => {
  it('acepta un color de 6 dígitos y rechaza cualquier otra forma', () => {
    expect(validateDesignDraft({ accentColor: '#3FB950' }, ACTUAL, CON_PROMOS)).toMatchObject({ ok: true })
    for (const malo of ['3FB950', '#3FB95', '#3FB9500', 'rgb(1,2,3)', '#GGGGGG']) {
      expect(validateDesignDraft({ accentColor: malo }, ACTUAL, CON_PROMOS)).toMatchObject({ ok: false, code: 'INVALID_ACCENT_COLOR' })
    }
  })

  it('un logo VACÍO se rechaza: «sin logo» es null, no una cadena vacía', () => {
    expect(validateDesignDraft({ logoAssetId: '' }, ACTUAL, CON_PROMOS)).toMatchObject({ ok: false, code: 'INVALID_LOGO' })
  })

  it('null en el color significa «los colores de hoy»', () => {
    expect(validateDesignDraft({ accentColor: null }, ACTUAL, CON_PROMOS)).toMatchObject({ ok: true, value: { accentColor: null } })
  })

  it('los segundos van de 5 a 30, enteros', () => {
    expect(validateDesignDraft({ slideSeconds: 5 }, ACTUAL, CON_PROMOS)).toMatchObject({ ok: true })
    expect(validateDesignDraft({ slideSeconds: 30 }, ACTUAL, CON_PROMOS)).toMatchObject({ ok: true })
    expect(validateDesignDraft({ slideSeconds: 4 }, ACTUAL, CON_PROMOS)).toMatchObject({ ok: false, code: 'INVALID_SLIDE_SECONDS' })
    expect(validateDesignDraft({ slideSeconds: 31 }, ACTUAL, CON_PROMOS)).toMatchObject({ ok: false, code: 'INVALID_SLIDE_SECONDS' })
    expect(validateDesignDraft({ slideSeconds: 8.5 }, ACTUAL, CON_PROMOS)).toMatchObject({ ok: false, code: 'INVALID_SLIDE_SECONDS' })
  })

  it('máximo 4 imágenes y sin repetidas', () => {
    const cuatro = [{ assetId: 'a' }, { assetId: 'b' }, { assetId: 'c' }, { assetId: 'd' }]
    expect(validateDesignDraft({ slides: cuatro }, ACTUAL, CON_PROMOS)).toMatchObject({ ok: true })
    expect(validateDesignDraft({ slides: [...cuatro, { assetId: 'e' }] }, ACTUAL, CON_PROMOS)).toMatchObject({
      ok: false,
      code: 'TOO_MANY_SLIDES',
    })
    expect(validateDesignDraft({ slides: [{ assetId: 'a' }, { assetId: 'a' }] }, ACTUAL, CON_PROMOS)).toMatchObject({
      ok: false,
      code: 'DUPLICATE_SLIDE',
    })
  })

  it('lo que no viene en el borrador se conserva del actual', () => {
    const actual = { ...FACTORY_DESIGN, welcomeText: 'Hola', slideSeconds: 12 }
    expect(validateDesignDraft({ theme: 'DARK' as const }, actual, CON_PROMOS)).toMatchObject({
      ok: true,
      value: { theme: 'DARK', welcomeText: 'Hola', slideSeconds: 12 },
    })
  })

  // Revisión de la Task 3 (ronda 1): un cuerpo ausente o que no es objeto hacía tronar la función (500).
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['un arreglo vacío', []],
    ['un arreglo con un borrador dentro', [{ theme: 'DARK' }]],
    ['un texto', 'DARK'],
    ['un número', 42],
    ['un booleano', true],
    ['un objeto que no es plano (Date)', new Date(0)],
  ])('un borrador que es %s se rechaza con INVALID_DRAFT, no truena', (_nombre, malo) => {
    expect(validateDesignDraft(malo as never, ACTUAL, CON_PROMOS)).toMatchObject({ ok: false, code: 'INVALID_DRAFT' })
  })

  it('un borrador vacío ({}) SÍ es válido: no cambia nada', () => {
    expect(validateDesignDraft({}, ACTUAL, CON_PROMOS)).toEqual({ ok: true, value: ACTUAL })
  })

  // El borrador llega del HTTP y del MCP: el tipo de TypeScript no protege en tiempo de ejecución.
  it('una forma inválida en tiempo de ejecución se rechaza con su código, sin guardarse', () => {
    const raro = (x: Record<string, unknown>) => x as never
    expect(validateDesignDraft(raro({ theme: 'AZUL' }), ACTUAL, CON_PROMOS)).toMatchObject({ ok: false, code: 'INVALID_THEME' })
    // Un arreglo pasa la regex (`String(['#3FB950'])` es '#3FB950') y luego no tiene `toUpperCase`: sería un 500.
    expect(validateDesignDraft(raro({ accentColor: ['#3FB950'] }), ACTUAL, CON_PROMOS)).toMatchObject({
      ok: false,
      code: 'INVALID_ACCENT_COLOR',
    })
    expect(validateDesignDraft(raro({ welcomeText: 42 }), ACTUAL, CON_PROMOS)).toMatchObject({ ok: false, code: 'INVALID_TEXT' })
    expect(validateDesignDraft(raro({ slides: 'a,b' }), ACTUAL, CON_PROMOS)).toMatchObject({ ok: false, code: 'INVALID_SLIDES' })
    expect(validateDesignDraft(raro({ slides: [{ assetId: '' }] }), ACTUAL, CON_PROMOS)).toMatchObject({
      ok: false,
      code: 'INVALID_SLIDES',
    })
    expect(validateDesignDraft(raro({ showPromotions: 'sí' }), ACTUAL, CON_PROMOS)).toMatchObject({
      ok: false,
      code: 'INVALID_SHOW_PROMOTIONS',
    })
  })
})

describe('validateDesignDraft — el candado de plan es por CAMPO, no por ruta', () => {
  const conUnaSlide = { ...FACTORY_DESIGN, slides: [{ assetId: 'vieja' }] }

  it('SIN plan: marca, textos y logo se guardan igual', () => {
    const r = validateDesignDraft(
      { theme: 'DARK' as const, accentColor: '#3FB950', logoAssetId: 'logo-1', welcomeText: 'Hola', thanksText: 'Gracias' },
      conUnaSlide,
      SIN_PROMOS,
    )
    expect(r).toMatchObject({ ok: true })
  })

  it('SIN plan: agregar una imagen se rechaza', () => {
    expect(validateDesignDraft({ slides: [{ assetId: 'vieja' }, { assetId: 'nueva' }] }, conUnaSlide, SIN_PROMOS)).toMatchObject({
      ok: false,
      code: 'FEATURE_REQUIRES_PRO',
    })
  })

  it('SIN plan: SUSTITUIR una imagen también se rechaza (mismo total, otro activo)', () => {
    expect(validateDesignDraft({ slides: [{ assetId: 'otra' }] }, conUnaSlide, SIN_PROMOS)).toMatchObject({
      ok: false,
      code: 'FEATURE_REQUIRES_PRO',
    })
  })

  it('SIN plan: QUITAR imágenes y reordenar las que ya estaban siempre se puede', () => {
    const dos = { ...FACTORY_DESIGN, slides: [{ assetId: 'a' }, { assetId: 'b' }] }
    expect(validateDesignDraft({ slides: [] }, dos, SIN_PROMOS)).toMatchObject({ ok: true })
    expect(validateDesignDraft({ slides: [{ assetId: 'b' }, { assetId: 'a' }] }, dos, SIN_PROMOS)).toMatchObject({ ok: true })
  })

  it('SIN plan: prender las promos se rechaza; APAGARLAS se permite', () => {
    expect(validateDesignDraft({ showPromotions: true }, ACTUAL, SIN_PROMOS)).toMatchObject({ ok: false, code: 'FEATURE_REQUIRES_PRO' })
    const prendidas = { ...FACTORY_DESIGN, showPromotions: true }
    expect(validateDesignDraft({ showPromotions: false }, prendidas, SIN_PROMOS)).toMatchObject({ ok: true })
  })

  it('SIN plan: dejar las promos como estaban no es «prenderlas»', () => {
    const prendidas = { ...FACTORY_DESIGN, showPromotions: true }
    expect(validateDesignDraft({ welcomeText: 'Hola' }, prendidas, SIN_PROMOS)).toMatchObject({ ok: true, value: { showPromotions: true } })
  })
})
