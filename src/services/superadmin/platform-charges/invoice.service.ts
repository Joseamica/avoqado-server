/**
 * «Por cobrar» — factura de una ocurrencia (spec 2026-11-02-por-cobrar-superadmin §6). Es el núcleo fiscal: NUNCA timbra dos
 * facturas por un mismo pago y NUNCA decide sin preguntarle a Facturapi.
 *
 * - La llave del intento es `por-cobrar:<id>:<invoiceSeq>` y la fila de `PlatformCfdi` con esa llave es el RECLAMO: nace STAMPING en
 *   la misma transacción que comprueba que la ocurrencia sigue PAID (`reserveCheck`), así «Facturar» y «Deshacer» no se cruzan.
 * - `invoiceSeq` sube SÓLO cuando está comprobado, con el PAC, que el intento anterior no dejó una factura viva. Facturapi contesta
 *   409 a una llave repetida en vez de regresar el documento (`FACTURAPI_DEDUPLICA = false`) y un timeout pudo haber timbrado de
 *   verdad: por eso nunca se cambia de llave sin confirmar antes. Tampoco se confía en las filas que `cancelPlatformCfdi` e
 *   `issuePlatformCfdi` escriben (CANCELLED aunque el SAT siga en trámite, STAMPED aunque el PAC conteste pending): se pregunta.
 * - 🔴 Toda escritura local de una decisión corre bajo el candado del cobro (`withChargeLock`) y ahí adentro vuelve a leer lo que
 *   decide (`underLock`). Las llamadas a Facturapi y al correo NUNCA van dentro del candado: una transacción abierta mientras el PAC
 *   contesta (hasta 30 s) retiene la fila y la conexión.
 * - Toda llamada a Facturapi de este flujo usa `chargesSandbox(emisor)` (modo de prueba de QA, ver `sandbox.ts`).
 */
import type { PlatformCfdi, PlatformCharge, PlatformChargeOccurrence, Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { ConflictError, NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import type { FiscalProvider } from '@/services/fiscal/providers/fiscal-provider.interface'
import { getBillingTaxProfileForCustomer } from '@/services/superadmin/platform-billing/billingTaxProfile.service'
import { issuePlatformCfdi, sendPlatformCfdiEmail } from '@/services/superadmin/platform-billing/platformCfdi.service'
import { getActivePlatformEmisor, PlatformBillingError } from '@/services/superadmin/platform-billing/platformEmisor.service'
import prisma from '@/utils/prismaClient'
import { lockCharge, withChargeLock } from './lock'
import { chargesSandbox } from './sandbox'
import { conceptToCfdiLine } from './totals'
import type { ChargeConcept } from './types'

export { chargesSandbox }

/** El PAC corta el timbrado a los 30 s; pasados 2 min un POST de timbrado ya no puede seguir en vuelo (spec §6). */
const STAMPING_GRACE_MS = 2 * 60_000
/** c_FormaPago 03 (transferencia): «Por cobrar» cobra por SPEI y factura siempre PUE. */
const PAYMENT_FORM_TRANSFER = '03'

/** Lo que `resolverIntento` concluye: no hay intento (se puede timbrar con la llave actual) o hay una factura VIVA. */
export type InvoiceAttempt = { kind: 'NONE' } | { kind: 'LIVE'; cfdi: PlatformCfdi }

export interface InvoiceOccurrenceInput {
  /** Perfil fiscal capturado o corregido en el diálogo de facturar: se guarda en el cobro. */
  billingTaxProfileId?: string
  /** Un par de claves del SAT por concepto, en el mismo orden: reescriben la foto de ESTA ocurrencia (los montos no cambian). */
  conceptKeys?: { satProductKey: string; satUnitKey: string }[]
  /** Quién lo pidió (authContext.userId). */
  actorId: string
}

type Occurrence = Pick<PlatformChargeOccurrence, 'id' | 'chargeId' | 'invoiceSeq'>

/** Lo que de un documento del PAC basta para adoptarlo (lo comparten `getInvoice` y `findByExternalId`). */
interface PacDocument {
  providerInvoiceId: string
  uuid: string
  serie: string | null
  folio: string | null
  totalCents: number
  stampedAt: Date | null
}

// ── Errores y textos ────────────────────────────────────────────────────────────────────────────────────────────────────────

const intentKey = (occurrence: Pick<PlatformChargeOccurrence, 'id' | 'invoiceSeq'>): string =>
  `por-cobrar:${occurrence.id}:${occurrence.invoiceSeq}`
const conflict = (message: string, code: string) => new ConflictError(message, code)
const occurrenceNotFound = () => new NotFoundError('Cobro no encontrado', 'PLATFORM_CHARGE_OCCURRENCE_NOT_FOUND')
const notPaid = () => conflict('El cobro no está marcado como pagado; márcalo como pagado antes de facturar', 'PLATFORM_CHARGE_NOT_PAID')
const changed = () => conflict('La factura cambió mientras se revisaba; consulta de nuevo', 'PLATFORM_CHARGE_INVOICE_CHANGED')
const stillProcessing = () =>
  conflict('El SAT la sigue procesando; consulta el estado en unos minutos', 'PLATFORM_CHARGE_INVOICE_PROCESSING')

/** «A-118», o «la factura» si aún no tiene serie y folio. */
const labelOf = (row: Pick<PlatformCfdi, 'serie' | 'folio'>): string => [row.serie, row.folio].filter(Boolean).join('-') || 'la factura'

// ── Acceso al PAC y al candado ──────────────────────────────────────────────────────────────────────────────────────────────

/** El proveedor del emisor con el que se timbró ESA fila (no necesariamente el activo hoy), en modo de prueba si toca. */
async function providerFor(row: PlatformCfdi): Promise<FiscalProvider> {
  const emisor = await prisma.platformEmisor.findUnique({ where: { id: row.platformEmisorId } })
  if (!emisor) throw new PlatformBillingError('Emisor no encontrado', 'NO_EMISOR')
  return resolveFiscalProvider({ provider: emisor.provider, providerKeyEnc: emisor.providerKeyEnc }, { sandbox: chargesSandbox(emisor) })
}

/** Una consulta al PAC que va a decidir algo: si falla, NO se decide (jamás se timbra ni se borra a ciegas). */
async function askPac<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.warn('[platform-charges] no se pudo confirmar con Facturapi', { error: reason })
    throw conflict(`No pude confirmar con Facturapi; reintenta en un momento (${reason})`, 'PLATFORM_CHARGE_INVOICE_UNCONFIRMED')
  }
}

