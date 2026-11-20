import type { ReservationStatus } from '@prisma/client'
import { SharedQueryService, type ReservationListSummary } from '@/services/dashboard/shared-query.service'
import type { DataCapability } from '../catalog'
import { template } from '../check'
import { wholeDayBounds } from '../params'
import { safeDbText } from '../sanitize'
import { SUPPORT_DATA_OMITTED } from '../texts'

/**
 * C4 · «Reservaciones de hoy»: la pestaña «Hoy» de Reservaciones del panel. Todas las del día calendario ENTERO de la sucursal (también
 * las que todavía no pasan), con cualquier estado, de la más temprana a la más tardía: el mismo filtro y el mismo orden que esa lista
 * (`reservation.dashboard.service.ts`, `getReservations`). Nunca el teléfono, el correo ni el código de confirmación. Permiso y candado
 * de plan de la pantalla: `reservations:read` y RESERVATIONS (Pro), sin puesto.
 */

const STATUS: Record<ReservationStatus, string> = {
  PENDING: 'Pendiente',
  CONFIRMED: 'Confirmada',
  CHECKED_IN: 'Llegó',
  COMPLETED: 'Completada',
  CANCELLED: 'Cancelada',
  NO_SHOW: 'No llegó',
}

/**
 * El nombre ENTERO pasa primero la regla de salida: si algo lo omite («Luis +525512345678»), sale omitido entero, nunca «Luis». Si no,
 * se acorta: el del cliente a nombre e inicial («Ana Ramírez» → «Ana R.»; si la segunda palabra no empieza con letra, como un
 * «[enlace]», sólo el nombre), el de quien atiende a su primera palabra. Lo acortado es lo que entra a `t.text`; vacío, sin nombre.
 */
function shortName(raw: string | null, keep: 'initial' | 'first'): string {
  const safe = safeDbText(raw)
  if (safe === SUPPORT_DATA_OMITTED) return safe
  const [first, second = ''] = safe.split(' ')
  const initial = keep === 'initial' ? /^\p{L}/u.exec(second)?.[0] : undefined
  return initial ? `${first} ${initial.toUpperCase()}.` : first
}

export const reservationsToday: DataCapability<Record<string, never>, ReservationListSummary> = {
  key: 'reservations_today',
  label: 'reservaciones de hoy',
  object: 'las reservaciones de hoy',
  aiHint: 'Las reservaciones o citas de hoy: hora, personas o servicio, cliente y estado.',
  permissions: ['reservations:read'],
  gate: { featureCode: 'RESERVATIONS', gateKind: 'FEATURE', refusal: 'PLAN_RESERVATIONS' },
  params: request =>
    request.day === null || request.day === 'today' ? { ok: true, value: {} } : { ok: false, refusal: 'RESERVATIONS_TODAY_ONLY' },
  // El día entero, no `dayBounds` (que termina en `scope.now`): a las 14:32 la de las 19:30 también es de hoy.
  read: async scope =>
    SharedQueryService.getReservations(scope.venueId, wholeDayBounds('today', scope), { limit: scope.rows }, scope.timezone),
  render: (scope, _params, list) => {
    const t = template(scope.timezone)
    const where = `en ${t.text(scope.venueName)} (corte ${t.time(scope.now)})`
    // El conteo y la lista son dos lecturas: si una se borró entre las dos, el total nunca queda por debajo de lo que se lista
    const total = Math.max(list.total, list.reservations.length)
    if (!total) return t.done(`No hay reservaciones hoy ${where}.`)
    const lines = [`Reservaciones de hoy ${where}: ${t.count(total)}`]
    for (const r of list.reservations) {
      // Como la lista del panel: el cliente ligado, y si no, el nombre que se escribió al reservar
      const client = shortName(r.customerName ?? r.guestName, 'initial')
      const staff = shortName(r.assignedStaffName, 'first')
      // Los huecos se anotan en el orden en que salen en el texto (el cotejo los busca así)
      const pieces = [
        t.time(r.startsAt),
        // Se decide con el valor ya saneado: un servicio o una mesa sólo de espacios no deja «· mesa » colgando ni se come las personas
        safeDbText(r.productName) ? t.text(r.productName) : `${t.count(r.partySize)} ${r.partySize === 1 ? 'persona' : 'personas'}`,
        client ? t.text(client) : '',
        staff ? `con ${t.text(staff)}` : '',
        STATUS[r.status as ReservationStatus] ?? '',
        safeDbText(r.tableNumber) ? `mesa ${t.text(r.tableNumber)}` : '',
      ]
      lines.push(pieces.filter(piece => piece !== '').join(' · '))
    }
    const more = total - list.reservations.length
    if (more > 0) lines.push(`y ${t.count(more)} más; el resto está en el panel.`)
    return t.done(lines.join('\n'))
  },
}
