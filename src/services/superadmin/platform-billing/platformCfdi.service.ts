/**
 * Platform CFDI service — issue/list/get/cancel income CFDIs (Avoqado → customer).
 *
 * Reuses the fiscal provider engine: resolveFiscalProvider() decrypts the emisor's
 * live key and returns a FacturapiProvider; createInvoice() stamps a type-I CFDI.
 * Supports PUE and PPD (a PPD income CFDI is a normal type-I with metodoPago=PPD,
 * formaPago="99"). The complemento de pago (REP, type P) is a separate follow-up.
 *
 * Money is integer cents end-to-end (MXN). IVA is ADD-ON (not included), unlike
 * the Stripe subscriptions which are IVA-inclusive.
 */
import { isDeepStrictEqual } from 'node:util'
import { Prisma, type PlatformCfdi, type PlatformEmisor } from '@prisma/client'
import logger from '@/config/logger'
import { ConflictError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import { esRechazoConfirmado, ProviderHttpError } from '@/services/fiscal/providers/facturapi.provider'
import type {
  CfdiItemInput,
  CreateInvoiceParams,
  FiscalProvider,
  PaymentComplementTax,
  ProviderInvoiceSummary,
  StampedInvoice,
} from '@/services/fiscal/providers/fiscal-provider.interface'
import { chargesSandbox } from '@/services/superadmin/platform-charges/sandbox'
import { getActivePlatformEmisor, PlatformBillingError } from './platformEmisor.service'
import type {
  IssuePlatformCfdiInput,
  ListPlatformCfdisFilters,
  PlatformCfdiLineInput,
  PlatformCfdiTotals,
  RegisterPaymentInput,
} from './types'

const DEFAULT_IVA_RATE = 0.16
const MAX_PAGE_SIZE = 100

/**
 * Cuánto se espera antes de preguntarle a Facturapi por un intento que nunca nos contestó (STAMPING sin `facturapiId`). Nuestro cliente
 * corta el timbrado a los 30 s (`AbortSignal.timeout` del proveedor): ese corte es NUESTRO, no una señal de que el PAC dejó de trabajar.
 * Los 2 min son una defensa razonable, no una prueba de que el documento ya no vaya a aparecer. Cuenta desde `createdAt`.
 */
export const STAMPING_GRACE_MS = 2 * 60_000
/** Las consultas a Facturapi (`getInvoice`, `findByExternalId`) van por el SDK, que no trae tiempo límite: aquí se impone. */
const PAC_QUERY_TIMEOUT_MS = 30_000
/** Lo primero que lee quien acaba de ver fallar un timbrado sin saber si llegó. */
const IN_FLIGHT_NOTICE = 'La factura pudo quedar en camino: consulta su estado en 2 minutos y no la timbres otra vez.'

const conflict = (message: string, code: string) => new ConflictError(message, code)

/**
 * Una consulta al PAC que va a decidir algo: si falla —o no contesta en 30 s— NO se decide (jamás se timbra ni se borra a ciegas) y
 * es el 409 «no pude confirmar; reintenta». El temporizador se cancela siempre, conteste o falle la consulta.
 */
export async function askPac<T>(call: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const silence = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Facturapi no contestó en ${PAC_QUERY_TIMEOUT_MS / 1000} s`)), PAC_QUERY_TIMEOUT_MS)
  })
  try {
    return await Promise.race([call(), silence])
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.warn('[platform-billing] no se pudo confirmar con Facturapi', { error: reason })
    throw conflict(`No pude confirmar con Facturapi; reintenta en un momento (${reason})`, 'PLATFORM_CHARGE_INVOICE_UNCONFIRMED')
  } finally {
    clearTimeout(timer)
  }
}

/** Campo del formulario al que apunta un rechazo del SAT sobre los datos del receptor. */
export type ReceptorField = 'razonSocial' | 'rfc' | 'regimenFiscal' | 'codigoPostal'

export interface StampErrorInfo {
  /** Lo que ve el operador: guía accionable + el mensaje crudo del SAT, SIEMPRE. */
  message: string
  /** 'VALIDATION' → dato corregible por el operador (422). 'PROVIDER' → falla del PAC (502). */
  code: 'VALIDATION' | 'PROVIDER'
  /** Campo culpable, cuando el SAT lo identifica. Lo consume la UI para marcarlo. */
  field?: ReceptorField
}

/**
 * El SAT nombra el campo que rechaza JUSTO DESPUÉS de "el campo". Ejemplo real de producción:
 *
 *   "El campo Nombre del receptor, debe pertenecer al nombre asociado al RFC
 *    registrado en el campo Rfc del Receptor."
 *
 * El culpable es Nombre, no Rfc — aunque el mensaje mencione ambos. Por eso anclamos en
 * `el campo <X>` y no en la mera presencia de la palabra: la regla anterior hacía
 * `includes('receptor') && includes('rfc')` y mandaba al operador a revisar el RFC, que
 * estaba correcto (incidente La Galeterie, 2026-08-07).
 *
 * El orden del arreglo importa: la primera regla que cace, gana.
 */
const RECEPTOR_RULES: ReadonlyArray<{ pattern: RegExp; field: ReceptorField; hint: string }> = [
  {
    pattern: /el campo\s+nombre\b/i,
    field: 'razonSocial',
    hint: 'La Razón social del receptor no coincide con la registrada en el SAT. Cópiala tal cual de su Constancia de Situación Fiscal: en MAYÚSCULAS y sin el régimen de capital (sin "S.A. DE C.V.").',
  },
  {
    pattern: /el campo\s+domiciliofiscalreceptor\b/i,
    field: 'codigoPostal',
    hint: 'El Código postal del receptor no coincide con su domicilio fiscal en el SAT. Cópialo de su Constancia de Situación Fiscal.',
  },
  {
    pattern: /el campo\s+regimenfiscalreceptor\b/i,
    field: 'regimenFiscal',
    hint: 'El Régimen fiscal del receptor no coincide con el registrado en el SAT. Cópialo de su Constancia de Situación Fiscal.',
  },
  {
    pattern: /el campo\s+rfc\b/i,
    field: 'rfc',
    hint: 'El RFC del receptor no está registrado en el SAT o no es válido.',
  },
]

/** Anexa el mensaje crudo del PAC/SAT a la guía. Nunca se descarta: es el dato que permite diagnosticar. */
function withRaw(hint: string, rawMessage: string): string {
  return `${hint} · Mensaje del SAT: ${rawMessage}`
}

/**
 * Traduce el error crudo del PAC/Facturapi (o de nuestra capa de descifrado) a un mensaje en
 * español accionable, y lo clasifica para el mapeo HTTP. El mensaje técnico original SIEMPRE
 * se guarda tal cual en `PlatformCfdi.lastError` y además viaja dentro de `message`.
 */
export function classifyStampError(rawMessage: string): StampErrorInfo {
  const msg = rawMessage.toLowerCase()

  // ── Rechazo del receptor con campo identificable: corre PRIMERO, antes que CUALQUIER heurística
  // de subcadena (401, unit_key, receptor genérico…). `el campo <X>` es el ancla MÁS específica que
  // el SAT nos da — estrictamente más específica que cualquier `includes()`. Ejemplo real: el código
  // de validación del SAT "CFDI40147" (rechazo de Nombre del receptor) contiene la subcadena "401".
  // Sin este orden, ese caso —el que esta fase existe para arreglar— clasificaría como fallo de
  // credenciales (401) ANTES de llegar aquí, y perdería el mensaje crudo del SAT (las ramas PROVIDER
  // de credenciales no llaman withRaw()): la reproducción exacta del bug original.
  //
  // Guardado tras comprobar que el mensaje habla del RECEPTOR (Minor #3): "El campo Nombre del
  // emisor…" (CFDI40146) usa el mismo patrón de campo pero apunta al EMISOR, no al receptor — sin
  // este guard mandaríamos al operador a corregir el receptor equivocado.
  if (/receptor/i.test(rawMessage)) {
    for (const rule of RECEPTOR_RULES) {
      if (rule.pattern.test(rawMessage)) {
        return { code: 'VALIDATION', field: rule.field, message: withRaw(rule.hint, rawMessage) }
      }
    }
  }

  // ── Fallas de infraestructura/credenciales: el operador no puede corregirlas con datos. ──
  // Descifrado de la llave del emisor (AES-GCM) — nunca llega a Facturapi; error de Node crypto.
  if (msg.includes('unsupported state') || msg.includes('unable to authenticate data') || msg.includes('bad decrypt')) {
    return {
      code: 'PROVIDER',
      message:
        'La llave del emisor no se pudo leer (dañada o corresponde a otra configuración). Ve a "Configurar emisor" y vincula la llave de nuevo.',
    }
  }
  // Autenticación contra Facturapi (llave vencida, revocada, o de otra organización).
  // "401" va con límite de palabra: un código de validación del SAT (CFDI40147) o un monto
  // (1401.00) contienen "401" como subcadena y NO son un fallo de credenciales — `\b` evita que
  // "1401"/"40147" disparen esta rama (defensa independiente del orden de arriba).
  if (msg.includes('unauthorized') || msg.includes('invalid api key') || /\b401\b/.test(rawMessage)) {
    return {
      code: 'PROVIDER',
      message:
        'Facturapi rechazó la llave del emisor (vencida, revocada, o de otra organización). Ve a "Configurar emisor" y vincula una llave live vigente.',
    }
  }

  // ── Datos corregibles por el operador → 422. ──
  // Clave de producto/servicio o de unidad del SAT inexistente en el catálogo.
  if (msg.includes('unit_key') || msg.includes('clave de unidad') || msg.includes('product_key') || msg.includes('clave de producto')) {
    return {
      code: 'VALIDATION',
      message: withRaw(
        'La Clave SAT o la Unidad de un concepto no existe en el catálogo del SAT. Corrígela en la línea del concepto.',
        rawMessage,
      ),
    }
  }
  // Rechazo del receptor sin campo identificable.
  if (msg.includes('receptor')) {
    return {
      code: 'VALIDATION',
      message: withRaw('Los datos fiscales del receptor no coinciden con su registro en el SAT.', rawMessage),
    }
  }

  // Sin patrón conocido: el mensaje del proveedor tal cual (suele venir ya en español).
  return { code: 'PROVIDER', message: rawMessage }
}

/** Compute CFDI money totals from line items. All integer cents, IVA add-on. */
export function computePlatformCfdiTotals(lines: PlatformCfdiLineInput[]): PlatformCfdiTotals {
  let subtotalCents = 0
  let discountCents = 0
  let taxCents = 0
  for (const line of lines) {
    const importe = Math.round(line.quantity * line.unitPriceCents) // cantidad × valorUnitario
    const lineDiscount = Math.round(line.discountCents ?? 0)
    const base = importe - lineDiscount
    const lineTax = line.taxExempt ? 0 : Math.round(base * (line.taxRate ?? DEFAULT_IVA_RATE))
    subtotalCents += importe
    discountCents += lineDiscount
    taxCents += lineTax
  }
  return { subtotalCents, discountCents, taxCents, totalCents: subtotalCents - discountCents + taxCents }
}

/** Map our line input to the provider's CfdiItemInput (IVA add-on, unless the line says its price already carries the IVA). */
function toCfdiItem(line: PlatformCfdiLineInput): CfdiItemInput {
  const taxed = !line.taxExempt
  return {
    satProductKey: line.satProductKey,
    satUnitKey: line.satUnitKey,
    description: line.description,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    discountCents: line.discountCents ?? 0,
    objetoImp: taxed ? '02' : '01', // 02 = sí objeto de impuesto; 01 = no objeto
    taxes: taxed ? [{ type: 'IVA', factor: 'Tasa', rate: line.taxRate ?? DEFAULT_IVA_RATE, withholding: false }] : [],
    taxIncluded: line.taxIncluded === true,
  }
}

/**
 * El `sandbox` con el que se habla con Facturapi: el que pidió quien llama o, con `PLATFORM_CHARGES_SANDBOX=true`, el del servidor de QA,
 * para que el recorrido sea completo. Sin esa variable queda como siempre, y con ella en producción `chargesSandbox` se niega.
 */
function sandboxFor(emisor: Pick<PlatformEmisor, 'providerKeyEnc'>, requested: boolean): boolean {
  return requested || chargesSandbox(emisor)
}

/**
 * ¿Es el mismo intento? Una llave repetida regresa la fila que ya existe, y eso sólo es cierto con los mismos datos: tras un corte, el
 * operador pudo cambiar un dato y volver a timbrar, y regresarle la factura anterior le diría «timbrada» con lo que ya no está en pantalla.
 */
async function assertSameIntent(prior: PlatformCfdi, input: IssuePlatformCfdiInput): Promise<void> {
  const profile = await prisma.billingTaxProfile.findUnique({ where: { id: input.billingTaxProfileId } })
  const same =
    prior.billingTaxProfileId === input.billingTaxProfileId &&
    prior.receptorRfc === profile?.rfc &&
    prior.receptorNombre === profile?.razonSocial &&
    prior.receptorRegimen === profile?.regimenFiscal &&
    prior.receptorCp === profile?.codigoPostal &&
    prior.usoCfdi === (input.usoCfdi ?? profile?.defaultUsoCfdi) &&
    prior.formaPago === input.formaPago &&
    prior.metodoPago === input.metodoPago &&
    isDeepStrictEqual(prior.lines, JSON.parse(JSON.stringify(input.lines)))
  if (!same) {
    throw conflict(
      'Ese intento ya había llegado con otros datos: revisa la factura en la lista antes de timbrar otra',
      'PLATFORM_CFDI_OTHER_DATA',
    )
  }
}

/**
 * Issue an income CFDI to a customer. Idempotent by idempotencyKey: a repeated
 * call returns the existing row instead of double-stamping.
 *
 * Lo que el PAC no confirmó no se da por hecho: si contesta sin timbre la fila se queda STAMPING con su `facturapiId`, y una falla que
 * no es un rechazo confirmado (timeout, 5xx, respuesta ilegible) la deja STAMPING con su `lastError`. `refreshPlatformCfdi` las termina.
 *
 * «Por cobrar» (spec 2026-11-02-por-cobrar-superadmin §6) usa tres campos opcionales que el camino de «Nueva factura» no manda:
 * `totals` (se guardan tal cual), `reserveCheck` (corre en la transacción que crea la fila) y `platformChargeOccurrenceId`, que
 * además liga la fila y hace que, si el total del PAC difiere, se guarde el del PAC. «Reintentar» manda `retryOfId`: le pregunta al PAC
 * por la factura fallida y, en la misma transacción que reserva la nueva, la quita. Si fuera aparte, un corte dejaría las dos filas y
 * reintentar la vieja otra vez emitiría una tercera.
 */
export async function issuePlatformCfdi(input: IssuePlatformCfdiInput): Promise<PlatformCfdi> {
  if (!input.lines.length) throw new PlatformBillingError('La factura requiere al menos un concepto', 'VALIDATION')

  // Idempotency short-circuit.
  const prior = await prisma.platformCfdi.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
  if (prior) {
    // «Por cobrar» lo compara en su servicio, contra lo que el operador confirmó.
    if (input.platformChargeOccurrenceId == null) await assertSameIntent(prior, input)
    return prior
  }

  const emisor = await getActivePlatformEmisor()
  if (!emisor) throw new PlatformBillingError('No hay emisor de plataforma configurado', 'NO_EMISOR')

  const requested = input.sandbox ?? false
  // 🔴 «Por cobrar» decidió `sandbox` con OTRA lectura del emisor: si entre las dos alguien guardó una llave real, con ella se timbraría de verdad.
  if (requested && input.platformChargeOccurrenceId != null) chargesSandbox(emisor)
  const sandbox = sandboxFor(emisor, requested)
  if (!sandbox && emisor.csdStatus !== 'ACTIVE') {
    throw new PlatformBillingError('El emisor no tiene un CSD activo; sube el sello digital antes de timbrar', 'CSD_INACTIVE')
  }

  const profile = await prisma.billingTaxProfile.findUnique({ where: { id: input.billingTaxProfileId } })
  if (!profile) throw new PlatformBillingError('Perfil fiscal del receptor no encontrado', 'NO_PROFILE')

  // «Por cobrar» manda los totales de su ocurrencia: sus líneas pueden traer el IVA incluido y el cálculo genérico lo sumaría otra vez.
  const totals = input.totals ?? computePlatformCfdiTotals(input.lines)
  const usoCfdi = input.usoCfdi ?? profile.defaultUsoCfdi
  const serie = input.serie ?? emisor.serie
  const linked = input.platformChargeOccurrenceId != null

  const data: Prisma.PlatformCfdiUncheckedCreateInput = {
    platformEmisorId: emisor.id,
    billingTaxProfileId: profile.id,
    type: 'INGRESO',
    platformChargeOccurrenceId: input.platformChargeOccurrenceId,
    organizationId: profile.organizationId,
    venueId: profile.venueId,
    receptorRfc: profile.rfc,
    receptorNombre: profile.razonSocial,
    receptorRegimen: profile.regimenFiscal,
    receptorCp: profile.codigoPostal,
    usoCfdi,
    lines: input.lines as unknown as Prisma.InputJsonValue,
    formaPago: input.formaPago,
    metodoPago: input.metodoPago,
    subtotalCents: totals.subtotalCents,
    discountCents: totals.discountCents,
    taxCents: totals.taxCents,
    totalCents: totals.totalCents,
    status: 'STAMPING',
    serie,
    idempotencyKey: input.idempotencyKey,
    createdById: input.performedById,
  }

  // «Reintentar»: primero se le pregunta al PAC por la fallida. Si sí se timbró o sigue en camino, aquí termina.
  const { reserveCheck, retryOfId } = input
  if (retryOfId) {
    const retried = await refreshPlatformCfdi(retryOfId, input.performedById, requested)
    if (retried.status !== 'STAMP_FAILED') throw conflict(`${stillAlive(retried)} No se timbró otra.`, 'PLATFORM_CFDI_NOT_RETRYABLE')
  }

  // Reserve the row first (unique idempotencyKey) so concurrent retries don't double-stamp.
  let row: PlatformCfdi
  try {
    if (reserveCheck || retryOfId) {
      // La comprobación, quitar la fallida y la reserva son UNA transacción: lo que se vio es lo que existe cuando nace la fila.
      const reserved = await prisma.$transaction(async tx => {
        const removed = retryOfId ? await removeFailed(tx, retryOfId) : null
        if (reserveCheck) await reserveCheck(tx, data)
        return { row: await tx.platformCfdi.create({ data }), removed }
      })
      row = reserved.row
      if (reserved.removed) auditDiscarded(reserved.removed, input.performedById, { retriedBy: row.id })
    } else {
      row = await prisma.platformCfdi.create({ data })
    }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const dup = await prisma.platformCfdi.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
      if (dup) return dup
    }
    throw e
  }

  // Stamp with the PAC.
  try {
    const provider = resolveFiscalProvider({ provider: emisor.provider, providerKeyEnc: emisor.providerKeyEnc }, { sandbox })
    const params: CreateInvoiceParams = {
      receptor: {
        rfc: profile.rfc,
        razonSocial: profile.razonSocial,
        regimenFiscal: profile.regimenFiscal,
        codigoPostal: profile.codigoPostal,
        usoCfdi,
        email: profile.email ?? undefined,
      },
      items: input.lines.map(toCfdiItem),
      formaPago: input.formaPago,
      metodoPago: input.metodoPago,
      serie,
      idempotencyKey: input.idempotencyKey,
      externalId: input.idempotencyKey, // deterministic orphan recovery
    }
    const stamped = await provider.createInvoice(params)

    // «Por cobrar»: si el PAC timbró otro total que la ocurrencia, manda el del PAC (es el que vio el SAT) y queda registrado.
    const totalDiffers = linked && stamped.totalCents !== totals.totalCents
    if (totalDiffers) {
      logger.error('[platform-charges] el total que timbró el PAC no es el de la ocurrencia; se guarda el del PAC', {
        platformCfdiId: row.id,
        platformChargeOccurrenceId: input.platformChargeOccurrenceId,
        occurrenceTotalCents: totals.totalCents,
        stampedTotalCents: stamped.totalCents,
      })
    }
    const pacTotal = totalDiffers ? { totalCents: stamped.totalCents } : {}

    // Si el PAC contestó SIN timbre (pending, o sin UUID) la fila NO se da por timbrada: se queda STAMPING con su `facturapiId` para
    // que `resolverIntento` o `refreshPlatformCfdi` la terminen preguntándole al PAC.
    const withoutStamp = stamped.status !== 'valid' || !stamped.uuid
    const updated = await prisma.platformCfdi.update({
      where: { id: row.id },
      data: withoutStamp
        ? { facturapiId: stamped.providerInvoiceId, ...pacTotal }
        : {
            status: 'STAMPED',
            facturapiId: stamped.providerInvoiceId,
            uuid: stamped.uuid,
            serie: stamped.serie ?? serie,
            folio: stamped.folio,
            stampedAt: stamped.stampedAt,
            ...pacTotal,
          },
    })
    // Sin timbre no hay nada que entregar: el correo sale cuando se adopta la factura.
    if (withoutStamp) return updated
    // Best-effort: entregar el CFDI por correo al timbrar. No bloquea ni hace fallar la emisión.
    if (profile.email) void sendPlatformCfdiEmail(updated.id, profile.email, sandbox).catch(() => undefined)
    return updated
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 🔴 (spec de «Por cobrar» §6, «Por qué así»): una falla que NO es un rechazo confirmado del PAC (timeout, 5xx, respuesta ilegible) no
    // prueba que el documento no haya quedado en camino. Si la fila pasara a STAMP_FAILED, el reintento inmediato preguntaría por la
    // llave, Facturapi todavía podría no tenerla y se timbraría con otra llave: dos CFDI por un pago. Por eso la fila SIGUE en STAMPING
    // (con su `lastError` y un intento más) y la espera de 2 min la cubre. Sólo un rechazo confirmado pasa a STAMP_FAILED.
    const stillInFlight = !esRechazoConfirmado(err, true)
    await prisma.platformCfdi.update({
      where: { id: row.id },
      data: { ...(stillInFlight ? {} : { status: 'STAMP_FAILED' as const }), lastError: message, attempts: { increment: 1 } },
    })
    const info = classifyStampError(message)
    // Salen sin el aviso un dato corregible que el SAT nombró (VALIDATION: eso es lo que hay que leer) y un rechazo confirmado. Quien lee
    // el aviso es un operador que podría volver a timbrar: se le dice qué hacer, y sigue el detalle del proveedor. `inFlight` y `cfdiId`
    // son para la pantalla: si está en camino conserva la llave, y si no, la fila fallida es la que corregir reemplaza.
    const text = `Error al timbrar el CFDI: ${info.message}`
    throw new PlatformBillingError(
      stillInFlight && info.code === 'PROVIDER' ? `${IN_FLIGHT_NOTICE} ${text}` : text,
      info.code,
      info.field,
      {
        inFlight: stillInFlight,
        cfdiId: row.id,
      },
    )
  }
}

export async function listPlatformCfdis(
  filters: ListPlatformCfdisFilters,
): Promise<{ rows: PlatformCfdi[]; total: number; page: number; pageSize: number }> {
  const where: Prisma.PlatformCfdiWhereInput = {}
  if (filters.status) where.status = filters.status as Prisma.PlatformCfdiWhereInput['status']
  if (filters.type) where.type = filters.type as Prisma.PlatformCfdiWhereInput['type']
  if (filters.organizationId) where.organizationId = filters.organizationId
  if (filters.venueId) where.venueId = filters.venueId

  const page = Math.max(filters.page ?? 1, 1)
  const pageSize = Math.min(Math.max(filters.pageSize ?? 20, 1), MAX_PAGE_SIZE)

  const [rows, total] = await Promise.all([
    // `id` is the TIEBREAK — without it a tie group crossing a skip/take page boundary repeats a row
    // on one page and drops another for good (Asana 1217127206664238).
    prisma.platformCfdi.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
    prisma.platformCfdi.count({ where }),
  ])
  return { rows, total, page, pageSize }
}

export async function getPlatformCfdi(id: string): Promise<PlatformCfdi | null> {
  return prisma.platformCfdi.findUnique({ where: { id } })
}

/**
 * Discard (hard-delete) a CFDI that FAILED to stamp. Only `STAMP_FAILED` rows with no child
 * payment complements (REPs) can be removed — a STAMPED CFDI must be CANCELLED at the SAT, never
 * deleted. Used to clean up failed attempts so they don't pile up in the list. Returns the deleted
 * row so the controller can write the ActivityLog audit entry.
 */
export async function discardFailedPlatformCfdi(id: string, actorId?: string): Promise<PlatformCfdi> {
  const row = await prisma.platformCfdi.findUnique({ where: { id } })
  if (!row) throw new PlatformBillingError('CFDI no encontrado', 'NO_CFDI')
  if (row.status !== 'STAMP_FAILED') {
    throw new PlatformBillingError('Solo se pueden descartar facturas que fallaron al timbrar', 'VALIDATION')
  }
  if (row.platformChargeOccurrenceId) {
    // «Por cobrar»: la fila es el reclamo de un intento de factura. Se confirma con Facturapi y se cierra desde «Por cobrar»; borrarla
    // aquí a ciegas dejaría timbrar otra vez algo que el PAC pudo haber timbrado.
    throw new PlatformBillingError('Esta factura es de un cobro de «Por cobrar»: se reintenta o se deshace desde ahí', 'VALIDATION')
  }
  const children = await prisma.platformCfdi.count({ where: { parentPlatformCfdiId: id } })
  if (children > 0) {
    throw new PlatformBillingError('No se puede descartar; tiene complementos de pago asociados', 'VALIDATION')
  }
  // 🔴 Antes de borrar se le pregunta al PAC: la fila dice «falló», pero la respuesta pudo perderse y la factura existir ante el SAT. Un
  // complemento de pago queda como estaba: adoptarlo también tendría que mover el saldo de su factura (docs/audit/deuda-encontrada.md).
  if (row.type === 'INGRESO') {
    const fresh = await refreshPlatformCfdi(id, actorId)
    if (fresh.status !== 'STAMP_FAILED') throw conflict(`${stillAlive(fresh)} No se descartó.`, 'PLATFORM_CFDI_NOT_RETRYABLE')
  }
  await deleteIfStillFailed(prisma, id)
  return row
}

/**
 * Cancel a stamped CFDI. Motivo 01 (substitution) requires the substitute UUID. 🔴 «Cancelada» sólo cuando el SAT la canceló: en trámite
 * queda CANCEL_REQUESTED (sigue vigente; `refreshPlatformCfdi` la termina) y, si no procedió, sigue STAMPED y se dice.
 */
export async function cancelPlatformCfdi(
  id: string,
  motivo: '01' | '02' | '03' | '04',
  substituteUuid?: string,
  sandbox = false,
): Promise<PlatformCfdi> {
  const row = await prisma.platformCfdi.findUnique({ where: { id } })
  if (!row) throw new PlatformBillingError('CFDI no encontrado', 'NO_CFDI')
  if (row.status !== 'STAMPED') throw new PlatformBillingError('Solo se puede cancelar un CFDI timbrado', 'VALIDATION')
  if (motivo === '01' && !substituteUuid) throw new PlatformBillingError('El motivo 01 requiere el UUID que sustituye', 'VALIDATION')
  if (!row.facturapiId) throw new PlatformBillingError('El CFDI no tiene folio del proveedor', 'VALIDATION')

  const emisor = await prisma.platformEmisor.findUnique({ where: { id: row.platformEmisorId } })
  if (!emisor) throw new PlatformBillingError('Emisor no encontrado', 'NO_EMISOR')

  const provider = resolveFiscalProvider(
    { provider: emisor.provider, providerKeyEnc: emisor.providerKeyEnc },
    { sandbox: sandboxFor(emisor, sandbox) },
  )
  // 🔴 Se apunta ANTES de llamar: si la respuesta se pierde, la fila ya dice «en trámite» y «Consultar estado» la termina. Después de la
  // llamada, un corte dejaba «Timbrada» una factura que el SAT pudo cancelar, sin rastro y sin nada que consultar.
  const asked = { cancelMotivo: motivo, cancelSubstituteUuid: substituteUuid ?? null }
  const claimed = await prisma.platformCfdi.updateMany({
    where: { id: row.id, status: 'STAMPED' },
    data: { ...asked, status: 'CANCEL_REQUESTED', cancelStatus: 'pending', cancelledAt: null },
  })
  if (claimed.count === 0) throw conflict('Esta factura acaba de cambiar: vuelve a consultarla', 'PLATFORM_CFDI_CHANGED')
  // Lo que contesta esta llamada tarda: si otra pestaña ya confirmó la cancelación, su «no» ya no decide nada.
  const backToStamped = (cancelStatus: string | null) =>
    prisma.platformCfdi.updateMany({
      where: { id: row.id, status: 'CANCEL_REQUESTED' },
      data: { status: 'STAMPED', cancelMotivo: row.cancelMotivo, cancelSubstituteUuid: row.cancelSubstituteUuid, cancelStatus },
    })

  let res: Awaited<ReturnType<typeof provider.cancelInvoice>>
  try {
    res = await provider.cancelInvoice({ providerInvoiceId: row.facturapiId, motivo, substituteUuid })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // El PAC contestó que no: no pasó nada.
    if (err instanceof ProviderHttpError && err.status >= 400 && err.status < 500) {
      await backToStamped(row.cancelStatus)
      throw new PlatformBillingError(`El proveedor no aceptó la cancelación: ${message}`, 'PROVIDER')
    }
    throw new PlatformBillingError(
      `La cancelación pudo quedar en trámite: usa «Consultar estado» antes de volver a cancelar. ${message}`,
      'PROVIDER',
      undefined,
      { inFlight: true },
    )
  }

  if (res.status === 'canceled' || res.status === 'accepted') {
    return prisma.platformCfdi.update({
      where: { id: row.id },
      data: { ...asked, status: 'CANCELLED', cancelStatus: res.status, cancelledAt: res.cancelledAt ?? new Date() },
    })
  }
  if (res.status === 'pending') {
    // La respuesta de la cancelación manda sobre una consulta que se adelantó y la regresó a timbrada.
    await prisma.platformCfdi.updateMany({
      where: { id: row.id, status: { in: ['STAMPED', 'CANCEL_REQUESTED'] } },
      data: { ...asked, status: 'CANCEL_REQUESTED', cancelStatus: 'pending', cancelledAt: null },
    })
    return prisma.platformCfdi.findUniqueOrThrow({ where: { id: row.id } })
  }
  await backToStamped(res.status)
  throw conflict(`La cancelación de ${labelOf(row)} no procedió: sigue vigente`, 'PLATFORM_CFDI_CANCEL_NOT_DONE')
}

// ── Consultar estado ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const labelOf = (row: Pick<PlatformCfdi, 'serie' | 'folio'>): string => [row.serie, row.folio].filter(Boolean).join('-') || 'la factura'

/** Por qué una factura que parecía fallida no se puede reintentar ni descartar. */
function stillAlive(row: PlatformCfdi): string {
  if (row.status === 'STAMPED') return `Esta factura sí se timbró (${labelOf(row)}): ya quedó en la lista.`
  if (row.status === 'CANCELLED') return `Esta factura existe ante el SAT, cancelada (${labelOf(row)}): se conserva como rastro.`
  if (row.status === 'CANCEL_REQUESTED') return `La cancelación de ${labelOf(row)} sigue en trámite ante el SAT.`
  return 'Esta factura sigue en camino ante el SAT: consulta su estado más tarde.'
}

function audit(action: string, row: PlatformCfdi, actorId: string | undefined, data: Prisma.InputJsonObject): void {
  void logAction({
    staffId: actorId ?? null,
    venueId: row.venueId,
    organizationId: row.organizationId,
    action,
    entity: 'PlatformCfdi',
    entityId: row.id,
    data,
  })
}

function auditDiscarded(row: PlatformCfdi, actorId: string | undefined, extra: Prisma.InputJsonObject = {}): void {
  audit('PLATFORM_CFDI_DISCARDED', row, actorId, {
    priorStatus: row.status,
    receptorRfc: row.receptorRfc,
    totalCents: row.totalCents,
    ...extra,
  })
}

/** 🔴 Sólo si sigue fallida: otra pestaña pudo adoptarla mientras se le preguntaba al PAC, y borrarla perdería el rastro de una factura viva. */
async function deleteIfStillFailed(db: Pick<Prisma.TransactionClient, 'platformCfdi'>, id: string): Promise<void> {
  const { count } = await db.platformCfdi.deleteMany({ where: { id, status: 'STAMP_FAILED' } })
  if (count === 0) throw conflict('Esta factura acaba de cambiar: revisa la lista', 'PLATFORM_CFDI_CHANGED')
}

/** Quita la factura fallida que se está reintentando, dentro de la transacción que reserva la nueva. */
async function removeFailed(tx: Prisma.TransactionClient, id: string): Promise<PlatformCfdi> {
  const row = await tx.platformCfdi.findUnique({ where: { id } })
  if (!row || row.status !== 'STAMP_FAILED' || row.platformChargeOccurrenceId) {
    throw conflict('Esta factura acaba de cambiar: revisa la lista antes de reintentar', 'PLATFORM_CFDI_CHANGED')
  }
  if ((await tx.platformCfdi.count({ where: { parentPlatformCfdiId: id } })) > 0) {
    throw new PlatformBillingError('No se puede reintentar; tiene complementos de pago asociados', 'VALIDATION')
  }
  await deleteIfStillFailed(tx, id)
  return row
}

/**
 * Escribe sólo si la fila sigue como se leyó antes de preguntarle al PAC. Por `updatedAt` y no sólo por estado: mientras una consulta
 * espera, la fila pudo ir y volver (se rechazó una cancelación y se pidió otra), y esa respuesta vieja no es de este trámite.
 */
async function writeIfUnchanged(row: PlatformCfdi, data: Prisma.PlatformCfdiUncheckedUpdateManyInput): Promise<PlatformCfdi> {
  const { count } = await prisma.platformCfdi.updateMany({ where: { id: row.id, status: row.status, updatedAt: row.updatedAt }, data })
  const fresh = await prisma.platformCfdi.findUnique({ where: { id: row.id } })
  if (count === 0 || !fresh) throw conflict('Esta factura acaba de cambiar: vuelve a consultarla', 'PLATFORM_CFDI_CHANGED')
  return fresh
}

type PacDocument = StampedInvoice | ProviderInvoiceSummary

async function adopt(row: PlatformCfdi, doc: PacDocument & { uuid: string }, actorId?: string): Promise<PlatformCfdi> {
  const updated = await writeIfUnchanged(row, {
    status: 'STAMPED',
    facturapiId: doc.providerInvoiceId,
    uuid: doc.uuid,
    serie: doc.serie ?? row.serie,
    folio: doc.folio,
    stampedAt: doc.stampedAt ?? new Date(),
    totalCents: doc.totalCents,
    lastError: null,
  })
  if (doc.totalCents !== row.totalCents) {
    logger.error('[platform-billing] el total que timbró el PAC no es el de la fila adoptada; se guarda el del PAC', {
      platformCfdiId: row.id,
      rowTotalCents: row.totalCents,
      stampedTotalCents: doc.totalCents,
    })
  }
  audit('PLATFORM_CFDI_ISSUED', updated, actorId, { adopted: true, uuid: doc.uuid, totalCents: updated.totalCents })
  void emailAdopted(updated)
  return updated
}

/** Lo que dice el PAC de un documento del que no se tenía timbre. */
async function settleDocument(row: PlatformCfdi, doc: PacDocument, actorId?: string): Promise<PlatformCfdi> {
  if (doc.status === 'valid' && doc.uuid) return adopt(row, { ...doc, uuid: doc.uuid }, actorId)
  if (doc.status === 'canceled') {
    // Ese documento existe ante el SAT aunque esté cancelado: la fila es su rastro fiscal.
    const updated = await writeIfUnchanged(row, {
      status: 'CANCELLED',
      facturapiId: doc.providerInvoiceId,
      cancelStatus: 'canceled',
      cancelledAt: new Date(),
      uuid: doc.uuid ?? row.uuid,
      serie: doc.serie ?? row.serie,
      folio: doc.folio ?? row.folio,
    })
    audit('PLATFORM_CFDI_CANCELLED', updated, actorId, { source: 'PAC', priorStatus: row.status, uuid: updated.uuid })
    return updated
  }
  // Sigue en camino: nadie puede emitir ni borrar, y la próxima consulta pregunta por su id.
  return writeIfUnchanged(row, { status: 'STAMPING', facturapiId: doc.providerInvoiceId })
}

async function refreshStamp(row: PlatformCfdi, provider: FiscalProvider, actorId?: string): Promise<PlatformCfdi> {
  const providerId = row.facturapiId
  if (providerId) return settleDocument(row, await askPac(() => provider.getInvoice(providerId)), actorId)
  if (row.status === 'STAMPING' && Date.now() - row.createdAt.getTime() < STAMPING_GRACE_MS) {
    throw conflict('La factura se está timbrando; espera un par de minutos y consulta de nuevo', 'PLATFORM_CFDI_STAMPING')
  }
  const key = row.idempotencyKey
  const found = key ? await askPac(() => provider.findByExternalId(key)) : null
  if (found) return settleDocument(row, found, actorId)
  if (row.status === 'STAMP_FAILED') return row
  // Se le preguntó y no hay nada: ahora sí se puede corregir, reintentar o descartar.
  return writeIfUnchanged(row, {
    status: 'STAMP_FAILED',
    lastError: row.lastError ?? 'La factura no llegó al SAT: puedes reintentarla o descartarla',
  })
}

async function refreshCancellation(row: PlatformCfdi, provider: FiscalProvider, actorId?: string): Promise<PlatformCfdi> {
  const providerId = row.facturapiId
  const answer = providerId ? await askPac(async () => provider.getCancellationStatus?.(providerId)) : undefined
  // Un proveedor que no sabe contestar esto (o una fila sin id) no deja decidir: jamás se supone que se canceló.
  if (!answer) throw conflict('No puedo consultar la cancelación en Facturapi; confírmala ahí', 'PLATFORM_CHARGE_INVOICE_UNCONFIRMED')
  if (answer.status === 'canceled' || answer.status === 'accepted') {
    const updated = await writeIfUnchanged(row, {
      status: 'CANCELLED',
      cancelStatus: answer.status,
      cancelledAt: answer.cancelledAt ?? row.cancelledAt ?? new Date(),
    })
    if (row.status !== 'CANCELLED') audit('PLATFORM_CFDI_CANCELLED', updated, actorId, { source: 'PAC', priorStatus: row.status })
    return updated
  }
  if (answer.status === 'pending') return writeIfUnchanged(row, { status: 'CANCEL_REQUESTED', cancelStatus: 'pending', cancelledAt: null })
  // Recién pedida: la petición puede seguir en vuelo y el PAC todavía no saberlo. Sólo tras la espera, «none» quiere decir que no se pidió.
  if (answer.status === 'none' && row.status === 'CANCEL_REQUESTED' && Date.now() - row.updatedAt.getTime() < STAMPING_GRACE_MS) return row
  const updated = await writeIfUnchanged(row, { status: 'STAMPED', cancelStatus: answer.status, cancelledAt: null })
  audit('PLATFORM_CFDI_CANCEL_NOT_APPLIED', updated, actorId, { pacStatus: answer.status, priorStatus: row.status })
  return updated
}

/**
 * «Consultar estado»: le pregunta al PAC qué hay de una factura que la base no tiene confirmada y deja la fila como es. Nunca emite.
 * Sirve también para las filas viejas que quedaron mal escritas: STAMPED sin UUID y CANCELLED con una cancelación sin confirmar.
 * Una fila ligada a «Por cobrar» se termina desde ahí (`resolverIntento`), salvo su cancelación, que sí se consulta aquí: ésa es la
 * salida de «Deshacer» mientras sigue en trámite. De un complemento de pago sólo su cancelación: adoptar uno también tendría que mover
 * el saldo de su factura.
 */
export async function refreshPlatformCfdi(id: string, actorId?: string, sandbox = false): Promise<PlatformCfdi> {
  const row = await prisma.platformCfdi.findUnique({ where: { id } })
  if (!row) throw new PlatformBillingError('CFDI no encontrado', 'NO_CFDI')

  const cancelUnconfirmed =
    row.status === 'CANCEL_REQUESTED' || (row.status === 'CANCELLED' && row.cancelStatus !== 'canceled' && row.cancelStatus !== 'accepted')
  const stampUnconfirmed = row.status === 'STAMPING' || row.status === 'STAMP_FAILED' || (row.status === 'STAMPED' && !row.uuid)
  if (!cancelUnconfirmed && !stampUnconfirmed) return row
  if (stampUnconfirmed && row.type !== 'INGRESO') {
    throw new PlatformBillingError('El timbre de un complemento de pago no se consulta aquí', 'VALIDATION')
  }
  if (stampUnconfirmed && row.platformChargeOccurrenceId) {
    throw conflict('Esta factura es de un cobro: su estado se consulta en «Por cobrar»', 'PLATFORM_CFDI_OF_A_CHARGE')
  }

  const emisor = await prisma.platformEmisor.findUnique({ where: { id: row.platformEmisorId } })
  if (!emisor) throw new PlatformBillingError('Emisor no encontrado', 'NO_EMISOR')
  const provider = resolveFiscalProvider(
    { provider: emisor.provider, providerKeyEnc: emisor.providerKeyEnc },
    { sandbox: sandboxFor(emisor, sandbox) },
  )
  return cancelUnconfirmed ? refreshCancellation(row, provider, actorId) : refreshStamp(row, provider, actorId)
}

/** El correo con PDF y XML al receptor de una factura que se acaba de adoptar, sin que su falla cuente. */
export async function emailAdopted(cfdi: PlatformCfdi): Promise<void> {
  try {
    const profile = cfdi.billingTaxProfileId
      ? await prisma.billingTaxProfile.findUnique({ where: { id: cfdi.billingTaxProfileId }, select: { email: true } })
      : null
    if (profile?.email) await sendPlatformCfdiEmail(cfdi.id, profile.email)
  } catch (error) {
    logger.warn('[platform-billing] no se pudo mandar el correo de una factura adoptada', {
      platformCfdiId: cfdi.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Build the FULL related-document tax breakdown (Pago 2.0), grouping lines by rate (+ exempt). */
function buildRelatedDocTaxes(lines: PlatformCfdiLineInput[]): PaymentComplementTax[] {
  const byRate = new Map<number, number>()
  let exemptBaseCents = 0
  for (const line of lines) {
    const importe = Math.round(line.quantity * line.unitPriceCents)
    const baseCents = importe - Math.round(line.discountCents ?? 0)
    if (line.taxExempt) {
      exemptBaseCents += baseCents
    } else {
      const rate = line.taxRate ?? DEFAULT_IVA_RATE
      byRate.set(rate, (byRate.get(rate) ?? 0) + baseCents)
    }
  }
  const taxes: PaymentComplementTax[] = []
  for (const [rate, baseCents] of byRate) taxes.push({ baseCents, rate, type: 'IVA', factor: 'Tasa', withholding: false })
  if (exemptBaseCents > 0) taxes.push({ baseCents: exemptBaseCents, rate: 0, type: 'IVA', factor: 'Exento', withholding: false })
  return taxes
}

/** If every line is taxed at exactly one IVA rate (no exempt), return that rate; else null. */
function singleIvaRate(lines: PlatformCfdiLineInput[]): number | null {
  const rates = new Set<number>()
  for (const line of lines) {
    if (line.taxExempt) return null
    rates.add(line.taxRate ?? DEFAULT_IVA_RATE)
  }
  return rates.size === 1 ? [...rates][0] : null
}

/**
 * Pago 2.0 DR tax breakdown for a (possibly partial) payment of `amountCents` (gross) on a
 * single-rate invoice: BaseDR = amount / (1 + rate); ImporteDR = BaseDR * rate (computed by the
 * provider). BaseDR + ImporteDR === amount, so installments always sum to the invoice total.
 */
function partialRepTaxes(amountCents: number, rate: number): PaymentComplementTax[] {
  return [{ baseCents: Math.round(amountCents / (1 + rate)), rate, type: 'IVA', factor: 'Tasa', withholding: false }]
}

/**
 * Register a payment against a PPD income CFDI by stamping a Complemento de Pago (REP, type P).
 * Supports PARCIALIDADES: pass `amountCents` for a partial payment (defaults to the full remaining
 * balance). Each payment is one REP carrying NumParcialidad / ImpSaldoAnt / ImpSaldoInsoluto and IVA
 * proportional to the amount; the parent's amountPaidCents is bumped atomically. Idempotent by
 * idempotencyKey. Partial payments require a single IVA rate; mixed/exempt invoices must be paid in full.
 */
export async function registerPlatformPayment(input: RegisterPaymentInput): Promise<PlatformCfdi> {
  const prior = await prisma.platformCfdi.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
  if (prior) return prior

  const parent = await prisma.platformCfdi.findUnique({ where: { id: input.platformCfdiId } })
  if (!parent) throw new PlatformBillingError('CFDI no encontrado', 'NO_CFDI')
  if (parent.type !== 'INGRESO') throw new PlatformBillingError('Solo las facturas de ingreso reciben complemento de pago', 'VALIDATION')
  if (parent.metodoPago !== 'PPD') throw new PlatformBillingError('Solo las facturas PPD requieren complemento de pago', 'VALIDATION')
  if (parent.status !== 'STAMPED') throw new PlatformBillingError('La factura debe estar timbrada', 'VALIDATION')
  if (!parent.uuid) throw new PlatformBillingError('La factura no tiene folio fiscal (UUID)', 'VALIDATION')

  const saldoAnteriorCents = parent.totalCents - parent.amountPaidCents
  if (saldoAnteriorCents <= 0) throw new PlatformBillingError('La factura ya está saldada', 'VALIDATION')

  const amountCents = input.amountCents ?? saldoAnteriorCents
  if (amountCents <= 0) throw new PlatformBillingError('El monto del pago debe ser mayor a 0', 'VALIDATION')
  if (amountCents > saldoAnteriorCents) throw new PlatformBillingError('El monto excede el saldo pendiente de la factura', 'VALIDATION')

  const lines = (parent.lines as unknown as PlatformCfdiLineInput[] | null) ?? []
  const rate = singleIvaRate(lines)
  const isFullSinglePayment = parent.amountPaidCents === 0 && amountCents === parent.totalCents
  let taxes: PaymentComplementTax[]
  if (rate != null) {
    taxes = partialRepTaxes(amountCents, rate)
  } else if (isFullSinglePayment) {
    taxes = buildRelatedDocTaxes(lines) // factura con IVA mixto/exento, pagada de una sola vez
  } else {
    throw new PlatformBillingError(
      'Las parcialidades solo están soportadas para facturas con una sola tasa de IVA; registra el pago total',
      'VALIDATION',
    )
  }

  const priorStampedReps = await prisma.platformCfdi.count({ where: { parentPlatformCfdiId: parent.id, type: 'PAGO', status: 'STAMPED' } })
  const installment = priorStampedReps + 1
  const saldoInsolutoCents = saldoAnteriorCents - amountCents

  const emisor = await getActivePlatformEmisor()
  if (!emisor) throw new PlatformBillingError('No hay emisor de plataforma configurado', 'NO_EMISOR')
  const sandbox = input.sandbox ?? false

  // Reserve the REP row (unique idempotencyKey) before calling the PAC.
  let row: PlatformCfdi
  try {
    row = await prisma.$transaction(async tx => {
      // 🔴 Un complemento no pasa sobre una factura anexada a un cobro sin pagar de «Por cobrar»: la fecha seguiría debiendo lo que ya se cobró. Tocar al
      // padre lo serializa con «anexar» (que escribe sólo si su `updatedAt` leído sigue igual): si anexó antes, este `update` espera su candado de fila y
      // devuelve el vínculo ya escrito; si reservamos antes, anexar ve que cambió. Nada del PAC va dentro de esta transacción.
      const linked = await tx.platformCfdi.update({
        where: { id: parent.id },
        data: { updatedAt: new Date() },
        select: { platformChargeOccurrenceId: true, chargeLinkedAt: true },
      })
      if (linked.chargeLinkedAt && linked.platformChargeOccurrenceId) {
        const date = await tx.platformChargeOccurrence.findUnique({
          where: { id: linked.platformChargeOccurrenceId },
          select: { status: true },
        })
        if (date?.status === 'PENDING') {
          throw new PlatformBillingError(
            'Esta factura está anexada a un cobro sin pagar en «Por cobrar». Márcalo como pagado primero y después registra el complemento',
            'VALIDATION',
          )
        }
      }
      return tx.platformCfdi.create({
        data: {
          platformEmisorId: emisor.id,
          billingTaxProfileId: parent.billingTaxProfileId,
          type: 'PAGO',
          parentPlatformCfdiId: parent.id,
          organizationId: parent.organizationId,
          venueId: parent.venueId,
          receptorRfc: parent.receptorRfc,
          receptorNombre: parent.receptorNombre,
          receptorRegimen: parent.receptorRegimen,
          receptorCp: parent.receptorCp,
          usoCfdi: 'CP01', // CFDI tipo P → uso "Pagos"
          formaPago: input.formaPago,
          subtotalCents: 0,
          taxCents: 0,
          totalCents: 0, // CFDI tipo P lleva Total 0; el importe vive en el complemento
          status: 'STAMPING',
          serie: parent.serie,
          idempotencyKey: input.idempotencyKey,
          createdById: input.performedById,
          paymentInfo: {
            fechaPago: input.paymentDate,
            formaPago: input.formaPago,
            montoCents: amountCents,
            parcialidad: installment,
            saldoAnteriorCents,
            saldoInsolutoCents,
          } as unknown as Prisma.InputJsonValue,
        },
      })
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const dup = await prisma.platformCfdi.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
      if (dup) return dup
    }
    throw e
  }

  try {
    const provider = resolveFiscalProvider({ provider: emisor.provider, providerKeyEnc: emisor.providerKeyEnc }, { sandbox })
    if (!provider.createPaymentComplement) throw new PlatformBillingError('El proveedor fiscal no soporta complemento de pago', 'PROVIDER')

    const stamped = await provider.createPaymentComplement({
      receptor: {
        rfc: parent.receptorRfc,
        razonSocial: parent.receptorNombre,
        regimenFiscal: parent.receptorRegimen,
        codigoPostal: parent.receptorCp,
      },
      paymentDate: new Date(input.paymentDate),
      paymentForm: input.formaPago,
      serie: parent.serie ?? undefined,
      externalId: input.idempotencyKey,
      relatedDocuments: [{ uuid: parent.uuid, amountCents, installment, lastBalanceCents: saldoAnteriorCents, taxes }],
    })

    const updated = await prisma.$transaction(async tx => {
      const rep = await tx.platformCfdi.update({
        where: { id: row.id },
        data: {
          status: 'STAMPED',
          facturapiId: stamped.providerInvoiceId,
          uuid: stamped.uuid,
          serie: stamped.serie ?? parent.serie,
          folio: stamped.folio,
          stampedAt: stamped.stampedAt,
        },
      })
      await tx.platformCfdi.update({ where: { id: parent.id }, data: { amountPaidCents: { increment: amountCents } } })
      return rep
    })
    return updated
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await prisma.platformCfdi.update({
      where: { id: row.id },
      data: { status: 'STAMP_FAILED', lastError: message, attempts: { increment: 1 } },
    })
    if (err instanceof PlatformBillingError) throw err
    const info = classifyStampError(message)
    throw new PlatformBillingError(`Error al timbrar el complemento de pago: ${info.message}`, info.code, info.field)
  }
}

/** List the payment complements (REPs) registered against a parent income CFDI. */
export async function listPlatformCfdiPayments(parentId: string): Promise<PlatformCfdi[]> {
  return prisma.platformCfdi.findMany({ where: { parentPlatformCfdiId: parentId, type: 'PAGO' }, orderBy: { createdAt: 'asc' } })
}

/**
 * Send a stamped CFDI (PDF + XML) to the receptor by email via the PAC. Uses the
 * override email, else the receptor profile's email. Stamps emailSentAt on success.
 */
export async function sendPlatformCfdiEmail(id: string, emailOverride?: string, sandbox = false): Promise<PlatformCfdi> {
  const row = await prisma.platformCfdi.findUnique({ where: { id } })
  if (!row) throw new PlatformBillingError('CFDI no encontrado', 'NO_CFDI')
  if (row.status !== 'STAMPED' || !row.facturapiId) throw new PlatformBillingError('Solo se puede enviar un CFDI timbrado', 'VALIDATION')

  let email = emailOverride
  if (!email && row.billingTaxProfileId) {
    const profile = await prisma.billingTaxProfile.findUnique({ where: { id: row.billingTaxProfileId } })
    email = profile?.email ?? undefined
  }
  if (!email) throw new PlatformBillingError('El receptor no tiene correo registrado; captura uno o envíalo manualmente', 'VALIDATION')

  const emisor = await prisma.platformEmisor.findUnique({ where: { id: row.platformEmisorId } })
  if (!emisor) throw new PlatformBillingError('Emisor no encontrado', 'NO_EMISOR')

  const provider = resolveFiscalProvider(
    { provider: emisor.provider, providerKeyEnc: emisor.providerKeyEnc },
    { sandbox: sandboxFor(emisor, sandbox) },
  )
  if (!provider.sendInvoiceByEmail) throw new PlatformBillingError('El proveedor fiscal no soporta envío por correo', 'PROVIDER')

  await provider.sendInvoiceByEmail(row.facturapiId, email)
  return prisma.platformCfdi.update({ where: { id: row.id }, data: { emailSentAt: new Date() } })
}

/** Fetch the stamped XML/PDF bytes from the PAC for download. */
export async function fetchPlatformCfdiArtifact(
  id: string,
  kind: 'pdf' | 'xml',
  sandbox = false,
): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
  const row = await prisma.platformCfdi.findUnique({ where: { id } })
  if (!row) throw new PlatformBillingError('CFDI no encontrado', 'NO_CFDI')
  if (!row.facturapiId) throw new PlatformBillingError('El CFDI aún no está timbrado', 'VALIDATION')

  const emisor = await prisma.platformEmisor.findUnique({ where: { id: row.platformEmisorId } })
  if (!emisor) throw new PlatformBillingError('Emisor no encontrado', 'NO_EMISOR')

  const provider = resolveFiscalProvider(
    { provider: emisor.provider, providerKeyEnc: emisor.providerKeyEnc },
    { sandbox: sandboxFor(emisor, sandbox) },
  )
  const buffer = kind === 'pdf' ? await provider.downloadPdf(row.facturapiId) : await provider.downloadXml(row.facturapiId)
  const filename = `${row.serie ?? ''}${row.folio ?? row.id}.${kind}`
  return { buffer, filename, contentType: kind === 'pdf' ? 'application/pdf' : 'application/xml' }
}
