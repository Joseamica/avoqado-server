/**
 * Adaptador HTTP de Uber Eats — spec paso 2 (adaptador real) + paso 5 (traer el pedido).
 *
 * Lo que estos tests protegen, en orden de gravedad:
 *  1. El par login↔api es INSEPARABLE. Cruzar `sandbox-login` con `api.uber.com`
 *     (o al revés) es exactamente cómo un token de prueba termina escribiendo en
 *     un comercio real — ya pasó el 2026-08-17 con Doña Simona.
 *  2. Toda ESCRITURA pasa por el candado de tiendas. Las lecturas no.
 *  3. Un error del proveedor se propaga legible, nunca se traga.
 */
import { UberStoreWriteBlockedError } from '@/services/delivery-channels/providers/uber-eats/uber.storeAllowlist'
import {
  createUberTokenFetcher,
  orderIdFromResourceHref,
  uberHostsFor,
  uberRequest,
} from '@/services/delivery-channels/providers/uber-eats/uber.http'

const CREDS = { clientId: 'cid-de-prueba', clientSecret: 'secreto-de-prueba' }

/** fetch falso que registra la última llamada y devuelve lo que se le indique. */
function fakeFetch(respuesta: { status?: number; body?: unknown; texto?: string }) {
  const llamadas: Array<{ url: string; init: RequestInit }> = []
  const impl = (async (url: string, init: RequestInit) => {
    llamadas.push({ url: String(url), init: init ?? {} })
    const texto = respuesta.texto ?? JSON.stringify(respuesta.body ?? {})
    return {
      status: respuesta.status ?? 200,
      ok: (respuesta.status ?? 200) < 400,
      text: async () => texto,
    }
  }) as unknown as typeof fetch
  return { impl, llamadas }
}

