import { DONDE_TIMBRE_EN_DUDA, textoDeTimbreEnDuda, timbreEnDuda } from '../../services/fiscal/timbreEnDuda'
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
import { emitRefundCreditNote, getRefundCreditNoteStatus, type RefundCreditNoteStatus } from '@/services/fiscal/cfdiCreditNote.service'
import { operationHash } from '@/utils/operationHash'
import { sendCfdiByEmail } from '@/services/fiscal/cfdiEmail.service'
import { estadoDeCancelacion, type EstadoDeCancelacion } from '@/services/fiscal/cfdi.service'
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
import { MOTIVO_MODALIDAD_NO_PERMITIDA } from '@/services/fiscal/saldoFiscal'

/**
 * C2: lo que el operador tiene que leer cuando la cancelación quedó EN DUDA (el POST no tuvo respuesta clara). T10 (R2 e I3 de la T2): la
 * duda puede durar hasta 24 h (`PLAZO_DE_LA_DUDA_MS`) y el dashboard ofrece «Consultar estado» (sólo consulta; nunca vuelve a enviar).
 */
export const TEXTO_CANCELACION_EN_DUDA =
  'Cancelación en duda: la estamos confirmando con el SAT (puede tardar hasta 24 horas). La factura sigue vigente mientras tanto. No la pidas otra vez; si quieres saber ya, pulsa «Consultar estado» en la lista de facturas: sólo consulta. Si en 24 horas el SAT no la registra, se cierra y podrás pedirla otra vez.'
function textoDeCancelacion(estado: EstadoDeCancelacion): { cancelacion?: string } {
  return estado === 'CANCELACION_EN_DUDA' ? { cancelacion: TEXTO_CANCELACION_EN_DUDA } : {}
}

type DesgloseDeNota = Array<{ tratamiento: string; cents: number; baseCents: number; ivaCents: number }>
const NOMBRE_DEL_TRATAMIENTO: Record<string, string> = {
  IVA_16: 'IVA 16 %',
  IVA_8: 'IVA 8 %',
  IVA_0: 'IVA 0 %',
  EXENTO: 'exento',
  NO_OBJETO: 'no objeto',
}
/** C2: lo que se acreditaría por tasa, en pesos. */
function desgloseMxn(d: DesgloseDeNota) {
  return d.map(x => ({ tratamiento: x.tratamiento, importeMxn: x.cents / 100, baseMxn: x.baseCents / 100, ivaMxn: x.ivaCents / 100 }))
}
function textoDelDesglose(d: DesgloseDeNota): string {
  return d.map(x => `${NOMBRE_DEL_TRATAMIENTO[x.tratamiento] ?? x.tratamiento}: $${(x.cents / 100).toFixed(2)}`).join(', ')
}
/** C2 · T8: la original puede ser la factura GLOBAL en la que entró el ticket; se dice. */
function facturaOriginalMcp(f: { folio: string; uuid: string; totalCents: number; esGlobal?: boolean }) {
  return { folio: f.folio, uuid: f.uuid, totalMxn: f.totalCents / 100, ...(f.esGlobal ? { esGlobal: true } : {}) }
}
/** C2 · T10: una nota relacionada con una global va a Público en General (RFC genérico); se dice. */
function nombreDeLaFactura(f: { folio: string; esGlobal?: boolean }): string {
  return f.esGlobal ? `factura global ${f.folio} (Público en General)` : `factura ${f.folio}`
}

