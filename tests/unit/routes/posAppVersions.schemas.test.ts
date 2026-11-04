import {
  assertImpactCandidate,
  assertPolicyRules,
  clearPolicySchema,
  impactQuerySchema,
  publicPosAppVersionQuerySchema,
  putPolicySchema,
} from '@/routes/superadmin/posAppVersions.schemas'
import { validateRequest } from '@/middlewares/validation'
import { BadRequestError, InternalServerError } from '@/errors/AppError'

const errores = (schema: { safeParse: (x: unknown) => any }, entrada: unknown): string[] => {
  const r = schema.safeParse(entrada)
  return r.success ? [] : r.error.issues.map((i: { message: string }) => i.message)
}
const parse = (schema: { safeParse: (x: unknown) => any }, entrada: unknown) => {
  const r = schema.safeParse(entrada)
  if (!r.success) throw new Error(`no pasó: ${JSON.stringify(r.error.issues)}`)
  return r.data
}
const query = (q: unknown) => ({ query: q })
const put = (platform: string, b: unknown) => ({ params: { platform }, body: b })
const mensajeDe = (fn: () => unknown): { message: string; code?: string; statusCode: number } => {
  try {
    fn()
  } catch (e: any) {
    expect(e).toBeInstanceOf(BadRequestError)
    return e
  }
  throw new Error('no lanzó')
}

describe('publicPosAppVersionQuerySchema', () => {
  it('ANDROID con versionCode en texto pasa como número', () => {
    expect(parse(publicPosAppVersionQuerySchema, query({ platform: 'ANDROID', versionCode: '96' })).query.versionCode).toBe(96)
  })
  it('ANDROID sin versionCode da el mensaje del número', () => {
    expect(errores(publicPosAppVersionQuerySchema, query({ platform: 'ANDROID' }))).toContain(
      'La versión de la app (versionCode) no es válida',
    )
  })
  it('ANDROID con versionCode fuera de rango o con ceros falla', () => {
    for (const v of ['0', '007', '2147483648', 'abc', '']) {
      expect(errores(publicPosAppVersionQuerySchema, query({ platform: 'ANDROID', versionCode: v }))).not.toEqual([])
    }
  })
  it('iOS con versionCode mal formado pasa y lo quita', () => {
    const q = parse(publicPosAppVersionQuerySchema, query({ platform: 'IOS', versionName: '1.16.0', versionCode: 'abc' })).query
    expect(q.versionName).toBe('1.16.0')
    expect(q).not.toHaveProperty('versionCode')
  })
  it('ANDROID con versionName mal formado pasa y lo quita', () => {
    const q = parse(publicPosAppVersionQuerySchema, query({ platform: 'ANDROID', versionCode: '96', versionName: 'x.y' })).query
    expect(q.versionCode).toBe(96)
    expect(q).not.toHaveProperty('versionName')
  })
  it('iOS con build pasa', () => {
    const q = parse(publicPosAppVersionQuerySchema, query({ platform: 'IOS', versionName: '1.16.0', build: '41.2.3' })).query
    expect(q.build).toBe('41.2.3')
  })
  it('build se recorta a 20 caracteres', () => {
    const q = parse(publicPosAppVersionQuerySchema, query({ platform: 'DESKTOP', build: 'a'.repeat(50) })).query
    expect(q.build).toHaveLength(20)
  })
  it('iOS sin versionName da el mensaje del nombre', () => {
    expect(errores(publicPosAppVersionQuerySchema, query({ platform: 'IOS' }))).toContain('La versión de la app (versionName) no es válida')
  })
  it('DESKTOP pasa y TPV falla', () => {
    expect(errores(publicPosAppVersionQuerySchema, query({ platform: 'DESKTOP' }))).toEqual([])
    expect(errores(publicPosAppVersionQuerySchema, query({ platform: 'TPV' }))).not.toEqual([])
  })
})

