/**
 * Nuestro horario semanal → el de la API de Utils de Rappi.
 *
 * 🔴 POR QUÉ IMPORTA MÁS QUE EN UBER: su documentación dice que **una tienda sin horario
 * configurado opera 24/7**. O sea que el default de Rappi es exactamente el escenario que
 * `deliveryHours.service.ts` existe para evitar — pedidos a las 3 de la mañana que nadie va a
 * cocinar, y cada rechazo contando contra la tasa de éxito del 98% que exigen.
 *
 * Formato de Rappi: días abreviados en inglés separados por coma (`mon,tue,…`, más `hol` para
 * feriados) y horas en `HH:mm:ss` de 24 horas. Se pueden mandar varias franjas por día
 * mientras no se traslapen.
 *
 * Hay dos formas distintas y no son intercambiables:
 *   · Pasillos y productos → `{ schedule_details: [{ days, starts_time, ends_time }] }`
 *   · Tienda (horario regular) → UNA franja por llamada: `{ day, starts_time, ends_time }`. Se publica por DIFERENCIA
 *     contra lo que Rappi ya tiene (`aplanarHorarioDeTienda` + `planDeHorario`, Tarea 19), porque no deja encimar franjas.
 */
import type { DiaHorario, HorarioSemanal } from '../../core/deliveryHours.service'

/** Nuestro día → el de Rappi. El orden importa: Rappi los lee como lista. */
const DIA_RAPPI: Record<keyof HorarioSemanal, string> = {
  monday: 'mon',
  tuesday: 'tue',
  wednesday: 'wed',
  thursday: 'thu',
  friday: 'fri',
  saturday: 'sat',
  sunday: 'sun',
}

const DIAS = Object.keys(DIA_RAPPI) as Array<keyof HorarioSemanal>

export interface FranjaRappi {
  days: string
  starts_time: string
  ends_time: string
}

export interface FranjaTiendaRappi {
  day: string
  starts_time: string
  ends_time: string
}

/** "HH:MM" → "HH:MM:SS". Rappi pide segundos; mandarlos de menos es un 400. */
function conSegundos(hhmm: string): string {
  return /^\d{2}:\d{2}$/.test(hhmm) ? `${hhmm}:00` : hhmm
}

/** Huella de un día, para agrupar los que tienen exactamente el mismo horario. */
function huella(dia: DiaHorario): string {
  if (!dia.enabled || dia.ranges.length === 0) return 'CERRADO'
  return dia.ranges.map(r => `${conSegundos(r.open)}-${conSegundos(r.close)}`).join('|')
}

/**
 * El horario de un PASILLO o un PRODUCTO (`{ schedule_details: [...] }`).
 *
 * Los días con el mismo horario se agrupan en una sola entrada (`"mon,tue,wed"`), que es como
 * Rappi los muestra en sus ejemplos. No es cosmética: menos entradas es menos superficie donde
 * un traslape accidental provoque un rechazo.
 *
 * 🔴 Los días CERRADOS simplemente no aparecen. Es la única forma de decir "cerrado" en este
 * formato — no hay un campo `enabled`. Mandar un día con franja `00:00:00`-`00:00:00` lo
 * dejaría abierto un instante, o lo rechazaría.
 */
export function aHorarioRappi(horario: HorarioSemanal): { schedule_details: FranjaRappi[] } {
  // Agrupar por huella conservando el orden de la semana.
  const grupos = new Map<string, Array<keyof HorarioSemanal>>()
  for (const dia of DIAS) {
    const h = huella(horario[dia])
    if (h === 'CERRADO') continue
    const lista = grupos.get(h) ?? []
    lista.push(dia)
    grupos.set(h, lista)
  }

  const detalles: FranjaRappi[] = []
  for (const [h, dias] of grupos) {
    const etiqueta = dias.map(d => DIA_RAPPI[d]).join(',')
    // Una entrada por FRANJA: un día con dos turnos (comida y cena) produce dos.
    for (const franja of h.split('|')) {
      const [inicio, fin] = franja.split('-')
      detalles.push({ days: etiqueta, starts_time: inicio, ends_time: fin })
    }
  }

  return { schedule_details: detalles }
}

