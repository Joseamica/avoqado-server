/**
 * «Por cobrar» — anexar a una fecha de cobro una factura que ya existe en «Facturas CFDI», y quitarla (spec
 * 2026-11-03-por-cobrar-desde-factura-y-filtros, «Anexar»; por qué está cada regla: docs/audit/2026-11-03-por-cobrar-anexar/codex-r1.md).
 * Un error aquí timbra dos veces la misma venta o suelta una factura en silencio.
 *
 * - Una factura es de un solo cobro, y un cobro con factura pide lo que ella dice: una fecha sin pagar toma sus conceptos y totales. Una ya
 *   pagada no: lo cobrado no se reescribe, y sólo se anexa si el total coincide. 🔴 Una factura que no cabe en el modelo del 16 % NUNCA se
 *   anexa, ni con el mismo total: quitarla o cancelarla dejaría a «Facturar» reemitirla con el modelo fijo.
 * - Sigue el orden de `invoiceOccurrence`: `resolverIntento` (puede preguntarle al PAC) va FUERA del candado del cobro, y adentro se
 *   vuelve a leer la fecha y la factura. El PAC y el correo NUNCA van dentro del candado; `logAction` siempre después y fuera.
 * - 🔴 El candado no basta para la factura: `cancelPlatformCfdi` no lo toma, y una fecha de otro cobro tiene otro candado. Por eso la
 *   escritura es condicional (vínculo nulo, estado y versión leídos): 0 filas es un 409, nunca un anexo a ciegas.
 * - 🔴 La anexada tiene otra llave y `resolverIntento` no la ve: lo que timbra o deshace pregunta aparte por ella (`linkedLiveWhere`).
 */
import type { BillingCustomerType, PlatformCfdi, PlatformCharge, PlatformChargeOccurrence, Prisma } from '@prisma/client'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { formatMoney } from '@/services/shared/receiptLayout/format'
import type { PlatformCfdiLineInput } from '@/services/superadmin/platform-billing/types'
import prisma from '@/utils/prismaClient'
import { MAX_CONCEPT_CENTS, MAX_CONCEPTS, pageParams } from './charges.service'
import { intentKey, resolverIntento } from './invoice.service'
import { withChargeLock } from './lock'
import { audit, invoiceName, probe, readLocked, viewOf, type OccurrenceView } from './occurrences.service'
import { dbToCalendarDay } from './schedule'
import { computeChargeTotals, IVA_RATE } from './totals'
import { LIVE_INVOICE_STATUSES, NEWEST_INVOICE_FIRST, type ChargeConcept } from './types'

// ── Errores ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Named = Pick<PlatformCfdi, 'serie' | 'folio'>

const conflict = (message: string, code: string) => new ConflictError(message, code)
const taken = (cfdi: Named) =>
  conflict(
    `No se puede anexar ${invoiceName(cfdi)}: ya es de otro cobro. Si se anexó por error, quítala de ese cobro`,
    'PLATFORM_CHARGE_INVOICE_LINK_TAKEN',
  )
/** `action`: lo que se intentaba, para que el texto no diga «anexar» cuando era quitar. */
const changed = (cfdi: Named, action: 'anexar' | 'quitar' = 'anexar') =>
  conflict(
    `No se pudo ${action} ${invoiceName(cfdi)}: acaba de cambiar. Revísala en Facturas CFDI y vuelve a intentarlo`,
    'PLATFORM_CHARGE_INVOICE_LINK_CHANGED',
  )
const hasLive = (cfdi: Named) =>
  conflict(`Esta fecha ya tiene ${invoiceName(cfdi)}: cancélala o quítala para anexar otra`, 'PLATFORM_CHARGE_INVOICE_LINK_HAS_LIVE')

// ── De factura a conceptos ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Los conceptos de la factura, o `null` si no cabe en el modelo de «Por cobrar» (IVA fijo del 16 %): un renglón exento, otra tasa, un
 * descuento, cantidad × precio que no da centavos enteros, más de lo que acepta un cobro, o si `computeChargeTotals` no da exactamente
 * sus totales. 🔴 Resumirla la volvería a timbrar mal al quitarla o cancelarla: $100 exentos saldrían como $86.21 + $13.79 de IVA.
 *
 * ponytail: `quantity × precio` exacto en flotante rechaza un 1.1 × $10.00 (1100.0000000000002). Se equivoca del lado seguro (no cabe), y
 * las cantidades con decimales aquí casi no existen; si un día estorba, se compara con una tolerancia.
 */
