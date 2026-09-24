// tests/unit/services/fiscal/facturapiWebhook.service.test.ts
//
// El webhook de Facturapi sustituye (como vía principal) a preguntarle al PAC cada 5 minutos si una
// cancelación ya quedó. Dos mitades: dar de alta el webhook de cada organización, y procesar sus avisos.
import { createHmac } from 'crypto'

jest.mock('../../../../src/config/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() }))

import {
  asegurarWebhookDelEmisor,
  procesarAvisoDeFacturapi,
  urlDelWebhook,
  firmaValida,
  asegurarWebhooksFaltantes,
  urlPublicaDelEntorno,
  EVENTOS_DEL_WEBHOOK,
  type AsegurarWebhookDeps,
  type ProcesarAvisoDeps,
} from '../../../../src/services/fiscal/facturapiWebhook.service'

const BASE = 'https://api.avoqado.io'
const URL_E1 = `${BASE}/api/v1/webhooks/facturapi/e1`

// ─── urlDelWebhook ────────────────────────────────────────────────────────────

describe('urlDelWebhook', () => {
  it('arma la URL pública por emisor', () => {
    expect(urlDelWebhook('e1', BASE)).toBe(URL_E1)
    expect(urlDelWebhook('e1', `${BASE}/`)).toBe(URL_E1)
  })

  it('sin BASE_URL, o si no es https, no hay a dónde mandar los avisos', () => {
    expect(urlDelWebhook('e1', undefined)).toBeNull()
    expect(urlDelWebhook('e1', 'http://localhost:3000')).toBeNull()
  })
})

// ─── asegurarWebhookDelEmisor ─────────────────────────────────────────────────

function emisor(over: Record<string, any> = {}) {
  return {
    id: 'e1',
    provider: 'FACTURAPI',
    providerKeyEnc: 'enc-key',
    webhookId: null,
    webhookSecretEnc: null,
    webhookUrl: null,
    ...over,
  }
}

function asegurarDeps(over: Partial<AsegurarWebhookDeps> & { existentes?: any[] } = {}) {
  const { existentes = [], ...resto } = over
  const cliente = {
    listar: jest.fn().mockResolvedValue(existentes),
    crear: jest.fn().mockResolvedValue({ id: 'wh-nuevo', secret: 'wh_sec_nuevo' }),
    borrar: jest.fn().mockResolvedValue(undefined),
  }
  const deps: AsegurarWebhookDeps = {
    findEmisor: jest.fn().mockResolvedValue(emisor()),
    clienteDeWebhooks: jest.fn().mockReturnValue(cliente),
    guardarWebhook: jest.fn().mockResolvedValue(undefined),
    encrypt: (s: string) => `enc(${s})`,
    baseUrl: () => BASE,
    now: () => new Date('2026-09-24T12:00:00Z'),
    ...resto,
  }
  return { deps, cliente }
}

describe('asegurarWebhookDelEmisor', () => {
  it('crea el webhook, guarda el secreto CIFRADO y pide los eventos de cancelación', async () => {
    const { deps, cliente } = asegurarDeps()
    const r = await asegurarWebhookDelEmisor('e1', deps)

    expect(r.resultado).toBe('CREADO')
    expect(cliente.crear).toHaveBeenCalledWith(URL_E1, EVENTOS_DEL_WEBHOOK)
    expect(EVENTOS_DEL_WEBHOOK).toContain('invoice.cancellation_status_updated')
    expect(deps.guardarWebhook).toHaveBeenCalledWith('e1', {
      webhookId: 'wh-nuevo',
      webhookSecretEnc: 'enc(wh_sec_nuevo)',
      webhookUrl: URL_E1,
      webhookConfiguredAt: new Date('2026-09-24T12:00:00Z'),
    })
  })

  it('si ya está dado de alta (mismo id, misma URL, activo, con secreto guardado) no crea otro', async () => {
    const { deps, cliente } = asegurarDeps({
      findEmisor: jest.fn().mockResolvedValue(emisor({ webhookId: 'wh-1', webhookSecretEnc: 'enc(x)', webhookUrl: URL_E1 })),
      existentes: [{ id: 'wh-1', url: URL_E1, status: 'enabled', enabledEvents: [...EVENTOS_DEL_WEBHOOK] }],
    })
    const r = await asegurarWebhookDelEmisor('e1', deps)

    expect(r.resultado).toBe('YA_ESTABA')
    expect(cliente.crear).not.toHaveBeenCalled()
    expect(deps.guardarWebhook).not.toHaveBeenCalled()
  })

  // Medido en el sandbox (24-sep): crear dos veces el mismo webhook DUPLICA, aunque la doc diga que no.
  it('borra los duplicados que apuntan a la misma URL y se queda con el suyo', async () => {
    const { deps, cliente } = asegurarDeps({
      findEmisor: jest.fn().mockResolvedValue(emisor({ webhookId: 'wh-1', webhookSecretEnc: 'enc(x)', webhookUrl: URL_E1 })),
      existentes: [
        { id: 'wh-1', url: URL_E1, status: 'enabled', enabledEvents: [...EVENTOS_DEL_WEBHOOK] },
        { id: 'wh-dup', url: URL_E1, status: 'enabled', enabledEvents: [...EVENTOS_DEL_WEBHOOK] },
        { id: 'wh-ajeno', url: 'https://otro.example/hook', status: 'enabled', enabledEvents: ['*'] },
      ],
    })
    await asegurarWebhookDelEmisor('e1', deps)

    expect(cliente.borrar).toHaveBeenCalledWith('wh-dup')
    expect(cliente.borrar).not.toHaveBeenCalledWith('wh-1')
    expect(cliente.borrar).not.toHaveBeenCalledWith('wh-ajeno') // lo que no apunta a nosotros no se toca
  })

  // Sin el secreto no se puede validar la firma, y Facturapi no lo vuelve a entregar: hay que recrearlo.
  it('si existe en Facturapi pero no tenemos el secreto, lo recrea y borra el viejo DESPUÉS de guardar el nuevo', async () => {
    const orden: string[] = []
    const { deps, cliente } = asegurarDeps({
      findEmisor: jest.fn().mockResolvedValue(emisor({ webhookId: 'wh-viejo', webhookSecretEnc: null, webhookUrl: URL_E1 })),
      existentes: [{ id: 'wh-viejo', url: URL_E1, status: 'enabled', enabledEvents: [...EVENTOS_DEL_WEBHOOK] }],
      guardarWebhook: jest.fn(async () => {
        orden.push('guardar')
      }),
    })
    cliente.borrar.mockImplementation(async (id: string) => {
      orden.push(`borrar ${id}`)
    })
    const r = await asegurarWebhookDelEmisor('e1', deps)

    expect(r.resultado).toBe('CREADO')
    expect(orden).toEqual(['guardar', 'borrar wh-viejo'])
  })

  it('un webhook desactivado o sin el evento de cancelación no cuenta: se recrea', async () => {
    const { deps, cliente } = asegurarDeps({
      findEmisor: jest.fn().mockResolvedValue(emisor({ webhookId: 'wh-1', webhookSecretEnc: 'enc(x)', webhookUrl: URL_E1 })),
      existentes: [{ id: 'wh-1', url: URL_E1, status: 'disabled', enabledEvents: [...EVENTOS_DEL_WEBHOOK] }],
    })
    const r = await asegurarWebhookDelEmisor('e1', deps)
    expect(r.resultado).toBe('CREADO')
    expect(cliente.borrar).toHaveBeenCalledWith('wh-1')
  })

  it('si Facturapi no devuelve el secreto, falla sin guardar nada (un webhook sin secreto no sirve)', async () => {
    const { deps, cliente } = asegurarDeps()
    cliente.crear.mockResolvedValue({ id: 'wh-x', secret: null })
    await expect(asegurarWebhookDelEmisor('e1', deps)).rejects.toThrow(/secreto/)
    expect(deps.guardarWebhook).not.toHaveBeenCalled()
  })

  it('un duplicado que no se deja borrar no tumba el alta', async () => {
    const { deps, cliente } = asegurarDeps({ existentes: [{ id: 'wh-viejo', url: URL_E1, status: 'enabled', enabledEvents: [] }] })
    cliente.borrar.mockRejectedValue(new Error('boom'))
    const r = await asegurarWebhookDelEmisor('e1', deps)
    expect(r.resultado).toBe('CREADO')
  })

  it('sin URL pública, sin llave o si no es de Facturapi: no hace nada y lo dice', async () => {
    expect((await asegurarWebhookDelEmisor('e1', asegurarDeps({ baseUrl: () => undefined }).deps)).resultado).toBe('SIN_URL_PUBLICA')
    expect(
      (await asegurarWebhookDelEmisor('e1', asegurarDeps({ clienteDeWebhooks: jest.fn().mockReturnValue(null) }).deps)).resultado,
    ).toBe('SIN_LLAVE')
    expect(
      (await asegurarWebhookDelEmisor('e1', asegurarDeps({ findEmisor: jest.fn().mockResolvedValue(emisor({ provider: 'ALEGRA' })) }).deps))
        .resultado,
    ).toBe('NO_ES_FACTURAPI')
  })

  it('emisor inexistente ⇒ error', async () => {
    await expect(asegurarWebhookDelEmisor('e1', asegurarDeps({ findEmisor: jest.fn().mockResolvedValue(null) }).deps)).rejects.toThrow(
      /not found/,
    )
  })
})

// ─── procesarAvisoDeFacturapi ─────────────────────────────────────────────────

const SECRETO = 'wh_sec_prueba'
const firmar = (cuerpo: string, secreto = SECRETO) => createHmac('sha256', secreto).update(cuerpo).digest('hex')

function aviso(over: Record<string, any> = {}) {
  return JSON.stringify({
    created_at: '2026-09-24T12:00:00Z',
    organization: 'org-1',
    livemode: true,
    type: 'invoice.cancellation_status_updated',
    data: { type: 'invoice', object: { id: 'fa-inv-1', status: 'canceled', cancellation_status: 'accepted' } },
    ...over,
  })
}

function procesarDeps(over: Partial<ProcesarAvisoDeps> = {}) {
  const deps: ProcesarAvisoDeps = {
    findEmisor: jest.fn().mockResolvedValue({ id: 'e1', providerOrgId: 'org-1', webhookSecretEnc: 'enc' }),
    decrypt: () => SECRETO,
    findCfdi: jest.fn().mockResolvedValue({ id: 'c1', status: 'STAMPED', cancelStatus: 'REQUESTED', facturapiId: 'fa-inv-1' }),
    refreshPending: jest.fn().mockResolvedValue({ id: 'c1', cancelStatus: 'CANCELLED' }),
    sincronizarCancelacionExterna: jest.fn().mockResolvedValue({ id: 'c1' }),
    ...over,
  }
  return deps
}

async function procesar(cuerpo: string, firma: string | undefined, deps: ProcesarAvisoDeps) {
  return procesarAvisoDeFacturapi({ emisorId: 'e1', cuerpo: Buffer.from(cuerpo, 'utf8'), firma }, deps)
}

describe('procesarAvisoDeFacturapi', () => {
  it('firma válida + cancelación en trámite ⇒ le vuelve a preguntar al PAC (no confía en el cuerpo)', async () => {
    const deps = procesarDeps()
    const cuerpo = aviso()
    const r = await procesar(cuerpo, firmar(cuerpo), deps)

    expect(r).toEqual({ http: 200, resultado: 'REVISADA' })
    expect(deps.findCfdi).toHaveBeenCalledWith('fa-inv-1', 'e1')
    expect(deps.refreshPending).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }))
  })

  it('firma de otro secreto ⇒ 401 y no toca nada', async () => {
    const deps = procesarDeps()
    const cuerpo = aviso()
    const r = await procesar(cuerpo, firmar(cuerpo, 'otro'), deps)
    expect(r.http).toBe(401)
    expect(deps.findCfdi).not.toHaveBeenCalled()
  })

  it('cuerpo alterado después de firmar ⇒ 401', async () => {
    const deps = procesarDeps()
    const firma = firmar(aviso())
    const r = await procesar(aviso({ organization: 'org-2' }), firma, deps)
    expect(r.http).toBe(401)
  })

  it('sin firma, o firma que no es hex ⇒ 401', async () => {
    expect((await procesar(aviso(), undefined, procesarDeps())).http).toBe(401)
    expect((await procesar(aviso(), 'zz-no-hex', procesarDeps())).http).toBe(401)
  })

  it('emisor sin secreto guardado ⇒ 401 (no se puede validar)', async () => {
    const deps = procesarDeps({ findEmisor: jest.fn().mockResolvedValue({ id: 'e1', providerOrgId: 'org-1', webhookSecretEnc: null }) })
    const cuerpo = aviso()
    expect((await procesar(cuerpo, firmar(cuerpo), deps)).http).toBe(401)
  })

  it('emisor inexistente ⇒ 404', async () => {
    const deps = procesarDeps({ findEmisor: jest.fn().mockResolvedValue(null) })
    const cuerpo = aviso()
    expect((await procesar(cuerpo, firmar(cuerpo), deps)).http).toBe(404)
  })

  it('aviso de OTRA organización (firma válida) ⇒ se ignora sin tocar facturas', async () => {
    const deps = procesarDeps()
    const cuerpo = aviso({ organization: 'org-ajena' })
    const r = await procesar(cuerpo, firmar(cuerpo), deps)
    expect(r).toEqual({ http: 200, resultado: 'ORG_DISTINTA' })
    expect(deps.findCfdi).not.toHaveBeenCalled()
  })

  it('evento que no nos interesa ⇒ 200 IGNORADO', async () => {
    const deps = procesarDeps()
    const cuerpo = aviso({ type: 'customer.edit_link_completed' })
    expect(await procesar(cuerpo, firmar(cuerpo), deps)).toEqual({ http: 200, resultado: 'IGNORADO' })
  })

  it('factura que no es nuestra (o de otro emisor) ⇒ 200 SIN_FACTURA', async () => {
    const deps = procesarDeps({ findCfdi: jest.fn().mockResolvedValue(null) })
    const cuerpo = aviso()
    expect(await procesar(cuerpo, firmar(cuerpo), deps)).toEqual({ http: 200, resultado: 'SIN_FACTURA' })
  })

  // El caso A-14: la factura se canceló por fuera (portal de Facturapi) y en Avoqado seguía «Timbrada».
  it('factura timbrada SIN cancelación pedida por nosotros ⇒ revisa si la cancelaron por fuera', async () => {
    const deps = procesarDeps({
      findCfdi: jest.fn().mockResolvedValue({ id: 'c1', status: 'STAMPED', cancelStatus: null, facturapiId: 'fa-inv-1' }),
    })
    const cuerpo = aviso({ type: 'invoice.status_updated' })
    const r = await procesar(cuerpo, firmar(cuerpo), deps)
    expect(r).toEqual({ http: 200, resultado: 'REVISADA' })
    expect(deps.sincronizarCancelacionExterna).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }))
    expect(deps.refreshPending).not.toHaveBeenCalled()
  })

  // Una cancelación que el SAT rechazó deja la factura VIGENTE: si después la cancelan por fuera, también cuenta.
  it('factura timbrada con cancelación anterior RECHAZADA ⇒ también revisa la cancelación externa', async () => {
    const deps = procesarDeps({
      findCfdi: jest.fn().mockResolvedValue({ id: 'c1', status: 'STAMPED', cancelStatus: 'REJECTED', facturapiId: 'fa-inv-1' }),
    })
    const cuerpo = aviso({ type: 'invoice.status_updated' })
    expect(await procesar(cuerpo, firmar(cuerpo), deps)).toEqual({ http: 200, resultado: 'REVISADA' })
    expect(deps.sincronizarCancelacionExterna).toHaveBeenCalled()
  })

  // La firma se valida aquí (comparación en tiempo constante) en vez de depender del SDK; esta prueba fija
  // que las dos dicen lo mismo, con el SDK real.
  it('firmaValida coincide con validateSignature del SDK oficial de Facturapi', async () => {
    const Facturapi = require('facturapi').default ?? require('facturapi')
    const sdk = new Facturapi('sk_test_no_se_usa')
    const cuerpo = aviso()
    const firma = firmar(cuerpo)
    await expect(sdk.webhooks.validateSignature({ secret: SECRETO, signature: firma, payload: cuerpo })).resolves.toBeTruthy()
    expect(firmaValida(SECRETO, Buffer.from(cuerpo), firma)).toBe(true)
    await expect(sdk.webhooks.validateSignature({ secret: 'otro', signature: firma, payload: cuerpo })).rejects.toThrow()
    expect(firmaValida('otro', Buffer.from(cuerpo), firma)).toBe(false)
  })

  it('factura ya cancelada ⇒ 200 SIN_CAMBIO, sin llamar al PAC', async () => {
    const deps = procesarDeps({
      findCfdi: jest.fn().mockResolvedValue({ id: 'c1', status: 'CANCELLED', cancelStatus: 'CANCELLED', facturapiId: 'fa-inv-1' }),
    })
    const cuerpo = aviso()
    expect(await procesar(cuerpo, firmar(cuerpo), deps)).toEqual({ http: 200, resultado: 'SIN_CAMBIO' })
    expect(deps.refreshPending).not.toHaveBeenCalled()
  })

  it('JSON inválido con firma válida ⇒ 400', async () => {
    const cuerpo = '{no-json'
    expect((await procesar(cuerpo, firmar(cuerpo), procesarDeps())).http).toBe(400)
  })

  // Si no pudimos procesarlo, que Facturapi reintente (y queda la revisión horaria de respaldo).
  it('si preguntarle al PAC falla, el error sube (el controlador responde 5xx)', async () => {
    const deps = procesarDeps({ refreshPending: jest.fn().mockRejectedValue(new Error('PAC caído')) })
    const cuerpo = aviso()
    await expect(procesar(cuerpo, firmar(cuerpo), deps)).rejects.toThrow('PAC caído')
  })
})

