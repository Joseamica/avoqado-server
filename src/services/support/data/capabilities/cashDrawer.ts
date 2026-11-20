import { cashDrawerIndexesReady, readCashDrawers, type CashDrawerRow } from '@/services/dashboard/cashDrawerWho.dashboard.service'
import { venueDayKey } from '@/utils/venueDateKeys'
import type { DataCapability } from '../catalog'
import { template } from '../check'
import { dayBounds } from '../params'

/**
 * C8 · «Quién abrió o cerró la caja, hoy o ayer»: el bloque de la caja física de «Turnos de caja» del panel (`CashDrawerSession`). Las
 * cajas de la sucursal que se abrieron o se cerraron ese día, o que siguen abiertas, de la más vieja a la más nueva: quién y a qué hora.
 * Sin montos, ni el aparato, ni la nota (la lectura no los trae). Quién sale sólo donde el nombre guardado en la caja es igual al del
 * directorio de personal (lo compara el servicio del panel: aquí llega `abrió`/`cerró` o null, «una persona»). Permiso de la pantalla
 * (`shifts:read`), sin puesto ni plan. Apagada mientras sus tres índices (los dos de C8 y el de la caja abierta) no sean válidos
 * (`available`).
 */

type Day = 'today' | 'yesterday'
type Drawers = Awaited<ReturnType<typeof readCashDrawers>>
type Template = ReturnType<typeof template>

/** «a las 08:02» o, si la caja no abrió y cerró en el día preguntado, «el mié 11-nov a las 23:10». Los huecos, en el orden del texto. */
const when = (t: Template, at: Date, dated: boolean) => (dated ? `el ${t.shortDay(at)} a las ${t.time(at)}` : `a las ${t.time(at)}`)

/** La frase de UNA caja. Sus únicos huecos de texto son las personas, por el filtro estricto: nunca «[dato omitido]». */
function drawerSentence(t: Template, row: CashDrawerRow, inAskedDay: (at: Date) => boolean): string {
  const dated = !inAskedDay(row.openedAt) || (row.closedAt !== null && !inAskedDay(row.closedAt))
  const opened = `${t.strict(row.abrió, 'una persona')} la abrió ${when(t, row.openedAt, dated)}`
  if (row.open) return `${opened} y sigue abierta.`
  // Los cuatro escritores que cierran una caja ponen su hora: sin ella no se dice nada (la plantilla falla y no sale ninguna cifra)
  if (!row.closedAt) throw new Error('Una caja cerrada sin hora de cierre')
  if (row.autoClosed) return `${opened} y se cerró sola ${when(t, row.closedAt, dated)}.`
  return `${opened} y ${t.strict(row.cerró, 'una persona')} la cerró ${when(t, row.closedAt, dated)}.`
}

export const cashDrawer: DataCapability<{ day: Day }, Drawers> = {
  key: 'cash_drawer',
  label: 'quién abrió o cerró la caja',
  object: 'quién abrió o cerró la caja',
  aiHint: 'Quién abrió o cerró la caja de la sucursal hoy o ayer, a qué hora, y si sigue abierta. Sin montos.',
  permissions: ['shifts:read'],
  available: cashDrawerIndexesReady,
  params: request =>
    request.day === 'other'
      ? { ok: false, refusal: 'CASH_DRAWER_TODAY_OR_YESTERDAY' }
      : { ok: true, value: { day: request.day ?? 'today' } },
  // Hoy, de las 00:00 de la sucursal hasta el corte; ayer, el día civil entero (dayBounds, nunca venueStartOfDay)
  read: async (scope, p) => readCashDrawers(scope.venueId, dayBounds(p.day, scope), scope.rows),
  render: (scope, p, drawers) => {
    const t = template(scope.timezone)
    const asked = dayBounds(p.day, scope).from
    const askedKey = venueDayKey(asked, scope.timezone)
    const inAskedDay = (at: Date) => venueDayKey(at, scope.timezone) === askedKey
    // Los huecos se anotan en el orden en que salen en el texto (el cotejo los busca así): la sucursal, el día y el corte, y las cajas
    const venue = t.strict(scope.venueName, 'tu sucursal')
    // El conteo y la lista son dos lecturas (cada una con su foto): si la lista no trae ninguna, se dice la frase de cero aunque el conteo
    // viera alguna, nunca un encabezado sin cajas (ronda 1); y el total nunca queda por debajo de lo que se lista.
    const total = Math.max(drawers.total, drawers.rows.length)
    if (!drawers.rows.length)
      return t.done(
        `No encontré cajas abiertas ni cerradas ${p.day === 'today' ? 'hoy' : 'ayer'} en ${venue} (corte ${t.time(scope.now)}).`,
      )
    const head = `${venue}, ${t.shortDay(asked)} (corte ${t.time(scope.now)})`
    const lines: string[] = []
    if (total === 1 && drawers.rows.length === 1) lines.push(`Caja de ${head}: ${drawerSentence(t, drawers.rows[0], inAskedDay)}`)
    else {
      lines.push(`Cajas de ${head}: ${t.count(total)}`)
      for (const row of drawers.rows) lines.push(drawerSentence(t, row, inAskedDay))
    }
    const more = total - drawers.rows.length
    if (more > 0) lines.push(`y ${t.count(more)} más; el resto está en Turnos de caja.`)
    return t.done(lines.join('\n'))
  },
}
