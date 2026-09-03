/**
 * La aritmética del cumpleaños. Función PURA: sin base, sin reloj, sin zona implícita.
 *
 * Todo lo delicado de esta fase vive aquí, y son tres cosas:
 *
 *  1. **El 29 de febrero.** Quien nació ese día cumple los años no bisiestos — normalizado
 *     al 28-feb, que es la convención civil mexicana (y la que usa el registro civil para
 *     efectos de mayoría de edad). Ignorarlo deja a esa gente sin felicitación 3 de cada 4
 *     años.
 *  2. **Se razona en fechas CIVILES, nunca en instantes.** Un cumpleaños no ocurre a una
 *     hora: ocurre un día. Evaluar por fecha civil hace el barrido inmune a las horas que
 *     no existen o existen dos veces con el cambio de horario — que en México siguen
 *     ocurriendo en Baja California.
 *  3. 🔴 **La tolerancia de atraso.** Si el sistema estuvo caído y el barrido se pone al
 *     día, una fecha vieja produciría un correo que llega DESPUÉS del cumpleaños.
 *     Felicitar tarde es peor que no felicitar: se omite.
 */
import {
  aniversarioNormalizado,
  cumpleanosAFelicitar,
  fechasPendientes,
  MAX_FECHAS_POR_BARRIDO,
  diasDeNacimientoQueCumplenEl,
} from '@/services/marketing/birthdaySchedule'

describe('aniversarioNormalizado', () => {
  it('un cumpleaños normal cae en su mismo día', () => {
    expect(aniversarioNormalizado('1990-07-15', 2026)).toBe('2026-07-15')
  })

  it('el 29 de febrero se felicita el 29 en año BISIESTO', () => {
    expect(aniversarioNormalizado('1992-02-29', 2028)).toBe('2028-02-29')
  })

  it('🔴 el 29 de febrero se felicita el 28 en año NO bisiesto', () => {
    // Sin esto, quien nació el 29-feb se queda sin felicitación 3 de cada 4 años.
    expect(aniversarioNormalizado('1992-02-29', 2026)).toBe('2026-02-28')
  })

  it('el 28 de febrero NO se mueve en año bisiesto', () => {
    expect(aniversarioNormalizado('1990-02-28', 2028)).toBe('2028-02-28')
  })

  it('una fecha de nacimiento ilegible no revienta: devuelve null', () => {
    expect(aniversarioNormalizado('no-es-fecha', 2026)).toBeNull()
    expect(aniversarioNormalizado('', 2026)).toBeNull()
  })
})

describe('cumpleanosAFelicitar — qué fecha de cumpleaños toca en la fecha evaluada', () => {
  it('con 7 días de antelación, el 1-jul se felicita a quien cumple el 8-jul', () => {
    expect(cumpleanosAFelicitar('2026-07-01', 7)).toBe('2026-07-08')
  })

  it('con 0 días, se felicita el mismo día del cumpleaños', () => {
    expect(cumpleanosAFelicitar('2026-07-08', 0)).toBe('2026-07-08')
  })

  it('cruza el fin de mes sin equivocarse', () => {
    expect(cumpleanosAFelicitar('2026-06-28', 7)).toBe('2026-07-05')
  })

  it('cruza el fin de AÑO sin equivocarse', () => {
    expect(cumpleanosAFelicitar('2026-12-28', 7)).toBe('2027-01-04')
  })
})

