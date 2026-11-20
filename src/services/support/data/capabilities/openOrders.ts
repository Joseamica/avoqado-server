import type { OrderType } from '@prisma/client'
import { listOpenOrdersBrief, type OpenOrdersBrief } from '@/services/dashboard/openOrders.service'
import { venueDayKey } from '@/utils/venueDateKeys'
import type { DataCapability } from '../catalog'
import { template } from '../check'
import { lastDaysStart } from '../params'

/**
 * C3 · «Cuentas abiertas de los últimos 7 días»: las cuentas de la sucursal que todavía deben (la definición del tool `open_orders` del
 * MCP), de la más vieja a la más nueva, y desde cuándo están abiertas. Los días son los 7 días calendario de la sucursal, hoy incluido,
 * como «Últimos 7 días» del panel. Sin montos: la lectura no los trae. Permiso de la ruta de órdenes del panel (`orders:read`), sin
 * puesto ni candado de plan.
 */

/** Una cuenta sin mesa se nombra por su tipo; un tipo fuera de la lista, «Cuenta». */
const BY_TYPE: Partial<Record<OrderType, string>> = {
  TAKEOUT: 'Para llevar',
  DELIVERY: 'A domicilio',
  PICKUP: 'Para recoger',
  DINE_IN: 'En el local',
}

export const openOrders: DataCapability<Record<string, never>, OpenOrdersBrief> = {
  key: 'open_orders',
  label: 'cuentas abiertas',
  object: 'las cuentas abiertas',
  aiHint: 'Qué cuentas siguen sin cobrarse del todo en los últimos días y desde cuándo están abiertas. Sin montos.',
  permissions: ['orders:read'],
  params: () => ({ ok: true, value: {} }),
  read: async scope => listOpenOrdersBrief(scope.venueId, lastDaysStart(scope.openOrdersDays, scope), scope.rows),
  render: (scope, _params, brief) => {
    const t = template(scope.timezone)
    const days = `de los últimos ${t.count(scope.openOrdersDays)} días en ${t.text(scope.venueName)} (corte ${t.time(scope.now)})`
    // El conteo y la lista son dos lecturas: si una cuenta se cobró entre las dos, el total nunca queda por debajo de lo que se lista
    const total = Math.max(brief.total, brief.orders.length)
    if (!total) return t.done(`No hay cuentas abiertas ${days}.`)
    const more = total - brief.orders.length
    const lines = [`Cuentas abiertas ${days}: ${t.count(total)}.${more > 0 ? ' Las más antiguas:' : ''}`]
    // Los huecos se anotan en el orden en que salen en el texto (el cotejo los busca así): la mesa, el día y la hora.
    for (const order of brief.orders) {
      const table = order.tableNumber ? t.text(order.tableNumber) : ''
      const name = table ? `Mesa ${table}` : (BY_TYPE[order.type] ?? 'Cuenta')
      const since =
        venueDayKey(order.createdAt, scope.timezone) === scope.day
          ? `hoy ${t.time(order.createdAt)}`
          : `desde el ${t.shortDay(order.createdAt)} a las ${t.time(order.createdAt)}`
      lines.push(`${name} · ${since}`)
    }
    lines.push(`${more > 0 ? `y ${t.count(more)} más. ` : ''}Los montos están en el panel.`)
    return t.done(lines.join('\n'))
  },
}
