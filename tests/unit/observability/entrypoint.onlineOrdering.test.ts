import { normalizeEntrypoint, redactPathSecrets } from '@/observability/entrypoint'

const TOKEN = 'Zx9_aB-3kLmN0pQrStUvWxYz12345678' // 32 caracteres base64url, como generateTrackingToken()

describe('🔴 el token de seguimiento de un pedido en línea es un secreto (R9)', () => {
  it('se redacta en el seguimiento y en la cancelación', () => {
    expect(normalizeEntrypoint('GET', `/api/v1/public/venues/flautas/ordering/orders/${TOKEN}`)).toBe(
      'GET /api/v1/public/venues/flautas/ordering/orders/:token',
    )
    expect(normalizeEntrypoint('POST', `/api/v1/public/venues/flautas/ordering/orders/${TOKEN}/cancel`)).toBe(
      'POST /api/v1/public/venues/flautas/ordering/orders/:token/cancel',
    )
    expect(redactPathSecrets(`/api/v1/public/venues/flautas/ordering/orders/${TOKEN}`, '[redactado]')).not.toContain(TOKEN)
  })

  it('crear el pedido y las demás rutas de la tienda no cambian', () => {
    expect(normalizeEntrypoint('POST', '/api/v1/public/venues/flautas/ordering/orders')).toBe(
      'POST /api/v1/public/venues/flautas/ordering/orders',
    )
    expect(normalizeEntrypoint('GET', '/api/v1/public/venues/flautas/ordering/menu')).toBe(
      'GET /api/v1/public/venues/flautas/ordering/menu',
    )
  })
})
