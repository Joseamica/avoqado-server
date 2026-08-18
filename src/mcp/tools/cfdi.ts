import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { venuesWithFeatureAccess } from '@/services/access/basePlan.service'
import { hasPermission } from '@/services/access/access.service'
import { emitRefundCreditNote, getRefundCreditNoteStatus } from '@/services/fiscal/cfdiCreditNote.service'

export function registerCfdiTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'cfdi_status',
    'CFDI 4.0 (facturación) status across your venues: invoice count by status (STAMPED = timbrada/issued; plus drafts, validation/stamp failures, and cancellations), the total stamped amount, and your most recent issued invoices (folio, UUID, receptor, amount). Pass venueId to focus one venue.',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      limit: z.number().int().min(1).max(20).default(5).describe('Max recent stamped invoices to return'),
    },
    async ({ venueId, limit }) => {
      guard.venueFilter(venueId) // scope check (throws if a given venueId is out of scope)
      // Read gate — mirror the dashboard's checkPermission('cfdi:view'). Single-venue focus throws
      // if the caller lacks it; the all-venues path filters to venues where the caller holds it below.
      if (venueId) guard.requirePermission('cfdi:view', venueId)
      // CFDI is a PAID feature — the dashboard gates its routes with checkFeatureAccess('CFDI').
      // Mirror that so the MCP isn't a billing bypass: only surface venues entitled to CFDI.
      const entitled = await venuesWithFeatureAccess(scope.allowedVenueIds, 'CFDI')
      if (venueId && !entitled.has(venueId)) {
        return text({
          ok: false,
          planRequired: true,
          feature: 'CFDI',
          error: 'CFDI (facturación) no está activo en este local. Requiere la feature CFDI o un plan Avoqado activo.',
        })
      }
      // All-venues path: only venues where the caller actually holds cfdi:view (per-venue role),
      // so a low-role staffer can't read fiscal data org-wide that the dashboard would 403.
      const cfdiVenueIds = venueId
        ? [venueId]
        : [...entitled].filter(v => {
            const access = scope.perVenueAccess.get(v)
            return access && hasPermission(access, 'cfdi:view')
          })
      if (cfdiVenueIds.length === 0) {
        return text({ ok: false, planRequired: true, feature: 'CFDI', error: 'Ninguno de tus locales tiene CFDI (facturación) activo.' })
      }
      const where = { venueId: { in: cfdiVenueIds } }
      const grouped = await prisma.cfdi.groupBy({ by: ['status'], where, _count: { _all: true } })
      const byStatus: Record<string, number> = {}
      for (const g of grouped) byStatus[g.status] = g._count._all

      const stamped = await prisma.cfdi.aggregate({
        where: { ...where, status: 'STAMPED' },
        _sum: { totalCents: true },
        _count: { _all: true },
      })
      const recent = await prisma.cfdi.findMany({
        where: { ...where, status: 'STAMPED' },
        select: {
          serie: true,
          folio: true,
          uuid: true,
          totalCents: true,
          receptorNombre: true,
          stampedAt: true,
          venue: { select: { name: true } },
        },
        orderBy: { stampedAt: 'desc' },
        take: limit,
      })

      return text({
        venuesInScope: cfdiVenueIds.length,
        byStatus,
        stamped: { count: stamped._count._all, totalMxn: (stamped._sum.totalCents ?? 0) / 100 },
        recentStamped: recent.map(r => ({
          folio: `${r.serie ?? ''}${r.folio ?? ''}` || null,
          uuid: r.uuid,
          totalMxn: r.totalCents / 100,
          receptor: r.receptorNombre,
          stampedAt: r.stampedAt,
          venue: r.venue?.name,
        })),
      })
    },
  )

  // ─── Nota de crédito (CFDI de EGRESO) por un reembolso ──────────────────────
  //
  // 🔴 Write IRREVERSIBLE: timbrar crea un documento fiscal real ante el SAT; deshacerlo
  // exige una cancelación (que el SAT puede rechazar). Por eso va con confirm de DOS pasos
  // con vista previa legible — regla `mcp-write-safety-confirm-gating`.
  server.tool(
    'emit_refund_credit_note',
    'Emite la NOTA DE CRÉDITO (CFDI de Egreso) que ampara un reembolso ya hecho. La venta original NO se modifica y su factura NO se cancela: se emite un comprobante nuevo relacionado a ella (TipoRelacion 01, uso G02) por el importe devuelto. Irreversible: pide confirmación en dos pasos. Requiere que la venta YA tenga factura (CFDI de ingreso) timbrada y vigente.',
    {
      venueId: z.string().describe('El local del reembolso (debe estar en tu alcance)'),
      refundPaymentId: z.string().describe('Id del pago de tipo REFUND que se va a amparar'),
      confirm: z.boolean().optional().describe('true para ejecutar; sin él sólo devuelve la vista previa'),
    },
    async ({ venueId, refundPaymentId, confirm }) => {
      guard.venueFilter(venueId)
      // Mismo permiso que el botón del dashboard: emitir un CFDI.
      guard.requirePermission('cfdi:issue', venueId)
      // CFDI es feature de pago — el MCP no puede ser un atajo al paywall.
      const entitled = await venuesWithFeatureAccess([venueId], 'CFDI')
      if (!entitled.has(venueId)) {
        return text({
          ok: false,
          planRequired: true,
          feature: 'CFDI',
          error: 'CFDI (facturación) no está activo en este local. Requiere la feature CFDI o un plan Avoqado activo.',
        })
      }

      // Estado real (resolver, no adivinar): ya emitida + si procede + vista previa.
      const status = await getRefundCreditNoteStatus(venueId, refundPaymentId)
      if (!status) return text({ ok: false, error: 'No encontré ese reembolso en tus locales.' })

      // Idempotencia VISIBLE antes de pedir confirmación: nunca se emite una segunda.
      if (status.creditNote && status.creditNote.status === 'STAMPED') {
        const cn = status.creditNote
        return text({
          ok: true,
          alreadyIssued: true,
          creditNote: { uuid: cn.uuid, folio: `${cn.serie ?? ''}${cn.folio ?? ''}` || null, totalMxn: cn.totalCents / 100 },
          message: 'Ese reembolso YA tiene su nota de crédito timbrada. No se emitió otra.',
        })
      }
      // La MISMA regla que apaga el botón del dashboard — el MCP no puede ser más permisivo.
      if (!status.eligibility.eligible) {
        return text({ ok: false, reason: status.eligibility.reason, error: status.eligibility.message })
      }

      if (!confirm) {
        const p = status.preview!
        const amountMxn = p.amountToCreditCents / 100
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: {
            facturaOriginal: {
              folio: p.facturaOriginal!.folio,
              uuid: p.facturaOriginal!.uuid,
              totalMxn: p.facturaOriginal!.totalCents / 100,
            },
            receptor: p.receptor,
            importeAcreditadoMxn: amountMxn,
            propinaDevueltaMxn: p.tipRefundCents / 100,
            tipoRelacion: '01 (Nota de crédito de los documentos relacionados)',
            usoCfdi: 'G02 (Devoluciones, descuentos o bonificaciones)',
          },
          message:
            `Esto TIMBRARÁ ante el SAT una nota de crédito por $${amountMxn.toFixed(2)} relacionada a la factura ` +
            `${p.facturaOriginal!.folio} (receptor ${p.receptor!.nombre}). La factura original NO se cancela.` +
            (p.tipRefundCents > 0
              ? ` La propina devuelta ($${(p.tipRefundCents / 100).toFixed(2)}) NO entra: nunca formó parte del CFDI.`
              : '') +
            ' Es IRREVERSIBLE (deshacerla exige cancelarla ante el SAT). Vuelve a llamar con confirm:true para ejecutar.',
        })
      }

      try {
        const result = await emitRefundCreditNote({
          venueId,
          refundPaymentId,
          // `process.env` a propósito y NO `@/config/env`: importar ese módulo desde un tool
          // corre la validación de entorno (y su `process.exit(1)`) dentro del worker de Jest.
          sandbox: process.env.NODE_ENV !== 'production',
          requestedByStaffId: scope.staffId,
        })
        if (result.status !== 'STAMPED') {
          return text({
            ok: false,
            status: result.status,
            error: result.reasons?.join(' | ') ?? result.cfdi?.lastError ?? 'No se pudo timbrar la nota de crédito.',
          })
        }
        await auditMcpWrite(scope, {
          action: 'CFDI_CREDIT_NOTE_ISSUED',
          entity: 'Cfdi',
          entityId: result.cfdi.id,
          venueId,
          data: { refundPaymentId, uuid: result.cfdi.uuid, amount: result.cfdi.totalCents / 100 },
        })
        return text({
          ok: true,
          creditNote: {
            uuid: result.cfdi.uuid,
            folio: `${result.cfdi.serie ?? ''}${result.cfdi.folio ?? ''}` || null,
            totalMxn: result.cfdi.totalCents / 100,
            pdfUrl: result.cfdi.pdfUrl,
            xmlUrl: result.cfdi.xmlUrl,
          },
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
