/**
 * Máquina de efectivo QuickPay Mini · fase 1a (plan `2026-11-20-maquina-de-efectivo-fase-1a.md`, A7, R4-7 #11, R3#10). Sólo lectura y
 * sólo en el MCP libre (no está en `directory/catalog.ts`). Los cierres de la máquina y las dudas abiertas, en PESOS.
 *
 * 🔴 «Originó deuda», nunca «pendiente»: la 1a no registra quién pagó esa deuda (se paga con un retiro de la caja que nadie liga al
 * folio), así que el MCP no puede decir que sigue sin pagarse.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { venueEndOfDay, venueStartOfDay } from '@/utils/datetime'
// El cursor `createdAt|id` opaco de la merma: la misma forma (orden `createdAt DESC, id DESC`).
import { decodeWasteCursor as leerCursor, encodeWasteCursor as cursorDe } from '@/schemas/mobile/inventoryWaste.mobile.schema'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

const NOTA_DE_DEUDA = 'Originó deuda con el cliente; si ya se le pagó, fue un pago por retiro sin verificar (no queda ligado a este folio).'
const pesos = (centavos: number) => centavos / 100

export function registerCashMachineTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'cash_machine_closes',
    'Cierres de la máquina de efectivo (autoservicio QuickPay) de una sucursal que puedes ver, registrados en un rango de fechas del negocio (por omisión, los últimos 7 días), más nuevos primero. Cada cierre trae su folio, el desenlace (PAGADO, CANCELADO o GUARDADO), quién lo decidió (la máquina o un gerente que lo resolvió a mano), la hora del comprobante (o «por conciliar»), el estado del turno, y los importes EN PESOS: adeudo, venta, propina, lo que entró, el cambio entregado, lo aplicado a la cuenta, el excedente y lo que la operación originó de deuda con el cliente, con su tipo (CAMBIO que faltó, dinero GUARDADO, NO_DEVUELTO al cancelar, o EXCEDENTE porque el precio bajó). «originó deuda» no quiere decir que siga sin pagarse: si ya se le pagó al cliente, fue un pago por retiro sin verificar. Filtros: soloConDeuda (sólo los que originaron deuda), folio (búsqueda por parte del folio) y enDuda (en vez de cierres, las operaciones que la PC no supo cómo terminaron y siguen esperando a un gerente; ignora el rango). Hasta 100 por página, con el total y un cursor para seguir. Requiere payments:read.',
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
      enDuda: z.boolean().optional().describe('En vez de cierres, las operaciones en duda que esperan a un gerente'),
      limit: z.number().int().positive().optional().describe('Cuántos por página (máximo 100; por omisión 50)'),
      cursor: z.string().max(200).optional().describe('El nextCursor de la página anterior'),
    },
    async ({ venueId, fromDate, toDate, soloConDeuda, folio, enDuda, limit, cursor }) => {
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
        const where = { venueId, kind: 'ESPERANDO', status: 'ABIERTO' }
        const [total, filas] = await Promise.all([
          prisma.cashMachineIncident.count({ where }),
          prisma.cashMachineIncident.findMany({
            where: pagina(where),
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: take + 1,
            select: { id: true, referenceCC: true, createdAt: true, deviceId: true, payload: true },
          }),
        ])
        const dudas = filas.slice(0, take).map(f => {
          const p = f.payload as { dueCents: number; saleCents: number; tipCents: number; startedAt?: string; lastSeen?: unknown }
          return {
            folio: f.referenceCC,
            subidaEl: f.createdAt.toISOString(),
            empezoEl: p.startedAt ?? null,
            adeudo: pesos(p.dueCents),
            venta: pesos(p.saleCents),
            propina: pesos(p.tipCents),
            loUltimoQueVioLaPc: p.lastSeen ?? null,
          }
        })
        return text({ ok: true, venueId, total, count: dudas.length, nextCursor: siguiente(filas), dudas })
      }

      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
      const tz = venue?.timezone || 'America/Mexico_City'
      const start = venueStartOfDay(tz, fromDate ? new Date(`${fromDate}T12:00:00`) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
      const end = venueEndOfDay(tz, toDate ? new Date(`${toDate}T12:00:00`) : undefined)
      // UN filtro para el total y las filas (R4-7 #11).
      const where = {
        venueId,
        createdAt: { gte: start, lte: end },
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
        window: { start: start.toISOString(), end: end.toISOString() },
        total,
        count: cierres.length,
        nextCursor: siguiente(filas),
        cierres,
      })
    },
  )
}