/**
 * El horario regular de la TIENDA. Rappi lo recibe de UNA franja a la vez
 * (`POST /store/schedule/{storeId}` con `{ day, starts_time, ends_time }`), así que esto
 * devuelve la lista de llamadas a hacer, no un solo cuerpo.
 *
 * Los días cerrados no aparecen, igual que arriba.
 */
export function aFranjasDeTienda(horario: HorarioSemanal): FranjaTiendaRappi[] {
  const salida: FranjaTiendaRappi[] = []
  for (const dia of DIAS) {
    const d = horario[dia]
    if (!d.enabled) continue
    for (const r of d.ranges) {
      salida.push({ day: DIA_RAPPI[dia], starts_time: conSegundos(r.open), ends_time: conSegundos(r.close) })
    }
  }
  return salida
}

// ─────────────────────────────────────────────────────────────────────────────────────────
//  Horario de la TIENDA por la API de Utils (Tarea 19): diferencia contra lo que Rappi ya tiene
// ─────────────────────────────────────────────────────────────────────────────────────────

/** Una franja que Rappi YA tiene (su `GET /store/schedule/{storeId}`, aplanado por `aplanarHorarioDeTienda`). */
export interface FranjaActualRappi {
  id: number | string
  day: string
  starts_time: string
  ends_time: string
}

/** Un paso del plan. `day` en el borrado es para el log y el orden; Rappi sólo necesita el id. */
export type OperacionDeHorario =
  | { tipo: 'BORRAR'; id: number | string; day: string }
  | { tipo: 'ACTUALIZAR'; id: number | string; franja: FranjaTiendaRappi }
  | { tipo: 'CREAR'; franja: FranjaTiendaRappi }

/** Los días de Rappi en el orden de la semana (`mon` … `sun`). */
export const DIAS_RAPPI: readonly string[] = DIAS.map(d => DIA_RAPPI[d])

/**
 * La hora como la escribe Rappi, `HH:MM:SS`, o `null` si no es una hora. 🔴 Es EL lugar donde se normaliza: la lectura y el
 * plan comparan siempre esto. Sin normalizar, «09:00» ≠ «09:00:00» y cada pasada republicaría un horario que ya está igual.
 */
export function horaRappi(h: unknown): string | null {
  const m = typeof h === 'string' ? /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(h.trim()) : null
  if (!m) return null
  const [hh, mm, ss] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)]
  // `24:00:00` (fin del día) se entiende: una franja así puesta desde el portal de Rappi no debe trabar la lectura para siempre.
  // Nuestro horario nunca lo produce (llega a 23:59), así que esa franja sólo se compara, se actualiza o se borra.
  if (hh === 24 && mm === 0 && ss === 0) return '24:00:00'
  if (hh > 23 || mm > 59 || ss > 59) return null
  return [hh, mm, ss].map(n => String(n).padStart(2, '0')).join(':')
}

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** El campo en camelCase o en snake_case: Rappi contesta el GET en camelCase y el POST en snake_case. */
const campo = (o: Record<string, unknown>, camel: string, snake: string): unknown => o[camel] ?? o[snake]

/**
 * La lectura de Rappi (`{ storeScheduleDays: [{ day, storeSchedules: [{ id, startsTime, endsTime }] }] }`, medida en DEV y en
 * `fuentes/es__utils.md:1015-1050`) → la lista plana que usa `planDeHorario`, con las horas ya normalizadas.
 *
 * 🔴 Un cuerpo que no se entiende LANZA. NUNCA se lee como «no hay franjas»: con eso el plan crearía encima de lo que Rappi sí
 * tiene (y lo rechazaría a media publicación) o dejaría franjas viejas mezcladas con las nuevas. Cada campo se acepta en las
 * dos grafías; un día fuera de `mon…sun`, una franja sin id, un id repetido o una hora ilegible también lanzan.
 */
