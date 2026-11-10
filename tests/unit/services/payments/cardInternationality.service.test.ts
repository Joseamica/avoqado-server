import {
  CARD_INTERNATIONALITY_CLASSIFICATION_VERSION,
  classifyCardInternationality,
  decidesMoney,
  extractBinFromMaskedPan,
  resolveIsInternational,
} from '@/services/payments/cardInternationality.service'
import { ISO_ALPHA2, ISO_ALPHA3_TO_ALPHA2, ISO_NUMERIC_TO_ALPHA2 } from '@/services/payments/iso3166'

describe('cardInternationality shadow classifier', () => {
  it('classifies Mexico from EMV 5F28 even when the product label could say INTERNAC', () => {
    const result = classifyCardInternationality({
      issuerCountryCode: '0484',
      issuerCountrySource: 'EMV_5F28',
      maskedPan: '415231******9979',
      legacyIsInternational: false,
    })

    expect(result).toMatchObject({
      status: 'DOMESTIC',
      source: 'EMV_5F28',
      issuerCountryCode: '484',
      reasonCode: 'COUNTRY_MEXICO',
      legacyComparison: 'MATCH',
      classificationVersion: CARD_INTERNATIONALITY_CLASSIFICATION_VERSION,
    })
  })

  it('classifies the Doña Simona BIN as domestic without trusting the legacy boolean', () => {
    const result = classifyCardInternationality({
      maskedPan: '477291******004F',
      legacyIsInternational: true,
    })

    expect(result).toMatchObject({
      status: 'DOMESTIC',
      source: 'BIN_REGISTRY',
      issuerCountryCode: '484',
      reasonCode: 'VERIFIED_BIN_MEXICO',
      legacyComparison: 'MISMATCH',
      registryMatched: true,
    })
  })

  it('classifies the physical USA test card as international from EMV 5F28', () => {
    const result = classifyCardInternationality({
      issuerCountryCode: '0840',
      issuerCountrySource: 'EMV_5F28',
      maskedPan: '403491******5159',
      legacyIsInternational: true,
    })

    expect(result).toMatchObject({
      status: 'INTERNATIONAL',
      source: 'EMV_5F28',
      issuerCountryCode: '840',
      reasonCode: 'COUNTRY_NON_MEXICO',
      legacyComparison: 'MATCH',
    })
  })

  it('accepts an explicit processor ISO alpha country', () => {
    const result = classifyCardInternationality({
      issuerCountryCode: 'US',
      issuerCountrySource: 'PROCESSOR',
      maskedPan: '403491******5159',
      legacyIsInternational: false,
    })

    expect(result).toMatchObject({
      status: 'INTERNATIONAL',
      source: 'PROCESSOR',
      issuerCountryCode: 'US',
      legacyComparison: 'MISMATCH',
    })
  })

  it('returns UNKNOWN when neither country nor a verified BIN is available', () => {
    const result = classifyCardInternationality({
      maskedPan: '499999******1234',
      legacyIsInternational: true,
    })

    expect(result).toMatchObject({
      status: 'UNKNOWN',
      source: 'LEGACY',
      issuerCountryCode: null,
      reasonCode: 'INSUFFICIENT_EVIDENCE',
      legacyComparison: 'INCONCLUSIVE',
      registryMatched: false,
    })
  })

  it('returns UNKNOWN on a country/BIN conflict instead of guessing', () => {
    const result = classifyCardInternationality({
      issuerCountryCode: '0840',
      issuerCountrySource: 'EMV_5F28',
      maskedPan: '477291******5280',
      legacyIsInternational: true,
    })

    expect(result).toMatchObject({
      status: 'UNKNOWN',
      source: 'CONFLICT',
      issuerCountryCode: null,
      reasonCode: 'COUNTRY_BIN_CONFLICT',
      legacyComparison: 'INCONCLUSIVE',
      registryMatched: true,
    })
  })

  it('does not treat malformed or incomplete country evidence as international', () => {
    const result = classifyCardInternationality({
      issuerCountryCode: 'DEFAULT',
      issuerCountrySource: 'PROCESSOR',
      maskedPan: '499999******1234',
      legacyIsInternational: false,
    })

    expect(result).toMatchObject({
      status: 'UNKNOWN',
      source: 'LEGACY',
      reasonCode: 'INVALID_COUNTRY_EVIDENCE',
    })
  })

  it('marks evidence-free records as NONE when no legacy value exists', () => {
    const result = classifyCardInternationality({ maskedPan: null })

    expect(result).toMatchObject({
      status: 'UNKNOWN',
      source: 'NONE',
      reasonCode: 'INSUFFICIENT_EVIDENCE',
      legacyComparison: 'NOT_AVAILABLE',
    })
  })

  it('extracts only the leading BIN/IIN from masked PAN variants', () => {
    expect(extractBinFromMaskedPan('477291******004F')).toBe('477291')
    expect(extractBinFromMaskedPan('4152-31**-****-9979')).toBe('415231')
    expect(extractBinFromMaskedPan('****5280')).toBeNull()
  })
})