const sameRow = (a: PlatformCfdi, b: PlatformCfdi): boolean =>
  a.id === b.id && a.status === b.status && a.facturapiId === b.facturapiId && a.updatedAt.getTime() === b.updatedAt.getTime()

/**
 * Corre `fn` bajo el candado del cobro DESPUÉS de volver a leer la ocurrencia y la fila sobre las que se decidió con el PAC. Si
 * cambió el `invoiceSeq` o la fila (su estado, su facturapiId o cualquier escritura), es un 409 y `fn` no corre: lo que se le
 * preguntó al PAC ya no describe lo que hay. `fn` recibe la fila recién leída.
 */
function underLock<T>(
  occurrence: Occurrence,
  row: PlatformCfdi,
  fn: (tx: Prisma.TransactionClient, current: PlatformCfdi) => Promise<T>,
): Promise<T> {
  return withChargeLock(occurrence.chargeId, async tx => {
    const fresh = await tx.platformChargeOccurrence.findUnique({ where: { id: occurrence.id }, select: { invoiceSeq: true } })
    const current = await tx.platformCfdi.findUnique({ where: { id: row.id } })
    if (!fresh || fresh.invoiceSeq !== occurrence.invoiceSeq || !current || !sameRow(current, row)) throw changed()
    return fn(tx, current)
  })
}

// ── Lo que decide un intento ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Cierra el intento: ya está comprobado, con el PAC, que no dejó una factura viva. Borra la fila STAMPING o STAMP_FAILED (la
 * CANCELLED se queda: es el rastro fiscal de lo que sí se timbró) y sube `invoiceSeq`, con lo que la llave siguiente queda libre.
 * Con `markCancelled`, en vez de borrar marca la fila CANCELLED (el PAC dice que el documento ya está cancelado).
 */
