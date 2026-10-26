// El servicio compartido de intents importa el env al cargarse; el objeto vive DENTRO de la fábrica (TDZ).
jest.mock('@/config/env', () => ({ env: { RAPPI_CONNECT_SIGNING_KEY: 'k'.repeat(40) } }))
jest.mock('../../../../src/services/delivery-channels/providers/rappi/rappi.client', () => ({
  canjearCodigoRappi: jest.fn(),
  tiendasDelComercio: jest.fn(),
  aprovisionarTiendasRappi: jest.fn(),
  suscribirTiendaAEventos: jest.fn(),
  marcarTiendaIntegradaRappi: jest.fn(),
  tiendasEscribiblesRappi: () => ['10', '11'],
  getRappiEnvironment: () => 'SANDBOX',
  clientIdRappi: () => 'cid',
  redirectUriRappi: jest.fn(() => 'https://api.test/api/v1/delivery/rappi/oauth/callback'),
  preflightSelfOnboardingRappi: jest.fn(() => 'https://api.test'),
}))
jest.mock('../../../../src/services/delivery-channels/providers/rappi/rappi.connect', () => ({
  ...jest.requireActual('../../../../src/services/delivery-channels/providers/rappi/rappi.connect'),
  revalidarRappi: jest.fn(async () => null),
}))

import prisma from '../../../../src/utils/prismaClient'
import logger from '@/config/logger'
import { crearDbFalsa, type DbFalsa, type Fila } from '../../../__helpers__/rappiDbFake'
import * as ctrl from '../../../../src/controllers/delivery-channels/rappi.oauth.controller'
import { getRappiConnectUrl } from '../../../../src/controllers/delivery-channels/deliveryChannels.controller'
import {
  cifrarIdToken,
  descifrarIdToken,
  firmar,
  leerFirma,
} from '../../../../src/services/delivery-channels/providers/rappi/rappi.connect'
import * as rappiClient from '../../../../src/services/delivery-channels/providers/rappi/rappi.client'

const cliente = rappiClient as unknown as Record<
  | 'canjearCodigoRappi'
  | 'tiendasDelComercio'
  | 'aprovisionarTiendasRappi'
  | 'suscribirTiendaAEventos'
  | 'marcarTiendaIntegradaRappi'
  | 'redirectUriRappi'
  | 'preflightSelfOnboardingRappi',
  jest.Mock
>
const deps = { llave: 'k'.repeat(40), ambiente: 'SANDBOX' as const, clientId: 'cid' }

// Base en memoria compartida con la prueba de `rappi.provisioning`, que aquí corre DE VERDAD: «aprovisiona
// una vez» y «se promueve» se miden en la base, no en un mock que devuelva lo que la prueba espera (R14).
let db: DbFalsa
const p = prisma as any
const I = p.deliveryConnectIntent

// El freno del re-chequeo (30 s por intent) vive en memoria del módulo: cada prueba corre un minuto
// «después» de la anterior, así una no hereda el freno de otra.
let reloj = Date.now()
afterAll(() => jest.restoreAllMocks())

beforeEach(() => {
  db = crearDbFalsa()
  reloj += 60_000
  jest.spyOn(Date, 'now').mockImplementation(() => reloj)
  p.venue.findUnique.mockReset().mockResolvedValue({ name: 'Café <b>Luna</b>' })
  cliente.canjearCodigoRappi.mockReset().mockResolvedValue('idt')
  cliente.tiendasDelComercio.mockReset().mockResolvedValue([{ storeId: '10', name: 'A', integrated: false }])
  cliente.aprovisionarTiendasRappi.mockReset().mockImplementation(async (_t: string, ts: Array<{ storeId: string }>) => ({
    batchId: 'b1',
    aceptadas: ts.map(t => ({ storeId: t.storeId, integrationId: `int${t.storeId}` })),
    rechazadas: [],
    inciertas: [],
  }))
  cliente.suscribirTiendaAEventos.mockReset().mockResolvedValue({ ok: true, fallidos: [] })
  cliente.marcarTiendaIntegradaRappi.mockReset().mockResolvedValue({ ok: true, status: 200, raw: '' })
})

