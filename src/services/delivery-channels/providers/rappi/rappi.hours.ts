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
 *   · Tienda (horario regular) → UNA franja por llamada: `{ day, starts_time, ends_time }`
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
