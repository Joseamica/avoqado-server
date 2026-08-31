/**
 * Autorización de horas extra — decisión del founder (29-ago-2026): «autorizarse».
 *
 * Lo MEDIDO se guarda siempre (es lo que marcó el reloj). Lo AUTORIZADO es lo que entra al
 * reparto doble/triple, porque es lo que se paga.
 *
 * 🔴 Tres estados, no dos, y confundirlos cuesta dinero:
 *   sin fila      → SIN REVISAR. Alguien tiene que mirarlo. Nunca se paga en silencio…
 *                   …pero tampoco desaparece: sale como PENDIENTE, muy visible.
 *   fila con 0    → revisado y NO autorizado.
 *   fila con N    → autorizado N, que puede ser MENOS de lo medido (autorización parcial).
 */
import { resumirAutorizacion, type DiaAutorizado } from '@/services/dashboard/overtime'

/** Un día sin revisar: se midió algo y nadie lo ha mirado. */
function sinRevisar(date: string, medidos: number): DiaAutorizado {
  return { date, medidos, autorizados: null, medidosAlAutorizar: null, huellaActual: 'h', huellaAlAutorizar: null }
}

/**
 * Un día ya revisado, con la jornada SIN cambios.
 *
 * 🔴 Las huellas coinciden a propósito: lo que cambia cuando la jornada se toca vive en
 * `overtime.huellaInvalida.test.ts`. Aquí se prueba la aritmética de los buckets, y meterle
 * huellas distintas convertiría cada caso en «pendiente» y no se probaría nada.
 */
function revisado(date: string, medidos: number, autorizados: number, alAutorizar = medidos): DiaAutorizado {
  return { date, medidos, autorizados, medidosAlAutorizar: alAutorizar, huellaActual: 'h', huellaAlAutorizar: 'h' }
}

/**
 * Un día ya revisado **cuya jornada se editó después**. Es el ÚNICO modo en que lo medido
 * puede diferir de lo que se firmó: tocar checadas, descansos, cuadrante o zona cambia la
 * huella. Antes estos casos se escribían con la misma huella y distinto medido — un estado
 * que ninguna edición real produce, y por eso las pruebas «pasaban» comprobando aritmética
 * que nunca se ejecuta (2ª auditoría de Codex, 30-ago-2026, P1 #2).
 */
function editadoDespues(date: string, medidosAhora: number, autorizados: number, alAutorizar: number): DiaAutorizado {
  return { date, medidos: medidosAhora, autorizados, medidosAlAutorizar: alAutorizar, huellaActual: 'nueva', huellaAlAutorizar: 'vieja' }
}

