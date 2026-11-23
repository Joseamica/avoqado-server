import {
  getSupportAiConfig,
  getSupportDataConfig,
  getSupportHandoffConfig,
  getSupportPublicHelpDailyUsd,
  isSupportDataEnabled,
  isSupportPublicHelpEnabled,
  isSupportWhatsappEnabled,
  LUNA_SUPPORT_PRICING as pricing,
  maximumSupportCost,
  observedSupportCost,
  SUPPORT_DATA_QUERY_TIMEOUT_MIN_SECONDS,
  supportDisplayNumber,
  supportPhoneNumberId,
  supportWhatsappAccessToken,
} from '@/config/supportWhatsapp'
import { STRIPE_TIMEOUT_MS } from '@/services/support/data/capabilities/planStatus'
import {
  SUPPORT_CLARIFY_CLOSE_MANUAL,
  SUPPORT_HANDOFF_GREETING,
  SUPPORT_HANDOFF_OFFER,
  SUPPORT_NOTICE,
  SUPPORT_NOTICE_DATA,
  SUPPORT_NOTICE_DATA_FREE_TEXT,
  SUPPORT_NOTICE_DATA_SENTENCE,
  SUPPORT_NOTICE_FREE_TEXT,
  SUPPORT_NOTICE_TEXTS,
  SUPPORT_PUBLIC_DAY_LIMIT,
  SUPPORT_PUBLIC_HOUR_LIMIT,
  SUPPORT_PUBLIC_INTRO,
  SUPPORT_PUBLIC_NOTICE_TEXTS,
  SUPPORT_LITERAL_CAP,
  SUPPORT_OTHER_QUESTION,
  SUPPORT_SECOND_FAILURE,
  keepOtherQuestion,
  withOtherQuestion,
  supportHandoffAlready,
  supportNotice,
  supportHandoffDone,
  supportManualSource,
  supportOldVersion,
  supportPublicNotice,
  supportPublicPause,
} from '@/services/support/texts'

const originalEnv = process.env
beforeEach(() => {
  process.env = {
    ...originalEnv,
    SUPPORT_WHATSAPP_ENABLED: 'true',
    SUPPORT_WHATSAPP_ENC_KEY: 'e'.repeat(64),
    SUPPORT_WHATSAPP_PHONE_NUMBER_ID: 'support',
    WHATSAPP_PHONE_NUMBER_ID: 'central',
    WHATSAPP_SALES_PHONE_NUMBER_ID: 'sales',
    SUPPORT_AI_ENABLED: 'true',
    SUPPORT_AI_MODEL: pricing.model,
    SUPPORT_AI_PRICING_VERSION: pricing.version,
    SUPPORT_AI_MONTHLY_USD_LIMIT: '1.00',
    SUPPORT_OPENAI_API_KEY: 'fixture-only',
  }
})
afterEach(() => {
  process.env = originalEnv
})

