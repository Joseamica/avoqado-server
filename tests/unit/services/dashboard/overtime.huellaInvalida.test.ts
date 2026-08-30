/**
 * La huella INVALIDA la autorización cuando la jornada cambió, aunque el total coincida.
 *
 * Es la segunda mitad del hallazgo #4: tener la huella no sirve de nada si `resumirAutorizacion`
 * sigue mirando sólo los minutos.
 */
import { resumirAutorizacion, type DiaAutorizado } from '@/services/dashboard/overtime'

const base = (over: Partial<DiaAutorizado> = {}): DiaAutorizado => ({
  date: '2026-08-24',
  medidos: 120,
  autorizados: 120,
  medidosAlAutorizar: 120,
  huellaActual: 'abc123',
  huellaAlAutorizar: 'abc123',
  ...over,
})

describe('la huella invalida una autorización que ya no corresponde', () => {
  it('con la misma huella, la autorización vale', () => {
    const r = resumirAutorizacion([base()])
    expect(r.minutosAutorizados).toBe(120)
    expect(r.diasPorRevisar).toEqual([])
  })

  it('🔴 con huella DISTINTA no se paga, aunque el total coincida', () => {
    // El caso exacto del hallazgo: mismo número, otra jornada. Nadie miró ESTAS checadas.
    const r = resumirAutorizacion([base({ huellaActual: 'otra999' })])
    expect(r.minutosAutorizados).toBe(0)
    expect(r.minutosPendientes).toBe(120)
    expect(r.diasPorRevisar).toEqual(['2026-08-24'])
  })

  it('🔴 una autorización VIEJA sin huella se trata como "hay que revisar"', () => {
    // Las filas anteriores a la columna no tienen huella. El lado seguro es no pagarlas a
    // ciegas: se piden de nuevo, no se descartan.
    const r = resumirAutorizacion([base({ huellaAlAutorizar: null })])
    expect(r.minutosAutorizados).toBe(0)
    expect(r.minutosPendientes).toBe(120)
    expect(r.diasPorRevisar).toEqual(['2026-08-24'])
  })

  it('sin huella actual tampoco se paga a ciegas', () => {
    const r = resumirAutorizacion([base({ huellaActual: null })])
    expect(r.minutosAutorizados).toBe(0)
    expect(r.diasPorRevisar).toEqual(['2026-08-24'])
  })

  it('🔴 la huella manda por encima del total: coincidir en minutos NO basta', () => {
    // Se autorizaron 120 sobre 120 medidos; hoy siguen siendo 120 pero de otra jornada.
    const r = resumirAutorizacion([
      base({ medidos: 120, autorizados: 120, medidosAlAutorizar: 120, huellaActual: 'nueva' }),
    ])
    expect(r.minutosAutorizados).toBe(0)
  })

  it('un día SIN revisar no se marca por revisar sólo por no tener huella', () => {
    // Sin fila de autorización no hay nada que invalidar: ya está en pendiente.
    const r = resumirAutorizacion([
      { date: '2026-08-24', medidos: 120, autorizados: null, medidosAlAutorizar: null, huellaActual: 'x', huellaAlAutorizar: null },
    ])
    expect(r.minutosPendientes).toBe(120)
    expect(r.diasPorRevisar).toEqual([])
  })

  it('regresión: sin huellas en juego, todo se comporta como antes', () => {
    const r = resumirAutorizacion([
      { date: '2026-08-24', medidos: 120, autorizados: 30, medidosAlAutorizar: 60, huellaActual: 'h', huellaAlAutorizar: 'h' },
    ])
    expect(r.minutosAutorizados).toBe(30)
    expect(r.minutosNegados).toBe(30)
    expect(r.minutosPendientes).toBe(60)
  })
})