// ─── C2 · T10: la vista previa en palabras (desglose por IVA y redondeo declarado) ──────────────────────────────────────────────────
const TASA_DEL_TRATAMIENTO: Record<string, string> = {
  IVA_16: '16 %',
  IVA_8: '8 %',
  IVA_0: '0 %',
  EXENTO: 'exento',
  NO_OBJETO: 'no objeto',
}
/** C2 · T10: lo que se acreditaría por tasa, en pesos (total, base e IVA). Nuevo y opcional: `desglose` se conserva tal cual. */
function desglosePorIva(d: DesgloseDeNota) {
  return d.map(x => ({
    tasa: TASA_DEL_TRATAMIENTO[x.tratamiento] ?? x.tratamiento,
    mxn: x.cents / 100,
    baseMxn: x.baseCents / 100,
    ivaMxn: x.ivaCents / 100,
  }))
}
type RedondeoDeNotaMcp = { tratamiento: string; componente: string; cents: number; ambito: string }
const COMPONENTE_DEL_REDONDEO: Record<string, string> = { BASE: 'en la base', IVA: 'en el IVA', ARTICULO: 'en un artículo' }
const AMBITO_DEL_REDONDEO: Record<string, string> = {
  FACTURA: '',
  TICKET: ' (del ticket en la factura global)',
  DOCUMENTO_GLOBAL: ' (de la factura global)',
}
/**
 * C2 · T10 (Codex C2-15, P8): cada centavo de redondeo declarado, en una frase. 🔴 T8 N4: el del documento global es una COTA (la suma de
 * las notas vivas: de más si una se cancela o se recaptura, nunca de menos) ⇒ «hasta N ¢».
 */
function avisoDeRedondeo(r: RedondeoDeNotaMcp): string {
  const tasa = TASA_DEL_TRATAMIENTO[r.tratamiento] ?? r.tratamiento
  const deLaTasa = /%$/.test(tasa) ? `del ${tasa}` : `de lo ${tasa}`
  const cuanto = r.ambito === 'DOCUMENTO_GLOBAL' ? `hasta ${r.cents} ¢` : `${r.cents} ¢`
  const donde = COMPONENTE_DEL_REDONDEO[r.componente] ?? `en ${r.componente}`
  return `La nota incluye ${cuanto} de redondeo del SAT ${donde} ${deLaTasa}${AMBITO_DEL_REDONDEO[r.ambito] ?? ` (${r.ambito})`}.`
}
function avisosDeRedondeo(r: RedondeoDeNotaMcp[] | undefined): { avisosDeRedondeo?: string[] } {
  return r && r.length ? { avisosDeRedondeo: r.map(avisoDeRedondeo) } : {}
}
const textoDeLosAvisos = (r: RedondeoDeNotaMcp[] | undefined) => (r && r.length ? ` ${r.map(avisoDeRedondeo).join(' ')}` : '')

// ─── C2 · T9 ronda 1: el protocolo de dos pasos que entiende el catálogo (`configureToolCatalog`) ───────────────────────────────────────
//
// El catálogo firma el `confirmationToken` sobre la ENTRADA del paso 1 (sin `confirm`) más los campos que copia de la respuesta
// (`expectedSourceFingerprint`, …) y en el paso 2 exige esos mismos argumentos. Por eso los `confirmationArgs` de toda herramienta de dos
// pasos son EXACTAMENTE eso + `confirm: true` (como `send_cfdi_email`): un campo que sólo aparece en el paso 2 cambia lo firmado y el
// catálogo responde `needsInput`. Lo que el paso 2 necesita y no se conoce en el paso 1 (una huella, una versión) viaja en
// `expectedSourceFingerprint`, que el catálogo copia.

/** Los argumentos del paso 2: la entrada del paso 1 tal cual (sin `confirm`, sin el token, sin campos vacíos) + `extra` + `confirm: true`. */
export function argsDeConfirmacion(args: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { confirm: _confirm, confirmationToken: _token, ...entrada } = { ...args, ...extra }
  return { ...Object.fromEntries(Object.entries(entrada).filter(([, v]) => v !== undefined)), confirm: true }
}
/** Sólo para las que atan la huella de la vista previa y no hacen nada si cambió (`emit_refund_credit_note`, `confirm_order_price_contract`). */
export const INSTRUCCION_DE_CONFIRMACION =
  'Para ejecutar, llama otra vez con los confirmationArgs TAL CUAL (traen confirm:true y la huella de esta vista previa) junto con el confirmationToken. Si algo cambia antes, no se hace nada y se pide otra vista previa.'
/** OF-1 (T9 N-2): las que no llevan huella (`send_cfdi_email`, `emit_global_invoice`) prometen sólo lo que hace el token del catálogo. */
export const INSTRUCCION_DE_CONFIRMACION_SIN_HUELLA =
  'Para ejecutar, llama otra vez con los confirmationArgs TAL CUAL (traen confirm:true) junto con el confirmationToken; con otros argumentos el token no sirve y no se hace nada.'