it.each([
  ['SUPPORT_AI_ENABLED', 'false'],
  ['SUPPORT_WHATSAPP_ENABLED', 'false'],
  ['SUPPORT_AI_MONTHLY_USD_LIMIT', '0'],
  ['SUPPORT_AI_MONTHLY_USD_LIMIT', '-1'],
  ['SUPPORT_AI_MONTHLY_USD_LIMIT', 'NaN'],
  ['SUPPORT_AI_MONTHLY_USD_LIMIT', '1e3'],
  ['SUPPORT_AI_PRICING_VERSION', ''],
  ['SUPPORT_AI_MODEL', 'unknown-model'],
  ['SUPPORT_OPENAI_API_KEY', ''],
  ['SUPPORT_WHATSAPP_ENC_KEY', 'bad'],
  ['SUPPORT_WHATSAPP_PHONE_NUMBER_ID', 'sales'],
  ['SUPPORT_WHATSAPP_PHONE_NUMBER_ID', 'central'],
  ['SUPPORT_WHATSAPP_PHONE_NUMBER_ID', ''],
])('fails closed before constructing a provider client when %s is %s', (key, value) => {
  process.env[key] = value
  expect(getSupportAiConfig()).toBeNull()
})
it('only returns explicitly configured model, tariff and exact USD limit; nothing is enabled by a default', () => {
  expect(getSupportAiConfig()?.monthlyLimitUsd.toString()).toBe('1')
  expect(getSupportAiConfig()?.pricing.version).toBe(pricing.version)
  delete process.env.SUPPORT_AI_ENABLED
  expect(getSupportAiConfig()).toBeNull()
})
it('reserves the full documented context and output including long-context cache writes', () => {
  expect(maximumSupportCost(pricing).toString()).toBe('0.52575')
})
it('settles only a complete, internally consistent usage breakdown with Decimal arithmetic', () => {
  const usage = {
    input_tokens: 12000,
    output_tokens: 1000,
    input_tokens_details: {
      cached_tokens: 4000,
      cache_write_tokens: 7000,
      cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 },
    },
  }
  expect(observedSupportCost(usage, pricing)?.toString()).toBe('0.002015')
  expect(observedSupportCost({ ...usage, input_tokens: 300000 }, pricing)?.toString()).toBe('0.06138')
  expect(observedSupportCost({ input_tokens: 12000, output_tokens: 1000 }, pricing)).toBeNull()
  expect(observedSupportCost({ ...usage, input_tokens: 1 }, pricing)).toBeNull()
  expect(observedSupportCost({ ...usage, output_tokens: 1001 }, pricing)).toBeNull()
  expect(observedSupportCost({ ...usage, input_tokens: 12000.5 }, pricing)).toBeNull()
})
it('cache writes reported without their 30m/12h breakdown are charged at the 12 h rate (the dearest), not left unknown', () => {
  // The Responses API sends cache_write_tokens without cache_write_tokens_details on long prompts (exam 10-nov, 131 of ~140 calls).
  const usage = {
    input_tokens: 12000,
    output_tokens: 1000,
    input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 7000 },
  }
  // 1000×0.10 + 4000×0.01 + 7000×0.25 + 1000×0.50 = 2390 per million
  expect(observedSupportCost(usage, pricing)?.toString()).toBe('0.00239')
  expect(observedSupportCost({ ...usage, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }, pricing)?.toString()).toBe(
    '0.0017',
  )
  // The breakdown sent as null is the same as missing.
  expect(
    observedSupportCost(
      { ...usage, input_tokens_details: { ...usage.input_tokens_details, cache_write_tokens_details: null } },
      pricing,
    )?.toString(),
  ).toBe('0.00239')
  // A breakdown that does not add up is still rejected.
  expect(
    observedSupportCost(
      {
        ...usage,
        input_tokens_details: { ...usage.input_tokens_details, cache_write_tokens_details: { ttl_30m_tokens: 1, ttl_12h_tokens: 1 } },
      },
      pricing,
    ),
  ).toBeNull()
})

// T-F14 (ruling T-P1, 18-nov): el soporte tiene su PROPIO número. El central (WHATSAPP_PHONE_NUMBER_ID) manda las plantillas a
// clientes finales y nunca es del soporte; sin el número propio, o igual al central o al de ventas, el soporte se apaga.
describe('T-F14: the support has its own WhatsApp number', () => {
  it('is the trimmed SUPPORT_WHATSAPP_PHONE_NUMBER_ID, distinct from the central and the sales numbers', () => {
    expect(supportPhoneNumberId()).toBe('support')
    expect(isSupportWhatsappEnabled()).toBe(true)
    process.env.SUPPORT_WHATSAPP_PHONE_NUMBER_ID = '  support  '
    expect(supportPhoneNumberId()).toBe('support')
  })
  it.each([
    ['unset', undefined],
    ['empty', '   '],
    ['equal to the central', 'central'],
    ['equal to the central with spaces', ' central '],
    ['equal to sales', 'sales'],
  ])('%s: there is no support number and the support is off', (_case, value) => {
    if (value === undefined) delete process.env.SUPPORT_WHATSAPP_PHONE_NUMBER_ID
    else process.env.SUPPORT_WHATSAPP_PHONE_NUMBER_ID = value
    expect(supportPhoneNumberId()).toBeNull()
    expect(isSupportWhatsappEnabled()).toBe(false)
    expect(getSupportAiConfig()).toBeNull()
  })
  it('the central setting alone (the old way) never turns the support on', () => {
    delete process.env.SUPPORT_WHATSAPP_PHONE_NUMBER_ID
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'support'
    expect(isSupportWhatsappEnabled()).toBe(false)
  })
  it('without a central number the support still has its own', () => {
    delete process.env.WHATSAPP_PHONE_NUMBER_ID
    expect(supportPhoneNumberId()).toBe('support')
  })
  it('the access token: its own when set, else the central one', () => {
    process.env.WHATSAPP_ACCESS_TOKEN = 'central-token'
    expect(supportWhatsappAccessToken()).toBe('central-token')
    process.env.SUPPORT_WHATSAPP_ACCESS_TOKEN = '  '
    expect(supportWhatsappAccessToken()).toBe('central-token')
    process.env.SUPPORT_WHATSAPP_ACCESS_TOKEN = 'support-token'
    expect(supportWhatsappAccessToken()).toBe('support-token')
    delete process.env.WHATSAPP_ACCESS_TOKEN
    expect(supportWhatsappAccessToken()).toBe('support-token')
    delete process.env.SUPPORT_WHATSAPP_ACCESS_TOKEN
    expect(supportWhatsappAccessToken()).toBe('')
  })
})