export function aplanarHorarioDeTienda(raw: string): FranjaActualRappi[] {
  const ilegible = (porque: string): never => {
    throw new Error(`[Rappi] el horario de la tienda no se entiende (${porque}): ${String(raw).slice(0, 200)}`)
  }
  let cuerpo: unknown
  try {
    cuerpo = JSON.parse(raw)
  } catch {
    return ilegible('no es JSON')
  }
  if (!esObjeto(cuerpo)) return ilegible('no es un objeto')
  const dias = campo(cuerpo, 'storeScheduleDays', 'store_schedule_days')
  if (!Array.isArray(dias)) return ilegible('falta storeScheduleDays')

  const salida: FranjaActualRappi[] = []
  const vistos = new Set<string>()
  for (const d of dias) {
    if (!esObjeto(d)) return ilegible('un día no es un objeto')
    const day = typeof d.day === 'string' ? d.day.trim().toLowerCase() : ''
    if (!DIAS_RAPPI.includes(day)) return ilegible(`día desconocido ${JSON.stringify(d.day)}`)
    const franjas = campo(d, 'storeSchedules', 'store_schedules')
    if (!Array.isArray(franjas)) return ilegible(`el ${day} no trae storeSchedules`)
    for (const f of franjas) {
      if (!esObjeto(f)) return ilegible(`una franja del ${day} no es un objeto`)
      const id = f.id
      if ((typeof id !== 'number' || !Number.isFinite(id)) && (typeof id !== 'string' || id.trim() === '')) {
        return ilegible(`una franja del ${day} no trae id`)
      }
      // 🔴 Un id repetido no es un horario que se entienda: con `[lunes id 1, lunes id 1]` y lunes 09–18 deseado, el plan
      // borraría la «sobrante» id 1, que es la única franja real.
      if (vistos.has(String(id))) return ilegible(`el id ${id} viene repetido`)
      vistos.add(String(id))
      const starts_time = horaRappi(campo(f, 'startsTime', 'starts_time'))
      const ends_time = horaRappi(campo(f, 'endsTime', 'ends_time'))
      if (!starts_time || !ends_time) return ilegible(`hora ilegible en la franja ${id}`)
      salida.push({ id, day, starts_time, ends_time })
    }
  }
  return salida
}

const aFranja = (f: FranjaTiendaRappi): FranjaTiendaRappi => ({ day: f.day, starts_time: f.starts_time, ends_time: f.ends_time })
const llaveDeFranja = (f: { starts_time: string; ends_time: string }) => `${f.starts_time}-${f.ends_time}`
const porInicio = <T extends { starts_time: string }>(a: T, b: T) =>
  a.starts_time < b.starts_time ? -1 : a.starts_time > b.starts_time ? 1 : 0

/** Por día y en orden, las franjas que se enciman o se tocan quedan en una sola (las horas ya vienen normalizadas). */
function fusionarPorDia(franjas: FranjaTiendaRappi[]): FranjaTiendaRappi[] {
  const salida: FranjaTiendaRappi[] = []
  for (const dia of DIAS_RAPPI) {
    for (const f of franjas.filter(x => x.day === dia).sort(porInicio)) {
      const ultima = salida[salida.length - 1]
      if (ultima && ultima.day === dia && f.starts_time <= ultima.ends_time) {
        if (f.ends_time > ultima.ends_time) ultima.ends_time = f.ends_time
      } else {
        salida.push({ day: f.day, starts_time: f.starts_time, ends_time: f.ends_time })
      }
    }
  }
  return salida
}

/**
 * Qué hay que hacer en Rappi para pasar de `actuales` (lo que tiene) a `deseadas` (lo nuestro), en el ORDEN en que se debe
 * ejecutar. Rappi no deja encimar franjas del mismo día (`fuentes/es__utils.md:969`; Codex plan r1 #6) y una tienda sin
 * NINGUNA franja la toma como abierta 24 h, así que, por día:
 *   · si ya está igual (comparado normalizado y sin importar el orden), no se toca;
 *   · las franjas que ya coinciden con una deseada se quedan;
 *   · de las que no coinciden se borran todas menos UNA, ésa se ACTUALIZA a la primera deseada que falta y las demás deseadas
 *     se CREAN. Borrar → actualizar → crear: en cada paso lo que queda en el día son franjas deseadas (que no se enciman entre
 *     sí) más, a lo mucho, la vieja que todavía no se actualiza; y un día que sigue abierto nunca se queda sin franjas;
 *   · los días que siguen abiertos van primero y al final los que cierran (sólo borrados). Así, si algo falla a la mitad y el
 *     plan se detiene, a la tienda nunca se le quitaron franjas que no fueran a quedar cubiertas.
 *
 * 🔴 Antes de planear, las deseadas del mismo día que se enciman o se TOCAN se FUSIONAN (09–14 + 13–18 ⇒ 09–18; 09–14 + 14–18 ⇒
 * 09–18): Rappi rechazaría las encimadas a media publicación, y fusionar también las que sólo se tocan hace que no importe si
 * Rappi las cuenta como encimadas (no está medido). El núcleo ya las manda fusionadas; esto es por si otro llamador no.
 */