export function conceptsFromInvoice(
  cfdi: Pick<PlatformCfdi, 'lines' | 'subtotalCents' | 'discountCents' | 'taxCents' | 'totalCents'>,
): ChargeConcept[] | null {
  if (cfdi.discountCents !== 0 || !Array.isArray(cfdi.lines) || cfdi.lines.length === 0 || cfdi.lines.length > MAX_CONCEPTS) return null

  const concepts: ChargeConcept[] = []
  for (const line of cfdi.lines as unknown as PlatformCfdiLineInput[]) {
    const amountCents = line.quantity * line.unitPriceCents
    const fits =
      !line.taxExempt &&
      (line.taxRate ?? IVA_RATE) === IVA_RATE &&
      !line.discountCents &&
      Number.isSafeInteger(amountCents) &&
      amountCents > 0 &&
      amountCents <= MAX_CONCEPT_CENTS
    if (!fits) return null
    concepts.push({
      description: line.description,
      amountCents,
      ivaMode: line.taxIncluded ? 'WITH_IVA' : 'WITHOUT_IVA',
      satProductKey: line.satProductKey,
      satUnitKey: line.satUnitKey,
    })
  }

  const { subtotalCents, taxCents, totalCents } = computeChargeTotals(concepts)
  return subtotalCents === cfdi.subtotalCents && taxCents === cfdi.taxCents && totalCents === cfdi.totalCents ? concepts : null
}

// ── Lo que se comprueba antes de anexar ─────────────────────────────────────────────────────────────────────────────────────

/** El RFC del perfil del cobro, buscado como al facturar (`findProfileId`): el del cobro o el de su cliente. Con el `tx`: esto corre bajo un candado. */
async function profileRfcOf(tx: Prisma.TransactionClient, charge: PlatformCharge): Promise<string | null> {
  const where: Prisma.BillingTaxProfileWhereUniqueInput | null = charge.billingTaxProfileId
    ? { id: charge.billingTaxProfileId }
    : charge.organizationId
      ? { organizationId: charge.organizationId }
      : charge.venueId
        ? { venueId: charge.venueId }
        : null
  if (!where) return null
  const profile = await tx.billingTaxProfile.findUnique({ where, select: { rfc: true } })
  return profile?.rfc ?? null
}

/** Misma organización o negocio, o el RFC del perfil del cobro. Un externo sin perfil no tiene con qué compararse: se deja, y la pantalla enseña nombre y RFC. */
async function isOfCustomer(tx: Prisma.TransactionClient, cfdi: PlatformCfdi, charge: PlatformCharge): Promise<boolean> {
  // Los dos ids se revisan: una factura sin organización y un cobro sin organización no son «la misma».
  if (charge.organizationId && cfdi.organizationId === charge.organizationId) return true
  if (charge.venueId && cfdi.venueId === charge.venueId) return true
  const rfc = await profileRfcOf(tx, charge)
  return rfc ? cfdi.receptorRfc === rfc : charge.customerType === 'STANDALONE'
}

/** Un complemento que cuenta: el que no esté cancelado ni fallido. Uno en duda pudo cobrarse con `amountPaidCents` todavía en 0. */
const LIVE_COMPLEMENT = { type: 'PAGO', status: { notIn: ['CANCELLED', 'STAMP_FAILED'] } } satisfies Prisma.PlatformCfdiWhereInput

async function hasPayments(tx: Prisma.TransactionClient, cfdi: PlatformCfdi): Promise<boolean> {
  if (cfdi.amountPaidCents > 0) return true
  return (await tx.platformCfdi.count({ where: { parentPlatformCfdiId: cfdi.id, ...LIVE_COMPLEMENT } })) > 0
}

/** La factura sin cobro ya existe ante el SAT. «Timbrada» sin UUID es una fila vieja mal escrita, y ligada a una fecha ya nadie la consultaría. */
const isStampedIncome = (cfdi: Pick<PlatformCfdi, 'type' | 'status' | 'uuid'>): boolean =>
  cfdi.type === 'INGRESO' && cfdi.status === 'STAMPED' && Boolean(cfdi.uuid)