// ─── Sólo producción y staging dan de alta webhooks ──────────────────────────
// En desarrollo no hay URL pública, y un `BASE_URL` copiado de producción haría que un server LOCAL creara
// webhooks con la URL de producción y borrara el bueno como «duplicado» (mismo URL).

describe('urlPublicaDelEntorno', () => {
  it('sólo en production/staging devuelve la BASE_URL', () => {
    expect(urlPublicaDelEntorno('production', BASE)).toBe(BASE)
    expect(urlPublicaDelEntorno('staging', 'https://staging.api.avoqado.io')).toBe('https://staging.api.avoqado.io')
    expect(urlPublicaDelEntorno('development', BASE)).toBeUndefined()
    expect(urlPublicaDelEntorno('test', BASE)).toBeUndefined()
  })

  // Como el resto del server (recibo digital, campañas): producción no depende de que BASE_URL esté declarada.
  // Staging NO cae a producción: sus webhooks apuntarían a la API de producción.
  it('producción sin BASE_URL cae a https://api.avoqado.io; staging sin BASE_URL no da URL', () => {
    expect(urlPublicaDelEntorno('production', undefined)).toBe('https://api.avoqado.io')
    expect(urlPublicaDelEntorno('staging', undefined)).toBeUndefined()
  })
})

