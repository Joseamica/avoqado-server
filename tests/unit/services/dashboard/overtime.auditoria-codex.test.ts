/**
 * Los defectos de dinero que encontró la auditoría de Codex (29-ago-2026) sobre `91c24c61`.
 *
 * 🔑 La lección de fondo, y por eso este archivo existe aparte: las 34 pruebas que ya había
 * sobre esta función NO vieron ninguno, porque todas ejercitan el caso que yo tenía en la
 * cabeza al escribirla — una entrada, una salida, un descanso limpio. Estas prueban lo que
 * NO se me ocurrió: dos descansos que se solapan, una decisión previa de negar, un rango que
 * empieza a media semana.
 */
import {
  agruparPorSemana,
  diasAutorizadosParaReparto,
  huellaDeLaJornada,
  minutosExtraDelDia,
  resumirAutorizacion,
  type DescansoDelDia,
} from '@/services/dashboard/overtime'

const TZ = 'America/Mexico_City'
const enMexico = (f: string, h: string) => new Date(`${f}T${h}:00.000-06:00`)
const TURNO = { date: '2026-08-24', expectedStart: '09:00', expectedEnd: '17:00' }

describe('P1 #7 · descansos que se SOLAPAN no se descuentan dos veces', () => {
  // 🔴 Este defecto paga de MENOS: va contra el empleado, que es la dirección que nadie
  // reclama hasta que revisa su recibo con calma.
  function extraCon(descansos: DescansoDelDia[]) {
    return minutosExtraDelDia({
      turno: TURNO,
      intervalos: [{ entrada: enMexico('2026-08-24', '09:00'), salida: enMexico('2026-08-24', '19:00') }],
      descansos,
      timezone: TZ,
    })
  }

  it('uno DENTRO de otro cuenta una sola vez', () => {
    // 17:00→19:00 son 120. La UNIÓN de los descansos son 60 (17:30–18:30). Deben quedar 60.
    expect(
      extraCon([
        { startTime: enMexico('2026-08-24', '17:30'), endTime: enMexico('2026-08-24', '18:30') },
        { startTime: enMexico('2026-08-24', '18:00'), endTime: enMexico('2026-08-24', '18:30') },
      ]),
    ).toBe(60)
  })

  it('dos que se solapan parcialmente cuentan su unión', () => {
    // 17:00–18:00 y 17:30–18:30 → unión 17:00–18:30 = 90. Quedan 30.
    expect(
      extraCon([
        { startTime: enMexico('2026-08-24', '17:00'), endTime: enMexico('2026-08-24', '18:00') },
        { startTime: enMexico('2026-08-24', '17:30'), endTime: enMexico('2026-08-24', '18:30') },
      ]),
    ).toBe(30)
  })

  it('dos IDÉNTICOS (duplicado en la base) cuentan una vez', () => {
    const d = { startTime: enMexico('2026-08-24', '17:30'), endTime: enMexico('2026-08-24', '18:00') }
    expect(extraCon([d, { ...d }])).toBe(90)
  })

  it('regresión: dos descansos SEPARADOS siguen sumando los dos', () => {
    expect(
      extraCon([
        { startTime: enMexico('2026-08-24', '17:10'), endTime: enMexico('2026-08-24', '17:25') },
        { startTime: enMexico('2026-08-24', '18:00'), endTime: enMexico('2026-08-24', '18:20') },
      ]),
    ).toBe(120 - 15 - 20)
  })

  it('tres encadenados A⊂B, B∩C se unen bien', () => {
    // B 17:00–18:00, A 17:15–17:45 (dentro de B), C 17:50–18:30 → unión 17:00–18:30 = 90.
    expect(
      extraCon([
        { startTime: enMexico('2026-08-24', '17:15'), endTime: enMexico('2026-08-24', '17:45') },
        { startTime: enMexico('2026-08-24', '17:00'), endTime: enMexico('2026-08-24', '18:00') },
        { startTime: enMexico('2026-08-24', '17:50'), endTime: enMexico('2026-08-24', '18:30') },
      ]),
    ).toBe(30)
  })

  it('el orden en que llegan no cambia el resultado', () => {
    const a: DescansoDelDia = { startTime: enMexico('2026-08-24', '17:30'), endTime: enMexico('2026-08-24', '18:30') }
    const b: DescansoDelDia = { startTime: enMexico('2026-08-24', '18:00'), endTime: enMexico('2026-08-24', '18:30') }
    expect(extraCon([a, b])).toBe(extraCon([b, a]))
  })
})

