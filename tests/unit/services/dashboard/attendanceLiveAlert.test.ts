import { evaluarAvisoEnVivo } from '@/services/dashboard/attendanceLiveAlert'

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
    expect(evaluarAvisoEnVivo({ ...nocturno, now: enMexico('00:30', '2026-08-29') }).aviso).toBe('RETARDO')
    expect(evaluarAvisoEnVivo({ ...nocturno, now: enMexico('21:30') }).aviso).toBe('NINGUNO')
  })

  it('un turno nocturno sigue vivo hasta su salida de madrugada', () => {
    const nocturno = { ...base, expectedStart: '22:00', expectedEnd: '06:00', scheduleDate: '2026-08-28' }
    expect(evaluarAvisoEnVivo({ ...nocturno, now: enMexico('05:30', '2026-08-29') }).aviso).toBe('RETARDO')
    expect(evaluarAvisoEnVivo({ ...nocturno, now: enMexico('06:30', '2026-08-29') }).aviso).toBe('NINGUNO')
  })
})