describe('uber.http', () => {
  describe('uberHostsFor — el par login↔api es inseparable', () => {
    it('SANDBOX usa sandbox-login + test-api, nunca los de producción', () => {
      const h = uberHostsFor('SANDBOX')
      expect(h.login).toBe('https://sandbox-login.uber.com')
      expect(h.api).toBe('https://test-api.uber.com')
      expect(h.login).not.toContain('auth.uber.com')
      expect(h.api).not.toBe('https://api.uber.com')
    })

    it('PRODUCTION usa auth + api, nunca los de sandbox', () => {
      const h = uberHostsFor('PRODUCTION')
      expect(h.login).toBe('https://auth.uber.com')
      expect(h.api).toBe('https://api.uber.com')
      expect(h.login).not.toContain('sandbox')
      expect(h.api).not.toContain('test-api')
    })

    it('un ambiente desconocido NO cae a producción por defecto: lanza', () => {
      expect(() => uberHostsFor('STAGING' as never)).toThrow(/ambiente de Uber/i)
    })
  })

  describe('createUberTokenFetcher', () => {
    it('pide el token al host de LOGIN del ambiente, con client_credentials', async () => {
      const { impl, llamadas } = fakeFetch({ body: { access_token: 'tok-123', expires_in: 2592000 } })
      const fetcher = createUberTokenFetcher({ environment: 'SANDBOX', credentials: CREDS, fetchImpl: impl })

      const r = await fetcher()

      expect(r).toEqual({ access_token: 'tok-123', expires_in: 2592000 })
      expect(llamadas).toHaveLength(1)
      expect(llamadas[0].url).toBe('https://sandbox-login.uber.com/oauth/v2/token')
      expect(llamadas[0].init.method).toBe('POST')

      const enviado = String(llamadas[0].init.body)
      expect(enviado).toContain('grant_type=client_credentials')
      expect(enviado).toContain(`client_id=${CREDS.clientId}`)
      expect(enviado).toContain('eats.order')
    })

    it('el secret NUNCA aparece en el mensaje de un error', async () => {
      const { impl } = fakeFetch({ status: 401, texto: 'unauthorized' })
      const fetcher = createUberTokenFetcher({ environment: 'SANDBOX', credentials: CREDS, fetchImpl: impl })

      await expect(fetcher()).rejects.toThrow(/401/)
      await expect(fetcher()).rejects.not.toThrow(new RegExp(CREDS.clientSecret))
    })

    it('un 4xx del proveedor NO se traga: lanza con el status visible', async () => {
      const { impl } = fakeFetch({ status: 400, texto: 'invalid_client' })
      const fetcher = createUberTokenFetcher({ environment: 'SANDBOX', credentials: CREDS, fetchImpl: impl })
      await expect(fetcher()).rejects.toThrow(/400|invalid_client/)
    })
  })

  describe('uberRequest — el candado de escrituras', () => {
    const permitidas = new Set(['77abff2e-e700-406d-aaba-5a50b41504dc'])

    it('una LECTURA no pasa por el candado (aunque la lista esté vacía)', async () => {
      const { impl, llamadas } = fakeFetch({ body: { id: 'ord-1' } })
      const r = await uberRequest(
        { environment: 'SANDBOX', token: 'tok', writableStores: new Set(), fetchImpl: impl },
        { method: 'GET', path: '/v2/eats/order/ord-1' },
      )

      expect(r.status).toBe(200)
      expect(llamadas[0].url).toBe('https://test-api.uber.com/v2/eats/order/ord-1')
      expect((llamadas[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    })

    it('una ESCRITURA a una tienda AUTORIZADA pasa', async () => {
      const { impl, llamadas } = fakeFetch({ status: 204, texto: '' })
      const r = await uberRequest(
        { environment: 'SANDBOX', token: 'tok', writableStores: permitidas, fetchImpl: impl },
        { method: 'POST', path: '/v1/eats/orders/ord-1/accept_pos_order', storeId: '77abff2e-e700-406d-aaba-5a50b41504dc' },
      )
      expect(r.status).toBe(204)
      expect(llamadas).toHaveLength(1)
    })

    it('🔴 una ESCRITURA a una tienda NO autorizada se bloquea ANTES de salir a la red', async () => {
      const { impl, llamadas } = fakeFetch({ status: 200 })
      await expect(
        uberRequest(
          { environment: 'SANDBOX', token: 'tok', writableStores: permitidas, fetchImpl: impl },
          { method: 'PUT', path: '/v2/eats/stores/78cf8848/menus', storeId: '78cf8848-5cea-48f5-9f44-5bf42d303153' },
        ),
      ).rejects.toBeInstanceOf(UberStoreWriteBlockedError)

      expect(llamadas).toHaveLength(0) // lo que de verdad importa: NO hubo request
    })

    it('🔴 una ESCRITURA sin storeId se bloquea: no se puede autorizar lo que no se identifica', async () => {
      const { impl, llamadas } = fakeFetch({ status: 200 })
      await expect(
        uberRequest(
          { environment: 'SANDBOX', token: 'tok', writableStores: permitidas, fetchImpl: impl },
          { method: 'POST', path: '/v1/eats/algo' },
        ),
      ).rejects.toBeInstanceOf(UberStoreWriteBlockedError)
      expect(llamadas).toHaveLength(0)
    })

    it('el ambiente decide el host de la API, no el caller', async () => {
      const { impl, llamadas } = fakeFetch({ body: {} })
      await uberRequest(
        { environment: 'PRODUCTION', token: 'tok', writableStores: new Set(), fetchImpl: impl },
        { method: 'GET', path: '/v2/eats/order/ord-9' },
      )
      expect(llamadas[0].url).toBe('https://api.uber.com/v2/eats/order/ord-9')
    })

    it('devuelve el texto crudo además del json (para congelar fixtures reales)', async () => {
      const crudo = '{"id":"ord-1","total":123}'
      const { impl } = fakeFetch({ texto: crudo })
      const r = await uberRequest(
        { environment: 'SANDBOX', token: 'tok', writableStores: new Set(), fetchImpl: impl },
        { method: 'GET', path: '/v2/eats/order/ord-1' },
      )
      expect(r.text).toBe(crudo)
      expect(r.json).toEqual({ id: 'ord-1', total: 123 })
    })

    it('un cuerpo que no es JSON no revienta: json queda null y el texto se conserva', async () => {
      const { impl } = fakeFetch({ status: 502, texto: '<html>bad gateway</html>' })
      const r = await uberRequest(
        { environment: 'SANDBOX', token: 'tok', writableStores: new Set(), fetchImpl: impl },
        { method: 'GET', path: '/v2/eats/order/ord-1' },
      )
      expect(r.status).toBe(502)
      expect(r.json).toBeNull()
      expect(r.text).toContain('bad gateway')
    })
  })

  describe('orderIdFromResourceHref — el host del payload NO se usa jamás', () => {
    it('extrae el id de un href normal de sandbox', () => {
      expect(orderIdFromResourceHref('https://test-api.uber.com/v2/eats/order/abc-123')).toBe('abc-123')
    })

    it('extrae el id de un href de producción', () => {
      expect(orderIdFromResourceHref('https://api.uber.com/v2/eats/order/xyz-789')).toBe('xyz-789')
    })

    it('🔴 de un href a un host HOSTIL saca solo el id — el host se descarta', () => {
      // El caller construye la URL con el host del AMBIENTE, así que un href
      // malicioso no puede redirigir la petición ni llevarse el token.
      expect(orderIdFromResourceHref('https://evil.example.com/v2/eats/order/ord-1')).toBe('ord-1')
    })

    it('ignora query string y fragmento', () => {
      expect(orderIdFromResourceHref('https://test-api.uber.com/v2/eats/order/ord-1?x=1#y')).toBe('ord-1')
    })

    it('devuelve null si el href no tiene forma de pedido', () => {
      expect(orderIdFromResourceHref('https://test-api.uber.com/v2/eats/stores/abc')).toBeNull()
      expect(orderIdFromResourceHref('')).toBeNull()
      expect(orderIdFromResourceHref(null)).toBeNull()
      expect(orderIdFromResourceHref(undefined)).toBeNull()
      expect(orderIdFromResourceHref(42)).toBeNull()
    })

    it('un id vacío o de puros espacios es null, no cadena vacía', () => {
      expect(orderIdFromResourceHref('https://test-api.uber.com/v2/eats/order/')).toBeNull()
      expect(orderIdFromResourceHref('https://test-api.uber.com/v2/eats/order/%20%20')).toBeNull()
    })
  })
})