describe('P1 #5 → superado por la huella · toda edición invalida la firma ENTERA', () => {
  // 🔴 Este bloque probaba una aritmética que ya no existe: partir el resto en «lo que se
  // negó» y «lo que creció». Se escribía con la MISMA huella y distinto medido — un estado
  // que ninguna edición real produce, así que la rama nunca corría en producción y la prueba
  // pasaba por el motivo equivocado (2ª auditoría de Codex, 30-ago-2026, P1 #2).
  //
  // Lo que de verdad protege el dinero es más simple: si la jornada cambió, la firma no vale
  // para NADA. Lo que sigue lo demuestra en vez de suponerlo.

  const turno = { date: '2026-08-24', expectedStart: '09:00', expectedEnd: '18:00' }
  const tz = 'America/Mexico_City'
  const iso = (s: string) => new Date(s)

  it('🔑 editar la SALIDA cambia la huella — por eso no hace falta comparar minutos', () => {
    const antes = huellaDeLaJornada({
      turno,
      intervalos: [{ entrada: iso('2026-08-24T15:00:00Z'), salida: iso('2026-08-25T02:00:00Z') }],
      descansos: [],
      timezone: tz,
    })
    const despues = huellaDeLaJornada({
      turno,
      intervalos: [{ entrada: iso('2026-08-24T15:00:00Z'), salida: iso('2026-08-25T04:00:00Z') }],
      descansos: [],
      timezone: tz,
    })
    expect(antes).not.toBe(despues)
  })

  it('🔴 y editarla NO deja nada heredado: todo vuelve a pendiente', () => {
    // 60 medidos → 30 autorizados (⇒ 30 negados); la checada sube a 120 con jornada nueva.
    const r = resumirAutorizacion([
      { date: '2026-08-24', medidos: 120, autorizados: 30, medidosAlAutorizar: 60, huellaActual: 'nueva', huellaAlAutorizar: 'vieja' },
    ])
    expect(r.minutosAutorizados).toBe(0)
    expect(r.minutosNegados).toBe(0)
    expect(r.minutosPendientes).toBe(120)
    expect(r.diasPorRevisar).toEqual(['2026-08-24'])
  })

  it('🔴 lo que se PAGA coincide con lo que el resumen dice — no pueden contradecirse', () => {
    // El defecto que introdujo el arreglo anterior: el resumen invalidaba por huella y el
    // reparto doble/triple no, así que una fila decía «0 autorizados» y pagaba 120 al doble.
    const dias = [
      { date: '2026-08-24', medidos: 120, autorizados: 120, medidosAlAutorizar: 120, huellaActual: 'nueva', huellaAlAutorizar: 'vieja' },
    ]
    const resumen = resumirAutorizacion(dias)
    const semanas = agruparPorSemana(diasAutorizadosParaReparto(dias), { startDate: '2026-08-24', endDate: '2026-08-30' })
    const pagados = semanas.reduce((t, s) => t + s.minutosDobles + s.minutosTriples, 0)
    expect(resumen.minutosAutorizados).toBe(0)
    expect(pagados).toBe(0)
  })

  it('con la jornada intacta, lo no autorizado sí queda NEGADO y los buckets suman', () => {
    for (const caso of [
      { medidos: 120, autorizados: 30 },
      { medidos: 200, autorizados: 100 },
      { medidos: 90, autorizados: 0 },
    ]) {
      const r = resumirAutorizacion([
        { date: '2026-08-24', ...caso, medidosAlAutorizar: caso.medidos, huellaActual: 'h', huellaAlAutorizar: 'h' },
      ])
      expect(r.minutosAutorizados).toBe(caso.autorizados)
      expect(r.minutosNegados).toBe(caso.medidos - caso.autorizados)
      expect(r.minutosAutorizados + r.minutosNegados + r.minutosPendientes).toBe(caso.medidos)
    }
  })
})