describe('D3 · el dato definitivo «internacional» lo decide el país de la tarjeta', () => {
  const decide = (input: Parameters<typeof classifyCardInternationality>[0]) =>
    resolveIsInternational(classifyCardInternationality(input), input.legacyIsInternational)

  it('chip de otro país ⇒ internacional aunque la terminal diga nacional (Nexgo con AngelPay)', () => {
    expect(decide({ issuerCountryCode: '0840', issuerCountrySource: 'EMV_5F28', legacyIsInternational: false })).toBe(true)
  })

  it('chip de México ⇒ nacional aunque la terminal diga internacional', () => {
    expect(decide({ issuerCountryCode: '0484', issuerCountrySource: 'EMV_5F28', legacyIsInternational: true })).toBe(false)
  })

  it('BIN verificado de BBVA sin chip ⇒ nacional aunque la terminal diga internacional (clase Doña Simona)', () => {
    expect(decide({ maskedPan: '477291******004F', legacyIsInternational: true })).toBe(false)
  })

  it.each([true, false])('sin evidencia se conserva lo que dijo la terminal (%s)', legacy => {
    expect(decide({ legacyIsInternational: legacy })).toBe(legacy)
  })

  it.each(['000', '999', 'UNKNOWN', ''])('un país inválido («%s») no decide: queda lo que dijo la terminal', code => {
    expect(decide({ issuerCountryCode: code, issuerCountrySource: 'EMV_5F28', legacyIsInternational: true })).toBe(true)
    expect(decide({ issuerCountryCode: code, issuerCountrySource: 'EMV_5F28', legacyIsInternational: false })).toBe(false)
  })

  it('chip y BIN verificado en conflicto no deciden: queda lo que dijo la terminal', () => {
    const conflicto = { issuerCountryCode: '0840', issuerCountrySource: 'EMV_5F28' as const, maskedPan: '477291******004F' }
    expect(decide({ ...conflicto, legacyIsInternational: false })).toBe(false)
    expect(decide({ ...conflicto, legacyIsInternational: true })).toBe(true)
  })

  it('🔴 un cobro nacido del aviso del banco se queda SIN dato (undefined), nunca false: un false taparía al REST', () => {
    expect(decide({})).toBeUndefined()
    expect(resolveIsInternational(null, undefined)).toBeUndefined()
  })

  it('lo que no es tarjeta (sin clasificación) no cambia', () => {
    expect(resolveIsInternational(null, false)).toBe(false)
  })
})