// T-F15: el número del soporte como lo ve la gente, para el panel: sólo dígitos, espacios, «+» y guiones.
describe('T-F15: the support number shown in the panel', () => {
  it.each([
    ['+1 555 788 4728', 'https://wa.me/15557884728'],
    ['+52 56 4007-0001', 'https://wa.me/525640070001'],
    ['  +1 555 788 4728  ', 'https://wa.me/15557884728'],
  ])('%s → its wa.me link', (value, waMe) => {
    process.env.SUPPORT_WHATSAPP_DISPLAY_NUMBER = value
    expect(supportDisplayNumber()).toEqual({ display: value.trim(), waMe })
  })
  it.each([
    '',
    '   ',
    'abc',
    '+1 (555) 788 4728',
    '555 1234',
    '+1 555 788 4728 ext 2',
    '++1 555 788 4728',
    '1+555 788 4728',
    '+1 555 788 4728-',
    '1234567890123456',
    '5640070001', // without its country code wa.me cannot open it
    '+1 555 78',
  ])('«%s» is not a number to show: null', value => {
    process.env.SUPPORT_WHATSAPP_DISPLAY_NUMBER = value
    expect(supportDisplayNumber()).toBeNull()
  })
  it('unset: null', () => {
    delete process.env.SUPPORT_WHATSAPP_DISPLAY_NUMBER
    expect(supportDisplayNumber()).toBeNull()
  })
})

