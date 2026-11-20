/**
 * Máquina de efectivo QuickPay Mini · fase 1a (plan `2026-11-20-maquina-de-efectivo-fase-1a.md`, A7, R4-7 #11, R3#10). Sólo lectura y
 * sólo en el MCP libre (no está en `directory/catalog.ts`). Los cierres de la máquina y las dudas abiertas, en PESOS.
 *
 * 🔴 «Originó deuda», nunca «pendiente»: la 1a no registra quién pagó esa deuda (se paga con un retiro de la caja que nadie liga al
 * folio), así que el MCP no puede decir que sigue sin pagarse.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { listarDudasDeLaMaquina } from '@/services/cashMachine/dudasDeLaMaquina'
import { venueEndOfDay, venueStartOfDay } from '@/utils/datetime'
// El cursor `createdAt|id` opaco de la merma: la misma forma (orden `createdAt DESC, id DESC`).
import { decodeWasteCursor as leerCursor, encodeWasteCursor as cursorDe } from '@/schemas/mobile/inventoryWaste.mobile.schema'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

const NOTA_DE_DEUDA = 'Originó deuda con el cliente; si ya se le pagó, fue un pago por retiro sin verificar (no queda ligado a este folio).'
const NOTA_DE_LA_EVIDENCIA =
  'evidenciaCrudaDeLaPc es el texto tal cual lo vio la PC en la máquina: sus cifras NO están en pesos de Avoqado (pueden venir en centavos). No las sumes ni las compares con los importes.'
const pesos = (centavos: number) => centavos / 100
/** Codex r1 #16: cualquier importe que salga de una evidencia guardada, en pesos; lo que no es un número entero de centavos, `null`. */
const pesosDe = (centavos: unknown) => (typeof centavos === 'number' && Number.isFinite(centavos) ? centavos / 100 : null)
/** La evidencia cruda de la PC, como TEXTO acotado: nunca un objeto con números que parezcan pesos. */
const textoCrudo = (v: unknown) => (v == null ? null : JSON.stringify(v).slice(0, 2000))

