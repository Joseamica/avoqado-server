/**
 * D26 · `cumplioElTecho`: la regla del techo a «sigo cobrando» que levanta el veto de la declaración de una persona. La misma que
 * `techoCumplidoSql` (que prueba contra Postgres `terminalPaymentTechoTrasCancelar.integration.test.ts`).
 */
import { cumplioElTecho, TECHO_TRAS_CANCELAR_MS } from '@/services/tpv/techoDeEjecucionViva'

const T0 = new Date('2026-11-22T15:25:24.000Z') // el cancel de la PAX de Testarudo (09:25:24 MX)
const mas = (ms: number, desde = T0) => new Date(desde.getTime() + ms)

describe('cumplioElTecho', () => {
  it('el «sigo» posterior al cancel cumple el techo a los 5 min exactos, no antes', () => {
    const fila = { cancelRequestedAt: T0, probeActiveAt: mas(30_000) }
    expect(cumplioElTecho(fila, null, mas(TECHO_TRAS_CANCELAR_MS - 1))).toBe(false)
    expect(cumplioElTecho(fila, null, mas(TECHO_TRAS_CANCELAR_MS))).toBe(true)
  })

  it('sin cancel del POS no hay techo', () => {
    expect(cumplioElTecho({ cancelRequestedAt: null, probeActiveAt: mas(30_000) }, null, mas(60 * 60_000))).toBe(false)
  })

  it('sin un «sigo» posterior al cancel no hay techo (el ACTIVE de antes del cancel no cuenta)', () => {
    expect(cumplioElTecho({ cancelRequestedAt: T0, probeActiveAt: null }, null, mas(60 * 60_000))).toBe(false)
    expect(cumplioElTecho({ cancelRequestedAt: T0, probeActiveAt: mas(-1) }, null, mas(60 * 60_000))).toBe(false)
  })

  it('un intento abierto DESPUÉS del cancel mueve el origen; uno de antes no', () => {
    const fila = { cancelRequestedAt: T0, probeActiveAt: mas(30_000) }
    const intento = mas(2 * 60_000)
    expect(cumplioElTecho(fila, intento, mas(TECHO_TRAS_CANCELAR_MS))).toBe(false)
    expect(cumplioElTecho(fila, intento, mas(TECHO_TRAS_CANCELAR_MS, intento))).toBe(true)
    expect(cumplioElTecho(fila, mas(-60_000), mas(TECHO_TRAS_CANCELAR_MS))).toBe(true)
  })
})