const IDENT = { id: 'i1', environment: 'SANDBOX', venueId: 'v1', clientId: 'cid' }
function sembrar(over: Fila = {}) {
  db.intents.set('i1', {
    ...IDENT,
    provider: 'RAPPI',
    staffId: 's1',
    state: 'CREATED',
    orderAcceptanceMode: 'AUTO',
    expiresAt: new Date(Date.now() + 60_000),
    merchantTokenEnvelope: null,
    storesJson: null,
    selectionJson: null,
    resultsJson: null,
    failureReason: null,
    ...over,
  })
  return db.intents.get('i1') as Fila
}
/** Lo que deja un callback exitoso: EXCHANGED, con el id_token cifrado y las tiendas que listó Rappi. */
const canjeado = (over: Fila = {}) =>
  sembrar({
    state: 'EXCHANGED',
    merchantTokenEnvelope: cifrarIdToken(deps, IDENT, 'idt'),
    storesJson: [
      { storeId: '10', name: 'A', integrated: false },
      { storeId: '11', name: 'B', integrated: true },
    ],
    ...over,
  })

const res = () => {
  const r: Record<string, jest.Mock> = {}
  for (const k of ['status', 'type', 'send', 'redirect', 'json']) r[k] = jest.fn(() => r)
  r.getHeader = jest.fn(() => undefined)
  return r
}
const html = (r: Record<string, jest.Mock>) => String(r.send.mock.calls.at(-1)?.[0])
const intent = () => db.intents.get('i1') as Fila

const callback = async (query: Record<string, string>) => {
  const r = res()
  await ctrl.rappiOAuthCallback({ query } as never, r as never)
  return r
}
const activar = async (body: Record<string, unknown>) => {
  const r = res()
  await ctrl.activarRappiOAuth({ body: { state2: firmar(deps, 'i1', 'activate'), ...body } } as never, r as never)
  return r
}
const resultado = async (firmado = firmar(deps, 'i1', 'result')) => {
  const r = res()
  await ctrl.resultadoRappiOAuth({ query: { intent: firmado } } as never, r as never)
  return r
}

describe('start', () => {
  it('una firma de otro propósito no pasa', async () => {
    sembrar()
    const r = res()
    await ctrl.startRappiOAuth({ query: { intent: firmar(deps, 'i1', 'callback') } } as never, r as never)
    expect(r.redirect).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(400)
  })

  it('CREATED: al login de Rappi con el state firmado para el callback y PKCE', async () => {
    sembrar()
    const r = res()
    await ctrl.startRappiOAuth({ query: { intent: firmar(deps, 'i1', 'start') } } as never, r as never)
    const [codigo, url] = r.redirect.mock.calls[0]
    const u = new URL(url)
    expect(codigo).toBe(302)
    expect(u.origin).toBe('https://login.partners.dev.rappi.com')
    expect(leerFirma(deps, u.searchParams.get('state'), 'callback')).toBe('i1')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('redirect_uri')).toBe('https://api.test/api/v1/delivery/rappi/oauth/callback')
  })

  it('un enlace ya usado no vuelve a mandar al login', async () => {
    sembrar({ state: 'EXCHANGED' })
    const r = res()
    await ctrl.startRappiOAuth({ query: { intent: firmar(deps, 'i1', 'start') } } as never, r as never)
    expect(r.redirect).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(400)
  })
})