async function closeAttempt(occurrence: Occurrence, row: PlatformCfdi, options: { markCancelled?: boolean } = {}): Promise<void> {
  await underLock(occurrence, row, async (tx, current) => {
    if (current.status === 'STAMPING' || current.status === 'STAMP_FAILED') {
      if (options.markCancelled) {
        await tx.platformCfdi.update({
          where: { id: current.id },
          data: { status: 'CANCELLED', cancelStatus: 'canceled', cancelledAt: new Date() },
        })
      } else {
        await tx.platformCfdi.delete({ where: { id: current.id } })
      }
    } else if (current.status !== 'CANCELLED') {
      throw changed()
    }
    await tx.platformChargeOccurrence.update({ where: { id: occurrence.id }, data: { invoiceSeq: { increment: 1 } } })
  })
  logger.info('[platform-charges] intento de factura cerrado; la llave siguiente queda libre', {
    platformChargeOccurrenceId: occurrence.id,
    platformCfdiId: row.id,
    closedStatus: row.status,
    key: intentKey(occurrence),
    markedCancelled: options.markCancelled === true,
  })
}

/** El PAC dijo «sigue procesando» y nos dio el id del documento: se guarda para que la próxima consulta pregunte por ese id. */
async function saveProviderId(occurrence: Occurrence, row: PlatformCfdi, providerInvoiceId: string): Promise<void> {
  await underLock(occurrence, row, (tx, current) =>
    tx.platformCfdi.update({ where: { id: current.id }, data: { facturapiId: providerInvoiceId } }),
  )
}

/** El SAT no aceptó la cancelación: la factura sigue vigente, la fila vuelve a STAMPED sin datos de cancelación. */
async function restoreStamped(occurrence: Occurrence, row: PlatformCfdi): Promise<void> {
  await underLock(occurrence, row, (tx, current) =>
    tx.platformCfdi.update({
      where: { id: current.id },
      data: { status: 'STAMPED', cancelMotivo: null, cancelSubstituteUuid: null, cancelStatus: null, cancelledAt: null },
    }),
  )
  logger.info('[platform-charges] la cancelación no procedió; la factura vuelve a estar vigente', {
    platformChargeOccurrenceId: occurrence.id,
    platformCfdiId: row.id,
  })
}

function auditIssued(cfdi: PlatformCfdi, actorId: string | undefined, adopted: boolean): void {
  void logAction({
    staffId: actorId ?? null,
    venueId: cfdi.venueId,
    organizationId: cfdi.organizationId,
    action: 'PLATFORM_CFDI_ISSUED',
    entity: 'PlatformCfdi',
    entityId: cfdi.id,
    data: {
      uuid: cfdi.uuid,
      totalCents: cfdi.totalCents,
      metodoPago: cfdi.metodoPago,
      formaPago: cfdi.formaPago,
      platformChargeOccurrenceId: cfdi.platformChargeOccurrenceId,
      ...(adopted ? { adopted: true } : {}),
    },
  })
}

