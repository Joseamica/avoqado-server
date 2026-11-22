/**
 * D26 · `cumplioElTechoDeLaVenta`: la regla del techo de la VENTA (150 s) que levanta el veto de la declaración de una persona. La
 * de la RANURA (30 s) es `techoCumplidoSql`, que se prueba contra Postgres en `terminalPaymentTechoTrasCancelar.integration.test.ts`.
 */
import {
  activaTrasElCancel,
  cumplioElTechoDeLaVenta,
  TECHO_DE_LA_RANURA_MS,
  VENTANA_DE_EJECUCION_MS,
} from '@/services/tpv/techoDeEjecucionViva'

const T0 = new Date('2026-11-22T15:25:24.000Z') // el cancel de la PAX de Testarudo (09:25:24 MX)
const mas = (ms: number, desde = T0) => new Date(desde.getTime() + ms)

describe('techo de D26', () => {
  it('la ranura (30 s) va antes que la venta (150 s)', () => {
    expect(TECHO_DE_LA_RANURA_MS).toBe(30_000)
    expect(VENTANA_DE_EJECUCION_MS).toBe(150_000)
  })

  it('el «sigo» posterior al cancel cumple el techo de la venta a los 150 s exactos, no antes', () => {
    const fila = { cancelRequestedAt: T0, probeActiveAt: mas(1_000) }
    expect(cumplioElTechoDeLaVenta(fila, null, mas(VENTANA_DE_EJECUCION_MS - 1))).toBe(false)
    expect(cumplioElTechoDeLaVenta(fila, null, mas(VENTANA_DE_EJECUCION_MS))).toBe(true)
  })

  it('sin cancel del POS, o sin un «sigo» posterior al cancel, no hay techo', () => {
    const tarde = mas(60 * 60_000)
    expect(cumplioElTechoDeLaVenta({ cancelRequestedAt: null, probeActiveAt: mas(1_000) }, null, tarde)).toBe(false)
    expect(cumplioElTechoDeLaVenta({ cancelRequestedAt: T0, probeActiveAt: null }, null, tarde)).toBe(false)
    expect(cumplioElTechoDeLaVenta({ cancelRequestedAt: T0, probeActiveAt: mas(-1) }, null, tarde)).toBe(false)
    expect(activaTrasElCancel({ cancelRequestedAt: T0, probeActiveAt: T0 })).toBe(true)
  })

  it('un intento abierto DESPUÉS del cancel mueve el origen; uno de antes no', () => {
    const fila = { cancelRequestedAt: T0, probeActiveAt: mas(1_000) }
    const intento = mas(60_000)
    expect(cumplioElTechoDeLaVenta(fila, intento, mas(VENTANA_DE_EJECUCION_MS))).toBe(false)
    expect(cumplioElTechoDeLaVenta(fila, intento, mas(VENTANA_DE_EJECUCION_MS, intento))).toBe(true)
    expect(cumplioElTechoDeLaVenta(fila, mas(-60_000), mas(VENTANA_DE_EJECUCION_MS))).toBe(true)
  })
})