// T-F14 (H-T15-1): entender vio otra pregunta en el mismo mensaje que la respuesta no contesta; la línea fija va al final.
describe('T-F14: the line for another question', () => {
  it('is exact, a paragraph of its own at the end, never twice, only when asked', () => {
    expect(SUPPORT_OTHER_QUESTION).toBe('También preguntaste otra cosa: mándamela en otro mensaje y te contesto.')
    expect(withOtherQuestion('Respuesta.', true)).toBe(`Respuesta.\n\n${SUPPORT_OTHER_QUESTION}`)
    expect(withOtherQuestion('Respuesta.', false)).toBe('Respuesta.')
    expect(withOtherQuestion('', true)).toBe('')
    const once = withOtherQuestion('Respuesta.', true)
    expect(withOtherQuestion(once, true)).toBe(once)
  })
  it('carries no figure, link, email or phone: it can follow a sealed figure of la B', () => {
    expect(SUPPORT_OTHER_QUESTION).not.toMatch(/[\p{N}@]|:\/\//u)
  })
  it('only if it fits the cap of the text it follows (1,500 drafted or fixed, 3,500 the literal guide); the text is never cut', () => {
    const room = 1500 - SUPPORT_OTHER_QUESTION.length - 2
    expect(withOtherQuestion('a'.repeat(room), true)).toHaveLength(1500)
    expect(withOtherQuestion('a'.repeat(room + 1), true)).toBe('a'.repeat(room + 1))
    expect(withOtherQuestion('a'.repeat(2000), true)).toHaveLength(2002 + SUPPORT_OTHER_QUESTION.length)
    const literalRoom = SUPPORT_LITERAL_CAP - SUPPORT_OTHER_QUESTION.length - 2
    expect(withOtherQuestion('a'.repeat(literalRoom), true)).toHaveLength(SUPPORT_LITERAL_CAP)
    expect(withOtherQuestion('a'.repeat(literalRoom + 1), true)).toBe('a'.repeat(literalRoom + 1))
    // A short literal guide is still the literal guide: its caller passes its cap.
    expect(withOtherQuestion('a'.repeat(1490), true, SUPPORT_LITERAL_CAP)).toHaveLength(1492 + SUPPORT_OTHER_QUESTION.length)
  })
  it('a text rebuilt from its guides keeps the line only when the saved one had it', () => {
    const saved = withOtherQuestion('Antes.', true)
    expect(keepOtherQuestion(saved, 'Después.')).toBe(`Después.\n\n${SUPPORT_OTHER_QUESTION}`)
    expect(keepOtherQuestion('Antes.', 'Después.')).toBe('Después.')
    expect(keepOtherQuestion(null, 'Después.')).toBe('Después.')
  })
})

describe('pasar a una persona: configuración y textos', () => {
  // Cada llamada parte del entorno base del archivo: lo que una prueba cambia no se arrastra a la siguiente línea.
  let base: NodeJS.ProcessEnv
  beforeEach(() => {
    base = { ...process.env }
  })
  const handoffEnv = (extra: Record<string, string | undefined> = {}) => {
    process.env = {
      ...base,
      SUPPORT_WHATSAPP_FREE_TEXT_ENABLED: 'true',
      SUPPORT_WHATSAPP_HYBRID_ENABLED: 'true',
      SUPPORT_HANDOFF_EMAIL_TO: 'soporte@avoqado.io',
    }
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  it('handoff config is null without hybrid, without central support or without a valid email', () => {
    handoffEnv()
    expect(getSupportHandoffConfig()).not.toBeNull()
    handoffEnv({ SUPPORT_WHATSAPP_HYBRID_ENABLED: 'false' })
    expect(getSupportHandoffConfig()).toBeNull()
    handoffEnv({ SUPPORT_WHATSAPP_HYBRID_ENABLED: undefined })
    expect(getSupportHandoffConfig()).toBeNull()
    // el híbrido depende del texto libre
    handoffEnv({ SUPPORT_WHATSAPP_FREE_TEXT_ENABLED: 'false' })
    expect(getSupportHandoffConfig()).toBeNull()
    // sin el número propio del soporte (aquí: el mismo número que ventas)
    handoffEnv({ SUPPORT_WHATSAPP_PHONE_NUMBER_ID: 'sales' })
    expect(getSupportHandoffConfig()).toBeNull()
    handoffEnv({ SUPPORT_WHATSAPP_ENABLED: 'false' })
    expect(getSupportHandoffConfig()).toBeNull()
    for (const bad of [undefined, '', '   ', 'no-es-un-correo', 'a@b', 'dos@avoqado.io, tres@avoqado.io', 'con espacio@avoqado.io']) {
      handoffEnv({ SUPPORT_HANDOFF_EMAIL_TO: bad })
      expect(getSupportHandoffConfig()).toBeNull()
    }
    handoffEnv({ SUPPORT_HANDOFF_EMAIL_TO: '  soporte@avoqado.io  ' })
    expect(getSupportHandoffConfig()?.to).toBe('soporte@avoqado.io')
  })

  it('defaults: +52 56 4007 0001, 3, 20, 9; an invalid number falls back to its default', () => {
    handoffEnv()
    expect(getSupportHandoffConfig()).toEqual({
      to: 'soporte@avoqado.io',
      whatsappDisplay: '+52 56 4007 0001',
      phoneDailyCap: 3,
      dailyCap: 20,
      weeklyHour: 9,
    })
    handoffEnv({
      SUPPORT_HANDOFF_WHATSAPP: '+52 55 1234 5678',
      SUPPORT_HANDOFF_PHONE_DAILY_CAP: '50',
      SUPPORT_HANDOFF_DAILY_CAP: '500',
      SUPPORT_WEEKLY_REPORT_HOUR: '0',
    })
    expect(getSupportHandoffConfig()).toMatchObject({
      whatsappDisplay: '+52 55 1234 5678',
      phoneDailyCap: 50,
      dailyCap: 500,
      weeklyHour: 0,
    })
    handoffEnv({ SUPPORT_HANDOFF_PHONE_DAILY_CAP: '1', SUPPORT_HANDOFF_DAILY_CAP: '1', SUPPORT_WEEKLY_REPORT_HOUR: '23' })
    expect(getSupportHandoffConfig()).toMatchObject({ phoneDailyCap: 1, dailyCap: 1, weeklyHour: 23 })
    for (const bad of ['0', '51', '-1', '2.5', 'tres', '', ' ', '1e1', '03x']) {
      handoffEnv({ SUPPORT_HANDOFF_PHONE_DAILY_CAP: bad })
      expect(getSupportHandoffConfig()?.phoneDailyCap).toBe(3)
    }
    for (const bad of ['0', '501', '-1', '2.5', 'veinte', '']) {
      handoffEnv({ SUPPORT_HANDOFF_DAILY_CAP: bad })
      expect(getSupportHandoffConfig()?.dailyCap).toBe(20)
    }
    for (const bad of ['24', '-1', '9.5', 'nueve', '']) {
      handoffEnv({ SUPPORT_WEEKLY_REPORT_HOUR: bad })
      expect(getSupportHandoffConfig()?.weeklyHour).toBe(9)
    }
    for (const bad of ['', '   ', 'llámame', '+52 <b>1</b>']) {
      handoffEnv({ SUPPORT_HANDOFF_WHATSAPP: bad })
      expect(getSupportHandoffConfig()?.whatsappDisplay).toBe('+52 56 4007 0001')
    }
  })

  it('texts are exact', () => {
    expect(supportHandoffDone('+52 56 4007 0001')).toBe(
      'Listo, ya le avisé al equipo de Avoqado. Una persona te va a escribir por WhatsApp desde el +52 56 4007 0001. Mientras, puedo seguir ayudándote con las guías.',
    )
    expect(supportHandoffAlready('+52 56 4007 0001')).toBe('Ya le avisé al equipo; te van a escribir desde el +52 56 4007 0001.')
    expect(SUPPORT_HANDOFF_OFFER).toBe('¿Quieres que te escriba una persona del equipo de Avoqado?')
    expect(SUPPORT_SECOND_FAILURE).toBe('No encontré eso en nuestras guías.')
    expect(supportOldVersion('2.22')).toBe('Esta guía es para la versión 2.22 o más nueva; te recomiendo actualizar la app.')
    expect(supportManualSource('Abrir la caja')).toBe('Fuente: manual de Avoqado · Abrir la caja')
    expect(SUPPORT_HANDOFF_GREETING).toBe('Hola, te escribo de Avoqado por tu mensaje en el asistente de ayuda.')
    expect(SUPPORT_CLARIFY_CLOSE_MANUAL).toBe('Escríbenos a hola@avoqado.io y te ayudamos con la que corresponda.')
  })

  it('data config: null without hybrid or without its switch; defaults; an invalid number falls back', () => {
    handoffEnv({ SUPPORT_DATA_ENABLED: 'true' })
    expect(getSupportDataConfig()).toEqual({
      dailyCap: 60,
      freshMs: 600_000,
      rows: 5,
      openOrdersDays: 7,
      queryTimeoutMs: 8_000,
      depositGroups: 2_000,
      depositTimeoutMs: 3_000,
    })
    handoffEnv({ SUPPORT_DATA_ENABLED: 'true', SUPPORT_DATA_DAILY_CAP: '0', SUPPORT_DATA_ROWS: '9', SUPPORT_DATA_FRESH_MINUTES: 'diez' })
    expect(getSupportDataConfig()).toMatchObject({ dailyCap: 60, rows: 5, freshMs: 600_000 })
    handoffEnv({ SUPPORT_DATA_ENABLED: 'false' })
    expect(isSupportDataEnabled()).toBe(false)
    handoffEnv({ SUPPORT_DATA_ENABLED: 'true', SUPPORT_WHATSAPP_HYBRID_ENABLED: 'false' })
    expect(getSupportDataConfig()).toBeNull()
    handoffEnv() // sin SUPPORT_DATA_ENABLED
    expect(getSupportDataConfig()).toBeNull()
  })

  it('the read timeout is 5 to 30 s: below 5 falls back to its default like any other out-of-range value, and 5 stays above the Stripe cap of the plan (C5)', () => {
    const timeout = (value: string) => {
      handoffEnv({ SUPPORT_DATA_ENABLED: 'true', SUPPORT_DATA_QUERY_TIMEOUT_SECONDS: value })
      return getSupportDataConfig()?.queryTimeoutMs
    }
    expect(['1', '3', '4', '5', '30', '31'].map(timeout)).toEqual([8_000, 8_000, 8_000, 5_000, 30_000, 8_000])
    expect(SUPPORT_DATA_QUERY_TIMEOUT_MIN_SECONDS).toBe(5)
    // Con un mínimo de 3 s o menos, la lectura se cortaría antes que Stripe: «No pude leer ese dato» en vez del plan sin fecha
    expect(SUPPORT_DATA_QUERY_TIMEOUT_MIN_SECONDS * 1000).toBeGreaterThan(STRIPE_TIMEOUT_MS)
  })

  it('the deposit timeout stays 4 s under the read timeout: within never answers while its transaction still holds a connection (C6 r1)', () => {
    const caps = (query: string | undefined, deposit: string | undefined) => {
      handoffEnv({
        SUPPORT_DATA_ENABLED: 'true',
        ...(query ? { SUPPORT_DATA_QUERY_TIMEOUT_SECONDS: query } : {}),
        ...(deposit ? { SUPPORT_DATA_DEPOSIT_TIMEOUT_SECONDS: deposit } : {}),
      })
      const c = getSupportDataConfig()
      return [c?.queryTimeoutMs, c?.depositTimeoutMs]
    }
    expect([caps(undefined, undefined), caps('5', '30'), caps('8', '30'), caps('30', '30'), caps('8', '3'), caps('5', '1')]).toEqual([
      [8_000, 3_000],
      [5_000, 1_000],
      [8_000, 4_000],
      [30_000, 26_000],
      [8_000, 3_000],
      [5_000, 1_000],
    ])
  })

  it('the general notice changes one sentence, only with data on, and still fits', () => {
    // La frase vive en UNA línea (SUPPORT_NOTICE_DATA_SENTENCE): la prueba no la repite, para que cambiarla sea tocar sólo esa línea
    expect(SUPPORT_NOTICE_DATA).toBe(
      SUPPORT_NOTICE.replace('no opero tu negocio ni consulto ventas privadas', SUPPORT_NOTICE_DATA_SENTENCE),
    )
    expect(SUPPORT_NOTICE_DATA).not.toBe(SUPPORT_NOTICE)
    expect(SUPPORT_NOTICE_DATA).not.toContain('ni consulto ventas privadas')
    expect(SUPPORT_NOTICE_DATA_SENTENCE).not.toMatch(/\d{8,}|c[oó]digo/i)
    expect(SUPPORT_NOTICE_DATA_FREE_TEXT.length).toBeLessThanOrEqual(1500)
    handoffEnv() // texto libre e híbrido prendidos, B apagada: byte-idéntico a hoy
    expect(supportNotice()).toBe(SUPPORT_NOTICE_FREE_TEXT)
    handoffEnv({ SUPPORT_DATA_ENABLED: 'true' })
    expect(supportNotice()).toBe(SUPPORT_NOTICE_DATA_FREE_TEXT)
    expect(SUPPORT_NOTICE_TEXTS).toEqual([SUPPORT_NOTICE, SUPPORT_NOTICE_FREE_TEXT, SUPPORT_NOTICE_DATA, SUPPORT_NOTICE_DATA_FREE_TEXT])
  })

  it('an invalid value warns once per process, naming the variable and never its value; its default applies (T4-m2)', () => {
    handoffEnv({ SUPPORT_HANDOFF_WHATSAPP: 'llámame al 55', SUPPORT_HANDOFF_DAILY_CAP: 'veinte', SUPPORT_WEEKLY_REPORT_HOUR: '' })
    // A fresh module: the «once per process» memory starts empty, whatever the tests above already warned.
    jest.isolateModules(() => {
      const { getSupportHandoffConfig: fresh } = require('@/config/supportWhatsapp')
      const logger = require('@/config/logger').default
      for (let i = 0; i < 2; i++)
        expect(fresh()).toMatchObject({ whatsappDisplay: '+52 56 4007 0001', dailyCap: 20, phoneDailyCap: 3, weeklyHour: 9 })
      // An empty value is unset, not invalid.
      expect(logger.warn.mock.calls.map((c: unknown[]) => (c[1] as { variable: string }).variable).sort()).toEqual([
        'SUPPORT_HANDOFF_DAILY_CAP',
        'SUPPORT_HANDOFF_WHATSAPP',
      ])
      handoffEnv({ SUPPORT_HANDOFF_EMAIL_TO: 'soporte(arroba)avoqado.io' })
      expect(fresh()).toBeNull()
      expect(fresh()).toBeNull()
      expect(logger.warn).toHaveBeenCalledTimes(3)
      expect(logger.warn).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ variable: 'SUPPORT_HANDOFF_EMAIL_TO' }))
      expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/llámame|veinte|arroba/)
    })
  })
})