describe('D3 · Codex r1-2: sólo un PAÍS de verdad decide dinero', () => {
  // 973/974 son los códigos de PRUEBA de ICU (XA/XB), 967 la Unión Europea, 961 Oceanía periférica, 001/419 macrorregiones;
  // 172 la CEI y 830 las Islas del Canal (agrupaciones); 280 Alemania Occidental y 810 la URSS (retirados). Codex r3-1.
  it.each(['123', '0123', '001', '419', '0973', '0974', '0967', '0961', '0172', '0830', '0280', '0810'])(
    'un numérico que NO es un país ISO vigente («%s») no decide',
    code => {
      const result = classifyCardInternationality({
        issuerCountryCode: code,
        issuerCountrySource: 'EMV_5F28',
        legacyIsInternational: false,
      })
      expect(result).toMatchObject({ status: 'UNKNOWN', source: 'LEGACY', issuerCountryCode: null, reasonCode: 'INVALID_COUNTRY_EVIDENCE' })
      expect(resolveIsInternational(result, false)).toBe(false)
    },
  )

  it.each(['QQ', 'ZZ', 'XA', 'XB', 'EU', 'EZ', 'UN', 'QO', 'XK', 'AN', 'QQQ', 'XXX'])(
    'letras del procesador que no son un país ISO vigente («%s») no clasifican',
    code => {
      const result = classifyCardInternationality({
        issuerCountryCode: code,
        issuerCountrySource: 'PROCESSOR',
        legacyIsInternational: false,
      })
      expect(result).toMatchObject({ status: 'UNKNOWN', reasonCode: 'INVALID_COUNTRY_EVIDENCE' })
    },
  )

  // Los códigos medidos en producción (EE. UU., Canadá, Lituania, Reino Unido, Alemania, Francia, Colombia, Suiza, El Salvador).
  it.each([
    ['0840', '840'],
    ['0124', '124'],
    ['0440', '440'],
    ['0826', '826'],
    ['276', '276'],
    ['0250', '250'],
    ['0170', '170'],
    ['0756', '756'],
    ['0222', '222'],
  ])('un país real del chip (%s) sigue clasificando como extranjera', (code, normalizado) => {
    expect(
      classifyCardInternationality({ issuerCountryCode: code, issuerCountrySource: 'EMV_5F28', legacyIsInternational: false }),
    ).toMatchObject({
      status: 'INTERNATIONAL',
      source: 'EMV_5F28',
      issuerCountryCode: normalizado,
    })
  })

  // Codex r2-3 / r3: el contrato admite letras del procesador (alfa-2 o alfa-3) y un país real se CLASIFICA; pero el dinero sólo
  // lo decide lo que dice la tarjeta (chip) o un BIN verificado. Hoy ninguna app manda `PROCESSOR`: queda como observación.
  it.each(['USA', 'CAN', 'PRI', 'US', 'LT', 'NAM'])(
    'un país real en letras del procesador («%s») se clasifica, y NO decide dinero',
    code => {
      const result = classifyCardInternationality({
        issuerCountryCode: code,
        issuerCountrySource: 'PROCESSOR',
        legacyIsInternational: false,
      })
      expect(result).toMatchObject({ status: 'INTERNATIONAL', source: 'PROCESSOR', issuerCountryCode: code })
      expect(decidesMoney(result)).toBe(false)
      expect(resolveIsInternational(result, false)).toBe(false)
      expect(resolveIsInternational(result, true)).toBe(true)
    },
  )

  it('México por letras del procesador tampoco decide dinero: una terminal que dijo «internacional» lo conserva', () => {
    const result = classifyCardInternationality({ issuerCountryCode: 'MX', issuerCountrySource: 'PROCESSOR', legacyIsInternational: true })
    expect(result.status).toBe('DOMESTIC')
    expect(resolveIsInternational(result, true)).toBe(true)
  })

  it('el chip y el BIN verificado SÍ deciden dinero', () => {
    expect(decidesMoney(classifyCardInternationality({ issuerCountryCode: '0840', issuerCountrySource: 'EMV_5F28' }))).toBe(true)
    expect(decidesMoney(classifyCardInternationality({ issuerCountryCode: '0484', issuerCountrySource: 'EMV_5F28' }))).toBe(true)
    expect(decidesMoney(classifyCardInternationality({ maskedPan: '477291******004F' }))).toBe(true)
    expect(decidesMoney(classifyCardInternationality({}))).toBe(false)
    expect(decidesMoney(null)).toBe(false)
  })

  it('la tabla ISO es la que se generó: 249 países, cada uno con su alfa-3 y al menos un numérico, y sin códigos de prueba', () => {
    expect(ISO_ALPHA2.size).toBe(249)
    expect(ISO_ALPHA3_TO_ALPHA2.size).toBe(249)
    expect(ISO_NUMERIC_TO_ALPHA2.size).toBe(249)
    expect(new Set(ISO_NUMERIC_TO_ALPHA2.values())).toEqual(ISO_ALPHA2)
    expect([ISO_NUMERIC_TO_ALPHA2.get('840'), ISO_NUMERIC_TO_ALPHA2.get('484'), ISO_ALPHA3_TO_ALPHA2.get('MEX')]).toEqual([
      'US',
      'MX',
      'MX',
    ])
    for (const falso of ['XA', 'XB', 'EU', 'EZ', 'UN', 'QO', 'ZZ', 'XK']) expect(ISO_ALPHA2.has(falso)).toBe(false)
    for (const falso of ['973', '974', '967', '961', '999', '000', '001', '172', '830', '280', '810', '530', '890']) {
      expect(ISO_NUMERIC_TO_ALPHA2.has(falso)).toBe(false)
    }
    // Los 12 países para los que ICU conoce más de un numérico: el vigente de ISO 3166-1, elegido a mano y fijado aquí.
    const vigentes = {
      RU: '643',
      CZ: '203',
      ET: '231',
      FR: '250',
      DE: '276',
      CW: '531',
      SA: '682',
      FM: '583',
      RS: '688',
      YE: '887',
      SD: '729',
      JE: '832',
    }
    for (const [pais, numero] of Object.entries(vigentes)) expect(ISO_NUMERIC_TO_ALPHA2.get(numero)).toBe(pais)
  })

  it('México sigue siendo nacional por chip (0484) y por letras del procesador (MX, MEX)', () => {
    expect(classifyCardInternationality({ issuerCountryCode: '0484', issuerCountrySource: 'EMV_5F28' }).status).toBe('DOMESTIC')
    expect(classifyCardInternationality({ issuerCountryCode: 'MX', issuerCountrySource: 'PROCESSOR' }).status).toBe('DOMESTIC')
    expect(classifyCardInternationality({ issuerCountryCode: 'MEX', issuerCountrySource: 'PROCESSOR' }).status).toBe('DOMESTIC')
  })
})