// ─── Auto-alta en el job (los emisores que ya existían, o a los que les falló) ─

describe('asegurarWebhooksFaltantes', () => {
  it('da de alta a cada emisor sin webhook; un fallo no detiene a los demás', async () => {
    const asegurar = jest
      .fn()
      .mockResolvedValueOnce({ resultado: 'CREADO' })
      .mockRejectedValueOnce(new Error('Facturapi caído'))
      .mockResolvedValueOnce({ resultado: 'SIN_LLAVE' })
    const r = await asegurarWebhooksFaltantes({
      baseUrl: () => BASE,
      findSinWebhook: jest.fn().mockResolvedValue(['e1', 'e2', 'e3']),
      asegurar,
    })
    expect(asegurar.mock.calls.map(c => c[0])).toEqual(['e1', 'e2', 'e3'])
    expect(r).toEqual({ revisados: 3, creados: 1, errores: 1 })
  })

  it('sin URL pública ni siquiera consulta la base', async () => {
    const findSinWebhook = jest.fn()
    const r = await asegurarWebhooksFaltantes({ baseUrl: () => undefined, findSinWebhook, asegurar: jest.fn() })
    expect(findSinWebhook).not.toHaveBeenCalled()
    expect(r).toEqual({ revisados: 0, creados: 0, errores: 0 })
  })
})