describe('resumirAutorizacion', () => {
  it('lo autorizado y lo medido se reportan por separado', () => {
    const r = resumirAutorizacion([revisado('2026-08-24', 120, 120)])
    expect(r.minutosMedidos).toBe(120)
    expect(r.minutosAutorizados).toBe(120)
    expect(r.minutosPendientes).toBe(0)
    expect(r.minutosNegados).toBe(0)
  })

  it('🔴 un día SIN REVISAR es PENDIENTE, no autorizado — no se paga solo', () => {
    const r = resumirAutorizacion([sinRevisar('2026-08-24', 120)])
    expect(r.minutosAutorizados).toBe(0)
    expect(r.minutosPendientes).toBe(120)
    expect(r.minutosNegados).toBe(0)
  })

  it('🔴 …pero tampoco desaparece: lo medido sigue ahí para que alguien lo vea', () => {
    // Si lo pendiente no se reportara, no pagar sería invisible — que es el riesgo real de
    // exigir autorización.
    const r = resumirAutorizacion([sinRevisar('2026-08-24', 120)])
    expect(r.minutosMedidos).toBe(120)
  })

  it('revisado y NEGADO (cero) no es lo mismo que sin revisar', () => {
    const r = resumirAutorizacion([revisado('2026-08-24', 120, 0)])
    expect(r.minutosAutorizados).toBe(0)
    expect(r.minutosNegados).toBe(120)
    expect(r.minutosPendientes).toBe(0) // ya lo miraron: no está pendiente
  })

  it('autorización PARCIAL: se queda 2 h, le autorizan 1', () => {
    const r = resumirAutorizacion([revisado('2026-08-24', 120, 60)])
    expect(r.minutosAutorizados).toBe(60)
    expect(r.minutosNegados).toBe(60)
    expect(r.minutosPendientes).toBe(0)
  })

  it('mezcla de días: cada bucket cuenta lo suyo', () => {
    const r = resumirAutorizacion([
      revisado('2026-08-24', 120, 120),
      revisado('2026-08-25', 120, 60),
      sinRevisar('2026-08-26', 90),
      revisado('2026-08-27', 60, 0),
    ])
    expect(r.minutosMedidos).toBe(390)
    expect(r.minutosAutorizados).toBe(180)
    expect(r.minutosNegados).toBe(120)
    expect(r.minutosPendientes).toBe(90)
  })

  describe('🔴 la checada cambió DESPUÉS de autorizar', () => {
    it('si ahora se midió MÁS, NADA se hereda: la firma entera deja de valer', () => {
      // Autorizaron 2 h sobre 2 h medidas; luego alguien editó la salida y hoy son 4 h.
      // Quien firmó no vio ESTA jornada, así que su decisión no vale para ninguna parte:
      // las 4 h vuelven a pendiente y el día se reporta.
      const r = resumirAutorizacion([editadoDespues('2026-08-24', 240, 120, 120)])
      expect(r.minutosAutorizados).toBe(0)
      expect(r.minutosPendientes).toBe(240)
      expect(r.minutosNegados).toBe(0)
      expect(r.diasPorRevisar).toEqual(['2026-08-24'])
    })

    it('si ahora se midió MENOS, tampoco se paga: se vuelve a revisar', () => {
      // Autorizaron 4 h; luego la salida se corrigió a 1 h. Ni 4 (sería pagar aire) ni 1
      // (nadie firmó ESA hora): 1 h pendiente.
      const r = resumirAutorizacion([editadoDespues('2026-08-24', 60, 240, 240)])
      expect(r.minutosAutorizados).toBe(0)
      expect(r.minutosPendientes).toBe(60)
      expect(r.diasPorRevisar).toEqual(['2026-08-24'])
    })

    it('sin cambio no se marca nada por revisar, y lo no autorizado queda NEGADO', () => {
      const r = resumirAutorizacion([revisado('2026-08-24', 120, 60, 120)])
      expect(r.diasPorRevisar).toEqual([])
      expect(r.minutosAutorizados).toBe(60)
      expect(r.minutosNegados).toBe(60)
      expect(r.minutosPendientes).toBe(0)
    })
  })

  it('un día sin extra no aporta nada', () => {
    const r = resumirAutorizacion([sinRevisar('2026-08-24', 0)])
    expect(r.minutosMedidos).toBe(0)
    expect(r.minutosPendientes).toBe(0)
  })

  it('sin días, todo en cero', () => {
    expect(resumirAutorizacion([])).toEqual({
      minutosMedidos: 0,
      minutosAutorizados: 0,
      minutosPendientes: 0,
      minutosNegados: 0,
      diasPorRevisar: [],
    })
  })

  it('un valor negativo no inventa dinero', () => {
    const r = resumirAutorizacion([revisado('2026-08-24', 120, -60, 120)])
    expect(r.minutosAutorizados).toBe(0)
  })

  it('los días por revisar salen ordenados', () => {
    const r = resumirAutorizacion([editadoDespues('2026-08-26', 240, 120, 120), editadoDespues('2026-08-24', 240, 120, 120)])
    expect(r.diasPorRevisar).toEqual(['2026-08-24', '2026-08-26'])
  })
})

describe('diasAutorizadosParaReparto — lo que entra al doble/triple', () => {
  const { diasAutorizadosParaReparto } = require('@/services/dashboard/overtime')

  it('🔴 al reparto sólo entra lo AUTORIZADO, nunca lo medido', () => {
    // 4 días de 3 h medidas = 12 h, pero sólo 6 h autorizadas: nada llega al triple.
    const dias = diasAutorizadosParaReparto([
      revisado('2026-08-24', 180, 90),
      revisado('2026-08-25', 180, 90),
      revisado('2026-08-26', 180, 90),
      revisado('2026-08-27', 180, 90),
    ])
    expect(dias.reduce((t: number, d: any) => t + d.minutos, 0)).toBe(360)
  })

  it('los días sin revisar no entran al reparto', () => {
    const dias = diasAutorizadosParaReparto([sinRevisar('2026-08-24', 180)])
    expect(dias).toEqual([])
  })

  it('los días negados tampoco', () => {
    const dias = diasAutorizadosParaReparto([revisado('2026-08-24', 180, 0)])
    expect(dias).toEqual([])
  })
})
