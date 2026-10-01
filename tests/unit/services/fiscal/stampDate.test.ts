/**
 * 🔴 H22 (auditoría 2026-09-30): Facturapi manda `stamp.date` en hora de México SIN zona. `new Date(...)` la lee en el huso del
 * servidor: en producción (UTC) quedaba 6 h antes, y una factura timbrada el 1-oct a la 01:00 caía el 30-sep en la lista y en
 * el IVA de flujo. En una Mac con huso de México salía bien, por eso no se veía en local. Correr también con TZ=UTC.
 */
import { parseStampDate } from '@/services/fiscal/providers/facturapi.provider'

describe('parseStampDate', () => {
  it('sin zona ⇒ hora de México (UTC-6), en cualquier huso del servidor', () => {
    expect(parseStampDate('2026-10-01T01:00:00').toISOString()).toBe('2026-10-01T07:00:00.000Z')
  })

  it('con Z o con desfase ⇒ tal cual', () => {
    expect(parseStampDate('2026-10-01T07:00:00Z').toISOString()).toBe('2026-10-01T07:00:00.000Z')
    expect(parseStampDate('2026-10-01T01:00:00-06:00').toISOString()).toBe('2026-10-01T07:00:00.000Z')
    expect(parseStampDate('2026-10-01T01:00:00.123-0600').toISOString()).toBe('2026-10-01T07:00:00.123Z')
  })
})