export const MOTIVO_VISTA_PREVIA_VIEJA =
  'Lo que se iba a hacer cambió desde la vista previa (o falta su huella). No se hizo nada: pide la vista previa otra vez (sin confirm) y confirma con sus confirmationArgs.'

/** `confirm_order_price_contract`: «version:huella» ⇒ las dos; `null` si no viene o no se lee. */
function desdeLaHuella(fp: string | undefined): { version: number; huella: string } | null {
  const m = fp ? /^(\d+):(.+)$/.exec(fp) : null
  return m ? { version: Number(m[1]), huella: m[2] } : null
}

type PlanDeLaNota =
  | { respuesta: Record<string, unknown> }
  | {
      accion: 'CONSULTAR' | 'EMITIR' | 'POR_IMPORTE'
      huella: string
      preview: Record<string, unknown>
      mensaje: string
      /** T10 ronda 1 (M9): la huella del SERVIDOR de lo que se timbraría (`preview.huella`); el servicio la compara bajo los candados. */
      huellaDelServidor?: string
    }

/**
 * `emit_refund_credit_note`: lo que se haría con el estado de AHORA —consultar el intento ya enviado, emitir, o emitir «por importe»— con
 * su vista previa y su huella; o la respuesta de por qué no. Es la MISMA decisión en los dos pasos: si entre ellos cambió (otra acción, otra
 * nota previa, otro importe), la huella no coincide y no se hace nada. «Por importe» usa la huella del reparto del servidor (que el
 * servicio vuelve a comparar bajo los candados).
 */