/**
 * 409 por lo que le falta a la fecha o a la factura; si todo está bien, lo que la fecha debe tomar de la factura. 🔴 Lo primero es que la factura
 * quepa en el modelo: una que no cabe no se anexa nunca, tampoco a una fecha pagada ni con el mismo total (si se pudiera quitar o cancelar, «Facturar»
 * la reemitiría al 16 %: $100 exentos saldrían como $86.21 + $13.79 de IVA).
 */
async function datePhotoOf(
  tx: Prisma.TransactionClient,
  occurrence: PlatformChargeOccurrence,
  cfdi: PlatformCfdi,
): Promise<Prisma.PlatformChargeOccurrenceUpdateInput> {
  const concepts = conceptsFromInvoice(cfdi)
  if (!concepts) {
    // `conceptsFromInvoice` da `null` por varias causas (exento, otra tasa, descuento, más renglones del tope, montos fuera de rango o totales
    // que no recalculan): el texto no afirma ninguna.
    throw conflict(
      `No se puede anexar ${invoiceName(cfdi)}: no cabe en lo que «Por cobrar» sabe calcular (IVA del 16 %, sin descuentos ni exentos, con los ` +
        'totales al centavo)',
      'PLATFORM_CHARGE_INVOICE_LINK_NOT_REPRESENTABLE',
    )
  }
  if (occurrence.status === 'PAID') {
    if (cfdi.totalCents === occurrence.totalCents) return {} // lo cobrado no se reescribe
    throw conflict(
      `No se puede anexar ${invoiceName(cfdi)}: esta fecha ya está pagada por ${formatMoney(occurrence.totalCents)} y la factura es por ` +
        `${formatMoney(cfdi.totalCents)}. Lo cobrado no se reescribe`,
      'PLATFORM_CHARGE_INVOICE_LINK_PAID_MISMATCH',
    )
  }
  if (await hasPayments(tx, cfdi)) {
    throw conflict(
      `No se puede anexar ${invoiceName(cfdi)} a un cobro sin pagar: ya tiene pagos en Facturas CFDI y nacería debiendo lo que ya se cobró`,
      'PLATFORM_CHARGE_INVOICE_LINK_HAS_PAYMENTS',
    )
  }
  return {
    concepts: concepts as unknown as Prisma.InputJsonValue,
    subtotalCents: cfdi.subtotalCents,
    taxCents: cfdi.taxCents,
    totalCents: cfdi.totalCents,
  }
}

// ── Anexar ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Las comprobaciones y la escritura de anexar, dentro de una transacción ajena: quien llama ya tomó el candado del cobro y leyó ahí la
 * fecha y la factura (`linkInvoice`, y el alta de un cobro desde una factura). Devuelve la fecha ya escrita, o `null` si esa factura ya
 * era la anexada de esta fecha (repetir no escribe). Un rechazo es un 409 que deshace la transacción de quien llama.
 */
