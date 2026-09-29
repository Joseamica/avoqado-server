import {
  aplanarTiendas,
  elegirIdToken,
  enLotes,
  hostDeLogin,
  leerEstadoAprovisionamiento,
  leerRespuestaAprovisionamiento,
  retoPkce,
  urlDeAutorizacion,
} from '../../../../src/services/delivery-channels/providers/rappi/rappi.selfOnboarding'

const b64u = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jws = (alg: string) => `${b64u({ alg, typ: 'JWT' })}.${b64u({ email: 'a@b.com' })}.firma`
const jwe = `${b64u({ alg: 'dir', enc: 'A256GCM' })}.llave.iv.cifrado.tag`

describe('rappi.selfOnboarding', () => {
  it('login: dev en SANDBOX, productivo en PRODUCTION', () => {
    expect(hostDeLogin('SANDBOX')).toBe('https://login.partners.dev.rappi.com')
    expect(hostDeLogin('PRODUCTION')).toBe('https://login.partners.rappi.com')
  })

  it('el reto PKCE es base64url(SHA-256(verifier)) — el vector del RFC 7636', () => {
    expect(retoPkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('la URL de autorización lleva code, openid, S256 y el state — y NUNCA el verifier', () => {
    const u = new URL(
      urlDeAutorizacion({ ambiente: 'SANDBOX', clientId: 'cid', redirectUri: 'https://x/cb', state: 'st', verifier: 'secreto-v' }),
    )
    expect(u.origin + u.pathname).toBe('https://login.partners.dev.rappi.com/authorize')
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('scope')).toBe('openid profile email')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('code_challenge')).toBe(retoPkce('secreto-v'))
    expect(u.searchParams.get('state')).toBe('st')
    expect(u.toString()).not.toContain('secreto-v')
  })

  // 🔴 Review Focus 4
  it('elige el id_token RS256 aunque el access_token venga primero', () => {
    const t = jws('RS256')
    expect(elegirIdToken({ access_token: jwe, id_token: t, token_type: 'Bearer' })).toBe(t)
  })
  it('sin id_token, o con uno que no es RS256, falla claro — jamás devuelve el access_token', () => {
    expect(() => elegirIdToken({ access_token: jwe })).toThrow('RAPPI_ID_TOKEN_INVALIDO')
    expect(() => elegirIdToken({ id_token: jwe })).toThrow('RAPPI_ID_TOKEN_INVALIDO')
    expect(() => elegirIdToken({ id_token: jws('HS256') })).toThrow('RAPPI_ID_TOKEN_INVALIDO')
    expect(() => elegirIdToken('basura')).toThrow('RAPPI_ID_TOKEN_INVALIDO')
  })

  it('aplana padres e hijas conservando quién integra, de quién es hija y su integration_id (R7)', () => {
    const r = aplanarTiendas({
      stores: [
        {
          store_id: '1',
          name: 'Main',
          brand: 'B',
          integrated: true,
          integration_id: 'int-1',
          children: [{ store_id: '3', name: 'Hija', integrated: false }],
        },
        { store_id: '11', name: 'Sola', integrated: false, children: [] },
      ],
    })
    expect(r).toEqual([
      { storeId: '1', name: 'Main', brand: 'B', integrated: true, integrationId: 'int-1' },
      { storeId: '3', name: 'Hija', integrated: false, parentId: '1' },
      { storeId: '11', name: 'Sola', integrated: false },
    ])
    // Sin integration_id la llave NO existe (no `integrationId: undefined`): quien compare con === lo agradece.
    expect('integrationId' in r[1]).toBe(false)
    expect(aplanarTiendas({})).toEqual([])
    expect(aplanarTiendas(null)).toEqual([])
  })

  it('parte en lotes de 20', () => {
    expect(enLotes(Array.from({ length: 41 }, (_, i) => i)).map(l => l.length)).toEqual([20, 20, 1])
  })

  describe('leerRespuestaAprovisionamiento (R6: incierta ≠ rechazada)', () => {
    it('202: separa aceptadas (con su integration_id) y rechazadas', () => {
      const raw = JSON.stringify({
        batch_id: 'b1',
        accepted: [{ store_id: '10', integration_id: 'int-10' }],
        rejected: [{ store_id: '11', reason: 'not_owned' }],
      })
      expect(leerRespuestaAprovisionamiento(202, raw, ['10', '11'])).toEqual({
        batchId: 'b1',
        aceptadas: [{ storeId: '10', integrationId: 'int-10' }],
        rechazadas: [{ storeId: '11', motivo: 'not_owned' }],
        inciertas: [],
      })
    })

    it('202 sin integration_id: la llave no existe en la aceptada', () => {
      const r = leerRespuestaAprovisionamiento(202, JSON.stringify({ batch_id: 'b1', accepted: [{ store_id: '10' }] }), ['10'])
      expect(r.aceptadas).toEqual([{ storeId: '10' }])
      expect('integrationId' in r.aceptadas[0]).toBe(false)
    })

    it.each([400, 401, 403, 422])('%i: Rappi rechazó la petición — TODAS las pedidas rechazadas con HTTP_<status>', status => {
      expect(leerRespuestaAprovisionamiento(status, '{"message":"x"}', ['10', '11'])).toEqual({
        aceptadas: [],
        rechazadas: [
          { storeId: '10', motivo: `HTTP_${status}` },
          { storeId: '11', motivo: `HTTP_${status}` },
        ],
        inciertas: [],
      })
    })

    it.each([200, 302, 404, 409, 424, 500, 503])(
      '%i: cualquier otro status ⇒ TODAS inciertas (no sabemos si Rappi aprovisionó)',
      status => {
        // 🔴 Un 5xx/424 puede llegar DESPUÉS de que Rappi ya empezó: tratarlo como rechazo borraría un vínculo
        // que la confirmación va a querer promover.
        expect(
          leerRespuestaAprovisionamiento(status, JSON.stringify({ batch_id: 'b1', accepted: [{ store_id: '10' }] }), ['10', '11']),
        ).toEqual({
          aceptadas: [],
          rechazadas: [],
          inciertas: ['10', '11'],
        })
      },
    )

    it('202 con `{}` ⇒ todas inciertas', () => {
      expect(leerRespuestaAprovisionamiento(202, '{}', ['10', '11'])).toEqual({ aceptadas: [], rechazadas: [], inciertas: ['10', '11'] })
    })

    it('202 con `null` ⇒ todas inciertas, sin lanzar', () => {
      expect(() => leerRespuestaAprovisionamiento(202, 'null', ['10'])).not.toThrow()
      expect(leerRespuestaAprovisionamiento(202, 'null', ['10'])).toEqual({ aceptadas: [], rechazadas: [], inciertas: ['10'] })
    })

    it('202 ilegible, vacío o que no es un objeto ⇒ todas inciertas (nunca aceptadas, nunca rechazadas)', () => {
      for (const raw of ['no-json', '', '[]', '"x"', '7']) {
        expect(leerRespuestaAprovisionamiento(202, raw, ['10'])).toEqual({ aceptadas: [], rechazadas: [], inciertas: ['10'] })
      }
    })

    it('un id que Rappi acepta o rechaza pero NO pedimos se ignora', () => {
      const raw = JSON.stringify({
        batch_id: 'b1',
        accepted: [{ store_id: '10' }, { store_id: '999' }],
        rejected: [{ store_id: '888', reason: 'x' }],
      })
      expect(leerRespuestaAprovisionamiento(202, raw, ['10'])).toEqual({
        batchId: 'b1',
        aceptadas: [{ storeId: '10' }],
        rechazadas: [],
        inciertas: [],
      })
    })

    it('una pedida que no aparece en ninguna lista ⇒ incierta (las demás siguen su curso)', () => {
      const raw = JSON.stringify({ batch_id: 'b1', accepted: [{ store_id: '10' }], rejected: [{ store_id: '11', reason: 'not_owned' }] })
      expect(leerRespuestaAprovisionamiento(202, raw, ['10', '11', '12'])).toEqual({
        batchId: 'b1',
        aceptadas: [{ storeId: '10' }],
        rechazadas: [{ storeId: '11', motivo: 'not_owned' }],
        inciertas: ['12'],
      })
    })

    it('una pedida que Rappi pone en las DOS listas ⇒ incierta (se contradice, no adivinamos)', () => {
      const raw = JSON.stringify({ batch_id: 'b1', accepted: [{ store_id: '10' }], rejected: [{ store_id: '10', reason: 'x' }] })
      expect(leerRespuestaAprovisionamiento(202, raw, ['10'])).toEqual({ batchId: 'b1', aceptadas: [], rechazadas: [], inciertas: ['10'] })
    })

    it('entradas basura dentro de las listas no rompen nada y los ids numéricos se aceptan', () => {
      const raw = JSON.stringify({ batch_id: 'b1', accepted: [null, 'x', {}, { store_id: 10 }], rejected: 'no-es-lista' })
      expect(leerRespuestaAprovisionamiento(202, raw, ['10', '11'])).toEqual({
        batchId: 'b1',
        aceptadas: [{ storeId: '10' }],
        rechazadas: [],
        inciertas: ['11'],
      })
    })

    it('sin pedidas no hay nada que clasificar', () => {
      expect(leerRespuestaAprovisionamiento(202, JSON.stringify({ accepted: [{ store_id: '10' }] }), [])).toEqual({
        aceptadas: [],
        rechazadas: [],
        inciertas: [],
      })
      expect(leerRespuestaAprovisionamiento(503, '', [])).toEqual({ aceptadas: [], rechazadas: [], inciertas: [] })
    })
  })

  it('lee el webhook STORE_PROVISIONING_STATUS en camelCase (con integrationId si viene)', () => {
    expect(
      leerEstadoAprovisionamiento({
        batchId: 'b1',
        operation: 'PROVISION',
        results: [
          { storeId: '10', status: 'ACTIVE', httpCode: 201, integrationId: 'int-10' },
          { storeId: '11', status: 'FAILED', errorMessage: 'Store already exists', httpCode: 409 },
          { storeId: '12', status: 'RARO' },
        ],
      }),
    ).toEqual({
      batchId: 'b1',
      operation: 'PROVISION',
      results: [
        { storeId: '10', status: 'ACTIVE', httpCode: 201, integrationId: 'int-10' },
        { storeId: '11', status: 'FAILED', errorMessage: 'Store already exists', httpCode: 409 },
      ],
    })
    expect(leerEstadoAprovisionamiento('x').results).toEqual([])
    expect(leerEstadoAprovisionamiento(null).results).toEqual([])
  })
})