function planDeLaNota(
  status: RefundCreditNoteStatus,
  o: { refundPaymentId: string; lookupOnly?: boolean; modalidad?: 'POR_IMPORTE' },
): PlanDeLaNota {
  const cn = status.creditNote
  if (o.lookupOnly === true || status.recoveryOnly) {
    if (!cn) return { respuesta: { ok: false, error: 'No hay una nota de crédito enviada para consultar.' } }
    return {
      accion: 'CONSULTAR',
      huella: operationHash({
        accion: 'CONSULTAR',
        refundPaymentId: o.refundPaymentId,
        nota: { id: cn.id, status: cn.status, totalCents: cn.totalCents },
      }),
      preview: { importeAcreditadoMxn: cn.totalCents / 100, receptor: { rfc: cn.receptorRfc, nombre: cn.receptorNombre } },
      mensaje: `Se consultará la nota de crédito ya enviada por $${(cn.totalCents / 100).toFixed(2)} para ${cn.receptorNombre}. No se emitirá otra.`,
    }
  }
  // C2 (Tarea 9, P10): «acreditar por importe» — sólo cuando la vista previa del servidor lo OFRECE (la misma regla que el panel).
  const alternativa = status.preview?.alternativa
  if (o.modalidad === 'POR_IMPORTE') {
    if (!alternativa)
      return {
        respuesta: {
          ok: false,
          reason: status.eligibility.eligible ? 'MODALIDAD_NO_PERMITIDA' : status.eligibility.reason,
          error: status.eligibility.eligible ? MOTIVO_MODALIDAD_NO_PERMITIDA : status.eligibility.message,
        },
      }
    const p = status.preview!
    const amountMxn = p.amountToCreditCents / 100
    const contra = p.facturaOriginal?.esGlobal ? 'lo que queda de este ticket en la factura global' : 'lo que queda en la factura'
    return {
      accion: 'POR_IMPORTE',
      huella: alternativa.huella,
      preview: {
        modalidad: 'POR_IMPORTE',
        motivo: status.eligibility.message,
        facturaOriginal: facturaOriginalMcp(p.facturaOriginal!),
        receptor: p.receptor,
        importeAcreditadoMxn: amountMxn,
        propinaDevueltaMxn: p.tipRefundCents / 100,
        desglose: desgloseMxn(alternativa.desglose),
        redondeo: alternativa.redondeo,
        // C2 · T10 (nuevos y opcionales): el desglose por tasa, si la original es una global y el redondeo en palabras.
        desglosePorIva: desglosePorIva(alternativa.desglose),
        facturaGlobal: p.facturaOriginal?.esGlobal === true,
        ...avisosDeRedondeo(alternativa.redondeo),
        ...(alternativa.aviso ? { aviso: alternativa.aviso } : {}),
        tipoRelacion: '01 (Nota de crédito de los documentos relacionados)',
        usoCfdi: 'G02 (Devoluciones, descuentos o bonificaciones)',
      },
      mensaje:
        `Esto TIMBRARÁ ante el SAT una nota de crédito POR IMPORTE por $${amountMxn.toFixed(2)} relacionada a la ` +
        `${nombreDeLaFactura(p.facturaOriginal!)} (receptor ${p.receptor!.nombre}): como no se puede comprobar cuánto se facturó de cada ` +
        `artículo, lo devuelto se acredita repartido por tasa en proporción a ${contra} (${textoDelDesglose(alternativa.desglose)}).` +
        textoDeLosAvisos(alternativa.redondeo) +
        (alternativa.aviso ? ` ${alternativa.aviso}` : '') +
        ' La factura original NO se cancela. Es IRREVERSIBLE (deshacerla exige cancelarla ante el SAT).',
    }
  }
  // La MISMA regla que apaga el botón del dashboard — el MCP no puede ser más permisivo.
  if (!status.eligibility.eligible)
    return {
      respuesta: {
        ok: false,
        reason: status.eligibility.reason,
        error: status.eligibility.message,
        // C2 (Tarea 9): la alternativa que el servidor ofrece, para que la persona decida (nunca se elige sola).
        ...(alternativa
          ? {
              alternativa: {
                modalidad: 'POR_IMPORTE',
                importeMxn: status.preview!.amountToCreditCents / 100,
                desglose: desgloseMxn(alternativa.desglose),
                redondeo: alternativa.redondeo,
                desglosePorIva: desglosePorIva(alternativa.desglose), // C2 · T10
                ...avisosDeRedondeo(alternativa.redondeo),
                ...(alternativa.aviso ? { aviso: alternativa.aviso } : {}),
              },
              sugerencia:
                'Se puede acreditar lo devuelto por importe (repartido por tasa en proporción a lo que queda). Si la persona lo quiere, vuelve a llamar con modalidad: "POR_IMPORTE" (sin confirm) para ver la vista previa y pedir su confirmación.',
            }
          : {}),
      },
    }
  const p = status.preview!
  const amountMxn = p.amountToCreditCents / 100
  const preview = {
    facturaOriginal: facturaOriginalMcp(p.facturaOriginal!),
    receptor: p.receptor,
    importeAcreditadoMxn: amountMxn,
    propinaDevueltaMxn: p.tipRefundCents / 100,
    // C2: lo que se acreditaría por tasa y el redondeo declarado (por componente y ámbito).
    ...(p.desglose ? { desglose: desgloseMxn(p.desglose), desglosePorIva: desglosePorIva(p.desglose) } : {}),
    ...(p.redondeo ? { redondeo: p.redondeo } : {}),
    // C2 · T10 (nuevos y opcionales): si la original es la factura global (la nota va a Público en General) y el redondeo en palabras.
    facturaGlobal: p.facturaOriginal?.esGlobal === true,
    ...avisosDeRedondeo(p.redondeo),
    // T10 ronda 1 (M5, nuevo y opcional): la facturación del comercio está apagada (la nota se emite igual), como lo dice el panel.
    ...(p.avisoFacturacionApagada ? { avisoFacturacionApagada: p.avisoFacturacionApagada } : {}),
    tipoRelacion: '01 (Nota de crédito de los documentos relacionados)',
    // El uso de la nota es SIEMPRE G02 (spec §4.5; el servidor lo manda en `preview.usoCfdi`): el texto es fijo.
    usoCfdi: 'G02 (Devoluciones, descuentos o bonificaciones)',
  }
  return {
    accion: 'EMITIR',
    // La nota previa (un intento fallido que se recapturaría) es parte de lo que se confirma. T10 ronda 1 (M9): también la huella del
    // SERVIDOR de lo que se timbraría (no se muestra; si cambió entre los pasos, no se hace nada).
    huella: operationHash({
      accion: 'EMITIR',
      refundPaymentId: o.refundPaymentId,
      nota: cn ? { id: cn.id, status: cn.status } : null,
      preview,
      huellaDelServidor: p.huella ?? null,
    }),
    ...(p.huella ? { huellaDelServidor: p.huella } : {}),
    preview,
    mensaje:
      `Esto TIMBRARÁ ante el SAT una nota de crédito por $${amountMxn.toFixed(2)} relacionada a la ` +
      `${nombreDeLaFactura(p.facturaOriginal!)} (receptor ${p.receptor!.nombre}). La factura original NO se cancela.` +
      (p.avisoFacturacionApagada ? ` ${p.avisoFacturacionApagada}` : '') +
      textoDeLosAvisos(p.redondeo) +
      (p.tipRefundCents > 0 ? ` La propina devuelta ($${(p.tipRefundCents / 100).toFixed(2)}) NO entra: nunca formó parte del CFDI.` : '') +
      ' Es IRREVERSIBLE (deshacerla exige cancelarla ante el SAT).',
  }
}

