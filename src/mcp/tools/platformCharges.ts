/**
 * «Por cobrar» desde el MCP (spec 2026-11-02-por-cobrar-superadmin §8): una sola tool de LECTURA que contesta lo que los clientes le
 * deben a Avoqado por cobros —recurrentes o de una sola vez— vencido, hoy y próximos 7 días, en pesos. Con filtros (periodicidad, factura, tipo de
 * cliente, fechas de cobro, nombre exacto) también dice cuántos cobros cumplen y cuánto suman: el mismo `where` que la pantalla del SUPERADMIN.
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
import { BadRequestError } from '@/errors/AppError'
import {
  listOccurrences,
  summarizeOccurrences,
  UPCOMING_DAYS,
  type OccurrenceFilters,
  type SummaryBucket,
} from '@/services/superadmin/platform-charges/occurrences.service'
import { addDays } from '@/services/superadmin/platform-charges/schedule'
import { text } from '../respond'
import type { McpScope } from '../scope'

const SOLO_AVOQADO = 'Sólo el equipo de Avoqado puede consultar lo que le deben a Avoqado por cobros recurrentes.'

const pesos = (cents: number) => cents / 100
const group = ({ count, totalCents }: SummaryBucket) => ({ cantidad: count, totalMxn: pesos(totalCents) })

/** Sólo los filtros que de verdad se pidieron: un arreglo vacío o un texto en blanco es «sin filtro». */
type Requested = Pick<OccurrenceFilters, 'frequency' | 'invoice' | 'customerType' | 'from' | 'to' | 'customer'>
function requestedFilters({ frequency, invoice, customerType, from, to, customer }: Requested): OccurrenceFilters {
  return {
    ...(frequency?.length ? { frequency } : {}),
    ...(invoice?.length ? { invoice } : {}),
    ...(customerType?.length ? { customerType } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(customer?.trim() ? { customer: customer.trim() } : {}),
  }
}

const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/

/** Un día `YYYY-MM-DD` se ordena como el calendario: comparar los textos es comparar los días. */
const groupOf = (dueDate: string, today: string) => (dueDate < today ? 'vencido' : dueDate === today ? 'hoy' : 'proximo')

export function registerPlatformChargeTools(server: McpServer, scope: McpScope): void {
  if (!scope.isSuperAdmin) return

  server.tool(
    'list_platform_charges_due',
    'Consulta lo que los clientes le deben a Avoqado por cobros (rentas, licencias, ventas de equipo) que pagan por transferencia, ' +
      'recurrentes o de una sola vez: cuánto está vencido, cuánto vence hoy y cuánto viene en los próximos 7 días (días de la Ciudad de ' +
      'México), con la cantidad de cobros y el total en pesos de cada grupo, más la lista de cobros pendientes con páginas, los más ' +
      'antiguos primero. Se puede filtrar por periodicidad, estado de la factura, tipo de cliente, rango de fechas de cobro y nombre ' +
      'exacto del cliente: con filtros también contesta cuántos cobros cumplen y cuánto suman en pesos. Sólo lectura: no marca nada como ' +
      'pagado ni genera facturas. Sólo para el equipo de Avoqado.',
    {
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(25),
      frequency: z
        .array(z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'ONE_TIME']))
        .optional()
        .describe(
          'Periodicidad del cobro: WEEKLY (semanal), BIWEEKLY (quincenal), MONTHLY (mensual) u ONE_TIME (una sola vez). Varias se suman.',
        ),
      invoice: z
        .array(z.enum(['STAMPED', 'PROBLEM', 'PENDING', 'NONE']))
        .optional()
        .describe(
          'Estado de la factura: STAMPED (ya facturado), PROBLEM (un intento de factura en camino o fallido), PENDING (por facturar) o NONE (cobro sin factura). Varios se suman.',
        ),
      customerType: z
        .array(z.enum(['ORGANIZATION', 'VENUE', 'STANDALONE']))
        .optional()
        .describe('Tipo de cliente: ORGANIZATION (organización), VENUE (negocio) o STANDALONE (cliente externo). Varios se suman.'),
      from: z
        .string()
        .regex(DAY_FORMAT, 'Usa el formato AAAA-MM-DD')
        .optional()
        .describe('Fecha de cobro desde este día (incluido), AAAA-MM-DD, de la Ciudad de México.'),
      to: z
        .string()
        .regex(DAY_FORMAT, 'Usa el formato AAAA-MM-DD')
        .optional()
        .describe('Fecha de cobro hasta este día (incluido), AAAA-MM-DD, de la Ciudad de México.'),
      customer: z.string().max(120).optional().describe('Nombre exacto del cliente, tal como sale en la lista.'),
    },
    async ({ page, pageSize, ...requested }) => {
      if (!scope.isSuperAdmin) return text({ ok: false, error: SOLO_AVOQADO })
      const filters = requestedFilters(requested)
      const filtered = Object.keys(filters).length > 0
      // El mismo instante para las dos lecturas: «hoy» es el mismo día en el total y en la lista.
      const now = new Date()
      let summary: Awaited<ReturnType<typeof summarizeOccurrences>>
      let rows: Awaited<ReturnType<typeof listOccurrences>>
      try {
        ;[summary, rows] = await Promise.all([
          summarizeOccurrences(now),
          listOccurrences({ view: 'open', page, pageSize, ...filters }, now),
        ])
      } catch (error) {
        // Un filtro que el servicio rechaza (un rango de fechas al revés) es una respuesta para el asistente; lo demás sube al instrumento del MCP.
        if (error instanceof BadRequestError) return text({ ok: false, error: error.message })
        throw error
      }

      // Lo de «próximos» es la ventana de las tarjetas, no todo lo que ya esté generado. Con filtros, la lista y su total son los del filtro.
      const horizon = addDays(summary.today, UPCOMING_DAYS)
      const total = filtered ? rows.total : summary.overdue.count + summary.dueToday.count + summary.upcoming.count
      const cobros = (filtered ? rows.rows : rows.rows.filter(row => row.dueDate <= horizon)).map(row => ({
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
        ...(filtered
          ? {
              // La suma de TODO el filtro (nunca la de la página), en pesos.
              filtrados: { cantidad: rows.total, totalMxn: pesos(rows.sumCents) },
              notaFiltros:
                'Sólo los cobros que cumplen los filtros salen en «filtrados» y en la lista. Los grupos vencido, hoy y proximos7Dias de arriba cuentan todos los cobros pendientes, sin filtros.',
            }
          : {}),
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
