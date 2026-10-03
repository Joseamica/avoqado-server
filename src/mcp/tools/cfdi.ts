import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { venuesWithFeatureAccess } from '@/services/access/basePlan.service'
import { hasPermission } from '@/services/access/access.service'
import { emitRefundCreditNote, getRefundCreditNoteStatus } from '@/services/fiscal/cfdiCreditNote.service'
import { sendCfdiByEmail } from '@/services/fiscal/cfdiEmail.service'
import { vistaPreviaContrato, confirmarContratoIvaIncluido } from '@/services/fiscal/confirmarContratoDePrecio.service'
import { DEFAULT_TIMEZONE } from '@/utils/datetime'

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
          // id + venueId: lo que send_cfdi_email necesita para reenviarla.
          id: true,
          venueId: true,
          serie: true,
          folio: true,
          uuid: true,
          totalCents: true,
          receptorNombre: true,
          stampedAt: true,
          cancelStatus: true,
          venue: { select: { name: true } },
          // Una factura SUSTITUIDA sigue STAMPED hasta que el SAT confirme su cancelación. Sin esto
          // el operador ve la equivocada y la corregida como dos ventas distintas.
          replacedBy: { select: { serie: true, folio: true, uuid: true }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: { stampedAt: 'desc' },
        take: limit,
      })

      // ¿Facturapi nos avisa solo cuando el SAT resuelve una cancelación? Sin webhook, la factura cancelada se
      // entera por la revisión de cada hora. Pocos emisores por venue: consulta acotada.
      const emisores = await prisma.fiscalEmisor.findMany({
        where: { venueId: { in: cfdiVenueIds }, provider: 'FACTURAPI' },
        select: { rfc: true, webhookId: true, webhookConfiguredAt: true, venue: { select: { name: true } } },
        take: 50,
      })

      return text({
        venuesInScope: cfdiVenueIds.length,
        avisosDeFacturapi: emisores.map(e => ({
          venue: e.venue?.name,
          rfc: e.rfc,
          webhookActivo: Boolean(e.webhookId),
          desde: e.webhookConfiguredAt,
        })),
        byStatus,
        stamped: { count: stamped._count._all, totalMxn: (stamped._sum.totalCents ?? 0) / 100 },
        recentStamped: recent.map(r => ({
          id: r.id,
          venueId: r.venueId,
          folio: `${r.serie ?? ''}${r.folio ?? ''}` || null,
          uuid: r.uuid,
          totalMxn: r.totalCents / 100,
          receptor: r.receptorNombre,
          stampedAt: r.stampedAt,
          venue: r.venue?.name,
          // null = vigente. Con valor: esta factura se corrigió y la cancelación puede seguir en trámite.
          sustituidaPor: r.replacedBy[0] ? `${r.replacedBy[0].serie ?? ''}${r.replacedBy[0].folio ?? ''}` || r.replacedBy[0].uuid : null,
          // true = se pidió cancelarla y el SAT aún no la confirma: sigue vigente, pero no se puede refacturar la venta todavía.
          cancelacionEnTramite: r.cancelStatus === 'REQUESTED',
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
      lookupOnly: z
        .boolean()
        .optional()
        .describe('Conserva el valor de confirmationArgs: true sólo consulta el intento previo; false confirma una nueva emisión.'),
    },
    async ({ venueId, refundPaymentId, confirm, lookupOnly }) => {
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
      const recoveryOnly = lookupOnly === true || status.recoveryOnly
      // La MISMA regla que apaga el botón del dashboard — el MCP no puede ser más permisivo.
      if (!recoveryOnly && !status.eligibility.eligible) {
        return text({ ok: false, reason: status.eligibility.reason, error: status.eligibility.message })
      }

      if (recoveryOnly && !status.creditNote) return text({ ok: false, error: 'No hay una nota de crédito enviada para consultar.' })
      if (!confirm && recoveryOnly && status.creditNote) {
        const cn = status.creditNote!
        return text({
          ok: false,
          requiresConfirmation: true,
          confirmationArgs: { venueId, refundPaymentId, confirm: true, lookupOnly: true },
          preview: { importeAcreditadoMxn: cn.totalCents / 100, receptor: { rfc: cn.receptorRfc, nombre: cn.receptorNombre } },
          message: `Se consultará la nota de crédito ya enviada por $${(cn.totalCents / 100).toFixed(2)} para ${cn.receptorNombre}. No se emitirá otra. Para consultar, conserva y usa los confirmationArgs completos, incluido lookupOnly:true.`,
        })
      }
      if (!confirm || (!recoveryOnly && status.creditNote && lookupOnly === undefined)) {
        const p = status.preview!
        const amountMxn = p.amountToCreditCents / 100
        return text({
          ok: false,
          requiresConfirmation: true,
          confirmationArgs: { venueId, refundPaymentId, confirm: true, lookupOnly: false },
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
            ' Es IRREVERSIBLE (deshacerla exige cancelarla ante el SAT). Para ejecutar, conserva y usa los confirmationArgs completos, incluido lookupOnly:false.',
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
          lookupOnly: recoveryOnly,
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

  // ─── Reenviar por correo una factura timbrada (H24, auditoría 2026-09-30) ─────────
  server.tool(
    'send_cfdi_email',
    'Envía por correo una factura (CFDI) ya timbrada: el PDF y el XML al correo del receptor que se registró al facturar, o a otro correo que indiques. No cambia la factura. Pide confirmación en dos pasos.',
    {
      venueId: z.string().describe('El local de la factura (debe estar en tu alcance)'),
      cfdiId: z.string().describe('Id de la factura'),
      email: z
        .string()
        .trim()
        .email('El correo no es válido')
        .optional()
        .describe('Correo al que mandarla; sin él, al del receptor registrado'),
      confirm: z.boolean().optional().describe('true para enviar; sin él sólo devuelve la vista previa'),
    },
    async ({ venueId, cfdiId, email, confirm }) => {
      guard.venueFilter(venueId)
      // Mismo permiso que el botón «Reenviar por correo» del dashboard.
      guard.requirePermission('cfdi:issue', venueId)
      const entitled = await venuesWithFeatureAccess([venueId], 'CFDI')
      if (!entitled.has(venueId)) {
        return text({ ok: false, planRequired: true, feature: 'CFDI', error: 'La facturación no está activa en este local.' })
      }
      const cfdi = await prisma.cfdi.findFirst({
        where: { id: cfdiId, venueId },
        select: { status: true, serie: true, folio: true, uuid: true, receptorNombre: true, receptorRfc: true },
      })
      if (!cfdi) return text({ ok: false, error: 'No encontré esa factura en tus locales.' })
      if (cfdi.status !== 'STAMPED') return text({ ok: false, error: 'Sólo se puede enviar por correo una factura timbrada.' })

      const folio = [cfdi.serie, cfdi.folio].filter(Boolean).join('-') || cfdi.uuid
      const destino = email ?? 'el correo del receptor registrado al facturar'
      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          confirmationArgs: { venueId, cfdiId, ...(email ? { email } : {}), confirm: true },
          preview: { folio, receptor: { nombre: cfdi.receptorNombre, rfc: cfdi.receptorRfc }, destino },
          message: `Se enviará la factura ${folio} (${cfdi.receptorNombre}) a ${destino}.`,
        })
      }
      try {
        const result = await sendCfdiByEmail({
          cfdiId,
          venueId,
          // `process.env` y no `@/config/env`: ver la nota de emit_refund_credit_note.
          sandbox: process.env.NODE_ENV !== 'production',
          origin: 'MCP',
          staffId: scope.staffId,
          email,
        })
        await auditMcpWrite(scope, {
          action: 'CFDI_EMAIL_SENT_MCP',
          entity: 'Cfdi',
          entityId: cfdiId,
          venueId,
          data: { folio: result.folio, destination: result.destination },
        })
        return text({ ok: true, folio: result.folio, destino: result.destination })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  // ─── Confirmar el contrato de precio de una venta VIEJA (IVA por producto, plan 2) ─────────
  //
  // Sólo corrige el DATO que la facturación va a leer: no emite, cancela ni toca ningún CFDI. Dos
  // pasos, igual que la nota de crédito de arriba, porque otra persona puede tocar la venta entre
  // la vista previa y la confirmación — el candado es la versión Y la huella que la persona vio
  // (B3b: hay escritores que cambian la venta sin subir la versión). La huella es OBLIGATORIA: si
  // fuera opcional, esta puerta conservaría el hueco que la huella cierra en el dashboard.
  server.tool(
    'confirm_order_price_contract',
    'Confirma que una venta VIEJA — de antes de que este negocio empezara a marcar el IVA por producto — se cobró con el IVA YA incluido en el precio (como se cobra normalmente en México). Sólo aplica a ventas cuyo tratamiento de IVA se desconoce; una vez confirmada, esa venta se puede facturar con el IVA de cada producto. NO emite, cancela ni modifica ninguna factura — sólo corrige el dato. Sin confirm, sólo devuelve la vista previa con su version y su huella. Para ejecutar, vuelve a llamar con confirm:true, la version, la huella tal cual y un motivo; sin la huella no se escribe nada (devuelve una vista previa nueva), y si la venta cambió desde la vista previa tampoco.',
    {
      venueId: z.string().describe('El local de la venta (debe estar en tu alcance)'),
      orderId: z.string().describe('Id de la venta a confirmar'),
      confirm: z.boolean().optional().describe('true para ejecutar; sin él sólo devuelve la vista previa'),
      version: z.number().int().optional().describe('La versión que viste en la vista previa (obligatoria con confirm:true)'),
      huella: z
        .string()
        .optional()
        .describe(
          'La huella que te devolvió la vista previa, tal cual (obligatoria con confirm:true; sin ella sólo devuelve la vista previa)',
        ),
      motivo: z.string().optional().describe('Por qué se sabe que esta venta cobró el IVA incluido (obligatorio con confirm:true)'),
    },
    async ({ venueId, orderId, confirm, version, huella, motivo }) => {
      guard.venueFilter(venueId)
      // Revisión final (F4): corregir el contrato de precio de una venta VIEJA es una decisión de
      // configuración fiscal del negocio (no un timbrado del día a día) — el spec la reserva al
      // dueño (OWNER/ADMIN) o al superadmin. `cfdi:configure` es exactamente ese permiso; MANAGER
      // NO lo tiene (ver src/lib/permissions.ts).
      guard.requirePermission('cfdi:configure', venueId)
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

      // B3b: sin huella no se escribe nada — ni con confirm:true. Sale una vista previa nueva (con su
      // versión y su huella) y la instrucción de volver a llamar con ellas.
      if (!confirm || !huella) {
        const preview = await vistaPreviaContrato(venueId, orderId)
        if (!preview) return text({ ok: false, error: 'No encontré esa venta en este negocio.' })
        if (!preview.confirmable) return text({ ok: false, error: preview.motivo })

        const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
        // El servicio no conoce el timezone del venue (F3) — se calcula aquí y se agrega al
        // objeto que se devuelve, para que quien lea `preview` tenga la fecha local sin tener
        // que parsear el mensaje.
        const fechaLocal = formatInTimeZone(preview.createdAt, venue?.timezone ?? DEFAULT_TIMEZONE, 'dd/MM/yyyy')

        // F3: nunca decir «cobrada» de una venta que no se ha cobrado — el monto y la palabra
        // dependen de `paymentStatus`, no del total de la orden.
        const montoTexto =
          preview.paymentStatus === 'PAID'
            ? `pagada $${preview.paidAmountMxn.toFixed(2)}`
            : `sin cobrar (total $${preview.totalMxn.toFixed(2)})`

        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { ...preview, fechaLocal },
          message:
            `Esto marcará la venta #${preview.orderNumber} (${montoTexto}, ${fechaLocal}) con el IVA YA incluido en el precio. ` +
            'Con eso podrá facturarse con el IVA de cada producto. No emite ni cancela ninguna factura. ' +
            `Para confirmar, llama otra vez con confirm: true, version: ${preview.version}, huella: "${preview.huella}" y un motivo.`,
        })
      }

      if (version === undefined) {
        return text({
          ok: false,
          error: 'Falta version: pide la vista previa primero (sin confirm) y usa la version y la huella que te devuelva.',
        })
      }
      if (!motivo || !motivo.trim()) {
        return text({ ok: false, error: 'Falta motivo: di en una frase por qué se sabe que esta venta cobró el IVA incluido.' })
      }

      // F9: si el servicio lanza (p. ej. la escritura de auditoría revienta por FK, o se cae la
      // conexión a media transacción), el tool no debe tronar — responde ok:false, como hace
      // `emit_refund_credit_note` arriba.
      let result: Awaited<ReturnType<typeof confirmarContratoIvaIncluido>>
      try {
        result = await confirmarContratoIvaIncluido({
          venueId,
          orderId,
          versionVista: version,
          huellaVista: huella,
          staffId: scope.staffId,
          motivo,
        })
      } catch (err) {
        logger.error('[mcp] confirm_order_price_contract: fallo inesperado al confirmar el contrato', {
          venueId,
          orderId,
          error: (err as Error).message,
        })
        return text({ ok: false, error: 'No se pudo confirmar el contrato de precio de esta venta. Intenta de nuevo.' })
      }
      if (!result.ok) return text({ ok: false, error: result.message })

      await auditMcpWrite(scope, {
        action: 'ORDER_PRICE_CONTRACT_CONFIRMED_MCP',
        entity: 'Order',
        entityId: orderId,
        venueId,
        data: { motivo, version },
      })
      return text({ ok: true })
    },
  )
}
