import { checadaDelTurno, evaluarAvisoEnVivo } from '@/services/dashboard/attendanceLiveAlert'

/**
 * 🔴 CUÁNDO SE AVISA DE UN RETARDO, Y CUÁNDO NO.
 *
 * `evaluateAttendance` contesta "¿llegó tarde?" — necesita la checada, así que sólo sirve DESPUÉS.
 * Esto contesta la pregunta contraria y en vivo: **"¿ya debería haber llegado y no ha llegado?"**.
 * Es la diferencia entre un reporte que abres a las 2 de la tarde y un aviso a las 9:20, cuando
 * todavía puedes llamarle a alguien.
 *
 * Función PURA con el reloj por parámetro (`now`), igual que el evaluador: sin eso no hay forma
 * de probar "20 minutos tarde" sin esperar 20 minutos.
 *
 * 🔴 La trampa de siempre: el cuadrante se escribe en hora del NEGOCIO y las checadas se guardan
 * en UTC. La zona es obligatoria y sin default — olvidarla tiene que romper la llamada, no
 * producir avisos a las 3 de la mañana.
 */
describe('evaluarAvisoEnVivo', () => {
  const base = {
    timezone: 'America/Mexico_City',
    graceMinutes: 10,
    expectedStart: '09:00' as string | null,
    expectedEnd: '17:00' as string | null,
    scheduleDate: '2026-08-28',
    clockInTime: null as Date | null,
  }

  /** Un instante en hora de México, escrito como se lee. */
  const enMexico = (hhmm: string, dia = '2026-08-28') => new Date(`${dia}T${hhmm}:00-06:00`)

  // ── Cuándo SÍ se avisa ─────────────────────────────────────────────────────

  it('avisa cuando ya pasó la hora más la tolerancia y no ha checado', () => {
    const r = evaluarAvisoEnVivo({ ...base, now: enMexico('09:20') })
    expect(r.aviso).toBe('RETARDO')
    expect(r.minutosTarde).toBe(20)
  })

  /**
   * 🔴 Los minutos son los REALES, no los que exceden la tolerancia — misma convención que
   * `evaluateAttendance.lateMinutes`. Si divergieran, el aviso diría "10 min" y el reporte del
   * mismo día "20 min", y nadie sabría cuál creer.
   */
  it('reporta los minutos reales de retraso, no los que exceden la tolerancia', () => {
    expect(evaluarAvisoEnVivo({ ...base, now: enMexico('09:45') }).minutosTarde).toBe(45)
  })

  // ── Cuándo NO se avisa ─────────────────────────────────────────────────────

  it('no avisa dentro de la tolerancia', () => {
    expect(evaluarAvisoEnVivo({ ...base, now: enMexico('09:10') }).aviso).toBe('NINGUNO')
  })

  it('no avisa antes de la hora de entrada', () => {
    expect(evaluarAvisoEnVivo({ ...base, now: enMexico('08:30') }).aviso).toBe('NINGUNO')
  })

  /** Ya llegó: si llegó tarde eso es el reporte. Un aviso a destiempo sólo entrena a ignorarlos. */
  it('no avisa si la persona ya checó', () => {
    const r = evaluarAvisoEnVivo({ ...base, now: enMexico('09:40'), clockInTime: enMexico('09:35') })
    expect(r.aviso).toBe('NINGUNO')
  })

  /**
   * Sin cuadrante NO se juzga — la misma regla que el reporte y las comisiones. Un negocio que
   * todavía no armó horarios no puede recibir un correo por cada empleado cada mañana.
   */
  it('no avisa sin cuadrante', () => {
    const r = evaluarAvisoEnVivo({ ...base, expectedStart: null, expectedEnd: null, now: enMexico('12:00') })
    expect(r.aviso).toBe('NINGUNO')
  })

  it('no avisa en un día de descanso', () => {
    expect(evaluarAvisoEnVivo({ ...base, isDayOff: true, now: enMexico('12:00') }).aviso).toBe('NINGUNO')
  })

  /**
   * 🔴 TOPE: pasada la hora de SALIDA ya no es un retardo, es una falta — y una falta la cuenta
   * el reporte. Sin este tope, abrir el sistema al día siguiente dispararía avisos de ayer, que
   * es exactamente cómo un aviso pierde su credibilidad.
   */
  it('deja de avisar una vez terminado el turno', () => {
    expect(evaluarAvisoEnVivo({ ...base, now: enMexico('17:30') }).aviso).toBe('NINGUNO')
    expect(evaluarAvisoEnVivo({ ...base, now: enMexico('09:00', '2026-08-29') }).aviso).toBe('NINGUNO')
  })

  // ── Vigencia: un aviso caduca ─────────────────────────────────────────────

  /**
   * 🔴 P1 #3 de Codex (29-ago). No había tope más que la hora de salida, así que prender el
   * interruptor a las 16:30 sobre un turno 09:00–17:00 hacía que el siguiente tick avisara por
   * TODOS los ausentes del día. Con 12 personas y 3 responsables: 36 correos de golpe — la forma
   * más rápida de que alguien apague la función para siempre.
   *
   * Pasadas 2 h ya no es un retardo accionable sino una falta, y la falta la cuenta el reporte.
   */
  it('deja de avisar pasadas 2 horas: ya es falta, no retardo', () => {
    // 09:00 + 10 de tolerancia + 120 de vigencia = 11:10 es el último momento con aviso.
    expect(evaluarAvisoEnVivo({ ...base, now: enMexico('11:05') }).aviso).toBe('RETARDO')
    expect(evaluarAvisoEnVivo({ ...base, now: enMexico('11:15') }).aviso).toBe('NINGUNO')
  })

  /** El caso que lo motivó: prender el interruptor a media tarde no puede disparar el día entero. */
  it('prender el aviso a las 16:30 NO dispara el turno completo', () => {
    expect(evaluarAvisoEnVivo({ ...base, now: enMexico('16:30') }).aviso).toBe('NINGUNO')
  })

  // ── Zona horaria: donde esto se rompe en silencio ──────────────────────────

  /**
   * 🔴 El MISMO instante juzgado desde dos zonas tiene que dar resultados distintos, porque
   * "las 9:00" significa cosas distintas. Comparar contra UTC produciría avisos con seis horas
   * de corrimiento — y de madrugada, cuando nadie los mira.
   */
  it('juzga en la zona del NEGOCIO, no en UTC', () => {
    const instante = new Date('2026-08-28T15:20:00Z') // 09:20 en México · 17:20 en Madrid
    expect(evaluarAvisoEnVivo({ ...base, now: instante }).aviso).toBe('RETARDO')

    const madrid = evaluarAvisoEnVivo({ ...base, timezone: 'Europe/Madrid', now: instante })
    expect(madrid.aviso).toBe('NINGUNO') // en Madrid ya terminó el turno de las 09:00-17:00
  })

  // ── Turno nocturno ─────────────────────────────────────────────────────────

  /**
   * 🔴 En un turno 22:00–06:00 la hora esperada se ancla al día del TURNO. Sin eso, a las 00:30
   * del día siguiente se compararía contra las 22:00 de ESE día y saldría "todavía no es hora",
   * callando un retardo de dos horas y media. Es el mismo anclaje que ya usa el evaluador.
   */
  it('ancla el turno nocturno al día del TURNO, no al del reloj', () => {
    const nocturno = { ...base, expectedStart: '22:00', expectedEnd: '06:00', scheduleDate: '2026-08-28' }
    // 🔑 El instante que DISCRIMINA es después de medianoche: a las 00:05 del 29, anclado al día
    // del TURNO (el 28) son 125 min de retraso; anclado al día del RELOJ (el 29) las 22:00 aún no
    // han llegado y saldría "todavía no es hora", callando más de dos horas de retraso.
    // Se mide dentro de la vigencia a propósito: un aviso suprimido devuelve 0 minutos y no
    // permitiría distinguir el anclaje bueno del malo.
    const cruzandoMedianoche = evaluarAvisoEnVivo({ ...nocturno, now: enMexico('00:05', '2026-08-29') })
    expect(cruzandoMedianoche.aviso).toBe('RETARDO')
    expect(cruzandoMedianoche.minutosTarde).toBe(125)
    // Antes de su hora no hay nada que avisar.
    expect(evaluarAvisoEnVivo({ ...nocturno, now: enMexico('21:30') }).aviso).toBe('NINGUNO')
    expect(evaluarAvisoEnVivo({ ...nocturno, now: enMexico('21:30') }).minutosTarde).toBe(0)
  })

  /** Dentro de la vigencia, el nocturno avisa igual que cualquier otro turno. */
  it('el nocturno avisa cuando el retraso es reciente, ya cruzada la medianoche', () => {
    const nocturno = { ...base, expectedStart: '22:00', expectedEnd: '06:00', scheduleDate: '2026-08-28' }
    expect(evaluarAvisoEnVivo({ ...nocturno, now: enMexico('23:45') }).aviso).toBe('RETARDO')
    expect(evaluarAvisoEnVivo({ ...nocturno, now: enMexico('00:05', '2026-08-29') }).aviso).toBe('RETARDO')
  })

  /**
   * 🔴 La vigencia aplica IGUAL al nocturno: a las 05:30 lleva 7.5 h y eso ya es una falta, no un
   * retardo — aunque el turno siga técnicamente vivo hasta las 06:00. La regla es la misma para
   * todos los turnos; si divergiera, el nocturno sería el único que puede avisar de madrugada por
   * algo que pasó antes de la cena.
   */
  it('el nocturno tampoco avisa fuera de la vigencia', () => {
    const nocturno = { ...base, expectedStart: '22:00', expectedEnd: '06:00', scheduleDate: '2026-08-28' }
    expect(evaluarAvisoEnVivo({ ...nocturno, now: enMexico('05:30', '2026-08-29') }).aviso).toBe('NINGUNO')
    expect(evaluarAvisoEnVivo({ ...nocturno, now: enMexico('06:30', '2026-08-29') }).aviso).toBe('NINGUNO')
  })
})