describe('D3 · Codex r4: qué evidencia manda', () => {
  it('r4-1 · un BIN verificado decide aunque el procesador también diga su país (y coincidan): nacional', () => {
    const result = classifyCardInternationality({
      issuerCountryCode: 'MX',
      issuerCountrySource: 'PROCESSOR',
      maskedPan: '477291******004F',
      legacyIsInternational: true,
    })
    expect(result).toMatchObject({ status: 'DOMESTIC', source: 'BIN_REGISTRY', issuerCountryCode: '484', registryMatched: true })
    expect(decidesMoney(result)).toBe(true)
    expect(resolveIsInternational(result, true)).toBe(false)
  })

  it.each(['MEXICO', 'MÉXICO', 'Mé xi co', 'MX', 'MEX', 'US'])(
    'r4-2 · letras presentadas como dato del chip («%s») no deciden: el chip es numérico',
    code => {
      const result = classifyCardInternationality({ issuerCountryCode: code, issuerCountrySource: 'EMV_5F28', legacyIsInternational: true })
      expect(result).toMatchObject({ status: 'UNKNOWN', reasonCode: 'INVALID_COUNTRY_EVIDENCE' })
      expect(resolveIsInternational(result, true)).toBe(true)
    },
  )

  /**
   * INVARIANTE (cierra la familia «qué puede mover el dinero»): sobre todas las combinaciones de fuente × código × BIN × lo que
   * dijo la terminal, el dato definitivo sólo se aparta de la terminal cuando (a) el CHIP trae un numérico ISO vigente, o (b) el
   * BIN está verificado — y nunca si las dos evidencias de la tarjeta se contradicen. El modelo de abajo está escrito aparte del
   * clasificador a propósito.
   */
  it('invariante: sólo el chip con un numérico ISO vigente o un BIN verificado apartan el dato de lo que dijo la terminal', () => {
    const codigos = [
      '0840',
      '840',
      '0484',
      '484',
      '0276',
      '0516',
      '0123',
      '123',
      '0973',
      '0967',
      '0172',
      '0830',
      '0280',
      '0810',
      '000',
      '999',
      '',
      ' ',
      'MX',
      'MEX',
      'MEXICO',
      'MÉXICO',
      'US',
      'USA',
      'NA',
      'NAM',
      'AN',
      'QQ',
      'ZZ',
      'XK',
      'UNKNOWN',
      'DEFAULT',
      'N/A',
      '84',
      '08400',
      'abc',
      ' 0840 ',
      '0 8 4 0',
    ]
    const fuentes = ['EMV_5F28', 'PROCESSOR', undefined] as const
    const pans = ['477291******004F', '403491******1234', undefined]
    const terminales = [true, false, undefined]
    const limpio = (c: string) => c.replace(/\s+/g, '')
    let apartados = 0
    for (const code of codigos) {
      for (const fuente of fuentes) {
        for (const pan of pans) {
          for (const terminal of terminales) {
            const decision = classifyCardInternationality({
              issuerCountryCode: code,
              issuerCountrySource: fuente,
              maskedPan: pan,
              legacyIsInternational: terminal,
            })
            const definitivo = resolveIsInternational(decision, terminal)
            const digitos = /^0?\d{3}$/.test(limpio(code)) ? limpio(code).slice(-3) : null
            const chipVigente = fuente === 'EMV_5F28' && digitos !== null && ISO_NUMERIC_TO_ALPHA2.has(digitos)
            const binVerificado = pan === '477291******004F'
            // El procesador también puede CONTRADECIR al BIN (y entonces nadie decide); sus letras válidas son ISO o MEXICO.
            const letras = limpio(code)
              .toUpperCase()
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
            const paisDelProcesador =
              fuente !== 'PROCESSOR' || ['NA', 'N/A', 'UNKNOWN', 'DEFAULT', '0', '000', '999', ''].includes(letras)
                ? null
                : ['MEXICO', 'MEX', 'MX'].includes(letras)
                  ? 'MX'
                  : digitos !== null
                    ? (ISO_NUMERIC_TO_ALPHA2.get(digitos) ?? null)
                    : ISO_ALPHA2.has(letras)
                      ? letras
                      : (ISO_ALPHA3_TO_ALPHA2.get(letras) ?? null)
            const paisDelChip = chipVigente ? ISO_NUMERIC_TO_ALPHA2.get(digitos!)! : null
            const paisReportado = paisDelChip ?? paisDelProcesador
            const choca = binVerificado && paisReportado !== null && paisReportado !== 'MX'
            const esperado = choca ? terminal : chipVigente ? paisDelChip !== 'MX' : binVerificado ? false : terminal
            const caso = JSON.stringify({ code, fuente, pan, terminal })
            expect({ caso, definitivo }).toEqual({ caso, definitivo: esperado })
            if (definitivo !== terminal) apartados++
          }
        }
      }
    }
    expect(apartados).toBeGreaterThan(20)
  })
})
