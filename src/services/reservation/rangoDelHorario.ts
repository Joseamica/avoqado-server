/**
 * Las fechas del horario público de clases (`GET /public/venues/:venueSlug/availability?type=class&dateFrom&dateTo`), leídas en UN
 * solo lugar. Lo usan el horario y «mis reservas de clase» (`GET /public/venues/:venueSlug/customer/class-reservations`) con las
 * MISMAS `dateFrom`/`dateTo` que manda el widget: una clase que sale en el horario sale también en la otra consulta.
 *
 * 🔴 Los límites del día se leen en la zona del PROCESO (`new Date('AAAA-MM-DDT00:00:00')`), como el horario desde siempre; en
 * producción es UTC. Pasarlos a la zona del negocio es deuda aparte: aquí sólo se comparte, sin cambiar lo que contesta el horario.
 * Función pura, sin base ni red; cada ruta pone sus propios mensajes de error.
 */
export const DIAS_POR_OMISION = 30
/** El horario recorta a `dateFrom + 60 días`; «mis reservas de clase» contesta 400 si se pide más. */
export const DIAS_TOPE = 60

const FECHA = /^\d{4}-\d{2}-\d{2}$/

export type MotivoDeRangoInvalido = 'FORMATO_DESDE' | 'FECHA_DESDE' | 'FORMATO_HASTA' | 'FECHA_HASTA' | 'HASTA_ANTES_DE_DESDE'

export type RangoDelHorario =
  | {
      ok: true
      /** Medianoche de `dateFrom` (zona del proceso). */
      desde: Date
      /** El último milisegundo de `dateTo` ya recortado (zona del proceso). */
      hasta: Date
      /** `dateTo` ya recortado, `AAAA-MM-DD` (el horario lo devuelve tal cual). */
      dateTo: string
      /** Se pidió más que `dateFrom + 60 días` y se recortó. */
      pasaDelTope: boolean
    }
  | { ok: false; motivo: MotivoDeRangoInvalido }

export function leerRangoDelHorario(dateFrom: string, dateTo?: string): RangoDelHorario {
  if (!FECHA.test(dateFrom)) return { ok: false, motivo: 'FORMATO_DESDE' }
  const fromDate = new Date(`${dateFrom}T00:00:00Z`)
  if (Number.isNaN(fromDate.getTime())) return { ok: false, motivo: 'FECHA_DESDE' }

  let toDate: Date
  if (dateTo) {
    if (!FECHA.test(dateTo)) return { ok: false, motivo: 'FORMATO_HASTA' }
    toDate = new Date(`${dateTo}T00:00:00Z`)
    if (Number.isNaN(toDate.getTime())) return { ok: false, motivo: 'FECHA_HASTA' }
  } else {
    toDate = new Date(fromDate)
    toDate.setUTCDate(toDate.getUTCDate() + DIAS_POR_OMISION)
  }

  const maxTo = new Date(fromDate)
  maxTo.setUTCDate(maxTo.getUTCDate() + DIAS_TOPE)
  const pasaDelTope = toDate.getTime() > maxTo.getTime()
  if (pasaDelTope) toDate = maxTo
  if (toDate.getTime() < fromDate.getTime()) return { ok: false, motivo: 'HASTA_ANTES_DE_DESDE' }

  const ultimoDia = toDate.toISOString().slice(0, 10)
  return {
    ok: true,
    desde: new Date(`${dateFrom}T00:00:00`),
    hasta: new Date(`${ultimoDia}T23:59:59.999`),
    dateTo: ultimoDia,
    pasaDelTope,
  }
}
