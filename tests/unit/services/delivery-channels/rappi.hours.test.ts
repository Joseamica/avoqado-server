/**
 * Nuestro horario → el de Rappi.
 *
 * Importa más que en Uber: la documentación de Rappi dice que una tienda SIN horario
 * configurado opera 24/7 — el escenario exacto que el horario de delivery existe para evitar.
 */
import {
  aFranjasDeTienda,
  aHorarioRappi,
  aplanarHorarioDeTienda,
  esPracticamente24x7,
  planDeHorario,
  type FranjaActualRappi,
  type FranjaTiendaRappi,
  type OperacionDeHorario,
} from '../../../../src/services/delivery-channels/providers/rappi/rappi.hours'
import type { HorarioSemanal } from '../../../../src/services/delivery-channels/core/deliveryHours.service'

const DIAS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

function horario(over: Partial<HorarioSemanal> = {}): HorarioSemanal {
  const base = {} as HorarioSemanal
  for (const d of DIAS) base[d] = { enabled: true, ranges: [{ open: '09:00', close: '22:00' }] }
  return { ...base, ...over }
}

describe('aHorarioRappi', () => {
  it('agrupa los días con el mismo horario en una sola entrada', () => {
    const r = aHorarioRappi(horario())
    expect(r.schedule_details).toEqual([{ days: 'mon,tue,wed,thu,fri,sat,sun', starts_time: '09:00:00', ends_time: '22:00:00' }])
  })

  it('🔴 añade los SEGUNDOS: Rappi pide HH:mm:ss y mandarlos de menos es un 400', () => {
    expect(aHorarioRappi(horario()).schedule_details[0].starts_time).toBe('09:00:00')
  })

  // ── La única forma de decir "cerrado" en este formato ─────────────────────────────
  // No hay campo `enabled`: un día cerrado simplemente NO aparece. Mandarlo con franja
  // 00:00-00:00 lo dejaría abierto un instante, o lo rechazaría.
  it('🔴 el día cerrado NO aparece — es así como se expresa "cerrado"', () => {
    const r = aHorarioRappi(horario({ sunday: { enabled: false, ranges: [] } }))
    expect(r.schedule_details[0].days).toBe('mon,tue,wed,thu,fri,sat')
    expect(JSON.stringify(r)).not.toMatch(/sun/)
  })

  it('separa los días que tienen horarios distintos', () => {
    const r = aHorarioRappi(horario({ saturday: { enabled: true, ranges: [{ open: '10:00', close: '23:00' }] } }))
    expect(r.schedule_details).toHaveLength(2)
    expect(r.schedule_details.find(d => d.days === 'sat')?.ends_time).toBe('23:00:00')
  })

  it('un día con dos turnos (comida y cena) produce DOS entradas', () => {
    const r = aHorarioRappi(
      horario({
        monday: {
          enabled: true,
          ranges: [
            { open: '13:00', close: '17:00' },
            { open: '19:00', close: '23:00' },
          ],
        },
      }),
    )
    const lunes = r.schedule_details.filter(d => d.days === 'mon')
    expect(lunes).toHaveLength(2)
    expect(lunes.map(f => f.starts_time)).toEqual(['13:00:00', '19:00:00'])
  })

  it('un horario con todo cerrado devuelve la lista vacía, no revienta', () => {
    const cerrado = {} as HorarioSemanal
    for (const d of DIAS) cerrado[d] = { enabled: false, ranges: [] }
    expect(aHorarioRappi(cerrado).schedule_details).toEqual([])
  })
})

describe('aFranjasDeTienda', () => {
  // El horario de TIENDA se manda de una franja a la vez, no en lote: la forma es distinta.
  it('devuelve una llamada por franja, con `day` en singular', () => {
    const f = aFranjasDeTienda(horario({ sunday: { enabled: false, ranges: [] } }))
    expect(f).toHaveLength(6)
    expect(f[0]).toEqual({ day: 'mon', starts_time: '09:00:00', ends_time: '22:00:00' })
  })

  it('los días cerrados tampoco aparecen aquí', () => {
    const f = aFranjasDeTienda(horario({ sunday: { enabled: false, ranges: [] } }))
    expect(f.some(x => x.day === 'sun')).toBe(false)
  })
})

