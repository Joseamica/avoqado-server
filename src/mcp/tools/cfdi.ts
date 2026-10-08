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
import {
  emitirGlobalComplementaria,
  issueGlobalForEmisor,
  listarExcluidasDeLaGlobal,
  vistaPreviaComplementaria,
  vistaPreviaPrincipal,
  type IssueGlobalResult,
} from '@/services/fiscal/cfdiGlobal.service'
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

  // ─── Emitir la factura GLOBAL a mano: la principal de un periodo reciente, o la complementaria de una principal (C1, Tarea 11) ─────────
  server.tool(
    'emit_global_invoice',
    'Emite una factura global (CFDI a público en general). PRINCIPAL: la de un periodo cerrado RECIENTE (desde = su inicio). COMPLEMENTARIA: la de las ventas que ninguna global vigente de su periodo documenta, por el id de su global principal. Pide confirmación en dos pasos.',
    {
      venueId: z.string().describe('El local (debe estar en tu alcance)'),
      emisorId: z.string().optional().describe('El RFC emisor; sin él, el único del local'),
      tipo: z.enum(['PRINCIPAL', 'COMPLEMENTARIA']).describe('PRINCIPAL o COMPLEMENTARIA'),
      desde: z.string().optional().describe('PRINCIPAL: el inicio del periodo (ISO, tal como lo da el panel de periodos)'),
      principalCfdiId: z.string().optional().describe('COMPLEMENTARIA: el id de la factura global principal'),
      confirm: z.boolean().optional().describe('true para emitir; sin él sólo devuelve la vista previa'),
    },
    async ({ venueId, emisorId, tipo, desde, principalCfdiId, confirm }) => {
      guard.venueFilter(venueId)
      // Mismo permiso que el botón «Emitir» del panel de la factura global (OWNER/ADMIN).
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
      if (tipo === 'COMPLEMENTARIA' && !principalCfdiId)
        return text({ ok: false, error: 'Para una complementaria indica principalCfdiId (el id de la factura global principal).' })
      if (tipo === 'PRINCIPAL' && !desde)
        return text({ ok: false, error: 'Para la principal indica desde: el inicio del periodo, tal como lo da el panel de periodos.' })
      // El RFC: el indicado, o el único del local (con varios, se pregunta cuál).
      const emisores = await prisma.fiscalEmisor.findMany({
        where: { venueId, ...(emisorId ? { id: emisorId } : {}) },
        select: { id: true, rfc: true, legalName: true },
        orderBy: { id: 'asc' },
        take: 20,
      })
      if (!emisores.length)
        return text({ ok: false, error: emisorId ? 'No encontré ese RFC emisor en este local.' : 'Este local no tiene RFC emisor.' })
      if (emisores.length > 1)
        return text({
          ok: false,
          needsInput: true,
          field: 'emisorId',
          question: '¿Con cuál RFC emisor?',
          opciones: emisores.map(e => ({ emisorId: e.id, rfc: e.rfc, nombre: e.legalName })),
        })
      const emisor = emisores[0]
      const now = new Date()
      // La vista previa sale del mismo servicio que la emisión: el periodo GUARDADO de la principal (complementaria) o uno reciente (principal).
      let vista: { periodo: unknown; estado: string; ventas: { n: number; completo: boolean }; motivo: string | null; tope?: boolean }
      try {
        if (tipo === 'COMPLEMENTARIA') {
          const v = await vistaPreviaComplementaria({ venueId, emisorId: emisor.id, principalId: principalCfdiId!, now })
          vista = {
            periodo: v.periodo,
            estado: v.estadoPrincipal,
            ventas: v.corregidasPendientes,
            motivo: v.motivo,
            tope: !v.siguienteLlave,
          }
        } else {
          const v = await vistaPreviaPrincipal({ venueId, emisorId: emisor.id, desde: desde!, now })
          // Ronda 1 de la T11 (I3): el periodo ya tiene su principal (timbrada o cancelada): emitirla otra vez no timbra nada (o se queda
          // «procesando»); lo que falta va en una COMPLEMENTARIA. Ni vista previa ni emisión.
          if (v.estado === 'TIMBRADA' || v.estado === 'CANCELADA')
            return text({
              ok: false,
              error:
                'Ese periodo ya tiene su factura global principal; para las ventas que no entraron usa tipo COMPLEMENTARIA con principalCfdiId.',
              principalCfdiId: v.cfdiId,
            })
          vista = { periodo: v.periodo, estado: v.estado, ventas: v.ventas, motivo: v.motivo }
        }
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
      if (vista.motivo) return text({ ok: false, error: vista.motivo })
      if (vista.tope) return text({ ok: false, error: 'Este periodo ya tiene 20 facturas globales complementarias; pide ayuda a soporte.' })
      if (!confirm) {
        const cuantas = vista.ventas.completo ? `${vista.ventas.n}` : `al menos ${vista.ventas.n}`
        return text({
          ok: true,
          requiresConfirmation: true,
          tipo,
          periodo: vista.periodo,
          estado: vista.estado,
          ventas: vista.ventas,
          confirmationArgs: {
            venueId,
            ...(emisorId ? { emisorId } : {}),
            tipo,
            ...(desde ? { desde } : {}),
            ...(principalCfdiId ? { principalCfdiId } : {}),
            confirm: true,
          },
          message:
            `Se timbrará ante el SAT una factura global ${tipo === 'COMPLEMENTARIA' ? 'COMPLEMENTARIA' : 'principal'} del RFC ${emisor.rfc} ` +
            `con ${cuantas} venta(s) de su periodo. Es irreversible (sólo se cancela ante el SAT) y es tardía: el periodo ya cerró.`,
        })
      }
      let r: IssueGlobalResult
      try {
        r =
          tipo === 'COMPLEMENTARIA'
            ? await emitirGlobalComplementaria({
                venueId,
                emisorId: emisor.id,
                principalId: principalCfdiId!,
                now,
                // `process.env` y no `@/config/env`: ver la nota de emit_refund_credit_note.
                sandbox: process.env.NODE_ENV !== 'production',
              })
            : await issueGlobalForEmisor({ emisorId: emisor.id, now, sandbox: process.env.NODE_ENV !== 'production', desde: desde! })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
      const excluidas = r.excluidas ?? {}
      // Ronda 1 (m4): ya estaba timbrada (otra solicitud llegó antes): no se audita ni se reporta como emisión nueva.
      if (r.status === 'STAMPED' && r.yaTimbrada)
        return text({
          ok: true,
          status: r.status,
          yaTimbrada: true,
          folio: `${r.cfdi.serie ?? ''}${r.cfdi.folio ?? ''}` || null,
          uuid: r.cfdi.uuid,
          message: 'Esta factura global ya estaba timbrada; no se emitió otra.',
          excluidas,
          ...(r.complementariaDe ? { complementariaDe: r.complementariaDe } : {}),
        })
      if (r.status !== 'STAMPED') {
        const motivo =
          r.status === 'NOTHING_TO_INVOICE'
            ? 'No hay ventas por facturar en este periodo.'
            : r.status === 'STAMP_FAILED'
              ? (r.cfdi?.lastError ?? 'El PAC rechazó el timbrado.')
              : (r.reasons?.join(' | ') ?? r.reason ?? null)
        return text({ ok: r.status === 'NOTHING_TO_INVOICE', status: r.status, motivo, excluidas })
      }
      await auditMcpWrite(scope, {
        action: 'CFDI_GLOBAL_ISSUED',
        entity: 'Cfdi',
        entityId: r.cfdi.id,
        venueId,
        data: {
          emisorId: emisor.id,
          period: r.period ? `${r.period.meses}/${r.period.anio}` : null,
          count: r.candidateCount ?? 0,
          uuid: r.cfdi.uuid,
          excluidas,
          ajustes: r.cfdi.entrada?.ajustes ?? [],
          complementariaDe: r.cfdi.entrada?.complementariaDe ?? r.complementariaDe ?? null,
        },
      })
      return text({
        ok: true,
        status: r.status,
        folio: `${r.cfdi.serie ?? ''}${r.cfdi.folio ?? ''}` || null,
        uuid: r.cfdi.uuid,
        excluidas,
        ...(r.complementariaDe ? { complementariaDe: r.complementariaDe } : {}),
      })
    },
  )

  // ─── Las ventas que no entraron a la factura global, y por qué (C1, Tarea 12) ─────────
  server.tool(
    'global_invoice_excluded_sales',
    'Lista las ventas de un periodo que NO entraron a la factura global (CFDI a público en general) y por qué (motivo, texto y detalle de cada una, con su folio y lo cobrado). Periodo: el de una global que ya existe (principalCfdiId, aunque la periodicidad haya cambiado), uno reciente (desde = su inicio, tal como lo da el panel de periodos) o, sin nada, el último cerrado. totales y corregidasPendientes (las que irían en una complementaria) sólo en la primera página; completo: false = «al menos N». ultimaCaptura es la estadística de cuando se capturó la global, aparte. globalApagada: true = la factura global de Avoqado está apagada para este RFC (ningún comercio suyo con «Incluir en la factura global» y el interruptor de ventas fuera de la terminal apagado): normal si su contador la emite por su cuenta. Sólo lectura.',
    {
      venueId: z.string().describe('El local (debe estar en tu alcance)'),
      emisorId: z.string().optional().describe('El RFC emisor; sin él, el único del local'),
      principalCfdiId: z.string().optional().describe('El id de una factura global principal que ya existe (su periodo guardado)'),
      desde: z.string().optional().describe('El inicio de un periodo reciente (ISO, tal como lo da el panel de periodos)'),
      cursor: z.string().optional().describe('El `siguiente` de la página anterior'),
      limite: z.number().int().min(1).max(50).optional().describe('Ventas por página (1 a 50; por omisión 50)'),
    },
    async ({ venueId, emisorId, principalCfdiId, desde, cursor, limite }) => {
      guard.venueFilter(venueId)
      // Mismo permiso que la lista del panel de la factura global (lectura).
      guard.requirePermission('cfdi:view', venueId)
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
      // El RFC: el indicado, o el único del local (con varios, se pregunta cuál).
      const emisores = await prisma.fiscalEmisor.findMany({
        where: { venueId, ...(emisorId ? { id: emisorId } : {}) },
        select: { id: true, rfc: true, legalName: true },
        orderBy: { id: 'asc' },
        take: 20,
      })
      if (!emisores.length)
        return text({ ok: false, error: emisorId ? 'No encontré ese RFC emisor en este local.' : 'Este local no tiene RFC emisor.' })
      if (emisores.length > 1)
        return text({
          ok: false,
          needsInput: true,
          field: 'emisorId',
          question: '¿Con cuál RFC emisor?',
          opciones: emisores.map(e => ({ emisorId: e.id, rfc: e.rfc, nombre: e.legalName })),
        })
      try {
        const r = await listarExcluidasDeLaGlobal({
          venueId,
          emisorId: emisores[0].id,
          now: new Date(),
          ...(principalCfdiId ? { principalId: principalCfdiId } : {}),
          ...(desde ? { desde } : {}),
          ...(cursor ? { cursor } : {}),
          ...(limite !== undefined ? { limite } : {}),
        })
        return text({
          ok: true,
          periodo: r.periodo,
          estadoDelPeriodo: r.estadoDelPeriodo,
          totales: r.totales,
          corregidasPendientes: r.corregidasPendientes,
          ultimaCaptura: r.ultimaCaptura,
          ventas: r.excluidas.map(x => ({ ...x, cobradoMxn: x.cobradoCents / 100 })),
          siguiente: r.siguiente,
          // Ola final de C1: true ⇒ la factura global de Avoqado está APAGADA para este RFC (ningún comercio suyo en la global y el
          // interruptor de las ventas fuera de la terminal apagado): lo que no entró es por eso, no un error.
          globalApagada: r.globalApagada,
        })
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