describe('callback', () => {
  it('escapa tiendas y negocio, pide confirmar el negocio, deshabilita la ya integrada y firma state2 para activate', async () => {
    sembrar()
    cliente.tiendasDelComercio.mockResolvedValue([
      { storeId: '10', name: '<script>x</script>', integrated: false },
      { storeId: '11', name: 'B', integrated: true },
    ])
    const r = await callback({ code: 'c', state: firmar(deps, 'i1', 'callback') })
    const h = html(r)
    expect(r.status).toHaveBeenCalledWith(200)
    expect(h).not.toContain('<script')
    expect(h).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(h).toContain('Estas tiendas se conectarán a <strong>Café &lt;b&gt;Luna&lt;/b&gt;</strong>')
    expect(h).toMatch(/<input type="checkbox" name="confirmo_negocio" value="si" required>/)
    expect(h).toMatch(/<input type="checkbox" disabled>[^<]*<strong>B<\/strong>.*ya integrada/)
    expect(h).not.toContain('value="11"')
    expect(h).toContain(`name="state2" value="${firmar(deps, 'i1', 'activate')}"`)
    expect(intent()).toMatchObject({ state: 'EXCHANGED', storesJson: [{ storeId: '10' }, { storeId: '11' }] })
    expect(descifrarIdToken(deps, intent() as never)).toBe('idt')
  })

  // D8: tras «Desconectar de todos modos» Rappi la sigue listando integrada con NUESTRA integración.
  it('la integrada que estaba conectada a ESTE negocio se puede marcar para reconectar; la ajena sigue en gris', async () => {
    sembrar()
    db.links.set('10', {
      id: 'x10',
      externalLocationId: '10',
      venueId: 'v1',
      status: 'DISABLED',
      config: { rappiProvisioning: { intentId: 'viejo', since: 'x', integrationId: 'AVQ', confirmedAt: 'y' } },
    })
    cliente.tiendasDelComercio.mockResolvedValue([
      { storeId: '10', name: 'A', integrated: true, integrationId: 'AVQ' },
      { storeId: '11', name: 'B', integrated: true, integrationId: 'AVQ' },
    ])
    const h = html(await callback({ code: 'c', state: firmar(deps, 'i1', 'callback') }))
    expect(h).toMatch(/<input type="checkbox" name="tiendas" value="10">[^<]*<strong>A<\/strong>.*márcala para reconectarla/)
    expect(h).toMatch(/<input type="checkbox" disabled>[^<]*<strong>B<\/strong>.*ya integrada/)
    expect(h).not.toContain('value="11"')
  })

  // 🔴 R12
  it('el código se canjea DESPUÉS de ganar el CAS CREATED → EXCHANGED', async () => {
    sembrar()
    let estadoAlCanjear: string | undefined
    cliente.canjearCodigoRappi.mockImplementation(async () => {
      estadoAlCanjear = intent().state
      return 'idt'
    })
    await callback({ code: 'c', state: firmar(deps, 'i1', 'callback') })
    expect(estadoAlCanjear).toBe('EXCHANGED')
  })

  it('si falla leer el negocio: nada se canjeó y el intent sigue CREATED (el enlace de inicio sirve)', async () => {
    sembrar()
    p.venue.findUnique.mockRejectedValue(new Error('db caída'))
    const r = await callback({ code: 'c', state: firmar(deps, 'i1', 'callback') })
    expect(r.status).toHaveBeenCalledWith(500)
    expect(cliente.canjearCodigoRappi).not.toHaveBeenCalled()
    expect(intent()).toMatchObject({ state: 'CREATED', merchantTokenEnvelope: null })
  })

  it('si otro callback ganó el CAS, éste NO canjea el código', async () => {
    sembrar()
    I.updateMany.mockImplementationOnce(async () => ({ count: 0 }))
    const r = await callback({ code: 'c', state: firmar(deps, 'i1', 'callback') })
    expect(cliente.canjearCodigoRappi).not.toHaveBeenCalled()
    expect(html(r)).toContain('ya se usó')
  })

  it('un callback repetido (ya EXCHANGED) no canjea el código', async () => {
    canjeado()
    const r = await callback({ code: 'c', state: firmar(deps, 'i1', 'callback') })
    expect(cliente.canjearCodigoRappi).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(400)
  })

  it('una firma de otro propósito no pasa', async () => {
    sembrar()
    const r = await callback({ code: 'c', state: firmar(deps, 'i1', 'start') })
    expect(r.status).toHaveBeenCalledWith(400)
    expect(cliente.canjearCodigoRappi).not.toHaveBeenCalled()
  })

  it('Rappi negó el permiso: FAILED RAPPI_DENIED y la descripción escapada, sin canjear', async () => {
    sembrar()
    const r = await callback({
      error: 'access_denied',
      error_description: '<img src=x onerror=alert(1)>',
      state: firmar(deps, 'i1', 'callback'),
    })
    expect(intent()).toMatchObject({ state: 'FAILED', failureReason: 'RAPPI_DENIED' })
    expect(html(r)).not.toContain('<img')
    expect(html(r)).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(cliente.canjearCodigoRappi).not.toHaveBeenCalled()
  })

  it.each([
    ['canjear', 'RAPPI_CANJE_401', 'RAPPI_CANJE_401'],
    ['canjear', 'RAPPI_ID_TOKEN_INVALIDO', 'RAPPI_ID_TOKEN_INVALIDO'],
    ['listar', 'RAPPI_INTEGRATION_STATUS_500', 'RAPPI_INTEGRATION_STATUS_500'],
    ['listar', 'fetch failed', 'RAPPI_ERROR'],
  ])('si falla %s (%s): FAILED con motivo %s y una página, nunca un 500', async (paso, mensaje, motivo) => {
    sembrar()
    ;(paso === 'canjear' ? cliente.canjearCodigoRappi : cliente.tiendasDelComercio).mockRejectedValue(new Error(mensaje))
    const r = await callback({ code: 'c', state: firmar(deps, 'i1', 'callback') })
    expect(intent()).toMatchObject({ state: 'FAILED', failureReason: motivo, merchantTokenEnvelope: null })
    expect(r.status).toHaveBeenCalledWith(502)
  })
})