describe('fechasPendientes — el catch-up, y su tolerancia de atraso', () => {
  it('al día: no hay nada que evaluar', () => {
    expect(fechasPendientes({ desde: '2026-07-10', hoy: '2026-07-10', daysBefore: 7 })).toEqual([])
  })

  it('un día de retraso: evalúa ese día', () => {
    expect(fechasPendientes({ desde: '2026-07-09', hoy: '2026-07-10', daysBefore: 7 })).toEqual(['2026-07-10'])
  })

  it('sin cursor previo (primera vez): sólo evalúa HOY, no toda la historia', () => {
    // Encender la automatización no puede disparar felicitaciones retroactivas.
    expect(fechasPendientes({ desde: null, hoy: '2026-07-10', daysBefore: 7 })).toEqual(['2026-07-10'])
  })

  it('varios días caídos: los evalúa en ORDEN', () => {
    expect(fechasPendientes({ desde: '2026-07-07', hoy: '2026-07-10', daysBefore: 7 })).toEqual(['2026-07-08', '2026-07-09', '2026-07-10'])
  })

  it('🔴 una fecha tan vieja que el correo llegaría DESPUÉS del cumpleaños se omite', () => {
    // El 1-jul tocaba felicitar a quien cumple el 8-jul. Si hoy es 10-jul, ese correo
    // llegaría dos días TARDE: no se manda. Las fechas cuyo cumpleaños aún no pasó, sí.
    const fechas = fechasPendientes({ desde: '2026-06-30', hoy: '2026-07-10', daysBefore: 7 })
    expect(fechas).not.toContain('2026-07-01') // cumpleaños 8-jul → ya pasó
    expect(fechas).not.toContain('2026-07-02') // cumpleaños 9-jul → ya pasó
    expect(fechas).toContain('2026-07-03') // cumpleaños 10-jul → es HOY, todavía sirve
    expect(fechas).toContain('2026-07-10') // cumpleaños 17-jul → falta
  })

  it('un reloj que va hacia atrás no produce fechas negativas ni un bucle', () => {
    expect(fechasPendientes({ desde: '2026-07-10', hoy: '2026-07-01', daysBefore: 7 })).toEqual([])
  })

  it('con la antelación normal, la tolerancia YA acota el catch-up a daysBefore+1 fechas', () => {
    const fechas = fechasPendientes({ desde: '2020-01-01', hoy: '2026-07-10', daysBefore: 7 })
    // No es el tope el que actúa aquí: es la regla de arriba. Con 7 días de antelación
    // sólo sobreviven las fechas cuyo cumpleaños es hoy o después — 8 exactamente.
    expect(fechas).toHaveLength(8)
    expect(fechas[0]).toBe('2026-07-03')
    expect(fechas[fechas.length - 1]).toBe('2026-07-10')
  })

  it('🔴 con una antelación GRANDE el tope sí actúa: no se evalúan cientos de días', () => {
    // 🔴 Esta prueba nació rota: con daysBefore 7 el tope nunca se activaba (la tolerancia
    // filtraba antes), así que quitarlo dejaba las pruebas en verde. Con una antelación de
    // un año sobrevivirían 366 fechas a la tolerancia y es el tope lo único que impide que
    // un barrido tras meses apagado encole cientos de días de una sentada.
    const fechas = fechasPendientes({ desde: '2020-01-01', hoy: '2026-07-10', daysBefore: 365 })
    expect(fechas.length).toBeLessThanOrEqual(MAX_FECHAS_POR_BARRIDO)
    // Y lo que evalúe debe ser lo MÁS RECIENTE, que es lo que sigue sirviendo.
    expect(fechas[fechas.length - 1]).toBe('2026-07-10')
  })
})

describe('diasDeNacimientoQueCumplenEl — la inversa, para poder buscarlos en la base', () => {
  it('un día normal corresponde a un solo día de nacimiento', () => {
    expect(diasDeNacimientoQueCumplenEl(2026, 7, 15)).toEqual([15])
  })

  it('🔴 el 28 de febrero de un año NO bisiesto incluye también a los nacidos el 29', () => {
    // Es la misma regla que `aniversarioNormalizado`, vista al revés. Si las dos no
    // coinciden, quien nació un 29-feb no aparece en la búsqueda y se queda sin felicitación.
    expect(diasDeNacimientoQueCumplenEl(2026, 2, 28)).toEqual([28, 29])
  })

  it('el 28 de febrero de un año BISIESTO es sólo el 28: el 29 tiene su propio día', () => {
    expect(diasDeNacimientoQueCumplenEl(2028, 2, 28)).toEqual([28])
  })

  it('el 29 de febrero de un año bisiesto es sólo el 29', () => {
    expect(diasDeNacimientoQueCumplenEl(2028, 2, 29)).toEqual([29])
  })

  it('🔴 la directa y la inversa CONCUERDAN para quien nació un 29-feb', () => {
    // El invariante que de verdad importa: si la directa dice que en 2026 se celebra el 28,
    // la inversa tiene que devolver a esa persona al buscar el 28.
    const celebra = aniversarioNormalizado('1992-02-29', 2026)
    expect(celebra).toBe('2026-02-28')
    expect(diasDeNacimientoQueCumplenEl(2026, 2, 28)).toContain(29)
  })
})