/** Como `issuePlatformCfdi`: el correo con PDF y XML al receptor, sin que su falla cuente. */
async function emailAdopted(cfdi: PlatformCfdi): Promise<void> {
  try {
    const profile = cfdi.billingTaxProfileId
      ? await prisma.billingTaxProfile.findUnique({ where: { id: cfdi.billingTaxProfileId }, select: { email: true } })
      : null
    if (profile?.email) await sendPlatformCfdiEmail(cfdi.id, profile.email)
  } catch (error) {
    logger.warn('[platform-charges] no se pudo mandar el correo de una factura adoptada', {
      platformCfdiId: cfdi.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * El PAC SÍ timbró: la fila pasa a STAMPED con los datos del PAC (bajo el candado) y la factura es VIVA. Fuera del candado queda la
 * bitácora y el correo al receptor. Si el total del PAC no es el de la fila, manda el del PAC y queda registrado.
 */
async function adoptInvoice(occurrence: Occurrence, row: PlatformCfdi, doc: PacDocument, actorId?: string): Promise<InvoiceAttempt> {
  const totalDiffers = doc.totalCents !== row.totalCents
  const cfdi = await underLock(occurrence, row, (tx, current) =>
    tx.platformCfdi.update({
      where: { id: current.id },
      data: {
        status: 'STAMPED',
        facturapiId: doc.providerInvoiceId,
        uuid: doc.uuid,
        serie: doc.serie ?? current.serie,
        folio: doc.folio,
        stampedAt: doc.stampedAt ?? new Date(),
        lastError: null, // una factura STAMPED no puede seguir mostrando el error de un intento anterior
        ...(totalDiffers ? { totalCents: doc.totalCents } : {}),
      },
    }),
  )
  if (totalDiffers) {
    logger.error('[platform-charges] el total que timbró el PAC no es el de la fila adoptada; se guarda el del PAC', {
      platformCfdiId: row.id,
      platformChargeOccurrenceId: occurrence.id,
      rowTotalCents: row.totalCents,
      stampedTotalCents: doc.totalCents,
    })
  }
  auditIssued(cfdi, actorId, true)
  void emailAdopted(cfdi)
  return { kind: 'LIVE', cfdi }
}

// ── resolverIntento ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** CANCELLED: `cancelPlatformCfdi` la escribe aunque el SAT siga en trámite, así que se pregunta cómo va la cancelación. */
async function resolveCancelled(occurrence: Occurrence, row: PlatformCfdi): Promise<InvoiceAttempt> {
  const provider = await providerFor(row)
  const providerId = row.facturapiId
  const answer = providerId ? await askPac(async () => provider.getCancellationStatus?.(providerId)) : undefined
  // Un proveedor que no sabe contestar esto (o una fila sin id) no deja decidir: jamás se supone que se canceló.
  if (!answer) {
    throw conflict(
      'No puedo consultar la cancelación en Facturapi; confírmala ahí antes de continuar',
      'PLATFORM_CHARGE_INVOICE_UNCONFIRMED',
    )
  }
  switch (answer.status) {
    case 'canceled':
    case 'accepted':
      await closeAttempt(occurrence, row)
      return { kind: 'NONE' }
    case 'pending':
      throw conflict(
        `La cancelación de ${labelOf(row)} sigue en trámite ante el SAT; consulta de nuevo más tarde`,
        'PLATFORM_CHARGE_CANCELLATION_PENDING',
      )
    case 'rejected':
    case 'expired':
    case 'none':
      await restoreStamped(occurrence, row)
      throw conflict(
        `La cancelación no procedió; ${labelOf(row)} sigue vigente. Si quieres, cancélala otra vez en Facturas CFDI`,
        'PLATFORM_CHARGE_CANCELLATION_NOT_DONE',
      )
    default:
      throw conflict(
        'Facturapi contestó algo que no entiendo sobre la cancelación; revísala ahí antes de continuar',
        'PLATFORM_CHARGE_INVOICE_UNCONFIRMED',
      )
  }
}

/** La fila ya trae el id del documento (el PAC aceptó pero no timbró): se pregunta por ese id. */
async function resolveWithProviderId(
  occurrence: Occurrence,
  row: PlatformCfdi,
  providerId: string,
  actorId?: string,
): Promise<InvoiceAttempt> {
  const provider = await providerFor(row)
  const doc = await askPac(() => provider.getInvoice(providerId))
  if (doc.status === 'canceled') {
    await closeAttempt(occurrence, row, { markCancelled: true })
    return { kind: 'NONE' }
  }
  if (doc.status === 'valid' && doc.uuid) return adoptInvoice(occurrence, row, { ...doc, uuid: doc.uuid }, actorId)
  throw stillProcessing()
}

/** STAMPING vieja o STAMP_FAILED, sin id del documento: se pregunta por la LLAVE (la respuesta del timbrado pudo perderse). */
async function resolveLostAttempt(occurrence: Occurrence, row: PlatformCfdi, actorId?: string): Promise<InvoiceAttempt> {
  const provider = await providerFor(row)
  const found = await askPac(() => provider.findByExternalId(intentKey(occurrence)))
  if (found === null || found.status === 'canceled') {
    await closeAttempt(occurrence, row)
    return { kind: 'NONE' }
  }
  if (found.status === 'valid' && found.uuid) return adoptInvoice(occurrence, row, { ...found, uuid: found.uuid }, actorId)
  await saveProviderId(occurrence, row, found.providerInvoiceId)
  throw stillProcessing()
}

/**
 * Concluye qué hay del intento actual de una ocurrencia, SIEMPRE preguntándole a Facturapi antes de decidir (spec §6):
 *
 *   sin fila                                  → NONE
 *   STAMPED o CANCEL_REQUESTED                → LIVE
 *   CANCELLED                                 → getCancellationStatus: canceled/accepted cierra; pending 409; rejected/expired/none
 *                                               regresa la fila a STAMPED y 409
 *   con facturapiId                           → getInvoice: valid con UUID adopta; pending 409; canceled cierra
 *   STAMPING de menos de 2 min, sin id        → 409 «se está timbrando» (sin consultar: el POST puede seguir en vuelo)
 *   STAMPING vieja o STAMP_FAILED, sin id     → findByExternalId(llave): error 409; null o canceled cierra; valid adopta; pending guarda
 *                                               el id y 409
 *
 * Lanza `ConflictError` (409) en cada «todavía no se sabe». `actorId` (opcional) atribuye la bitácora cuando adopta una factura.
 */
export async function resolverIntento(occurrenceId: string, actorId?: string): Promise<InvoiceAttempt> {
  const occurrence = await prisma.platformChargeOccurrence.findUnique({ where: { id: occurrenceId } })
  if (!occurrence) throw occurrenceNotFound()

  const row = await prisma.platformCfdi.findUnique({ where: { idempotencyKey: intentKey(occurrence) } })
  if (!row) return { kind: 'NONE' }
  if (row.status === 'STAMPED' || row.status === 'CANCEL_REQUESTED') return { kind: 'LIVE', cfdi: row }
  if (row.status === 'CANCELLED') return resolveCancelled(occurrence, row)
  if (row.facturapiId) return resolveWithProviderId(occurrence, row, row.facturapiId, actorId)
  if (row.status === 'STAMPING' && Date.now() - row.createdAt.getTime() < STAMPING_GRACE_MS) {
    throw conflict('La factura se está timbrando; espera unos segundos y consulta de nuevo', 'PLATFORM_CHARGE_INVOICE_STAMPING')
  }
  return resolveLostAttempt(occurrence, row, actorId)
}

// ── invoiceOccurrence ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Perfil fiscal con el que se factura: el de la llamada, el del cobro o —para una organización o un negocio— el del cliente
 * (spec §5). Sin ninguno, 422 NEEDS_FISCAL_DATA. 🔴 `getBillingTaxProfileForCustomer` usa el Prisma global: va ANTES del candado.
 */
async function resolveProfileId(charge: PlatformCharge, requested?: string): Promise<string> {
  if (requested) return requested
  if (charge.billingTaxProfileId) return charge.billingTaxProfileId
  const { customerType } = charge
  const ownerId = customerType === 'ORGANIZATION' ? charge.organizationId : customerType === 'VENUE' ? charge.venueId : null
  if (ownerId) {
    const profile = await getBillingTaxProfileForCustomer(customerType, ownerId)
    if (profile) return profile.id
  }
  throw new PlatformBillingError('Captura los datos fiscales del cliente para poder facturarle', 'NEEDS_FISCAL_DATA')
}

/**
 * Bajo el candado: lee la foto de la ocurrencia, comprueba que sigue PAID y que no hay una fila con la llave actual, y aplica
 * `conceptKeys` (reescribe las claves de la foto; los montos no cambian) y el perfil si vinieron. Devuelve lo que se va a timbrar.
 */
async function prepareSnapshot(occurrence: PlatformChargeOccurrence & { charge: PlatformCharge }, input: InvoiceOccurrenceInput) {
  const { conceptKeys, billingTaxProfileId } = input
  const saveProfile = billingTaxProfileId !== undefined && billingTaxProfileId !== occurrence.charge.billingTaxProfileId

  const snapshot = await withChargeLock(occurrence.chargeId, async tx => {
    const fresh = await tx.platformChargeOccurrence.findUnique({ where: { id: occurrence.id } })
    if (!fresh) throw occurrenceNotFound()
    if (fresh.status !== 'PAID') throw notPaid()
    const clash = await tx.platformCfdi.findUnique({ where: { idempotencyKey: intentKey(fresh) }, select: { id: true } })
    if (clash)
      throw conflict('Ya hay un intento de factura en proceso para este cobro; consulta su estado', 'PLATFORM_CHARGE_INVOICE_STAMPING')

    let concepts = Array.isArray(fresh.concepts) ? (fresh.concepts as unknown as ChargeConcept[]) : []
    if (conceptKeys) {
      if (conceptKeys.length !== concepts.length) {
        throw new PlatformBillingError(
          `Manda un par de claves del SAT por concepto: el cobro tiene ${concepts.length} y llegaron ${conceptKeys.length}`,
          'VALIDATION',
        )
      }
      concepts = concepts.map((concept, i) => ({
        ...concept,
        satProductKey: conceptKeys[i].satProductKey,
        satUnitKey: conceptKeys[i].satUnitKey,
      }))
      await tx.platformChargeOccurrence.update({
        where: { id: fresh.id },
        data: { concepts: concepts as unknown as Prisma.InputJsonValue },
      })
    }
    if (saveProfile && billingTaxProfileId) {
      // Un id colgado en el cobro rompería su facturación automática: sólo se guarda un perfil que existe.
      const exists = await tx.billingTaxProfile.findUnique({ where: { id: billingTaxProfileId }, select: { id: true } })
      if (!exists) throw new PlatformBillingError('Perfil fiscal del receptor no encontrado', 'NO_PROFILE')
      await tx.platformCharge.update({ where: { id: occurrence.chargeId }, data: { billingTaxProfileId } })
    }
    return {
      id: fresh.id,
      invoiceSeq: fresh.invoiceSeq,
      concepts,
      subtotalCents: fresh.subtotalCents,
      taxCents: fresh.taxCents,
      totalCents: fresh.totalCents,
    }
  })

  if (conceptKeys || saveProfile) {
    void logAction({
      staffId: input.actorId,
      venueId: occurrence.charge.venueId,
      organizationId: occurrence.charge.organizationId,
      action: 'PLATFORM_CHARGE_UPDATED',
      entity: 'PlatformCharge',
      entityId: occurrence.chargeId,
      data: { occurrenceId: occurrence.id, ...(conceptKeys ? { conceptKeys } : {}), ...(saveProfile ? { billingTaxProfileId } : {}) },
    })
  }
  return snapshot
}

/** Lo que corre en la MISMA transacción que crea la fila STAMPING: toma el candado y exige PAID e `invoiceSeq` igual; si no, 409. */
async function reserveCheck(
  tx: Prisma.TransactionClient,
  occurrence: Pick<Occurrence, 'id' | 'chargeId'>,
  invoiceSeq: number,
): Promise<void> {
  await lockCharge(tx, occurrence.chargeId)
  const fresh = await tx.platformChargeOccurrence.findUnique({ where: { id: occurrence.id }, select: { status: true, invoiceSeq: true } })
  if (!fresh || fresh.status !== 'PAID') throw notPaid()
  if (fresh.invoiceSeq !== invoiceSeq) throw changed()
}

/**
 * Factura una ocurrencia PAID (el botón «Facturar», el reintento, «Consultar estado» y la factura automática de `pay`):
 *   1. exige PAID y resuelve el perfil (sin perfil: 422 NEEDS_FISCAL_DATA);
 *   2. `resolverIntento`: si ya hay una factura VIVA, la regresa sin timbrar;
 *   3. bajo el candado aplica `conceptKeys` y el perfil, y toma la foto de conceptos y totales;
 *   4. `issuePlatformCfdi` con la llave del intento, PUE, forma de pago 03 y el `reserveCheck` que cierra la carrera con «Deshacer».
 *
 * Si el PAC contesta sin timbre, regresa la fila en STAMPING (no lanza): la UI dice «El SAT la sigue procesando» y la próxima
 * consulta la termina. Escribe la bitácora PLATFORM_CFDI_ISSUED cuando timbra o adopta.
 */
export async function invoiceOccurrence(occurrenceId: string, input: InvoiceOccurrenceInput): Promise<PlatformCfdi> {
  const occurrence = await prisma.platformChargeOccurrence.findUnique({ where: { id: occurrenceId }, include: { charge: true } })
  if (!occurrence) throw occurrenceNotFound()
  if (occurrence.status !== 'PAID') throw notPaid()

  const billingTaxProfileId = await resolveProfileId(occurrence.charge, input.billingTaxProfileId)

  const attempt = await resolverIntento(occurrenceId, input.actorId)
  if (attempt.kind === 'LIVE') return attempt.cfdi

  // El modo de prueba se decide ANTES de escribir nada: con una configuración que se negaría a timbrar, tampoco se reescribe la foto.
  const emisor = await getActivePlatformEmisor()
  if (!emisor) throw new PlatformBillingError('No hay emisor de plataforma configurado', 'NO_EMISOR')
  const sandbox = chargesSandbox(emisor)

  const snapshot = await prepareSnapshot(occurrence, input)
  const cfdi = await issuePlatformCfdi({
    billingTaxProfileId,
    lines: snapshot.concepts.map(conceptToCfdiLine),
    formaPago: PAYMENT_FORM_TRANSFER,
    metodoPago: 'PUE',
    idempotencyKey: intentKey(snapshot),
    performedById: input.actorId,
    sandbox,
    totals: { subtotalCents: snapshot.subtotalCents, discountCents: 0, taxCents: snapshot.taxCents, totalCents: snapshot.totalCents },
    platformChargeOccurrenceId: occurrence.id,
    reserveCheck: tx => reserveCheck(tx, occurrence, snapshot.invoiceSeq),
  })
  if (cfdi.status === 'STAMPED') auditIssued(cfdi, input.actorId, false)
  return cfdi
}