describe('errores del OAuth sin credenciales en registros', () => {
  const errores = [new Error('LEAK42'), new SyntaxError('LEAK42'), new TypeError('Bearer LEAK42\n inválido'), { message: 'LEAK42' }, null]
  it.each(['canje', 'listado', 'rechequeo', 'general'].flatMap(paso => errores.map(error => ({ paso, error }))))(
    '$paso conserva el estado correcto y nunca registra el error crudo ($error)',
    async ({ paso, error }) => {
      jest.clearAllMocks()
      let r: ReturnType<typeof res>
      if (paso === 'rechequeo') {
        canjeado()
        await activar({ tiendas: '10', confirmo_negocio: 'si' })
        cliente.tiendasDelComercio.mockRejectedValue(error)
        r = await resultado()
        expect(intent().state).toBe('ACTIVATING')
        expect(db.links.get('10')?.status).toBe('PENDING')
        expect(r.status).toHaveBeenCalledWith(200)
      } else {
        sembrar()
        if (paso === 'general') p.venue.findUnique.mockRejectedValue(error)
        else (paso === 'canje' ? cliente.canjearCodigoRappi : cliente.tiendasDelComercio).mockRejectedValue(error)
        r = await callback({ code: 'c', state: firmar(deps, 'i1', 'callback') })
        expect(intent().state).toBe(paso === 'general' ? 'CREATED' : 'FAILED')
        expect(intent().merchantTokenEnvelope).toBeNull()
        expect(r.status).toHaveBeenCalledWith(paso === 'general' ? 500 : 502)
      }
      expect(html(r)).not.toContain('LEAK42')
      expect(JSON.stringify([(logger.error as jest.Mock).mock.calls, (logger.warn as jest.Mock).mock.calls])).not.toContain('LEAK42')
    },
  )
})