export async function attachInvoiceInTx(
  tx: Prisma.TransactionClient,
  occurrence: PlatformChargeOccurrence,
  cfdi: PlatformCfdi,
  now: Date,
): Promise<PlatformChargeOccurrence | null> {
  if (!isStampedIncome(cfdi)) {
    throw conflict(
      `No se puede anexar ${invoiceName(cfdi)}: sólo se anexa una factura de ingreso timbrada y vigente`,
      'PLATFORM_CHARGE_INVOICE_LINK_NOT_STAMPED',
    )
  }
  if (cfdi.platformChargeOccurrenceId === occurrence.id) {
    if (cfdi.chargeLinkedAt) return null
    throw hasLive(cfdi) // la timbrada desde aquí: nunca se marca como anexada, porque lo anexado se puede quitar
  }
  if (cfdi.platformChargeOccurrenceId) throw taken(cfdi)
  if (occurrence.status === 'SKIPPED') {
    throw conflict('Esta fecha está omitida: deshaz la omisión para anexarle una factura', 'PLATFORM_CHARGE_INVOICE_LINK_SKIPPED')
  }

  const charge = await tx.platformCharge.findUnique({ where: { id: occurrence.chargeId } })
  if (!charge) throw new NotFoundError('Cobro no encontrado', 'PLATFORM_CHARGE_NOT_FOUND')
  if (!(await isOfCustomer(tx, cfdi, charge))) {
    throw conflict(
      `No se puede anexar ${invoiceName(cfdi)}: es de otro cliente (RFC ${cfdi.receptorRfc})`,
      'PLATFORM_CHARGE_INVOICE_LINK_OTHER_CUSTOMER',
    )
  }

  // Ligada o por llave: otra pestaña pudo reservar la factura de esta fecha después de `resolverIntento`.
  const live = await tx.platformCfdi.findFirst({
    where: {
      OR: [{ platformChargeOccurrenceId: occurrence.id }, { idempotencyKey: intentKey(occurrence) }],
      status: { in: LIVE_INVOICE_STATUSES },
    },
    orderBy: NEWEST_INVOICE_FIRST,
    select: { serie: true, folio: true },
  })
  if (live) throw hasLive(live)

  const photo = await datePhotoOf(tx, occurrence, cfdi)

  // 🔴 Condicional: cancelar no toma este candado, y otra fecha de otro cobro tiene el suyo. Se escribe sólo si la factura sigue como se validó.
  const { count } = await tx.platformCfdi.updateMany({
    where: { id: cfdi.id, platformChargeOccurrenceId: null, status: 'STAMPED', updatedAt: cfdi.updatedAt },
    data: { platformChargeOccurrenceId: occurrence.id, chargeLinkedAt: now },
  })
  if (count === 0) {
    const fresh = await tx.platformCfdi.findUnique({ where: { id: cfdi.id }, select: { platformChargeOccurrenceId: true } })
    throw fresh?.platformChargeOccurrenceId ? taken(cfdi) : changed(cfdi)
  }

  // AUTOMATIC y NONE pasan a MANUAL: deshacer el vínculo no debe timbrar solo ni esconder «Facturar».
  const data: Prisma.PlatformChargeOccurrenceUpdateInput = occurrence.invoiceMode === 'MANUAL' ? photo : { ...photo, invoiceMode: 'MANUAL' }
  if (Object.keys(data).length === 0) return occurrence
  const updated = await tx.platformChargeOccurrence.update({ where: { id: occurrence.id }, data })

  // 🔴 Un cobro de UNA SOLA VEZ y su única fecha dicen lo mismo: el editor carga los conceptos del cobro, y si se quedaran en lo anterior, guardar sólo
  // otra fecha mostraría un monto distinto del que está pendiente. Quitar no cambia nada: la fecha y el cobro ya quedaron iguales. Un cobro recurrente
  // sí conserva lo suyo: el vínculo es de esa fecha.
  if (
    charge.frequency === 'ONE_TIME' &&
    (updated.invoiceMode !== charge.invoiceMode || JSON.stringify(updated.concepts) !== JSON.stringify(charge.concepts))
  ) {
    await tx.platformCharge.update({
      where: { id: charge.id },
      data: { concepts: updated.concepts as Prisma.InputJsonValue, invoiceMode: updated.invoiceMode },
    })
  }
  return updated
}

/**
 * `POST /occurrences/:id/invoice-link`: anexa la factura a la fecha. Primero se resuelve un intento en duda (con el PAC y fuera del
 * candado, como `invoiceOccurrence`): si deja una factura viva, no se anexa. Repetir con la misma es éxito y no escribe ni registra.
 */
export async function linkInvoice(
  occurrenceId: string,
  { cfdiId }: { cfdiId: string },
  actorId: string,
  now: Date = new Date(),
): Promise<OccurrenceView> {
  const { chargeId } = await probe(occurrenceId)

  const attempt = await resolverIntento(occurrenceId, actorId)
  if (attempt.kind === 'LIVE') throw hasLive(attempt.cfdi)

  const linked = await withChargeLock(chargeId, async tx => {
    const occurrence = await readLocked(tx, occurrenceId)
    const cfdi = await tx.platformCfdi.findUnique({ where: { id: cfdiId } })
    if (!cfdi) throw new NotFoundError('Esa factura ya no existe: revisa la lista', 'PLATFORM_CHARGE_INVOICE_LINK_NOT_FOUND')
    const updated = await attachInvoiceInTx(tx, occurrence, cfdi, now)
    return updated && { updated, cfdi, occurrence }
  })

  if (linked) {
    const { updated, cfdi, occurrence } = linked
    audit('PLATFORM_CHARGE_INVOICE_LINKED', actorId, chargeId, occurrence.charge, {
      occurrenceId,
      dueDate: dbToCalendarDay(updated.dueDate),
      platformCfdiId: cfdi.id,
      uuid: cfdi.uuid,
      serie: cfdi.serie,
      folio: cfdi.folio,
      previousTotalCents: occurrence.totalCents,
      totalCents: updated.totalCents,
      invoiceMode: updated.invoiceMode,
    })
  }
  return viewOf(occurrenceId, now)
}

