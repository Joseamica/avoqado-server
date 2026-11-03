/**
 * «Por cobrar» desde el MCP (spec 2026-11-02-por-cobrar-superadmin §8): una sola tool de LECTURA que contesta lo que los clientes le
 * deben a Avoqado por cobros recurrentes — vencido, hoy y próximos 7 días — en pesos.
 *
 * 🔴 SOLO SUPERADMIN, con defensa doble: `registerAllTools` no la registra para un cliente, este archivo tampoco y el handler vuelve a
 * comprobarlo. Es una ficha de PLATAFORMA, no datos de un local. Sólo en el MCP libre: NO está en `directory/catalog.ts`.
 *
 * Marcar pagado por MCP no entra en esta versión: timbra una factura. El día que se pida, va con confirmación en dos pasos.
 *
 * Totales y filas salen del mismo servicio que la pantalla del SUPERADMIN: los totales son los agregados exactos de
 * `summarizeOccurrences` (nunca la suma de una página) y las filas las acota el servidor. La respuesta dice cuántas hay y cómo pedir
 * el resto, para que nada se trunque en silencio. Dinero: el servicio trabaja en centavos enteros y aquí se divide entre 100 UNA vez,
 * al contestar, sobre un entero (173884 centavos son 1738.84, el valor exacto más cercano): el asistente sólo ve pesos.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  listOccurrences,
  summarizeOccurrences,
  UPCOMING_DAYS,
  type SummaryBucket,
} from '@/services/superadmin/platform-charges/occurrences.service'
import { addDays } from '@/services/superadmin/platform-charges/schedule'
import { text } from '../respond'
import type { McpScope } from '../scope'

const SOLO_AVOQADO = 'Sólo el equipo de Avoqado puede consultar lo que le deben a Avoqado por cobros recurrentes.'

const pesos = (cents: number) => cents / 100
const group = ({ count, totalCents }: SummaryBucket) => ({ cantidad: count, totalMxn: pesos(totalCents) })

/** Un día `YYYY-MM-DD` se ordena como el calendario: comparar los textos es comparar los días. */
const groupOf = (dueDate: string, today: string) => (dueDate < today ? 'vencido' : dueDate === today ? 'hoy' : 'proximo')

export function registerPlatformChargeTools(server: McpServer, scope: McpScope): void {
  if (!scope.isSuperAdmin) return

  server.tool(
    'list_platform_charges_due',
    'Consulta lo que los clientes le deben a Avoqado por cobros recurrentes (rentas, licencias) que pagan por transferencia: cuánto está ' +
      'vencido, cuánto vence hoy y cuánto viene en los próximos 7 días (días de la Ciudad de México), con la cantidad de cobros y el total en ' +
      'pesos de cada grupo, más la lista de cobros pendientes con páginas, los más antiguos primero. Sólo lectura: no marca nada como ' +
      'pagado ni genera facturas. Sólo para el equipo de Avoqado.',
    {
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(25),
    },
    async ({ page, pageSize }) => {
      if (!scope.isSuperAdmin) return text({ ok: false, error: SOLO_AVOQADO })
      // El mismo instante para las dos lecturas: «hoy» es el mismo día en el total y en la lista.
      const now = new Date()
      const [summary, rows] = await Promise.all([summarizeOccurrences(now), listOccurrences({ view: 'open', page, pageSize }, now)])

      // Lo de «próximos» es la ventana de las tarjetas, no todo lo que ya esté generado.
      const horizon = addDays(summary.today, UPCOMING_DAYS)
      const total = summary.overdue.count + summary.dueToday.count + summary.upcoming.count
      const cobros = rows.rows
        .filter(row => row.dueDate <= horizon)
        .map(row => ({
          cliente: row.customerName,
          vence: row.dueDate,
          grupo: groupOf(row.dueDate, summary.today),
          conceptos: row.concepts.map(concept => concept.description),
          totalMxn: pesos(row.totalCents),
        }))
      const hayMas = rows.page * rows.pageSize < total

      return text({
        ok: true,
        dia: summary.today,
        vencido: group(summary.overdue),
        hoy: group(summary.dueToday),
        proximos7Dias: group(summary.upcoming),
        // La página y el tamaño son los que acotó el servidor, no los que pidió el cliente.
        pagina: rows.page,
        porPagina: rows.pageSize,
        mostrando: cobros.length,
        de: total,
        hayMas,
        ...(hayMas
          ? {
              nota: 'Hay más cobros pendientes que los de esta página: pide la siguiente con page. Los totales de arriba ya los cuentan todos.',
            }
          : {}),
        cobros,
      })
    },
  )
}