describe('activate', () => {
  // 🔴 R11
  it('sin confirmo_negocio: 400 y nada sale a Rappi', async () => {
    canjeado()
    const r = await activar({ tiendas: '10' })
    expect(r.status).toHaveBeenCalledWith(400)
    expect(cliente.aprovisionarTiendasRappi).not.toHaveBeenCalled()
    expect(intent().state).toBe('EXCHANGED')
  })

  it('ignora ids que Rappi no listó (y la ya integrada): sin ninguna válida, 400', async () => {
    canjeado()
    const r = await activar({ tiendas: ['999', '11'], confirmo_negocio: 'si' })
    expect(r.status).toHaveBeenCalledWith(400)
    expect(cliente.aprovisionarTiendasRappi).not.toHaveBeenCalled()
    expect(intent().state).toBe('EXCHANGED')
  })

  it('una firma de otro propósito no pasa', async () => {
    canjeado()
    const r = res()
    await ctrl.activarRappiOAuth(
      { body: { state2: firmar(deps, 'i1', 'callback'), tiendas: '10', confirmo_negocio: 'si' } } as never,
      r as never,
    )
    expect(r.status).toHaveBeenCalledWith(400)
    expect(cliente.aprovisionarTiendasRappi).not.toHaveBeenCalled()
  })

  // 🔴 Review Focus 2 + R14
  it('el primer envío aprovisiona UNA vez; el segundo (doble clic / atrás) no vuelve a aprovisionar', async () => {
    canjeado()
    const r1 = await activar({ tiendas: ['10', '999', '10'], confirmo_negocio: 'si' })
    expect(cliente.aprovisionarTiendasRappi).toHaveBeenCalledTimes(1)
    expect(cliente.aprovisionarTiendasRappi).toHaveBeenCalledWith('idt', [{ storeId: '10', name: 'A' }])
    expect(intent()).toMatchObject({ state: 'ACTIVATING', selectionJson: ['10'], resultsJson: { '10': { outcome: 'PROVISIONING' } } })
    expect(db.links.get('10')).toMatchObject({
      venueId: 'v1',
      status: 'PENDING',
      config: { rappiProvisioning: { intentId: 'i1', batchId: 'b1', integrationId: 'int10' } },
    })
    const [codigo, url] = r1.redirect.mock.calls[0]
    expect(codigo).toBe(303)
    expect(leerFirma(deps, new URL(url, 'https://x').searchParams.get('intent'), 'result')).toBe('i1')

    const r2 = await activar({ tiendas: '10', confirmo_negocio: 'si' })
    expect(cliente.aprovisionarTiendasRappi).toHaveBeenCalledTimes(1)
    expect(r2.redirect).toHaveBeenCalledWith(303, expect.stringContaining('/api/v1/delivery/rappi/oauth/result?intent='))
  })

  // D8
  it('reconectar: la MISMA fila queda ACTIVE sin aprovisionar, con «integrada: sí», y la página dice Conectada', async () => {
    canjeado({ storesJson: [{ storeId: '10', name: 'A', integrated: true, integrationId: 'AVQ' }] })
    db.links.set('10', {
      id: 'x10',
      externalLocationId: '10',
      venueId: 'v1',
      status: 'DISABLED',
      config: { rappiProvisioning: { intentId: 'viejo', since: 'x', integrationId: 'AVQ', confirmedAt: 'y' } },
    })
    // Al confirmar se le vuelve a preguntar a Rappi (Codex r1 #2): la sigue teniendo con nuestra integración.
    cliente.tiendasDelComercio.mockResolvedValue([{ storeId: '10', name: 'A', integrated: true, integrationId: 'AVQ' }])
    const r1 = await activar({ tiendas: '10', confirmo_negocio: 'si' })
    expect(cliente.tiendasDelComercio).toHaveBeenCalledWith('idt')
    await new Promise<void>(resolver => setImmediate(resolver))
    expect(cliente.aprovisionarTiendasRappi).not.toHaveBeenCalled()
    expect(cliente.suscribirTiendaAEventos).toHaveBeenCalledWith('10')
    expect(cliente.marcarTiendaIntegradaRappi).toHaveBeenCalledWith('10', true)
    expect(db.links.get('10')).toMatchObject({ id: 'x10', status: 'ACTIVE' })
    expect(intent()).toMatchObject({ state: 'CONSUMED', resultsJson: { '10': { outcome: 'ACTIVATED' } } })
    expect(r1.redirect).toHaveBeenCalledWith(303, expect.stringContaining('/api/v1/delivery/rappi/oauth/result?intent='))
    expect(html(await resultado())).toContain('Conectada')
  })

  it('reconectar no confía en la página: si la fila ya no es reconectable al enviar, 400 y nada sale a Rappi', async () => {
    canjeado({ storesJson: [{ storeId: '10', name: 'A', integrated: true, integrationId: 'AVQ' }] })
    db.links.set('10', { id: 'x10', externalLocationId: '10', venueId: 'v1', status: 'ACTIVE', config: null })
    const r = await activar({ tiendas: '10', confirmo_negocio: 'si' })
    expect(r.status).toHaveBeenCalledWith(400)
    expect(cliente.suscribirTiendaAEventos).not.toHaveBeenCalled()
    expect(intent().state).toBe('EXCHANGED')
  })

  it.each([
    ['basura', 'v1:basura'],
    ['un token vacío', cifrarIdToken(deps, IDENT, '')],
  ])('un sobre ilegible (%s): FAILED con motivo controlado y sin llamar a Rappi', async (_c, sobre) => {
    canjeado({ merchantTokenEnvelope: sobre })
    const r = await activar({ tiendas: '10', confirmo_negocio: 'si' })
    expect(intent()).toMatchObject({ state: 'FAILED', failureReason: 'RAPPI_TOKEN_ILEGIBLE' })
    expect(cliente.aprovisionarTiendasRappi).not.toHaveBeenCalled()
    expect(r.redirect).not.toHaveBeenCalled()
  })
})