// ── Quitar ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `DELETE /occurrences/:id/invoice-link?cfdiId=`: suelta lo anexado; la fecha conserva sus números y su modo, y el cobro vuelve a poder facturarse.
 * 🔴 Sólo la factura que el operador confirmó (`cfdiId`) y sólo si sigue anexada a ESTA fecha (`chargeLinkedAt`): una confirmación vieja no suelta
 * otra factura que se anexó después, y una timbrada desde «Por cobrar» nunca se quita, se cancela. Una anexada ya cancelada también sale.
 * 🔴 Con la cancelación en trámite (`CANCEL_REQUESTED`) es 409: si el SAT la rechaza vuelve a estar vigente, y ya suelta se podría facturar la
 * fecha otra vez. Y la escritura es condicional por estado y versión, como la de anexar: cancelar no toma el candado del cobro.
 */
export async function unlinkInvoice(
  occurrenceId: string,
  { cfdiId }: { cfdiId: string },
  actorId: string,
  now: Date = new Date(),
): Promise<OccurrenceView> {
  const { chargeId } = await probe(occurrenceId)

  const { occurrence, cfdi } = await withChargeLock(chargeId, async tx => {
    const occurrence = await readLocked(tx, occurrenceId)
    const cfdi = await tx.platformCfdi.findFirst({
      where: { id: cfdiId, platformChargeOccurrenceId: occurrenceId, chargeLinkedAt: { not: null } },
    })
    if (!cfdi) {
      throw conflict(
        'Esta fecha no tiene una factura anexada. Una factura timbrada desde «Por cobrar» no se quita: se cancela en Facturas CFDI',
        'PLATFORM_CHARGE_INVOICE_NOT_LINKED',
      )
    }
    if (cfdi.status === 'CANCEL_REQUESTED') {
      throw conflict(
        `La cancelación de ${invoiceName(cfdi)} sigue en trámite ante el SAT; quítala cuando el SAT conteste`,
        'PLATFORM_CHARGE_INVOICE_CANCEL_PENDING',
      )
    }
    // 🔴 Condicional: si «Facturas CFDI» pidió cancelarla (o la tocó) después de leerla, 0 filas y no se suelta a ciegas.
    const { count } = await tx.platformCfdi.updateMany({
      where: { id: cfdi.id, status: cfdi.status, updatedAt: cfdi.updatedAt },
      data: { platformChargeOccurrenceId: null, chargeLinkedAt: null },
    })
    if (count === 0) throw changed(cfdi, 'quitar')
    return { occurrence, cfdi }
  })

  audit('PLATFORM_CHARGE_INVOICE_UNLINKED', actorId, chargeId, occurrence.charge, {
    occurrenceId,
    dueDate: dbToCalendarDay(occurrence.dueDate),
    platformCfdiId: cfdi.id,
    uuid: cfdi.uuid,
    serie: cfdi.serie,
    folio: cfdi.folio,
    status: cfdi.status,
  })
  return viewOf(occurrenceId, now)
}

// ── Candidatas ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface InvoiceCandidateFilters {
  customerType?: BillingCustomerType
  organizationId?: string
  venueId?: string
  rfc?: string
  /** Busca por folio («19», «A19», «A-19»), RFC o razón social. */
  q?: string
  page?: number
  pageSize?: number
}

/** Una factura que la pantalla ofrece para anexar. */
export interface InvoiceCandidate {
  id: string
  serie: string | null
  folio: string | null
  uuid: string | null
  stampedAt: Date | null
  subtotalCents: number
  taxCents: number
  totalCents: number
  metodoPago: string
  receptorRfc: string
  receptorNombre: string
  /** Los renglones como dicen en la factura, para leerlos aunque no quepa en el modelo. */
  descriptions: string[]
  /** Los conceptos que tomaría una fecha sin pagar. `null`: no cabe en el modelo del 16 % y NO se puede anexar (409 NOT_REPRESENTABLE), ni con el mismo total. */
  concepts: ChargeConcept[] | null
  /** Ya tiene pagos o un complemento vivo: no se anexa a una fecha sin pagar ni da de alta un cobro. */
  hasPayments: boolean
}

const CANDIDATE_SELECT = {
  id: true,
  serie: true,
  folio: true,
  uuid: true,
  stampedAt: true,
  subtotalCents: true,
  discountCents: true,
  taxCents: true,
  totalCents: true,
  amountPaidCents: true,
  metodoPago: true,
  receptorRfc: true,
  receptorNombre: true,
  lines: true,
} satisfies Prisma.PlatformCfdiSelect