describe('esPracticamente24x7', () => {
  // 🔴 El default de Rappi ES 24/7. Publicar un horario que en la práctica equivale a eso
  // deja al comercio justo donde no queríamos: pedidos de madrugada que nadie cocina.
  it('detecta un horario que en la práctica es 24/7', () => {
    const todoElDia = {} as HorarioSemanal
    for (const d of DIAS) todoElDia[d] = { enabled: true, ranges: [{ open: '00:00', close: '23:59' }] }
    expect(esPracticamente24x7(todoElDia)).toBe(true)
  })

  it('un horario normal NO se marca como 24/7', () => {
    expect(esPracticamente24x7(horario())).toBe(false)
  })

  it('si un solo día está cerrado, ya no es 24/7', () => {
    const casi = {} as HorarioSemanal
    for (const d of DIAS) casi[d] = { enabled: true, ranges: [{ open: '00:00', close: '23:59' }] }
    casi.sunday = { enabled: false, ranges: [] }
    expect(esPracticamente24x7(casi)).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════
//  Horario de la TIENDA por la API de Utils (Tarea 19): lo que Rappi tiene → lo que queremos
// ═════════════════════════════════════════════════════════════════════════════════════════

const ya = (id: number, day: string, starts_time: string, ends_time: string): FranjaActualRappi => ({ id, day, starts_time, ends_time })
const quiero = (day: string, starts_time: string, ends_time: string): FranjaTiendaRappi => ({ day, starts_time, ends_time })

const seEnciman = (a: { starts_time: string; ends_time: string }, b: { starts_time: string; ends_time: string }) =>
  a.starts_time < b.ends_time && b.starts_time < a.ends_time

/**
 * Un Rappi de mentira que aplica el plan paso a paso con SUS reglas: no deja encimar franjas del mismo día (`es__utils.md:969`)
 * y, sin ninguna franja, la tienda abre 24 h (por eso en ningún instante puede quedarse vacía). Devuelve lo que quedó.
 */
function aplicarEnRappi(actuales: FranjaActualRappi[], plan: OperacionDeHorario[], deseadas: FranjaTiendaRappi[]) {
  const tienda = new Map<string, FranjaActualRappi>(actuales.map(f => [String(f.id), { ...f }]))
  const abiertos = new Set(deseadas.map(f => f.day))
  let siguiente = 9_000
  const revisar = (paso: OperacionDeHorario) => {
    const lista = [...tienda.values()]
    for (const a of lista)
      for (const b of lista)
        if (a !== b && a.day === b.day && seEnciman(a, b)) throw new Error(`Rappi rechaza: franjas encimadas tras ${JSON.stringify(paso)}`)
    if (lista.length === 0) throw new Error(`la tienda se quedó SIN franjas (Rappi la abre 24 h) tras ${JSON.stringify(paso)}`)
    // Un día que sigue abierto nunca se queda sin franjas a media publicación.
    for (const dia of abiertos) {
      const teniaAntes = actuales.some(f => f.day === dia)
      if (teniaAntes && !lista.some(f => f.day === dia))
        throw new Error(`el ${dia} (abierto) se quedó sin franjas tras ${JSON.stringify(paso)}`)
    }
  }
  for (const paso of plan) {
    if (paso.tipo === 'BORRAR') {
      if (!tienda.delete(String(paso.id))) throw new Error(`borrar ${paso.id}: no existe`)
    } else if (paso.tipo === 'ACTUALIZAR') {
      const f = tienda.get(String(paso.id))
      if (!f) throw new Error(`actualizar ${paso.id}: no existe`)
      tienda.set(String(paso.id), { ...f, starts_time: paso.franja.starts_time, ends_time: paso.franja.ends_time })
    } else {
      tienda.set(String(siguiente), { id: siguiente++, ...paso.franja })
    }
    revisar(paso)
  }
  return [...tienda.values()]
}

const comoTexto = (fs: Array<{ day: string; starts_time: string; ends_time: string }>) =>
  fs.map(f => `${f.day} ${f.starts_time}-${f.ends_time}`).sort()

describe('planDeHorario — de lo que Rappi tiene a lo que queremos, sin encimar ni dejar la tienda vacía', () => {
  it('🔴 tienda sin horario hoy (lo que mide el sandbox) ⇒ el plan sólo CREA', () => {
    const deseadas = aFranjasDeTienda(horario({ sunday: { enabled: false, ranges: [] } }))

    const plan = planDeHorario([], deseadas)

    expect(plan.every(p => p.tipo === 'CREAR')).toBe(true)
    expect(plan.map(p => (p.tipo === 'CREAR' ? p.franja.day : '?'))).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat'])
    expect(plan[0]).toEqual({ tipo: 'CREAR', franja: { day: 'mon', starts_time: '09:00:00', ends_time: '22:00:00' } })
  })

  it('🔴 cambiar 09–18 a 09–19 ACTUALIZA la franja (crearla primero la encimaría y Rappi la rechaza)', () => {
    const plan = planDeHorario([ya(11, 'mon', '09:00:00', '18:00:00')], [quiero('mon', '09:00:00', '19:00:00')])

    expect(plan).toEqual([{ tipo: 'ACTUALIZAR', id: 11, franja: { day: 'mon', starts_time: '09:00:00', ends_time: '19:00:00' } }])
  })

  it('un día que pasa de dos turnos a uno borra uno y actualiza el otro (primero el borrado)', () => {
    const plan = planDeHorario(
      [ya(1, 'mon', '13:00:00', '17:00:00'), ya(2, 'mon', '19:00:00', '23:00:00')],
      [quiero('mon', '12:00:00', '22:00:00')],
    )

    expect(plan).toEqual([
      { tipo: 'BORRAR', id: 2, day: 'mon' },
      { tipo: 'ACTUALIZAR', id: 1, franja: { day: 'mon', starts_time: '12:00:00', ends_time: '22:00:00' } },
    ])
  })

  it('un día que cierra va al final (los que siguen abiertos primero)', () => {
    const plan = planDeHorario(
      [ya(1, 'mon', '09:00:00', '22:00:00'), ya(7, 'sun', '10:00:00', '18:00:00')],
      [quiero('mon', '09:00:00', '23:00:00'), quiero('tue', '09:00:00', '22:00:00')],
    )

    expect(plan).toEqual([
      { tipo: 'ACTUALIZAR', id: 1, franja: { day: 'mon', starts_time: '09:00:00', ends_time: '23:00:00' } },
      { tipo: 'CREAR', franja: { day: 'tue', starts_time: '09:00:00', ends_time: '22:00:00' } },
      { tipo: 'BORRAR', id: 7, day: 'sun' },
    ])
  })

  it('🔴 un día igual no se toca, y se compara NORMALIZADO ("09:00" = "09:00:00"; si no, cada pasada republicaría)', () => {
    const plan = planDeHorario(
      [ya(1, 'mon', '19:00', '23:00:00'), ya(2, 'mon', '9:00', '14:00')],
      [quiero('mon', '09:00:00', '14:00:00'), quiero('mon', '19:00:00', '23:00:00')],
    )

    expect(plan).toEqual([])
  })

  it('🔴 ids repetidos en lo que Rappi tiene ⇒ lanza (si no, `[lunes id 1, lunes id 1]` con lunes 09–18 borraría la única franja real)', () => {
    expect(() =>
      planDeHorario([ya(1, 'mon', '09:00:00', '18:00:00'), ya(1, 'mon', '09:00:00', '18:00:00')], [quiero('mon', '09:00:00', '18:00:00')]),
    ).toThrow(/repetid/)
  })

  it('la franja que ya coincide se queda: sólo se toca la otra', () => {
    const plan = planDeHorario(
      [ya(1, 'mon', '09:00:00', '14:00:00'), ya(2, 'mon', '16:00:00', '22:00:00')],
      [quiero('mon', '09:00:00', '14:00:00'), quiero('mon', '16:00:00', '23:00:00')],
    )

    expect(plan).toEqual([{ tipo: 'ACTUALIZAR', id: 2, franja: { day: 'mon', starts_time: '16:00:00', ends_time: '23:00:00' } }])
  })

  // 🔴 Ronda 1: turnos del dueño que se enciman o se tocan NO son un FAILED: se fusionan antes de planear. Así tampoco
  // importa si Rappi cuenta como encimadas dos franjas que sólo se tocan (no está medido).
  it.each([
    ['se enciman (09–14 + 13–18)', [quiero('mon', '09:00:00', '14:00:00'), quiero('mon', '13:00:00', '18:00:00')]],
    ['sólo se tocan (09–14 + 14–18)', [quiero('mon', '14:00:00', '18:00:00'), quiero('mon', '09:00:00', '14:00:00')]],
  ])('🔴 franjas deseadas del mismo día que %s se FUSIONAN en 09–18 antes de planear', (_caso, deseadas) => {
    expect(planDeHorario([], deseadas)).toEqual([{ tipo: 'CREAR', franja: { day: 'mon', starts_time: '09:00:00', ends_time: '18:00:00' } }])
    // Y si Rappi ya tiene 09–18, no hay nada que hacer.
    expect(planDeHorario([ya(5, 'mon', '09:00:00', '18:00:00')], deseadas)).toEqual([])
  })

  it('la fusión es por día y deja aparte lo que no se toca (09–12 + 11–14 + 16–20 ⇒ 09–14 y 16–20)', () => {
    const plan = planDeHorario(
      [],
      [
        quiero('tue', '16:00:00', '20:00:00'),
        quiero('tue', '11:00:00', '14:00:00'),
        quiero('tue', '09:00:00', '12:00:00'),
        quiero('wed', '12:00:00', '13:00:00'),
      ],
    )

    expect(plan).toEqual([
      { tipo: 'CREAR', franja: { day: 'tue', starts_time: '09:00:00', ends_time: '14:00:00' } },
      { tipo: 'CREAR', franja: { day: 'tue', starts_time: '16:00:00', ends_time: '20:00:00' } },
      { tipo: 'CREAR', franja: { day: 'wed', starts_time: '12:00:00', ends_time: '13:00:00' } },
    ])
  })

  // El plan, aplicado por un Rappi que hace cumplir sus reglas: nunca encima, nunca deja la tienda (ni un día abierto) sin
  // franjas a media publicación, y termina exactamente en lo deseado.
  it.each([
    ['sin horario → semana normal', [], aFranjasDeTienda(horario({ sunday: { enabled: false, ranges: [] } }))],
    [
      'dos turnos → uno, un día que abre y otro que cierra',
      [ya(1, 'mon', '13:00:00', '17:00:00'), ya(2, 'mon', '19:00:00', '23:00:00'), ya(3, 'sun', '10:00:00', '18:00:00')],
      [quiero('mon', '12:00:00', '22:00:00'), quiero('tue', '09:00:00', '22:00:00')],
    ],
    [
      'uno → dos turnos que se cruzan con el viejo',
      [ya(1, 'fri', '09:00:00', '22:00:00')],
      [quiero('fri', '08:00:00', '12:00:00'), quiero('fri', '13:00:00', '23:00:00')],
    ],
    [
      'tres turnos → otros tres, todos distintos',
      [ya(1, 'sat', '07:00:00', '09:00:00'), ya(2, 'sat', '10:00:00', '12:00:00'), ya(3, 'sat', '13:00:00', '15:00:00')],
      [quiero('sat', '08:00:00', '10:30:00'), quiero('sat', '11:00:00', '16:00:00'), quiero('sat', '18:00:00', '23:00:00')],
    ],
    [
      'sólo queda abierto un día que hoy no tiene franjas',
      [ya(1, 'mon', '09:00:00', '22:00:00'), ya(2, 'tue', '09:00:00', '22:00:00')],
      [quiero('wed', '10:00:00', '20:00:00')],
    ],
  ])('aplicado paso a paso por Rappi: %s', (_caso, actuales, deseadas) => {
    const plan = planDeHorario(actuales, deseadas)

    const final = aplicarEnRappi(actuales, plan, deseadas)

    expect(comoTexto(final)).toEqual(comoTexto(deseadas))
    // Lo que cierra va al final: después del primer borrado de un día que cierra ya no hay nada de los días abiertos.
    const abiertos = new Set(deseadas.map(f => f.day))
    const primerCierre = plan.findIndex(p => p.tipo === 'BORRAR' && !abiertos.has(p.day))
    if (primerCierre >= 0) expect(plan.slice(primerCierre).every(p => p.tipo === 'BORRAR' && !abiertos.has(p.day))).toBe(true)
  })
})

describe('aplanarHorarioDeTienda — la lectura de Rappi a la forma del plan', () => {
  /** El ejemplo de la doc (`fuentes/es__utils.md:1015-1050`): anidado y en camelCase. */
  const DOC = JSON.stringify({
    storeScheduleDays: [
      { day: 'mon', storeSchedules: [{ id: 1171828, startsTime: '07:00:00', endsTime: '09:00:00' }] },
      { day: 'tue', storeSchedules: [{ id: 21126084, startsTime: '00:00:00', endsTime: '05:00:00' }] },
      { day: 'sun', storeSchedules: [{ id: 1171833, startsTime: '00:00:00', endsTime: '13:00:00' }] },
    ],
  })

  it('🔴 la respuesta anidada en camelCase se aplana a { id, day, starts_time, ends_time }', () => {
    expect(aplanarHorarioDeTienda(DOC)).toEqual([
      { id: 1171828, day: 'mon', starts_time: '07:00:00', ends_time: '09:00:00' },
      { id: 21126084, day: 'tue', starts_time: '00:00:00', ends_time: '05:00:00' },
      { id: 1171833, day: 'sun', starts_time: '00:00:00', ends_time: '13:00:00' },
    ])
  })

  it('también acepta snake_case en cada campo (como contesta el POST) y normaliza la hora a HH:MM:SS', () => {
    const r = aplanarHorarioDeTienda(
      JSON.stringify({
        store_schedule_days: [
          { day: 'MON ', store_schedules: [{ id: '55', starts_time: '8:00', ends_time: '09:30' }] },
          { day: 'wed', storeSchedules: [{ id: 56, starts_time: '10:00:00', endsTime: '11:00:00' }] },
        ],
      }),
    )

    expect(r).toEqual([
      { id: '55', day: 'mon', starts_time: '08:00:00', ends_time: '09:30:00' },
      { id: 56, day: 'wed', starts_time: '10:00:00', ends_time: '11:00:00' },
    ])
  })

  it('«24:00:00» (fin del día, si viene del portal de Rappi) se entiende y el plan lo cambia por lo nuestro', () => {
    const franjas = aplanarHorarioDeTienda(
      '{"storeScheduleDays":[{"day":"fri","storeSchedules":[{"id":3,"startsTime":"18:00:00","endsTime":"24:00:00"}]}]}',
    )

    expect(franjas).toEqual([{ id: 3, day: 'fri', starts_time: '18:00:00', ends_time: '24:00:00' }])
    expect(planDeHorario(franjas, [quiero('fri', '18:00:00', '23:59:00')])).toEqual([
      { tipo: 'ACTUALIZAR', id: 3, franja: { day: 'fri', starts_time: '18:00:00', ends_time: '23:59:00' } },
    ])
  })

  it('la tienda sin horario (lo medido en el sandbox: `{"storeScheduleDays":[]}`) ⇒ lista vacía', () => {
    expect(aplanarHorarioDeTienda('{"storeScheduleDays":[]}')).toEqual([])
    expect(aplanarHorarioDeTienda('{"storeScheduleDays":[{"day":"mon","storeSchedules":[]}]}')).toEqual([])
  })

  // 🔴 «No entendí» NUNCA es «no hay franjas»: con eso el plan crearía encima de lo que sí existe (Rappi lo rechazaría, o
  // peor, quedarían franjas viejas y nuevas mezcladas).
  it.each([
    ['no es JSON', '<html>Bad Gateway</html>'],
    ['vacío', ''],
    ['sin la lista de días', '{}'],
    ['la lista no es lista', '{"storeScheduleDays":null}'],
    ['otra forma (lista plana)', '[{"id":1,"day":"mon","starts_time":"09:00:00","ends_time":"18:00:00"}]'],
    ['un día sin sus franjas', '{"storeScheduleDays":[{"day":"mon"}]}'],
    ['un día que no es de la semana', '{"storeScheduleDays":[{"day":"monday","storeSchedules":[]}]}'],
    ['una franja sin id', '{"storeScheduleDays":[{"day":"mon","storeSchedules":[{"startsTime":"09:00:00","endsTime":"18:00:00"}]}]}'],
    ['una hora ilegible', '{"storeScheduleDays":[{"day":"mon","storeSchedules":[{"id":1,"startsTime":"9 am","endsTime":"18:00:00"}]}]}'],
    [
      'un id repetido (ronda 2)',
      '{"storeScheduleDays":[{"day":"mon","storeSchedules":[{"id":1,"startsTime":"09:00:00","endsTime":"18:00:00"},{"id":1,"startsTime":"09:00:00","endsTime":"18:00:00"}]}]}',
    ],
    [
      'un id repetido en dos días',
      '{"storeScheduleDays":[{"day":"mon","storeSchedules":[{"id":7,"startsTime":"09:00:00","endsTime":"18:00:00"}]},{"day":"tue","storeSchedules":[{"id":"7","startsTime":"09:00:00","endsTime":"18:00:00"}]}]}',
    ],
    [
      'una hora fuera de rango',
      '{"storeScheduleDays":[{"day":"mon","storeSchedules":[{"id":1,"startsTime":"25:00:00","endsTime":"26:00:00"}]}]}',
    ],
  ])('🔴 un cuerpo que no se entiende LANZA (%s), nunca «no hay franjas»', (_caso, cuerpo) => {
    expect(() => aplanarHorarioDeTienda(cuerpo)).toThrow(/horario de la tienda/)
  })
})