describe('result', () => {
  const integrada = (integrationId: string) =>
    cliente.tiendasDelComercio.mockResolvedValue([{ storeId: '10', name: 'A', integrated: true, integrationId }])

  // 🔴 Review Focus 3 + R14
  it('el webhook nunca llegó: integration-status dice integrada con NUESTRO integrationId ⇒ se promueve', async () => {
    canjeado()
    await activar({ tiendas: '10', confirmo_negocio: 'si' })
    integrada('int10')

    const r = await resultado()
    expect(db.links.get('10')?.status).toBe('ACTIVE')
    expect(intent()).toMatchObject({ state: 'CONSUMED', merchantTokenEnvelope: null, resultsJson: { '10': { outcome: 'ACTIVATED' } } })
    expect(cliente.suscribirTiendaAEventos).toHaveBeenCalledWith('10')
    expect(html(r)).toContain('Conectada')

    // Tarea 18: la promoción por el re-chequeo también le dice a Rappi «integrada» (sin esperar su respuesta).
    await new Promise<void>(resolver => setImmediate(resolver))
    expect(cliente.marcarTiendaIntegradaRappi).toHaveBeenCalledTimes(1)
    expect(cliente.marcarTiendaIntegradaRappi).toHaveBeenCalledWith('10', true)

    // Recargar no vuelve a suscribir ni a tocar nada.
    const r2 = await resultado()
    expect(cliente.suscribirTiendaAEventos).toHaveBeenCalledTimes(1)
    expect(cliente.marcarTiendaIntegradaRappi).toHaveBeenCalledTimes(1)
    expect(html(r2)).toContain('Conectada')
  })

  it('🔴 si Rappi rechaza el «integrada» (el sandbox contesta 500), la página igual dice Conectada y no se revierte nada', async () => {
    canjeado()
    await activar({ tiendas: '10', confirmo_negocio: 'si' })
    integrada('int10')
    cliente.marcarTiendaIntegradaRappi.mockResolvedValue({ ok: false, status: 500, raw: 'Please contact support team' })

    const r = await resultado()
    await new Promise<void>(resolver => setImmediate(resolver))

    expect(cliente.marcarTiendaIntegradaRappi).toHaveBeenCalledWith('10', true)
    expect(db.links.get('10')?.status).toBe('ACTIVE')
    expect(intent()).toMatchObject({ state: 'CONSUMED', resultsJson: { '10': { outcome: 'ACTIVATED' } } })
    expect(html(r)).toContain('Conectada')
  })

  // R7
  it('integrada pero con OTRO integrationId: no se promueve y dice que Rappi la está confirmando', async () => {
    canjeado()
    await activar({ tiendas: '10', confirmo_negocio: 'si' })
    integrada('de-otro')

    await resultado()
    const r = await resultado()
    expect(db.links.get('10')?.status).toBe('PENDING')
    expect(intent().state).toBe('ACTIVATING')
    expect(cliente.suscribirTiendaAEventos).not.toHaveBeenCalled()
    expect(html(r)).toContain('Rappi la está confirmando — recarga esta página en un minuto')
  })

  it('SUBSCRIBE_FAILED: Rappi YA la aceptó, falta lo nuestro — no «Rappi la está confirmando»', async () => {
    canjeado()
    await activar({ tiendas: '10', confirmo_negocio: 'si' })
    integrada('int10')
    cliente.suscribirTiendaAEventos.mockResolvedValue({ ok: false, fallidos: ['NEW_ORDER'] })

    const r = await resultado()
    expect(intent().resultsJson['10'].outcome).toBe('SUBSCRIBE_FAILED')
    expect(html(r)).toContain('Rappi ya la aceptó; estamos activando la recepción de pedidos — recarga en un minuto.')
    expect(html(r)).not.toContain('Rappi la está confirmando')
  })

  it('SUBSCRIBE_FAILED fuera de ACTIVATING: dice que Rappi ya la aceptó, sin «recarga» (ya nadie re-lee)', async () => {
    sembrar({ state: 'FAILED', selectionJson: ['10'], resultsJson: { '10': { outcome: 'SUBSCRIBE_FAILED' } } })
    const r = await resultado()
    expect(html(r)).toContain('Rappi ya la aceptó, pero falta activar la recepción de pedidos')
    expect(html(r)).not.toContain('recarga')
  })

  it('dos cargas en menos de 30 s llaman a Rappi UNA vez; la página sigue enseñando lo que hay', async () => {
    canjeado()
    await activar({ tiendas: '10', confirmo_negocio: 'si' })
    integrada('de-otro')

    await resultado()
    reloj += 29_000
    const r = await resultado()
    expect(cliente.tiendasDelComercio).toHaveBeenCalledTimes(1)
    expect(html(r)).toContain('Rappi la está confirmando')

    reloj += 1_000 // ya pasaron 30 s
    await resultado()
    expect(cliente.tiendasDelComercio).toHaveBeenCalledTimes(2)
  })

  // H8: un re-chequeo lento (Rappi despacio, varias tiendas que suscribir) pasaba de los 30 s y otra carga
  // arrancaba OTRO encima: HTTP y suscripciones duplicadas. Ahora uno a la vez, y los 30 s cuentan desde que termina.
  it('mientras un re-chequeo sigue en vuelo no arranca otro; los 30 s cuentan desde que TERMINÓ', async () => {
    canjeado()
    await activar({ tiendas: '10', confirmo_negocio: 'si' })
    let soltar!: (v: unknown) => void
    cliente.tiendasDelComercio.mockImplementationOnce(() => new Promise(r => (soltar = r)))

    const primera = resultado()
    await new Promise(r => setImmediate(r))
    expect(cliente.tiendasDelComercio).toHaveBeenCalledTimes(1) // en vuelo

    reloj += 60_000 // más de 30 s desde que EMPEZÓ
    const r2 = await resultado()
    expect(cliente.tiendasDelComercio).toHaveBeenCalledTimes(1)
    expect(html(r2)).toContain('Rappi la está confirmando')

    soltar([{ storeId: '10', name: 'A', integrated: true, integrationId: 'de-otro' }])
    await primera
    reloj += 29_000
    await resultado()
    expect(cliente.tiendasDelComercio).toHaveBeenCalledTimes(1)
    reloj += 1_000
    await resultado()
    expect(cliente.tiendasDelComercio).toHaveBeenCalledTimes(2)
  })

  it('el motivo de rechazo de Rappi y el negocio van escapados; sin re-chequeo fuera de ACTIVATING', async () => {
    sembrar({
      state: 'CONSUMED',
      selectionJson: ['10', '12'],
      storesJson: [
        { storeId: '10', name: 'A', integrated: false },
        { storeId: '12', name: 'C', integrated: false },
      ],
      resultsJson: { '10': { outcome: 'REJECTED', detalle: '<script>r</script>' }, '12': { outcome: 'OTHER_VENUE' } },
    })
    const r = await resultado()
    const h = html(r)
    expect(h).not.toContain('<script')
    expect(h).toContain('Rappi la rechazó: &lt;script&gt;r&lt;/script&gt;')
    expect(h).toContain('Esta tienda ya está conectada a otro negocio de Avoqado')
    expect(h).toContain('Café &lt;b&gt;Luna&lt;/b&gt;')
    expect(cliente.tiendasDelComercio).not.toHaveBeenCalled()
  })

  it('una firma de otro propósito no pasa', async () => {
    sembrar({ state: 'ACTIVATING' })
    const r = await resultado(firmar(deps, 'i1', 'activate'))
    expect(r.status).toHaveBeenCalledWith(400)
    expect(cliente.tiendasDelComercio).not.toHaveBeenCalled()
  })
})