describe('ayuda pública para números no registrados (22-nov)', () => {
  const hybrid = (extra: Record<string, string | undefined> = {}) => {
    process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = 'true'
    process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = 'true'
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  it('is on by default with the hybrid; SUPPORT_PUBLIC_HELP_ENABLED=false turns it off; without the hybrid it is off', () => {
    hybrid()
    expect(isSupportPublicHelpEnabled()).toBe(true)
    for (const off of ['false', ' FALSE ']) {
      hybrid({ SUPPORT_PUBLIC_HELP_ENABLED: off })
      expect(isSupportPublicHelpEnabled()).toBe(false)
    }
    hybrid({ SUPPORT_PUBLIC_HELP_ENABLED: 'true', SUPPORT_WHATSAPP_HYBRID_ENABLED: undefined })
    expect(isSupportPublicHelpEnabled()).toBe(false)
  })
  it('its daily AI budget: US$1 by default, an exact USD amount, an invalid value falls back to 1', () => {
    expect(getSupportPublicHelpDailyUsd().toString()).toBe('1')
    process.env.SUPPORT_PUBLIC_HELP_DAILY_USD = '2.50'
    expect(getSupportPublicHelpDailyUsd().toString()).toBe('2.5')
    process.env.SUPPORT_PUBLIC_HELP_DAILY_USD = '0'
    expect(getSupportPublicHelpDailyUsd().toString()).toBe('0')
    for (const bad of ['-1', 'un dólar', '1e3', '01'])
      expect((process.env.SUPPORT_PUBLIC_HELP_DAILY_USD = bad) && getSupportPublicHelpDailyUsd().toString()).toBe('1')
  })
  it('the first message says what the bot does and that business data needs the number linked, then the notice of today', () => {
    hybrid()
    expect(supportPublicNotice()).toBe(`${SUPPORT_PUBLIC_INTRO}\n\n${SUPPORT_NOTICE_FREE_TEXT}`)
    expect(SUPPORT_PUBLIC_INTRO).toContain('https://dashboard.avoqado.io/support/whatsapp')
    hybrid({ SUPPORT_DATA_ENABLED: 'true' })
    expect(supportPublicNotice()).toBe(`${SUPPORT_PUBLIC_INTRO}\n\n${SUPPORT_NOTICE_DATA_FREE_TEXT}`)
    // Every variant is recognized as a shown notice, and fits in one WhatsApp answer.
    expect(SUPPORT_PUBLIC_NOTICE_TEXTS).toEqual(SUPPORT_NOTICE_TEXTS.map(text => `${SUPPORT_PUBLIC_INTRO}\n\n${text}`))
    for (const text of SUPPORT_PUBLIC_NOTICE_TEXTS) expect(text.length).toBeLessThanOrEqual(1500)
    // The four of today are untouched.
    expect(SUPPORT_NOTICE_TEXTS).toEqual([SUPPORT_NOTICE, SUPPORT_NOTICE_FREE_TEXT, SUPPORT_NOTICE_DATA, SUPPORT_NOTICE_DATA_FREE_TEXT])
  })
  it('the limit and pause texts are exact', () => {
    expect(SUPPORT_PUBLIC_DAY_LIMIT).toBe('Llegaste al límite de preguntas por hoy. Seguimos mañana. Mientras: https://avoqado.io/help')
    expect(SUPPORT_PUBLIC_HOUR_LIMIT).toBe(
      'Llegaste al límite de preguntas por ahora. Seguimos en una hora. Mientras: https://avoqado.io/help',
    )
    expect(supportPublicPause(1)).toBe(
      'Pausé esta conversación 24 horas. Si necesitas ayuda con Avoqado, escríbeme después o ve a https://avoqado.io/help',
    )
    expect(supportPublicPause(7)).toBe(
      'Pausé esta conversación 7 días. Si necesitas ayuda con Avoqado, escríbeme después o ve a https://avoqado.io/help',
    )
  })
})