export function registerCashMachineTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'cash_machine_closes',
    'Cierres de la máquina de efectivo (autoservicio QuickPay) de una sucursal que puedes ver, en un rango de fechas del negocio (por omisión, los últimos 7 días), más nuevos primero. porFecha decide qué fecha cuenta: «comprobante» (por omisión: el día en que la máquina cobró; los que no tienen hora cuentan por el día en que se registraron) o «registro» (el día en que llegaron al servidor, que puede ser después si la PC estuvo sin internet). Cada cierre trae su folio, el desenlace (PAGADO, CANCELADO o GUARDADO), quién lo decidió (la máquina o un gerente que lo resolvió a mano), la hora del comprobante (o «por conciliar»), el estado del turno, y los importes EN PESOS: adeudo, venta, propina, lo que entró, el cambio entregado, lo aplicado a la cuenta, el excedente y lo que la operación originó de deuda con el cliente, con su tipo (CAMBIO que faltó, dinero GUARDADO, NO_DEVUELTO al cancelar, o EXCEDENTE porque el precio bajó). «originó deuda» no quiere decir que siga sin pagarse: si ya se le pagó al cliente, fue un pago por retiro sin verificar. Filtros: soloConDeuda (sólo los que originaron deuda), folio (búsqueda por parte del folio, también en las incidencias) y enDuda (en vez de cierres, las incidencias abiertas que esperan a un gerente, con su tipo: ESPERANDO = la PC no supo cómo terminó la operación; IMPOSIBLE = importes que la máquina no puede dar; CONFLICTO = el mismo folio con otra versión o desde otra PC; NO_SE_PUDO_REGISTRAR = la máquina cobró pero no se registró la venta, el dinero queda ahí; TRAS_REVOCAR = folio de una PC a la que ya le habían quitado la máquina; ignora el rango). Todos los importes en PESOS. Hasta 100 por página, con el total y un cursor para seguir. Requiere payments:read.',
    {
      venueId: z.string().describe('Sucursal (debe estar en tu alcance)'),
      fromDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa YYYY-MM-DD')
        .optional()
        .describe('Desde (YYYY-MM-DD, fecha del negocio; por omisión hace 7 días)'),
      toDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa YYYY-MM-DD')
        .optional()
        .describe('Hasta (YYYY-MM-DD, fecha del negocio; por omisión hoy)'),
      soloConDeuda: z.boolean().optional().describe('Sólo los cierres que originaron deuda con el cliente'),
      folio: z.string().max(32).optional().describe('Parte del folio de la máquina (AQ…)'),
      enDuda: z
        .boolean()
        .optional()
        .describe('En vez de cierres, las incidencias abiertas que esperan a un gerente (cada una con su tipo)'),
      porFecha: z
        .enum(['comprobante', 'registro'])
        .optional()
        .describe('Qué fecha filtra los cierres: la del comprobante de la máquina (por omisión) o la de registro en el servidor'),
      limit: z.number().int().positive().optional().describe('Cuántos por página (máximo 100; por omisión 50)'),
      cursor: z.string().max(200).optional().describe('El nextCursor de la página anterior'),
    },
    async ({ venueId, fromDate, toDate, soloConDeuda, folio, enDuda, porFecha, limit, cursor }) => {
      guard.venueFilter(venueId) // ScopeError si la sucursal no está en tu alcance
      guard.requirePermission('payments:read', venueId)
      const take = Math.min(limit ?? 50, 100)
      const despues = cursor === undefined ? null : leerCursor(cursor)
      if (cursor !== undefined && !despues)
        return text({ ok: false, error: 'El cursor no es válido: usa el nextCursor de la página anterior.' })
      const pagina = <W extends object>(where: W) =>
        despues
          ? { AND: [where, { OR: [{ createdAt: { lt: despues.createdAt } }, { createdAt: despues.createdAt, id: { lt: despues.id } }] }] }
          : where
      const siguiente = <F extends { createdAt: Date; id: string }>(filas: F[]) => {
        const ultima = filas.length > take ? filas[take - 1] : null
        return ultima ? cursorDe(ultima.createdAt, ultima.id) : null
      }

      if (enDuda) {
        // Codex r1 #16: la MISMA lista que la bandeja del gerente (todas las incidencias abiertas, el folio filtra el total y la página).
        const r = await listarDudasDeLaMaquina(venueId, { status: 'ABIERTO', folio, cursor, limit: take })
        const dudas = r.data.map(f => {
          const base = { folio: f.referenceCC, tipo: f.kind, subidaEl: (f.createdAt as Date).toISOString() }
          if (f.kind === 'ESPERANDO') {
            return {
              ...base,
              empezoEl: f.startedAt ?? null,
              adeudo: pesosDe(f.dueCents),
              venta: pesosDe(f.saleCents),
              propina: pesosDe(f.tipCents),
              evidenciaCrudaDeLaPc: textoCrudo(f.lastSeen),
            }
          }
          const ev = (f.primerEvento ?? {}) as { cierre?: Record<string, unknown>; duda?: Record<string, unknown>; motivo?: unknown }
          const c = ev.cierre ?? ev.duda ?? {}
          return {
            ...base,
            veces: f.veces,
            motivo: typeof ev.motivo === 'string' ? ev.motivo : null,
            desenlace: typeof c.outcome === 'string' ? c.outcome : null,
            adeudo: pesosDe(c.dueCents),
            venta: pesosDe(c.saleCents),
            propina: pesosDe(c.tipCents),
            entro: pesosDe(c.creditCents),
            cambioEntregado: pesosDe(c.changeDispensedCents),
          }
        })
        return text({ ok: true, venueId, total: r.total, count: dudas.length, nextCursor: r.nextCursor, dudas, nota: NOTA_DE_LA_EVIDENCIA })
      }

      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
      const tz = venue?.timezone || 'America/Mexico_City'
      const start = venueStartOfDay(tz, fromDate ? new Date(`${fromDate}T12:00:00`) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
      const end = venueEndOfDay(tz, toDate ? new Date(`${toDate}T12:00:00`) : undefined)
      // UN filtro para el total y las filas (R4-7 #11). Codex r1 #16: la venta del domingo que subió el lunes es del domingo
      // (comprobante); sin hora, cuenta el día en que se registró.
      // ponytail: la hora del comprobante no tiene índice propio; el filtro va dentro de la sucursal (un índice si crece mucho).
      const rango = { gte: start, lte: end }
      const where: Prisma.CashMachineCloseWhereInput = {
        venueId,
        ...(porFecha === 'registro'
          ? { createdAt: rango }
          : {
              OR: [
                { occurredAtKnown: true, occurredAt: rango },
                { occurredAtKnown: false, createdAt: rango },
              ],
            }),
        ...(soloConDeuda ? { owedCents: { gt: 0 } } : {}),
        ...(folio?.trim() ? { referenceCC: { contains: folio.trim().toUpperCase() } } : {}),
      }
      const [total, filas] = await Promise.all([
        prisma.cashMachineClose.count({ where }),
        prisma.cashMachineClose.findMany({ where: pagina(where), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: take + 1 }),
      ])
      const cierres = filas.slice(0, take).map(c => ({
        folio: c.referenceCC,
        desenlace: c.outcome,
        resueltoPor: c.resolvedBy,
        horaDelComprobante: c.occurredAtKnown && c.occurredAt ? c.occurredAt.toISOString() : 'por conciliar',
        registradoEl: c.createdAt.toISOString(),
        turno: c.shiftStatus,
        adeudo: pesos(c.dueCents),
        venta: pesos(c.saleCents),
        propina: pesos(c.tipCents),
        entro: pesos(c.creditCents),
        cambioEntregado: pesos(c.changeDispensedCents),
        aplicado: pesos(c.appliedCents),
        excedente: pesos(c.excedenteCents),
        origenDeuda: pesos(c.owedCents),
        tipoDeDeuda: c.owedKind,
        orderId: c.orderId,
        paymentId: c.paymentId,
        ...(c.owedCents > 0 ? { nota: NOTA_DE_DEUDA } : {}),
      }))
      return text({
        ok: true,
        venueId,
        timezone: tz,
        porFecha: porFecha ?? 'comprobante',
        window: { start: start.toISOString(), end: end.toISOString() },
        total,
        count: cierres.length,
        nextCursor: siguiente(filas),
        cierres,
      })
    },
  )
}