describe('connect-url', () => {
  // F2: el preflight cubre retorno, host y webhooks — sin la base de webhooks Rappi aprovisionaba una tienda sorda.
  it.each([['Falta RAPPI_OAUTH_REDIRECT_BASE'], ['Falta RAPPI_WEBHOOK_BASE_URL']])(
    '%s: AppError de configuración y NO se crea el intent',
    async falta => {
      cliente.preflightSelfOnboardingRappi.mockImplementationOnce(() => {
        throw new Error(falta)
      })
      const r = res()
      const next = jest.fn()
      await getRappiConnectUrl({ params: { venueId: 'v1' }, authContext: { userId: 's1' } } as never, r as never, next)
      expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 500, code: 'RAPPI_CONNECT_NOT_CONFIGURED' })
      expect(I.create).not.toHaveBeenCalled()
      expect(r.json).not.toHaveBeenCalled()
    },
  )

  it('la base es la de la redirect_uri validada, y el enlace va firmado para start', async () => {
    I.create.mockResolvedValue({ id: 'i9' })
    const r = res()
    await getRappiConnectUrl(
      { params: { venueId: 'v1' }, authContext: { userId: 's1' }, protocol: 'http', get: () => 'x' } as never,
      r as never,
      jest.fn(),
    )
    const { url } = r.json.mock.calls[0][0]
    expect(url.startsWith('https://api.test/api/v1/delivery/rappi/oauth/start?intent=')).toBe(true)
    expect(cliente.preflightSelfOnboardingRappi).toHaveBeenCalledTimes(1)
    expect(leerFirma(deps, new URL(url).searchParams.get('intent'), 'start')).toBe('i9')
    expect(I.create.mock.calls[0][0].data).toMatchObject({ provider: 'RAPPI', venueId: 'v1', staffId: 's1' })
  })
})