describe('putPolicySchema (forma)', () => {
  const ok = { required: { versionCode: 100, versionName: '2.27.0' }, recommended: null, expectedVersion: null }
  it('ANDROID válido pasa', () => {
    expect(errores(putPolicySchema, put('ANDROID', ok))).toEqual([])
  })
  it('plataforma TPV o DESKTOP falla', () => {
    expect(errores(putPolicySchema, put('TPV', ok))).not.toEqual([])
    expect(errores(putPolicySchema, put('DESKTOP', ok))).not.toEqual([])
  })
  it('sin la llave recommended, required o expectedVersion falla', () => {
    for (const k of ['recommended', 'required', 'expectedVersion']) {
      const b: any = { ...ok }
      delete b[k]
      expect(errores(putPolicySchema, put('ANDROID', b))).not.toEqual([])
    }
  })
  it('iOS con sólo versionName pasa', () => {
    const d = parse(putPolicySchema, put('IOS', { required: { versionName: '1.16.0' }, recommended: null, expectedVersion: 3 }))
    expect(d.body.required.versionName).toBe('1.16.0')
  })
  it('nombre de versión mal formado falla', () => {
    expect(errores(putPolicySchema, put('IOS', { required: { versionName: '1.x' }, recommended: null, expectedVersion: 3 }))).not.toEqual(
      [],
    )
  })
  it('message en blanco queda null', () => {
    expect(parse(putPolicySchema, put('ANDROID', { ...ok, message: '   ' })).body.message).toBeNull()
  })
  it('message de 281 caracteres falla; de 280 pasa', () => {
    expect(errores(putPolicySchema, put('ANDROID', { ...ok, message: 'a'.repeat(281) }))).not.toEqual([])
    expect(errores(putPolicySchema, put('ANDROID', { ...ok, message: 'a'.repeat(280) }))).toEqual([])
  })
  it('un campo extra se descarta', () => {
    expect(parse(putPolicySchema, put('ANDROID', { ...ok, version: 9 })).body).not.toHaveProperty('version')
  })
})

describe('mensajes en español', () => {
  const ok = { required: { versionCode: 100 }, recommended: null, expectedVersion: null }
  const sin = (k: string) => {
    const b: any = { ...ok }
    delete b[k]
    return errores(putPolicySchema, put('ANDROID', b))
  }
  it('falta required / recommended', () => {
    expect(sin('required')).toEqual(['Falta la versión obligatoria (usa null si no hay)'])
    expect(sin('recommended')).toEqual(['Falta la versión recomendada (usa null si no hay)'])
  })
  it('expectedVersion de tipo equivocado', () => {
    expect(errores(putPolicySchema, put('ANDROID', { ...ok, expectedVersion: 'x' }))).toEqual(['La versión esperada debe ser un entero'])
  })
  it('message no texto', () => {
    expect(errores(putPolicySchema, put('ANDROID', { ...ok, message: 5 }))).toEqual(['El mensaje debe ser texto'])
  })
  it('noticeStyle no válido o no texto', () => {
    for (const n of ['TOAST', 5]) {
      expect(errores(putPolicySchema, put('ANDROID', { ...ok, recommended: { versionCode: 100, noticeStyle: n } }))).toEqual([
        'El aviso debe ser banner o ventana',
      ])
    }
  })
  it('impact versionCode "1e3" falla', () => {
    expect(errores(impactQuerySchema, { params: { platform: 'ANDROID' }, query: { versionCode: '1e3' } })).not.toEqual([])
    expect(errores(impactQuerySchema, { params: { platform: 'ANDROID' }, query: { versionCode: '0x10' } })).not.toEqual([])
    expect(parse(impactQuerySchema, { params: { platform: 'ANDROID' }, query: { versionCode: '96' } }).query.versionCode).toBe(96)
  })
})

describe('assertPolicyRules', () => {
  it('iOS recomendada 1.16 con obligatoria 1.16.0 pasa (iguales al rellenar)', () => {
    expect(() =>
      assertPolicyRules('IOS', { required: { versionName: '1.16.0' }, recommended: { versionName: '1.16', noticeStyle: 'BANNER' } }),
    ).not.toThrow()
  })
  it('ANDROID válido normaliza los campos ausentes a null', () => {
    const r = assertPolicyRules('ANDROID', { required: { versionCode: 100 } as any, recommended: null })
    expect(r).toEqual({ required: { versionCode: 100, versionName: null }, recommended: null })
  })
  it('ANDROID exige versionCode en cada nivel', () => {
    const e = mensajeDe(() => assertPolicyRules('ANDROID', { required: { versionName: '2.0' } as any, recommended: null }))
    expect(e.code).toBe('POS_APP_VERSION_POLICY_INVALID')
  })
  it('iOS rechaza versionCode', () => {
    const e = mensajeDe(() => assertPolicyRules('IOS', { required: { versionName: '1.16.0', versionCode: 9 } as any, recommended: null }))
    expect(e.message).toBe('En iOS la versión se fija por nombre, no por número')
    expect(e.code).toBe('POS_APP_VERSION_POLICY_INVALID')
  })
  it('iOS exige versionName', () => {
    mensajeDe(() => assertPolicyRules('IOS', { required: {} as any, recommended: null }))
  })
  it('iOS válido deja versionCode en null', () => {
    expect(assertPolicyRules('IOS', { required: { versionName: '1.16.0' } as any, recommended: null }).required).toEqual({
      versionCode: null,
      versionName: '1.16.0',
    })
  })
  it('los dos niveles null piden usar Quitar', () => {
    expect(mensajeDe(() => assertPolicyRules('ANDROID', { required: null, recommended: null })).message).toBe(
      'Para quitar las dos mínimas usa Quitar',
    )
  })
  it('recomendada menor que obligatoria falla (ANDROID)', () => {
    const e = mensajeDe(() =>
      assertPolicyRules('ANDROID', {
        required: { versionCode: 100 } as any,
        recommended: { versionCode: 99, noticeStyle: 'BANNER' } as any,
      }),
    )
    expect(e.message).toBe('La recomendada no puede ser menor que la obligatoria')
  })
  it('recomendada menor que obligatoria falla (iOS)', () => {
    mensajeDe(() =>
      assertPolicyRules('IOS', {
        required: { versionName: '1.16' } as any,
        recommended: { versionName: '1.15', noticeStyle: 'MODAL' } as any,
      }),
    )
  })
  it('recomendada igual a la obligatoria pasa', () => {
    const r = assertPolicyRules('ANDROID', {
      required: { versionCode: 100 } as any,
      recommended: { versionCode: 100, noticeStyle: 'MODAL' } as any,
    })
    expect(r.recommended).toEqual({ versionCode: 100, versionName: null, noticeStyle: 'MODAL' })
  })
  it('la recomendada exige noticeStyle', () => {
    expect(mensajeDe(() => assertPolicyRules('ANDROID', { required: null, recommended: { versionCode: 100 } as any })).message).toBe(
      'Elige cómo se avisa: banner o ventana',
    )
  })
})

