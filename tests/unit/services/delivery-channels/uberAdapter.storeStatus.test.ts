/**
 * Las rutas de estado de tienda, fijadas por prueba.
 *
 * 🔴 POR QUÉ EXISTE ESTE ARCHIVO: la validación de producción de Uber (caso 59683742, 28-ago)
 * REPROBÓ la integración porque su rastreador sólo mira la familia `/v1/delivery/*`. Nuestras
 * llamadas de estado seguían en la clásica `/v1/eats/store/{id}/status`: funcionaban
 * perfectamente y aun así nos costaron el acceso a producción. Una ruta que "funciona" no es
 * una ruta correcta cuando el proveedor mide por dónde entras.
 *
 * Si alguien las devuelve a la familia clásica, este archivo falla. Es a propósito.
 */
import { uberAdapter } from '@/services/delivery-channels/providers/uber-eats/uber.adapter'
import { uberApi } from '@/services/delivery-channels/providers/uber-eats/uber.client'

jest.mock('@/services/delivery-channels/providers/uber-eats/uber.client', () => ({
  uberApi: jest.fn(),
  fetchUberOrder: jest.fn(),
}))

const api = uberApi as jest.MockedFunction<typeof uberApi>
const STORE = 'store-abc'

beforeEach(() => {
  jest.clearAllMocks()
  api.mockResolvedValue({ status: 200, json: {}, text: '{}' })
})

describe('uber.adapter — estado de la tienda (uAPI)', () => {
  it('🔴 PAUSAR pega a /v1/delivery/store/{id}/update-store-status, NO a la clásica', async () => {
    await uberAdapter.setStoreStatus(true, STORE, 'cocina saturada')

    const llamada = api.mock.calls[0][0]
    expect(llamada.path).toBe(`/v1/delivery/store/${STORE}/update-store-status`)
    expect(llamada.path).not.toContain('/v1/eats/')
    expect(llamada.method).toBe('POST')
    // `store` en SINGULAR: el plural da 404 (medido).
    expect(llamada.path).not.toContain('/stores/')
  })

  it('🔴 PAUSAR manda OFFLINE con `is_offline_until` — `PAUSED` ya NO existe en el uAPI', async () => {
    // Medido contra la API real (28-ago): `{status:'PAUSED'}` responde
    // "unknown enum value string:PAUSED", y `{status:'OFFLINE'}` a secas responde
    // "is_offline_until timestamp is needed when setting store offline".
    // Migrar sólo la ruta dejaba al negocio sin poder pausar — el peor fallo de este canal.
    await uberAdapter.setStoreStatus(true, STORE, 'cocina saturada')

    const body = api.mock.calls[0][0].body as { status: string; is_offline_until: string }
    expect(body.status).toBe('OFFLINE')
    expect(body.status).not.toBe('PAUSED')
    // ISO, no epoch: con el número la API responde 400.
    expect(body.is_offline_until).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(new Date(body.is_offline_until).getTime()).toBeGreaterThan(Date.now())
  })

  it('REANUDAR manda ONLINE por la misma ruta', async () => {
    await uberAdapter.setStoreStatus(false, STORE)

    const llamada = api.mock.calls[0][0]
    expect(llamada.path).toBe(`/v1/delivery/store/${STORE}/update-store-status`)
    expect(llamada.body).toEqual({ status: 'ONLINE' })
  })

  it('🔴 CONSULTAR pega a /v1/delivery/store/{id}/status', async () => {
    await uberAdapter.getStoreStatus(STORE)

    const llamada = api.mock.calls[0][0]
    expect(llamada.path).toBe(`/v1/delivery/store/${STORE}/status`)
    expect(llamada.path).not.toContain('/v1/eats/')
    expect(llamada.method).toBe('GET')
  })

  it('🔴 lee `offline_reason` en SNAKE_CASE — el uAPI lo cambió y el motivo se perdía', async () => {
    // Respuesta REAL del sandbox (28-ago). La clásica mandaba `offlineReason`; leer sólo esa
    // deja el motivo en `undefined` y la pantalla dice "pausada" sin poder decir POR QUÉ,
    // justo cuando alguien está tratando de entender por qué no le entran pedidos.
    api.mockResolvedValue({
      status: 200,
      json: { status: 'OFFLINE', offline_reason: 'OUT_OF_MENU_HOURS', integrator_store_id: 'venue-1' },
      text: '{}',
    })

    const r = await uberAdapter.getStoreStatus(STORE)

    expect(r.estado).toBe('OFFLINE')
    expect(r.motivo).toBe('OUT_OF_MENU_HOURS')
  })

  it('…y sigue leyendo el camelCase de la clásica, por si alguna respuesta viene vieja', async () => {
    api.mockResolvedValue({ status: 200, json: { status: 'OFFLINE', offlineReason: 'PAUSED_BY_MERCHANT' }, text: '{}' })

    expect((await uberAdapter.getStoreStatus(STORE)).motivo).toBe('PAUSED_BY_MERCHANT')
  })
})
