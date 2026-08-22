/**
 * El log NUNCA debe llevar credenciales en la URL.
 *
 * Hallado por auditoría externa el 2026-08-20: el request logger escribe `req.url` completo
 * en `Request Start` y `Request End`. El callback de OAuth de Uber recibe
 * `?code=…&state=…` — o sea, el código de autorización de un solo uso quedaba en texto
 * plano en el log, y con él se puede canjear un token si alguien lo lee antes de que expire.
 */
import { redactUrlSecrets } from '@/middlewares/requestLogger'

describe('redactUrlSecrets', () => {
  it('🔴 redacta el `code` de OAuth', () => {
    const r = redactUrlSecrets('/api/v1/delivery/uber/oauth/callback?code=crd.EA.CAESEDSg&state=abc.def')
    expect(r).not.toContain('crd.EA.CAESEDSg')
    expect(r).toContain('code=%5Bredactado%5D')
  })

  it('🔴 redacta el `state`', () => {
    expect(redactUrlSecrets('/x?state=abc123.mac')).not.toContain('abc123.mac')
  })

  it('redacta tokens, secretos y contraseñas por cualquiera de sus nombres comunes', () => {
    const r = redactUrlSecrets('/x?access_token=A&refresh_token=B&client_secret=C&password=D&api_key=E&signature=F')
    for (const secreto of ['=A', '=B', '=C', '=D', '=E', '=F']) expect(r).not.toContain(secreto)
  })

  it('no distingue mayúsculas: `?CODE=` también se redacta', () => {
    expect(redactUrlSecrets('/x?CODE=secreto')).not.toContain('secreto')
  })

  it('deja intactos los parámetros inofensivos', () => {
    const r = redactUrlSecrets('/api/v1/orders?page=2&from=2026-08-01&venueId=cmr123')
    expect(r).toBe('/api/v1/orders?page=2&from=2026-08-01&venueId=cmr123')
  })

  it('una URL sin query string pasa sin tocarse', () => {
    expect(redactUrlSecrets('/api/v1/orders')).toBe('/api/v1/orders')
  })

  it('conserva la ruta y el resto de los parámetros al redactar', () => {
    const r = redactUrlSecrets('/cb?code=X&venueId=v1')
    expect(r).toContain('/cb?')
    expect(r).toContain('venueId=v1')
    expect(r).not.toContain('code=X')
  })

  it('una query malformada no revienta: se redacta entera por prudencia', () => {
    expect(() => redactUrlSecrets('/x?%%%&code=Y')).not.toThrow()
    expect(redactUrlSecrets('/x?%%%&code=Y')).not.toContain('Y')
  })
})