export function registerCfdiTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'cfdi_status',
    'CFDI 4.0 (facturación) status across your venues: invoice count by status (STAMPED = timbrada/issued; plus drafts, validation/stamp failures, and cancellations), the total stamped amount, and your most recent issued invoices (folio, UUID, receptor, amount). STAMP_FAILED includes `timbresEnDuda`: the PAC gave no clear answer and may have stamped them — they are NOT rejections, never re-issue them; reconciliation confirms them. Pass venueId to focus one venue.',
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
      // Ronda QA (hermanos): `byStatus.STAMP_FAILED` mezcla rechazos y timbres EN DUDA (el PAC no contestó claro; pudo timbrarlos y la
      // conciliación los confirma). Se cuentan aparte, con la MISMA regla (`DONDE_TIMBRE_EN_DUDA`), para no llamarlos «rechazados».
      const timbresEnDuda = await prisma.cfdi.count({ where: { ...where, ...DONDE_TIMBRE_EN_DUDA } })
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
          // C2: con estas dos se deriva si la cancelación está en trámite (acusada) o EN DUDA (enviada sin acuse).
          cancelEnviadaAt: true,
          cancelAcusadaAt: true,
          cancelIntento: true, // ronda 1 (M2): intento 0 = legado (enviada y acusada antes de C2)
          // T10 ronda 1 (M5): el porqué de una cancelación RECHAZADA (`motivoRechazoCancelacion`). Interno: el `lastError` crudo no sale.
          lastError: true,
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

      const ahora = new Date()
      return text({
        venuesInScope: cfdiVenueIds.length,
        avisosDeFacturapi: emisores.map(e => ({
          venue: e.venue?.name,
          rfc: e.rfc,
          webhookActivo: Boolean(e.webhookId),
          desde: e.webhookConfiguredAt,
        })),
        byStatus,
        // Ronda QA (hermanos, aditivo): cuántas de `byStatus.STAMP_FAILED` están EN DUDA (no son rechazos: no se re-emiten).
        timbresEnDuda,
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
          // C2: ANOTADA · ENVIANDO · EN_TRAMITE · CANCELACION_EN_DUDA · RECHAZADA · CANCELADA (null = nunca se pidió cancelarla).
          estadoCancelacion: estadoDeCancelacion(r, ahora),
          ...textoDeCancelacion(estadoDeCancelacion(r, ahora)),
          // T10 ronda 1 (M5): con la cancelación rechazada, POR QUÉ (el mismo texto que ve el panel). Nuevo y opcional.
          ...(estadoDeCancelacion(r, ahora) === 'RECHAZADA' && r.lastError ? { motivoRechazoCancelacion: r.lastError } : {}),
        })),
      })
    },
  )

  // ─── Nota de crédito (CFDI de EGRESO) por un reembolso ──────────────────────
  //
  // 🔴 Write IRREVERSIBLE: timbrar crea un documento fiscal real ante el SAT; deshacerlo
  // exige una cancelación (que el SAT puede rechazar). Por eso va con confirm de DOS pasos
  // con vista previa legible — regla `mcp-write-safety-confirm-gating`.
  //
  // C2 · T9 ronda 1 (I-2 y sus hermanos): el catálogo (`configureToolCatalog`) firma el token sobre la ENTRADA del paso 1 más los campos
  // que copia de la respuesta (`expectedSourceFingerprint`). Por eso los `confirmationArgs` son EXACTAMENTE eso + `confirm: true`, y lo que
  // se iba a hacer (consultar el intento enviado, emitir, emitir «por importe») queda atado a esa huella: si cambió entre los pasos, no se
  // hace nada y se pide otra vista previa (nunca una vista previa sin token: el bucle de antes).
  server.tool(
    'emit_refund_credit_note',
    'Emite la NOTA DE CRÉDITO (CFDI de Egreso) que ampara un reembolso ya hecho. La venta original NO se modifica y su factura NO se cancela: se emite un comprobante nuevo relacionado a ella (TipoRelacion 01, uso G02) por el importe devuelto. Irreversible: dos pasos. Paso 1, sin confirm: la vista previa con sus confirmationArgs. Paso 2: esos confirmationArgs TAL CUAL (traen confirm:true y la huella de lo que se vio) con el confirmationToken. Requiere que la venta YA tenga factura (CFDI de ingreso) timbrada y vigente.',
    {
      venueId: z.string().describe('El local del reembolso (debe estar en tu alcance)'),
      refundPaymentId: z.string().describe('Id del pago de tipo REFUND que se va a amparar'),
      confirm: z.boolean().optional().describe('true para ejecutar; sin él sólo devuelve la vista previa'),
      lookupOnly: z.boolean().optional().describe('Opcional, en el paso 1: true sólo consulta el intento ya enviado (nunca emite otro).'),
      modalidad: z
        .literal('POR_IMPORTE')
        .optional()
        .describe(
          '«Acreditar por importe», en el paso 1: sólo cuando la devolución por artículos no tiene evidencia de lo facturado. La vista previa devuelve el reparto por tasa.',
        ),
      expectedSourceFingerprint: z
        .string()
        .min(1)
        .optional()
        .describe('La huella de la vista previa, tal cual: la ponen los confirmationArgs (no se escribe a mano).'),
    },
    async args => {
      const { venueId, refundPaymentId, confirm, lookupOnly, modalidad, expectedSourceFingerprint } = args
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

      // Lo que se haría con el estado de AHORA (la misma decisión en los dos pasos): consultar el intento enviado, emitir, o emitir «por
      // importe»; o por qué no.
      const plan = planDeLaNota(status, { refundPaymentId, lookupOnly, modalidad })
      if ('respuesta' in plan) return text(plan.respuesta)
      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          // El catálogo copia este campo a confirmationArguments: el token queda atado a lo que se vio.
          expectedSourceFingerprint: plan.huella,
          confirmationArgs: argsDeConfirmacion(args, { expectedSourceFingerprint: plan.huella }),
          preview: plan.preview,
          message: `${plan.mensaje} ${INSTRUCCION_DE_CONFIRMACION}`,
        })
      }
      // Paso 2: sólo si lo que se va a hacer es lo que se vio. «Por importe» compara su huella del reparto en el servicio, bajo los
      // candados (si cambió: «El reparto cambió…» y no reserva nada).
      if (plan.accion !== 'POR_IMPORTE' && expectedSourceFingerprint !== plan.huella)
        return text({ ok: false, error: MOTIVO_VISTA_PREVIA_VIEJA })

      try {
        const result = await emitRefundCreditNote({
          venueId,
          refundPaymentId,
          // `process.env` a propósito y NO `@/config/env`: importar ese módulo desde un tool
          // corre la validación de entorno (y su `process.exit(1)`) dentro del worker de Jest.
          sandbox: process.env.NODE_ENV !== 'production',
          requestedByStaffId: scope.staffId,
          lookupOnly: plan.accion === 'CONSULTAR',
          ...(plan.accion === 'POR_IMPORTE' ? { modalidad: 'POR_IMPORTE' as const, huellaDelReparto: expectedSourceFingerprint } : {}),
          // T10 ronda 1 (M9): la emisión normal también ata lo que se vio hasta los candados (la huella del servidor, firmada en el paso 1
          // dentro de `expectedSourceFingerprint`). Un servidor que no la manda emite como siempre.
          ...(plan.accion === 'EMITIR' && plan.huellaDelServidor ? { huellaDelReparto: plan.huellaDelServidor } : {}),
        })
        if (result.status !== 'STAMPED') {
          // Ronda QA (hermanos): el PAC no contestó claro ⇒ EN DUDA, no «rechazó» ni el error crudo («fetch failed»).
          if (timbreEnDuda(result.cfdi))
            return text({ ok: false, status: result.status, enDuda: true, error: textoDeTimbreEnDuda('la nota de crédito') })
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
          data: {
            refundPaymentId,
            uuid: result.cfdi.uuid,
            amount: result.cfdi.totalCents / 100,
            ...(plan.accion === 'POR_IMPORTE' ? { modalidad: 'POR_IMPORTE_ELEGIDO' } : {}),
          },
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
    async args => {
      const { venueId, cfdiId, email, confirm } = args
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
          // T9 ronda 1: exactamente lo que firma el catálogo + confirm (la entrada del paso 1).
          confirmationArgs: argsDeConfirmacion(args),
          preview: { folio, receptor: { nombre: cfdi.receptorNombre, rfc: cfdi.receptorRfc }, destino },
          message: `Se enviará la factura ${folio} (${cfdi.receptorNombre}) a ${destino}. ${INSTRUCCION_DE_CONFIRMACION_SIN_HUELLA}`,
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
    async args => {
      const { venueId, emisorId, tipo, desde, principalCfdiId, confirm } = args
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
          // T9 ronda 1: exactamente lo que firma el catálogo + confirm (la entrada del paso 1).
          confirmationArgs: argsDeConfirmacion(args),
          message:
            `Se timbrará ante el SAT una factura global ${tipo === 'COMPLEMENTARIA' ? 'COMPLEMENTARIA' : 'principal'} del RFC ${emisor.rfc} ` +
            `con ${cuantas} venta(s) de su periodo (se toman las que haya al confirmar). Es irreversible (sólo se cancela ante el SAT) y es ` +
            `tardía: el periodo ya cerró. ${INSTRUCCION_DE_CONFIRMACION_SIN_HUELLA}`,
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
        // Ronda QA (hermanos): una global EN DUDA (el PAC no contestó claro) no es «el PAC rechazó».
        const enDuda = r.status === 'STAMP_FAILED' && timbreEnDuda(r.cfdi)
        const motivo =
          r.status === 'NOTHING_TO_INVOICE'
            ? 'No hay ventas por facturar en este periodo.'
            : enDuda
              ? textoDeTimbreEnDuda('la factura global')
              : r.status === 'STAMP_FAILED'
                ? (r.cfdi?.lastError ?? 'El PAC rechazó el timbrado.')
                : (r.reasons?.join(' | ') ?? r.reason ?? null)
        return text({ ok: r.status === 'NOTHING_TO_INVOICE', status: r.status, ...(enDuda ? { enDuda: true } : {}), motivo, excluidas })
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
    'Confirma que una venta VIEJA — de antes de que este negocio empezara a marcar el IVA por producto — se cobró con el IVA YA incluido en el precio (como se cobra normalmente en México). Sólo aplica a ventas cuyo tratamiento de IVA se desconoce; una vez confirmada, esa venta se puede facturar con el IVA de cada producto. NO emite, cancela ni modifica ninguna factura — sólo corrige el dato. Dos pasos. Paso 1, sin confirm y CON el motivo: la vista previa (con su version y su huella, que quedan en expectedSourceFingerprint) y sus confirmationArgs. Paso 2: esos confirmationArgs TAL CUAL con el confirmationToken. Sin motivo, la vista previa lo pide. Si la venta cambió desde la vista previa no se escribe nada.',
    {
      venueId: z.string().describe('El local de la venta (debe estar en tu alcance)'),
      orderId: z.string().describe('Id de la venta a confirmar'),
      confirm: z.boolean().optional().describe('true para ejecutar; sin él sólo devuelve la vista previa'),
      motivo: z
        .string()
        .optional()
        .describe('Por qué se sabe que esta venta cobró el IVA incluido. Va en el PASO 1 (la vista previa lo pide si falta)'),
      expectedSourceFingerprint: z
        .string()
        .optional()
        .describe('«version:huella» de la vista previa, tal cual: la ponen los confirmationArgs (no se escribe a mano)'),
      version: z.number().int().optional().describe('Compatibilidad: la versión que viste en la vista previa (usa confirmationArgs)'),
      huella: z.string().optional().describe('Compatibilidad: la huella que te devolvió la vista previa, tal cual (usa confirmationArgs)'),
    },
    async args => {
      const { venueId, orderId, confirm, motivo, expectedSourceFingerprint } = args
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

      // C2 · T9 ronda 1 (medido en la revisión: rota desde el 1-oct por el catálogo): la versión y la huella que se VIERON viajan juntas en
      // `expectedSourceFingerprint` («version:huella»), un campo que el catálogo copia de la respuesta al token; el motivo va en el paso 1
      // (el catálogo firma la entrada del paso 1). Los campos sueltos `version`/`huella` siguen valiendo para quien llama directo.
      const vista = desdeLaHuella(expectedSourceFingerprint) ?? { version: args.version, huella: args.huella }

      // B3b: sin huella no se escribe nada — ni con confirm:true. Sale la vista previa (con su versión y su huella).
      if (!confirm || !vista.huella) {
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
        const queHace =
          `Esto marcará la venta #${preview.orderNumber} (${montoTexto}, ${fechaLocal}) con el IVA YA incluido en el precio. ` +
          'Con eso podrá facturarse con el IVA de cada producto. No emite ni cancela ninguna factura.'
        const huellaVista = `${preview.version}:${preview.huella}`

        // C2 · OF-2 (T9 N-1): quien manda version/huella de una vista ANTERIOR en el paso 1 (el rodeo viejo) no confirma en silencio contra
        // la venta de ahora: se le dice que cambió, con la vista nueva y sin token.
        if ((vista.version !== undefined && vista.version !== preview.version) || (vista.huella && vista.huella !== preview.huella)) {
          return text({
            ok: false,
            preview: { ...preview, fechaLocal },
            error: `La venta cambió desde la vista previa que mandaste (version: ${vista.version ?? '—'}). No se hizo nada: revisa esta vista nueva y, si sigue siendo correcto, pide la vista previa otra vez con el motivo y sin version ni huella.`,
          })
        }

        // Sin motivo no se ofrece una confirmación que no podría terminar (el motivo no se puede agregar en el paso 2): se pide.
        if (!motivo || !motivo.trim()) {
          return text({
            ok: false,
            needsInput: true,
            field: 'motivo',
            preview: { ...preview, fechaLocal },
            question: 'Para confirmar, ¿por qué se sabe que esta venta cobró el IVA incluido?',
            message: `${queHace} Para confirmar, pide la vista previa otra vez con un motivo.`,
          })
        }
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { ...preview, fechaLocal },
          // El catálogo copia este campo a confirmationArguments: el token queda atado a la versión y la huella que se vieron.
          expectedSourceFingerprint: huellaVista,
          confirmationArgs: argsDeConfirmacion(args, { expectedSourceFingerprint: huellaVista }),
          message: `${queHace} Se confirmará con version: ${preview.version} y huella: "${preview.huella}". ${INSTRUCCION_DE_CONFIRMACION}`,
        })
      }

      if (vista.version === undefined) {
        return text({
          ok: false,
          error: 'Falta version: pide la vista previa primero (sin confirm) y usa sus confirmationArgs tal cual.',
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
          versionVista: vista.version,
          huellaVista: vista.huella,
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
        data: { motivo, version: vista.version },
      })
      return text({ ok: true })
    },
  )
}
