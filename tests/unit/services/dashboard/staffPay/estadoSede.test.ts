// tests/unit/services/dashboard/staffPay/estadoSede.test.ts — fase 3, B13 (revisión de B12 #3, ruling del controlador): UNA sola
// definición de «sede activa» y de su estado para las tres pantallas (Configuración › Sedes, el diálogo y la vista previa del
// cierre). Pura: la situación de la sede (ventana abierta, ventana que cubre hoy) llega resuelta.
import { estadoDeSede, situacionDe } from '@/services/dashboard/staffPay/estadoSede'

describe('estadoDeSede: las cuatro respuestas (ruling de B12 #3)', () => {
  it.each([
    // ACTIVA ⇔ con plan y una ventana que cubre hoy, también la que termina hoy.
    [{ tienePlan: true, abierta: true, cubreHoy: true }, 'ACTIVA'],
    [{ tienePlan: true, abierta: false, cubreHoy: true }, 'ACTIVA'],
    // SIN_ACTIVAR ⇔ con plan y sin ventana que cubra hoy.
    [{ tienePlan: true, abierta: false, cubreHoy: false }, 'SIN_ACTIVAR'],
    [{ tienePlan: true, abierta: true, cubreHoy: false }, 'SIN_ACTIVAR'],
    // ACTIVA_SIN_PLAN ⇔ ventana abierta y sin plan: exactamente la sede del bloqueo del cierre.
    [{ tienePlan: false, abierta: true, cubreHoy: true }, 'ACTIVA_SIN_PLAN'],
    [{ tienePlan: false, abierta: true, cubreHoy: false }, 'ACTIVA_SIN_PLAN'],
    // SIN_PLAN ⇔ sin plan y sin ventana abierta (aunque la última haya terminado hoy: no bloquea nada).
    [{ tienePlan: false, abierta: false, cubreHoy: true }, 'SIN_PLAN'],
    [{ tienePlan: false, abierta: false, cubreHoy: false }, 'SIN_PLAN'],
  ])('%o ⇒ %s', (s, esperado) => {
    expect(estadoDeSede(s)).toBe(esperado)
  })
})

describe('situacionDe: qué dicen las ventanas de UNA sede el día de hoy (civil, en su zona)', () => {
  const v = (desde: string, hasta: string | null) => ({ venueId: 'b', desde, hasta })

  it('sin ventanas: ni abierta ni hoy, sin vigente ni último día cerrado', () => {
    expect(situacionDe([], '2026-10-20')).toEqual({ abierta: false, cubreHoy: false, vigente: null, ultimoDiaCerrado: null })
  })

  it('una abierta que empezó antes: abierta y cubre hoy; es la vigente', () => {
    expect(situacionDe([v('2026-10-01', null)], '2026-10-20')).toEqual({
      abierta: true,
      cubreHoy: true,
      vigente: v('2026-10-01', null),
      ultimoDiaCerrado: null,
    })
  })

  it('una cerrada que termina HOY cubre hoy (todavía entra); ayer, ya no: la vigente es la última', () => {
    expect(situacionDe([v('2026-10-01', '2026-10-20')], '2026-10-20')).toMatchObject({ abierta: false, cubreHoy: true })
    expect(situacionDe([v('2026-10-01', '2026-10-19')], '2026-10-20')).toEqual({
      abierta: false,
      cubreHoy: false,
      vigente: v('2026-10-01', '2026-10-19'),
      ultimoDiaCerrado: '2026-10-19',
    })
  })

  it('sale y vuelve: la vigente es la que cubre hoy, y el último día cerrado es el de la cerrada más reciente', () => {
    const ventanas = [v('2026-09-01', '2026-09-10'), v('2026-09-20', '2026-10-05'), v('2026-10-15', null)]
    expect(situacionDe(ventanas, '2026-10-20')).toEqual({
      abierta: true,
      cubreHoy: true,
      vigente: v('2026-10-15', null),
      ultimoDiaCerrado: '2026-10-05',
    })
    // Hoy entre dos ventanas: ninguna cubre hoy; la vigente es la última (por inicio).
    expect(situacionDe([v('2026-09-01', '2026-09-10'), v('2026-09-20', '2026-10-05')], '2026-10-10')).toMatchObject({
      cubreHoy: false,
      vigente: v('2026-09-20', '2026-10-05'),
    })
  })
})