describe('clearPolicySchema', () => {
  it('sin expectedVersion o con 0 falla; con 2 pasa', () => {
    expect(errores(clearPolicySchema, put('ANDROID', {}))).not.toEqual([])
    expect(errores(clearPolicySchema, put('ANDROID', { expectedVersion: 0 }))).not.toEqual([])
    expect(errores(clearPolicySchema, put('ANDROID', { expectedVersion: 2 }))).toEqual([])
  })
})

describe('impactQuerySchema y assertImpactCandidate', () => {
  const imp = (platform: string, q: unknown) => ({ params: { platform }, query: q })
  it('sin days vale 7; days en texto se convierte', () => {
    expect(parse(impactQuerySchema, imp('ANDROID', {})).query.days).toBe(7)
    expect(parse(impactQuerySchema, imp('ANDROID', { days: '30' })).query.days).toBe(30)
  })
  it('days 0, 91 y -1 fallan', () => {
    for (const d of ['0', '91', '-1']) expect(errores(impactQuerySchema, imp('ANDROID', { days: d }))).not.toEqual([])
  })
  it('candidato: iOS con versionCode lanza 400', () => {
    mensajeDe(() => assertImpactCandidate('IOS', { versionCode: 3 }))
  })
  it('candidato: ANDROID con versionName lanza 400', () => {
    mensajeDe(() => assertImpactCandidate('ANDROID', { versionName: '1.0' }))
  })
  it('candidato válido y vacío', () => {
    expect(assertImpactCandidate('ANDROID', { versionCode: 96 })).toEqual({ versionCode: 96 })
    expect(assertImpactCandidate('IOS', { versionName: '1.16.0' })).toEqual({ versionName: '1.16.0' })
    expect(assertImpactCandidate('ANDROID', {})).toBeNull()
  })
})

describe('con el middleware real', () => {
  const correr = async (schema: any, req: any) => {
    const next = jest.fn()
    await validateRequest(schema)(req, {} as any, next)
    return next.mock.calls[0]?.[0]
  }
  it('entradas válidas llaman next() sin error', async () => {
    expect(
      await correr(putPolicySchema, {
        params: { platform: 'ANDROID' },
        query: {},
        body: { required: { versionCode: 5 }, recommended: null, expectedVersion: null },
      }),
    ).toBeUndefined()
    expect(await correr(impactQuerySchema, { params: { platform: 'IOS' }, query: { versionName: '1.0' }, body: {} })).toBeUndefined()
    expect(await correr(clearPolicySchema, { params: { platform: 'IOS' }, query: {}, body: { expectedVersion: 1 } })).toBeUndefined()
    expect(await correr(publicPosAppVersionQuerySchema, { params: {}, query: { platform: 'DESKTOP' }, body: {} })).toBeUndefined()
  })
  it('entradas inválidas dan BadRequestError 400, nunca InternalServerError', async () => {
    const casos: [any, any][] = [
      [putPolicySchema, { params: { platform: 'TPV' }, query: {}, body: {} }],
      [impactQuerySchema, { params: { platform: 'IOS' }, query: { days: '0' }, body: {} }],
      [clearPolicySchema, { params: { platform: 'IOS' }, query: {}, body: {} }],
      [publicPosAppVersionQuerySchema, { params: {}, query: { platform: 'ANDROID' }, body: {} }],
    ]
    for (const [s, req] of casos) {
      const err = await correr(s, req)
      expect(err).toBeInstanceOf(BadRequestError)
      expect(err).not.toBeInstanceOf(InternalServerError)
      expect(err.statusCode).toBe(400)
    }
  })
})