export function planDeHorario(actuales: FranjaActualRappi[], deseadas: FranjaTiendaRappi[]): OperacionDeHorario[] {
  const normalizar = <T extends { day: string; starts_time: string; ends_time: string }>(f: T): T => ({
    ...f,
    day: f.day.trim().toLowerCase(),
    starts_time: horaRappi(f.starts_time) ?? f.starts_time,
    ends_time: horaRappi(f.ends_time) ?? f.ends_time,
  })
  const ya = actuales.map(normalizar)
  // Defensa: lo que Rappi tiene viene de `aplanarHorarioDeTienda`, que ya rechaza ids repetidos; si otro llamador los trae, borrar
  // «la sobrante» podría borrar la única franja real.
  if (new Set(ya.map(f => String(f.id))).size !== ya.length) throw new Error('[Rappi] el horario de la tienda trae ids repetidos')
  const quiero = fusionarPorDia(deseadas.map(normalizar))

  const abiertos: OperacionDeHorario[] = []
  const cierran: OperacionDeHorario[] = []
  for (const dia of DIAS_RAPPI) {
    const tiene = ya.filter(f => f.day === dia).sort(porInicio)
    const falta = quiero.filter(f => f.day === dia).sort(porInicio)

    // Lo que ya coincide se queda (una franja de Rappi por cada deseada igual).
    const sobran: FranjaActualRappi[] = []
    for (const f of tiene) {
      const i = falta.findIndex(d => llaveDeFranja(d) === llaveDeFranja(f))
      if (i >= 0) falta.splice(i, 1)
      else sobran.push(f)
    }
    if (sobran.length === 0 && falta.length === 0) continue

    // El día cierra: sólo borrados, y al final del plan.
    if (quiero.every(f => f.day !== dia)) {
      for (const f of sobran) cierran.push({ tipo: 'BORRAR', id: f.id, day: dia })
      continue
    }

    // Todas las deseadas ya están: sólo sobran franjas viejas (el día conserva las que coinciden, que no son cero).
    if (falta.length === 0) {
      for (const f of sobran) abiertos.push({ tipo: 'BORRAR', id: f.id, day: dia })
      continue
    }

    // Una vieja se conserva para ACTUALIZARLA (el día no se queda sin franjas); las otras viejas se borran ANTES.
    const [conservada, ...otras] = sobran
    for (const f of otras) abiertos.push({ tipo: 'BORRAR', id: f.id, day: dia })
    const [primera, ...demas] = falta
    if (conservada) abiertos.push({ tipo: 'ACTUALIZAR', id: conservada.id, franja: aFranja(primera) })
    else abiertos.push({ tipo: 'CREAR', franja: aFranja(primera) })
    for (const f of demas) abiertos.push({ tipo: 'CREAR', franja: aFranja(f) })
  }
  return [...abiertos, ...cierran]
}

/**
 * ¿Este horario dejaría la tienda abierta las 24 horas?
 *
 * 🔴 Existe porque el default de Rappi ES 24/7, y publicar un horario que en la práctica
 * equivale a eso deja al comercio exactamente donde no queríamos. Quien publique debe poder
 * avisar antes, no descubrirlo cuando entre un pedido de madrugada.
 */
export function esPracticamente24x7(horario: HorarioSemanal): boolean {
  return DIAS.every(dia => {
    const d = horario[dia]
    if (!d.enabled || d.ranges.length === 0) return false
    return d.ranges.some(
      r => conSegundos(r.open) === '00:00:00' && (r.close === '23:59' || r.close === '24:00' || conSegundos(r.close) === '23:59:59'),
    )
  })
}