/**
 * 🔴 A QUÉ TURNO PERTENECE UNA CHECADA.
 *
 * P1 #1 de la auditoría de Codex (29-ago), CONFIRMADO reproduciéndolo contra la base: la checada
 * se buscaba por PERSONA y el mismo valor se usaba para juzgar hoy Y ayer. Consecuencia: **la
 * checada de ayer apagaba el aviso de hoy**. Medido — sin checada previa avisaba; con una checada
 * del día anterior el MISMO retardo daba 0 avisos.
 *
 * En un negocio real casi todo el mundo trabajó ayer, así que el aviso no habría servido para
 * prácticamente nadie. Los 19 escenarios del /full-testing no lo vieron porque en todos la persona
 * NO tenía checadas previas: se probó "ya checó hoy", nunca "checó ayer y hoy no".
 *
 * El margen hacia atrás existe para quien llega temprano; hacia adelante el límite es la salida,
 * porque después ya es otro turno.
 */
describe('checadaDelTurno', () => {
  const turnoDiurno = {
    expectedStart: '09:00',
    expectedEnd: '17:00',
    scheduleDate: '2026-08-29',
    timezone: 'America/Mexico_City',
  }
  const enMexico = (iso: string) => new Date(`${iso}-06:00`)

  it('la checada de AYER no cuenta para el turno de HOY', () => {
    expect(checadaDelTurno([enMexico('2026-08-28T09:00:00')], turnoDiurno)).toBeNull()
  })

  it('la checada de hoy dentro del turno sí cuenta', () => {
    const hoy = enMexico('2026-08-29T09:05:00')
    expect(checadaDelTurno([hoy], turnoDiurno)).toEqual(hoy)
  })

  /** Con las dos en la lista, se toma la de hoy — no la primera. */
  it('entre la de ayer y la de hoy, elige la de HOY', () => {
    const hoy = enMexico('2026-08-29T09:40:00')
    expect(checadaDelTurno([enMexico('2026-08-28T09:00:00'), hoy], turnoDiurno)).toEqual(hoy)
  })

  /** Llegar temprano es normal y no puede leerse como no haber llegado. */
  it('llegar temprano cuenta', () => {
    const temprano = enMexico('2026-08-29T07:30:00')
    expect(checadaDelTurno([temprano], turnoDiurno)).toEqual(temprano)
  })

  /** Después de la salida ya es otro turno, no éste. */
  it('una checada posterior a la salida no cuenta para este turno', () => {
    expect(checadaDelTurno([enMexico('2026-08-29T18:00:00')], turnoDiurno)).toBeNull()
  })

  const turnoNocturno = {
    expectedStart: '22:00',
    expectedEnd: '06:00',
    scheduleDate: '2026-08-28',
    timezone: 'America/Mexico_City',
  }

  it('el turno nocturno reclama su propia entrada de la noche', () => {
    const entrada = enMexico('2026-08-28T22:10:00')
    expect(checadaDelTurno([entrada], turnoNocturno)).toEqual(entrada)
  })

  /**
   * 🔴 La entrada de la MAÑANA SIGUIENTE no es del nocturno: pertenece al turno diurno del 29.
   * Sin este tope, el nocturno se daría por cubierto con la llegada de otra persona-turno.
   */
  it('el turno nocturno no se queda con la entrada del día siguiente', () => {
    expect(checadaDelTurno([enMexico('2026-08-29T08:55:00')], turnoNocturno)).toBeNull()
  })

  it('sin checadas devuelve null', () => {
    expect(checadaDelTurno([], turnoDiurno)).toBeNull()
  })
})