/** 🔴 Cada rama revisa su id: un `undefined` en un filtro de Prisma no filtra, y traería las facturas de TODOS los clientes. */
function candidateCustomerWhere({ customerType, organizationId, venueId, rfc }: InvoiceCandidateFilters): Prisma.PlatformCfdiWhereInput {
  const cleanRfc = rfc?.trim().toUpperCase()
  const byRfc = cleanRfc ? [{ receptorRfc: cleanRfc }] : []
  if (customerType === 'ORGANIZATION' && organizationId) return { OR: [{ organizationId }, ...byRfc] }
  if (customerType === 'VENUE' && venueId) return { OR: [{ venueId }, ...byRfc] }
  if (cleanRfc) return { receptorRfc: cleanRfc }
  if (customerType === 'STANDALONE') return { organizationId: null, venueId: null } // un externo sin RFC: las que no son de ningún cliente registrado
  throw new BadRequestError('Elige el cliente para ver sus facturas', 'PLATFORM_CHARGE_INVOICE_CANDIDATES_NEEDS_CUSTOMER')
}

function candidateSearchWhere(q: string | undefined): Prisma.PlatformCfdiWhereInput[] {
  const term = (q ?? '').trim()
  if (!term) return []
  const contains = { contains: term, mode: 'insensitive' as const }
  const anyOf: Prisma.PlatformCfdiWhereInput[] = [{ folio: contains }, { receptorRfc: contains }, { receptorNombre: contains }]
  // «A19» o «A-19», como se nombra una factura: la serie y el folio son columnas aparte.
  const serieAndFolio = /^([a-z]+)-?(\d+)$/i.exec(term)
  if (serieAndFolio) anyOf.push({ serie: { equals: serieAndFolio[1], mode: 'insensitive' }, folio: serieAndFolio[2] })
  return [{ OR: anyOf }]
}

/**
 * `GET /invoice-candidates`: las facturas de ingreso timbradas y sin cobro de un cliente, de la más nueva a la más vieja, con tope de
 * página impuesto aquí y el total de un `count`. Los complementos de la página salen de UNA consulta aparte, no una por factura.
 */
export async function listInvoiceCandidates(
  filters: InvoiceCandidateFilters,
): Promise<{ rows: InvoiceCandidate[]; total: number; page: number; pageSize: number }> {
  const where: Prisma.PlatformCfdiWhereInput = {
    type: 'INGRESO',
    status: 'STAMPED',
    uuid: { not: null },
    platformChargeOccurrenceId: null,
    AND: [candidateCustomerWhere(filters), ...candidateSearchWhere(filters.q)],
  }
  const { page, pageSize } = pageParams(filters)
  const [rows, total] = await Promise.all([
    prisma.platformCfdi.findMany({
      where,
      // Lo mismo que `NEWEST_INVOICE_FIRST`, escrito aquí porque el guardia de paginación lee el texto de la llamada y busca `id` al final.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: CANDIDATE_SELECT,
    }),
    prisma.platformCfdi.count({ where }),
  ])

  const complements =
    rows.length === 0
      ? []
      : await prisma.platformCfdi.findMany({
          where: { parentPlatformCfdiId: { in: rows.map(row => row.id) }, ...LIVE_COMPLEMENT },
          distinct: ['parentPlatformCfdiId'],
          take: rows.length,
          select: { parentPlatformCfdiId: true },
        })
  const withComplement = new Set(complements.map(complement => complement.parentPlatformCfdiId))

  return {
    rows: rows.map(row => ({
      id: row.id,
      serie: row.serie,
      folio: row.folio,
      uuid: row.uuid,
      stampedAt: row.stampedAt,
      subtotalCents: row.subtotalCents,
      taxCents: row.taxCents,
      totalCents: row.totalCents,
      metodoPago: row.metodoPago,
      receptorRfc: row.receptorRfc,
      receptorNombre: row.receptorNombre,
      descriptions: Array.isArray(row.lines) ? (row.lines as unknown as PlatformCfdiLineInput[]).map(line => line.description) : [],
      concepts: conceptsFromInvoice(row),
      hasPayments: row.amountPaidCents > 0 || withComplement.has(row.id),
    })),
    total,
    page,
    pageSize,
  }
}
