/**
 * Los defectos de dinero que encontró la auditoría de Codex (29-ago-2026) sobre `91c24c61`.
 *
 * 🔑 La lección de fondo, y por eso este archivo existe aparte: las 34 pruebas que ya había
 * sobre esta función NO vieron ninguno, porque todas ejercitan el caso que yo tenía en la
 * cabeza al escribirla — una entrada, una salida, un descanso limpio. Estas prueban lo que
 * NO se me ocurrió: dos descansos que se solapan, una decisión previa de negar, un rango que
 * empieza a media semana.
 */
import { minutosExtraDelDia, resumirAutorizacion, agruparPorSemana, type DescansoDelDia } from '@/services/dashboard/overtime'

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

describe('P1 #5 · la decisión de NEGAR sobrevive al crecer lo medido', () => {
  // 🔴 Antes: se midieron 60, autorizas 30 (⇒ 30 negados); la checada sube a 120 y los 30
  // negados VOLVÍAN a «pendiente», como si nadie los hubiera mirado.
  it('conserva lo negado y sólo lo NUEVO queda pendiente', () => {
    const r = resumirAutorizacion([{ date: '2026-08-24', medidos: 120, autorizados: 30, medidosAlAutorizar: 60, huellaActual: 'h', huellaAlAutorizar: 'h' }])
    expect(r.minutosAutorizados).toBe(30)
    expect(r.minutosNegados).toBe(30) // lo revisado y no autorizado, intacto
    expect(r.minutosPendientes).toBe(60) // sólo el crecimiento sobre el retrato
    expect(r.diasPorRevisar).toEqual(['2026-08-24'])
  })

  it('sin crecimiento, todo lo no autorizado sigue siendo negado', () => {
    const r = resumirAutorizacion([{ date: '2026-08-24', medidos: 120, autorizados: 30, medidosAlAutorizar: 120, huellaActual: 'h', huellaAlAutorizar: 'h' }])
    expect(r.minutosNegados).toBe(90)
    expect(r.minutosPendientes).toBe(0)
  })

  it('crecimiento con autorización TOTAL previa: nada negado, todo lo nuevo pendiente', () => {
    const r = resumirAutorizacion([{ date: '2026-08-24', medidos: 120, autorizados: 60, medidosAlAutorizar: 60, huellaActual: 'h', huellaAlAutorizar: 'h' }])
    expect(r.minutosNegados).toBe(0)
    expect(r.minutosPendientes).toBe(60)
  })

  it('si ahora se mide MENOS, no se paga más de lo trabajado y no se inventa negado', () => {
    const r = resumirAutorizacion([{ date: '2026-08-24', medidos: 60, autorizados: 240, medidosAlAutorizar: 240, huellaActual: 'h', huellaAlAutorizar: 'h' }])
    expect(r.minutosAutorizados).toBe(60)
    expect(r.minutosNegados).toBe(0)
    expect(r.minutosPendientes).toBe(0)
  })

  it('los tres buckets siempre suman lo medido', () => {
    for (const caso of [
      { medidos: 120, autorizados: 30, medidosAlAutorizar: 60 },
      { medidos: 120, autorizados: 30, medidosAlAutorizar: 120 },
      { medidos: 200, autorizados: 100, medidosAlAutorizar: 150 },
      { medidos: 90, autorizados: 0, medidosAlAutorizar: 90 },
    ]) {
      const r = resumirAutorizacion([{ date: '2026-08-24', ...caso, huellaActual: 'h', huellaAlAutorizar: 'h' }])
      expect(r.minutosAutorizados + r.minutosNegados + r.minutosPendientes).toBe(caso.medidos)
    }
  })
})

describe('P1 #2 · un rango a media semana NO reinicia el umbral de 9 h', () => {
  // 🔴 Antes: pedir sólo el domingo con 8 h ya trabajadas el lunes pagaba las 3 h del domingo
  // al DOBLE, cuando legalmente 1 h iba al doble y 2 h al TRIPLE. El campo `parcial` avisaba
  // del riesgo y aun así el dinero salía mal: avisar no es resolver.
  it('el acumulado previo de la semana empuja al triple', () => {
    const semanas = agruparPorSemana(
      [{ date: '2026-08-30', minutos: 180 }], // domingo
      { startDate: '2026-08-30', endDate: '2026-08-30' },
      // Lo ya acumulado en esa semana ANTES del rango pedido.
      { '2026-08-24': 480 },
    )
    expect(semanas[0].minutosDobles).toBe(60)
    expect(semanas[0].minutosTriples).toBe(120)
  })

  it('sin acumulado previo el reparto no cambia', () => {
    const semanas = agruparPorSemana([{ date: '2026-08-30', minutos: 180 }], {
      startDate: '2026-08-24',
      endDate: '2026-08-30',
    })
    expect(semanas[0].minutosDobles).toBe(180)
    expect(semanas[0].minutosTriples).toBe(0)
  })

  it('🔴 sólo devuelve lo atribuible al RANGO, no el acumulado ajeno', () => {
    const semanas = agruparPorSemana(
      [{ date: '2026-08-30', minutos: 180 }],
      { startDate: '2026-08-30', endDate: '2026-08-30' },
      { '2026-08-24': 480 },
    )
    // 60 + 120 = 180, los del domingo. Los 480 del lunes NO se re-reportan.
    expect(semanas[0].minutosDobles + semanas[0].minutosTriples).toBe(180)
    expect(semanas[0].minutosTotal).toBe(180)
  })

  it('un acumulado previo que YA pasó las 9 h manda todo al triple', () => {
    const semanas = agruparPorSemana(
      [{ date: '2026-08-30', minutos: 60 }],
      { startDate: '2026-08-30', endDate: '2026-08-30' },
      { '2026-08-24': 600 },
    )
    expect(semanas[0].minutosDobles).toBe(0)
    expect(semanas[0].minutosTriples).toBe(60)
  })

  it('el acumulado previo de OTRA semana no contamina', () => {
    const semanas = agruparPorSemana(
      [{ date: '2026-08-31', minutos: 180 }], // lunes, semana NUEVA
      { startDate: '2026-08-31', endDate: '2026-08-31' },
      { '2026-08-24': 480 }, // acumulado de la semana ANTERIOR
    )
    expect(semanas[0].minutosDobles).toBe(180)
    expect(semanas[0].minutosTriples).toBe(0)
  })

  it('la infracción del art. 66 también cuenta los días previos', () => {
    const semanas = agruparPorSemana(
      [{ date: '2026-08-30', minutos: 30 }],
      { startDate: '2026-08-30', endDate: '2026-08-30' },
      { '2026-08-24': 30, '2026-08-25': 30, '2026-08-26': 30 }, // ya 3 días con extra
    )
    expect(semanas[0].diasConExtra).toBe(4)
    expect(semanas[0].excedeDiasPermitidos).toBe(true)
  })
})
