// src/services/fiscal/cfdiReplacement.service.ts
//
// Sustituir una factura equivocada: se timbra la CORREGIDA relacionada a la original
// (CFDI 4.0, c_TipoRelacion '04') y después se pide cancelar la original con motivo '01'
// apuntando a la nueva. Es el camino que el SAT define para corregir un importe, y es el que
// Testarudo necesita para las 6 facturas que salieron por menos de lo cobrado.
//
// 🔴 Lo que hace delicada esta operación: son DOS documentos fiscales en DOS llamadas al PAC.
// Entre una y otra el proceso puede morir. Por eso:
//
//   1. La sustituta se RESERVA en la base —con `replacesCfdiId` apuntando a la original— ANTES
//      de llamar al PAC. Ese vínculo es el intento durable: si el proceso muere, volver a pedir
//      la sustitución REANUDA desde donde se quedó en vez de timbrar un tercer documento.
//   2. Nunca se promete que la original quedó cancelada. El PAC puede contestar `pending`
//      (espera la aceptación del receptor) o `rejected`, y eso se devuelve tal cual.
//   3. El documento corregido pasa las MISMAS barreras que uno nuevo: sobre seguro, validación
//      D1 y la barrera de dinero. Sustituir una factura equivocada por otra equivocada es peor
//      que no hacer nada — la primera al menos se puede cancelar.

import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { ConflictError, ProviderUnavailableError } from '../../errors/AppError'
import { uploadFileToStorage } from '../storage.service'
import { resolveFiscalProvider } from './fiscalProvider.factory'
import { buildCreateInvoiceParams } from './cfdiPayloadBuilder'
import { validateBeforeStamp } from './cfdiValidation'
import { assembleSaleInput } from './assembleSaleInput'
import { correoCapturado } from './cfdiEmail.service'
import {
  cancelCfdi,
  anotarIntencionDeCancelar,
  tomarEnvio,
  sigoSiendoDueno,
  refreshPendingCancellation,
  emitirConEntrada,
  finalizarEmision,
  type IssueCfdiDeps,
  aplicarCancelacion,
  type CancelCfdiDeps,
  claimWhere,
  loadOrderForCfdiFromDb,
  STAMPING_TTL_MS,
  type LoadedOrderBundle,
  type IssueReceptor,
} from './cfdi.service'
import { conceptoDesdeElPayload, totalSegunElPacCents } from './reglaDelPac'
import type { ArchivosCfdi } from './finalizadorCfdi'

export interface ReplaceCfdiDeps {
  /** La factura ORIGINAL, con su `fiscalEmisor` incluido (lo necesita el conector). */
  loadCfdi: (cfdiId: string) => Promise<any | null>
  /** La sustituta que ya exista para esta original — el intento durable de una corrida anterior. */
  findSustituta: (originalCfdiId: string) => Promise<any | null>
  loadOrderForCfdi: IssueCfdiDeps['loadOrderForCfdi']
  runInTransaction?: IssueCfdiDeps['runInTransaction']
  resolveProvider: typeof resolveFiscalProvider
  /** INSERT que reserva la llave de la sustituta. Un P2002 es la carrera con otra petición. */
  reserveCfdi: IssueCfdiDeps['reserveCfdi']
  persistCfdi: IssueCfdiDeps['persistCfdi']
  /** Reclamo con la VERSIÓN leída (`attempts`) — ver `claimCfdi` en cfdi.service (Codex P1-1). */
  claimCfdi: (cfdiId: string, desdeEstados: string[], version: number) => Promise<boolean>
  /** Guarda SÓLO los archivos (URLs y, C2 · T5, la evidencia del XML); nunca el estado fiscal (Codex P1-4). */
  persistArtifacts: (idempotencyKey: string, urls: ArchivosCfdi, version?: number) => Promise<any>
  storeArtifact: (buffer: Buffer, path: string, contentType: string) => Promise<string>
  updateCfdi: CancelCfdiDeps['updateCfdi']
  /** C2: lo que `cancelCfdi` necesita para anotar la intención, tomar el único envío, releer el token y consultar. */
  anotarIntencion: CancelCfdiDeps['anotarIntencion']
  tomarEnvio: CancelCfdiDeps['tomarEnvio']
  dueno: NonNullable<CancelCfdiDeps['dueno']>
  refresh: CancelCfdiDeps['refresh']
}

export interface ReplaceCfdiResult {
  status: 'REPLACED' | 'VALIDATION_FAILED' | 'STAMP_FAILED'
  /** La factura corregida. `null` cuando no se llegó a timbrar. */
  sustituta: any | null
  original: any
  /** Lo que el PAC contestó sobre la cancelación de la ORIGINAL. `null` = ni siquiera contestó. */
  cancelStatus: 'REQUESTED' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED' | null
  /** true mientras la original NO conste cancelada. La pantalla lo tiene que decir. */
  cancelPendiente: boolean
  reasons?: string[]
  /**
   * C2 (M6/G4): la cancelación de la original NO se pudo ni anotar, por una regla (documentos relacionados vivos, u otra cancelación en
   * trámite con otro motivo): su texto, para que la pantalla diga qué hacer. Nuevo y opcional.
   */
  cancelConflicto?: string
  /** C2 ronda 2 (N3): la cancelación de la original no salió por un aviso del PAC (p. ej. no se pudo consultar antes de enviarla). */
  cancelAviso?: string
  /**
   * Ronda de la ola (3): la cancelación de la original quedó EN DUDA (el POST no tuvo respuesta clara; sólo se consulta). Sólo cuando es
   * verdad, con la misma regla que `cancelCfdi`. Nuevo y opcional.
   */
  enDuda?: true
  /**
   * Ronda de la ola (3): ESTA petición anotó un intento NUEVO de cancelar la original. `false` ⇒ el `cancelStatus` que se devuelve no es de
   * esta petición (p. ej. el REJECTED de un intento anterior, si falló antes de anotar). Nuevo y opcional.
   */
  cancelIntentoNuevo?: boolean
}

/**
 * La llave de la sustituta, derivada de la de la original: `…-r1`, y `…-r2` si lo que se sustituye
 * ya era una sustituta. Determinista a propósito — dos peticiones para la MISMA corrección chocan
 * en el índice único en vez de producir dos documentos.
 */
export function siguienteLlaveDeSustitucion(llaveOriginal: string | null | undefined, orderId: string): string {
  const base = llaveOriginal ?? `cfdi-order-${orderId}`
  const m = base.match(/^(.*)-r(\d+)$/)
  if (m) return `${m[1]}-r${Number(m[2]) + 1}`
  return `${base}-r1`
}

export async function replaceCfdi(
  params: { cfdiId: string; sandbox: boolean; expectedVenueId?: string },
  overrides: Partial<ReplaceCfdiDeps> = {},
): Promise<ReplaceCfdiResult> {
  const deps = { ...defaultReplaceDeps, ...overrides }
  // 1. Cargar la original + aislamiento de inquilino (mismo patrón que cancelCfdi).
  const original = await deps.loadCfdi(params.cfdiId)
  if (!original) throw new Error(`CFDI ${params.cfdiId} not found`)
  if (params.expectedVenueId && original.venueId !== params.expectedVenueId) {
    throw new Error(`CFDI ${params.cfdiId} not found`) // → 404, sin fuga entre negocios
  }

  // 2. Guardas de negocio.
  if (original.isGlobal || !original.orderId) {
    throw new Error('La factura global no se sustituye por este camino; cancélala y vuelve a emitirla.')
  }
  // 🔴 Una nota de crédito (EGRESO) también tiene `orderId` y puede estar STAMPED. Sustituirla por
  // este camino reconstruiría la factura de VENTA: un documento de otro tipo que no corresponde al
  // que se relaciona (Codex P2-7).
  if (original.type && original.type !== 'INGRESO') {
    throw new Error('Esta es una nota de crédito (egreso), no una factura de venta; no se sustituye por este camino.')
  }
  if (!original.uuid || !original.facturapiId) {
    throw new Error('La factura original no tiene folio fiscal; no se puede relacionar una sustituta.')
  }

  // 3. ¿Ya hay un intento durable de una corrida anterior?
  //    🔴 Se mira ANTES del guardado por estado: si la sustitución ya terminó, la original está
  //    CANCELLED y contestar 409 sería castigar a quien sólo perdió la respuesta (Codex P2-5).
  const previa = await deps.findSustituta(original.id)

  if (previa) {
    // Aislamiento: una sustituta SIEMPRE nace con el venue de su original. Una fila que diga otra cosa
    // está corrupta y no se usa para cancelar un documento fiscal.
    if (previa.venueId && previa.venueId !== original.venueId) {
      throw new Error(`CFDI ${params.cfdiId} not found`)
    }
  }
  if (previa?.status === 'STAMPED' && (original.status === 'CANCELLED' || original.cancelStatus === 'ACCEPTED')) {
    // Replay de una sustitución COMPLETA: se contesta lo mismo, sin volver a pedirle nada al PAC.
    if (!previa.uuid) throw new Error('La factura sustituta quedó sin folio fiscal; espera la conciliación antes de reintentar.')
    return { status: 'REPLACED', sustituta: previa, original, cancelStatus: original.cancelStatus ?? 'CANCELLED', cancelPendiente: false }
  }
  if (original.status !== 'STAMPED' && !(previa?.protocoloIva === 1 && previa.enviadoAt)) {
    throw new Error('Solo se puede sustituir una factura timbrada y vigente.')
  }
  if (previa?.status === 'STAMPED') {
    if (!previa.uuid) {
      // Timbrada sin folio fiscal: no se puede relacionar la cancelación. Lo resuelve el job de
      // conciliación (completa el UUID contra el PAC por `external_id`), no un segundo timbre.
      throw new Error('La factura sustituta quedó sin folio fiscal; espera la conciliación antes de reintentar.')
    }
    // Ya se timbró: NO se vuelve a timbrar. Lo que falta es la cancelación — se reanuda ahí.
    return await cancelarOriginal(params, original, previa, deps, 'REPLACED')
  }
  const emissionDeps = { ...deps, findExistingCfdi: () => deps.findSustituta(original.id) }
  if (!previa || previa.protocoloIva === 1) {
    const receptor: IssueReceptor = {
      rfc: original.receptorRfc,
      razonSocial: original.receptorNombre,
      regimenFiscal: original.receptorRegimen,
      codigoPostal: original.receptorCp,
      usoCfdi: original.usoCfdi,
      // H24: la corregida llega al mismo correo que la original.
      email: correoCapturado(original.entrada),
    }
    const result = await emitirConEntrada(
      { orderId: original.orderId, receptor, sandbox: params.sandbox, flow: original.flow ?? 'STAFF_B', expectedVenueId: original.venueId },
      previa?.idempotencyKey ?? siguienteLlaveDeSustitucion(original.idempotencyKey, original.orderId),
      emissionDeps,
      { id: original.id, uuid: original.uuid, fiscalEmisorId: original.fiscalEmisorId },
    ).catch((err: unknown) => {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw new ConflictError('Sustitución en proceso para esta factura')
      throw err
    })
    if (result.status === 'STAMPED') return cancelarOriginal(params, original, result.cfdi, deps, 'REPLACED')
    return {
      status: result.status,
      sustituta: result.status === 'VALIDATION_FAILED' ? null : result.cfdi,
      original,
      cancelStatus: null,
      cancelPendiente: true,
      ...(result.reasons ? { reasons: result.reasons } : {}),
    }
  }
  // Sólo las filas históricas persistidas sin protocolo conservan el ciclo anterior.
  // C2 · Tarea 3: esta rama NO lleva las guardas de la sustitución (cancelación en trámite, G4). Es inalcanzable mientras exista la
  // restricción `Cfdi_heredada_solo_terminada` (D21): una sustituta heredada sólo puede estar STAMPED/CANCEL_REQUESTED/CANCELLED y
  // `claimCfdi` no reclama ninguno de esos estados (409 antes del PAC). Quitar esa restricción exige poner aquí las guardas.
  // C2 · T10 (M4 de la T3): una sustituta HEREDADA ya terminada (cancelada, o con su cancelación pendiente) no se reclama nunca (D21):
  // antes contestaba para siempre «Sustitución en proceso para esta factura», que es falso. Se dice qué pasó y a quién acudir; nada se
  // timbra (volver a sustituir esa original no es automático: la fila heredada ocupa su lugar).
  if (previa && (previa.status === 'CANCELLED' || previa.status === 'CANCEL_REQUESTED')) {
    const folio = [previa.serie, previa.folio].filter(Boolean).join('-') || previa.uuid || 'sin folio'
    throw new ConflictError(
      previa.status === 'CANCELLED'
        ? `La corrección anterior de esta factura (${folio}) se canceló antes de este sistema, así que no se puede volver a sustituir desde aquí. Escríbenos a soporte para resolverla.`
        : `La corrección anterior de esta factura (${folio}) tiene una cancelación pendiente de antes de este sistema, así que no se puede volver a sustituir desde aquí. Escríbenos a soporte para resolverla.`,
    )
  }
  if (previa && previa.status === 'STAMPING') {
    const ageMs = Date.now() - new Date(previa.updatedAt ?? previa.createdAt ?? Date.now()).getTime()
    if (ageMs < STAMPING_TTL_MS) throw new Error('Sustitución en proceso para esta factura') // → 409
    logger.warn(`[cfdi] reclamando sustitución STAMPING vieja de ${original.id} (${Math.round(ageMs / 1000)}s)`)
  }
  // El reclamo legacy conserva su incremento y su identidad PAC sin sufijo de versión.
  const mio = await deps.claimCfdi(previa.id, ['STAMPING', 'STAMP_FAILED', 'VALIDATION_FAILED'], previa.attempts ?? 0)
  if (!mio) throw new ConflictError('Sustitución en proceso para esta factura')
  const llave = previa.idempotencyKey ?? siguienteLlaveDeSustitucion(original.idempotencyKey, original.orderId)
  let legacyReservation = { ...previa, idempotencyKey: llave, status: 'STAMPING', attempts: (previa.attempts ?? 0) + 1 }
  const legacyWhere = { id: previa.id, attempts: legacyReservation.attempts, status: 'STAMPING' as const }

  // 4. Armar el documento CORREGIDO con los datos ACTUALES de la orden.
  // La sustitución la hace el personal a propósito: el interruptor de efectivo es de la autofactura.
  const bundle = await deps.loadOrderForCfdi(original.orderId, { permitirEfectivo: true })
  if (!bundle) throw new Error(`Order ${original.orderId} not found or has no fiscal emisor configured`)
  if (bundle.venueId !== original.venueId) throw new Error(`CFDI ${params.cfdiId} not found`)
  // 🔴 Una sustitución vive ENTRE DOS DOCUMENTOS DEL MISMO EMISOR. Si el negocio cambió de comercio
  // (o de RFC) desde que se emitió la original, relacionarlas sería declarar que el emisor nuevo
  // sustituye un comprobante que no es suyo.
  if (bundle.emisor.id !== original.fiscalEmisorId) {
    throw new Error('El emisor fiscal de esta cuenta cambió desde que se emitió la factura; no se puede sustituir automáticamente.')
  }

  // El receptor se conserva DE LA ORIGINAL: una sustitución corrige el importe, no a quién se le factura.
  const receptor: IssueReceptor = {
    rfc: original.receptorRfc,
    razonSocial: original.receptorNombre,
    regimenFiscal: original.receptorRegimen,
    codigoPostal: original.receptorCp,
    usoCfdi: original.usoCfdi,
  }

  const saleInput = assembleSaleInput(bundle.order, {
    receptor,
    paymentMethod: bundle.paymentMethod,
    tenderSatFormaPago: bundle.tenderSatFormaPago ?? null,
    metodoPago: bundle.metodoPago,
    serie: bundle.emisor.serie ?? undefined,
    idempotencyKey: llave,
  })
  const invoiceParams = buildCreateInvoiceParams(saleInput)
  invoiceParams.externalId = llave
  invoiceParams.relation = { tipoRelacion: '04', relatedUuids: [original.uuid] }

  // 5. Las MISMAS barreras que una emisión nueva. Se validan ANTES de reservar: una corrección que
  //    no cuadra no deja basura en la base ni toca al PAC.
  const validation = validateBeforeStamp({
    csdStatus: bundle.emisor.csdStatus,
    formaPago: invoiceParams.formaPago,
    receptor: { ...receptor },
    items: invoiceParams.items,
    expectedSubtotalCents: bundle.subtotalCents,
    expectedTaxCents: bundle.taxCents,
    expectedTotalCents: bundle.totalCents,
    isGlobal: false,
  })
  const reasons = [...validation.reasons, ...(bundle.unsupportedReasons ?? [])]
  // B3a Tarea 6b: el documento que SE MANDA, sumado como el PAC (tras el ajuste del cargador, la suma por concepto ya no es lo cobrado).
  const documentoCents = totalSegunElPacCents(invoiceParams.items.map(conceptoDesdeElPayload))
  if (!bundle.unsupportedReasons?.length && bundle.paidCents !== undefined && bundle.paidCents !== documentoCents) {
    const pesos = (c: number) => `$${(c / 100).toFixed(2)}`
    reasons.push(
      `El total de la factura corregida (${pesos(documentoCents)}) no coincide con lo cobrado (${pesos(bundle.paidCents)}). No se sustituyó; revisa la cuenta o repórtala a soporte.`,
    )
  }
  if (reasons.length > 0) {
    return { status: 'VALIDATION_FAILED', sustituta: null, original, cancelStatus: null, cancelPendiente: true, reasons }
  }

  // La fila histórica ya fue reclamada; sólo un envío nuevo refresca su dinero.
  const datosBase = baseSustitutaData(original, bundle, llave, receptor, invoiceParams)

  // 7. Timbrar.
  const provider = deps.resolveProvider(bundle.emisor as any, { sandbox: params.sandbox })

  // 🔴 Si esta fila viene de un intento anterior, ese intento PUDO haber timbrado y perder la
  // respuesta (un timeout después de que el PAC contestó). Re-timbrar sin preguntar produciría un
  // TERCER documento fiscal por la misma venta (Codex P1-2).
  if (typeof provider.findByExternalId === 'function') {
    let previo
    try {
      previo = await provider.findByExternalId(llave)
    } catch (err: unknown) {
      logger.error(
        `[cfdi] no se pudo consultar el PAC antes de reintentar la sustituta ${llave}: ${err instanceof Error ? err.message : String(err)}`,
      )
      throw new Error('Sustitución en proceso para esta factura') // → 409; nunca se timbra a ciegas
    }
    if (previo && previo.status !== 'canceled') {
      if (previo.status !== 'valid' || !previo.uuid) {
        throw new ConflictError('Sustitución en proceso para esta factura')
      }
      logger.warn(`[cfdi] el PAC ya tenía ${previo.uuid} para ${llave}: se completa sin volver a timbrar`)
      const recuperada = await finalizarEmision(legacyReservation, previo, provider, bundle.venueSlug, emissionDeps)
      return cancelarOriginal(params, original, recuperada.cfdi, deps, 'REPLACED')
    }
    if (previo?.status === 'canceled') {
      throw new Error(
        `La sustituta anterior (${previo.uuid ?? previo.providerInvoiceId}) quedó cancelada en el PAC; revísala antes de volver a sustituir.`,
      )
    }
  }

  const refreshed = await deps.persistCfdi({ ...datosBase, status: 'STAMPING' }, legacyWhere)
  if (!refreshed) throw new ConflictError('Sustitución en proceso para esta factura')
  legacyReservation = { ...legacyReservation, ...datosBase }

  let timbrada
  try {
    timbrada = await provider.createInvoice(invoiceParams)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdi] falló el timbrado de la sustituta de ${original.id}: ${message}`)
    const fallida = await deps.persistCfdi({ idempotencyKey: llave, status: 'STAMP_FAILED', lastError: message }, legacyWhere)
    if (!fallida) throw new ConflictError('Sustitución en proceso para esta factura')
    // 🔴 La original NO se cancela: sin sustituta, cancelarla dejaría la venta sin ningún comprobante.
    return { status: 'STAMP_FAILED', sustituta: fallida, original, cancelStatus: null, cancelPendiente: true }
  }

  if (timbrada.status !== 'valid' || !timbrada.uuid) {
    await deps.persistCfdi({ idempotencyKey: llave, facturapiId: timbrada.providerInvoiceId }, legacyWhere)
    throw new ConflictError('Sustitución en proceso para esta factura')
  }
  const result = await finalizarEmision(legacyReservation, timbrada, provider, bundle.venueSlug, emissionDeps)
  return cancelarOriginal(params, original, result.cfdi, deps, 'REPLACED')
}

/**
 * Pide la cancelación de la original con motivo '01' + el UUID de la sustituta, y devuelve lo que
 * el PAC haya contestado — sin adornarlo. `pending`/`rejected` dejan la original VIGENTE, y eso es
 * exactamente lo que el dueño necesita ver.
 */
async function cancelarOriginal(
  params: { cfdiId: string; sandbox: boolean; expectedVenueId?: string },
  original: any,
  sustituta: any,
  deps: ReplaceCfdiDeps,
  status: 'REPLACED',
): Promise<ReplaceCfdiResult> {
  // C2 ronda 1 (M8): `vigente` vive fuera del `try` para que el caso del conflicto describa la original RELEÍDA, no la foto vieja.
  let vigente = original
  // Ronda de la ola (3): ¿ESTA petición anotó un intento nuevo? Se sabe aunque la cancelación truene después de anotar.
  let cancelIntentoNuevo = false
  const anotarIntencion: ReplaceCfdiDeps['anotarIntencion'] = async (...a) => {
    const r = await deps.anotarIntencion(...a)
    if ('estado' in r && r.estado === 'ANOTADA') cancelIntentoNuevo = true
    return r
  }
  try {
    // 🔴 Se RELEE: entre el timbre de la sustituta y este punto la original pudo cambiar de estado
    // (otra petición la canceló, o una cancelación anterior se resolvió). Usar la foto vieja podría
    // pisar un `cancelSubstituteUuid` bueno o revertir una cancelación aceptada (Codex P2-5).
    vigente = (await deps.loadCfdi(original.id)) ?? original
    if (vigente.status === 'CANCELLED') {
      return {
        status,
        sustituta,
        original: vigente,
        cancelStatus: vigente.cancelStatus ?? 'CANCELLED',
        cancelPendiente: false,
        cancelIntentoNuevo,
      }
    }
    let primeraLectura = true
    const res = await cancelCfdi(
      {
        cfdiId: vigente.id,
        motivo: '01',
        substituteUuid: sustituta.uuid,
        sandbox: params.sandbox,
        expectedVenueId: params.expectedVenueId,
      },
      {
        // Reutiliza la lectura de arriba; si pierde el CAS, devuelve la fila actual.
        loadCfdi: async id => {
          if (!primeraLectura) return deps.loadCfdi(id)
          primeraLectura = false
          return vigente
        },
        resolveProvider: deps.resolveProvider,
        updateCfdi: deps.updateCfdi,
        anotarIntencion,
        tomarEnvio: deps.tomarEnvio,
        dueno: deps.dueno,
        refresh: deps.refresh,
      },
    )
    return {
      status,
      sustituta,
      original: res.cfdi,
      cancelStatus: res.cancelStatus,
      cancelPendiente: !(res.cancelStatus === 'CANCELLED' || res.cancelStatus === 'ACCEPTED'),
      cancelIntentoNuevo,
      ...(res.enDuda ? { enDuda: true as const } : {}),
    }
  } catch (err: unknown) {
    // 🔴 C2 (M6/G4): una REGLA impidió anotar la intención (la original tiene una nota de crédito viva, u otra cancelación en trámite con
    // otro motivo). No es «el PAC no contestó»: no se le llamó. La sustituta ya está timbrada; se devuelve el texto para que se resuelva.
    if (err instanceof ConflictError) {
      logger.warn(`[cfdi] sustituta ${sustituta.uuid} timbrada; la cancelación de ${original.id} no se pidió: ${err.message}`)
      return {
        status,
        sustituta,
        original: vigente,
        cancelStatus: vigente.cancelStatus ?? null,
        cancelPendiente: true,
        cancelConflicto: err.message,
        cancelIntentoNuevo,
      }
    }
    // C2 ronda 2 (N3): la cancelación pudo cambiar la fila antes de fallar (M1 la cierra «no se llegó a enviar»): el resultado describe
    // la original RELEÍDA, no la foto de antes de timbrar.
    const releida = (await deps.loadCfdi(original.id).catch(() => null)) ?? vigente
    // C2 ronda 2 (N3): la consulta previa al PAC falló (M1): no salió nada y el intento ya quedó cerrado. Es un aviso con su texto.
    if (err instanceof ProviderUnavailableError) {
      logger.warn(`[cfdi] sustituta ${sustituta.uuid} timbrada; la cancelación de ${original.id} no salió: ${err.message}`)
      return {
        status,
        sustituta,
        original: releida,
        cancelStatus: releida.cancelStatus ?? null,
        cancelPendiente: true,
        cancelAviso: err.message,
        cancelIntentoNuevo,
      }
    }
    // El PAC no contestó. La sustituta YA está timbrada y su vínculo es durable: volver a pedir la
    // sustitución reanuda justo aquí.
    logger.error(
      `[cfdi] sustituta ${sustituta.uuid} timbrada pero falló la cancelación de ${original.id}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { status, sustituta, original: releida, cancelStatus: releida.cancelStatus ?? null, cancelPendiente: true, cancelIntentoNuevo }
  }
}

function baseSustitutaData(
  original: any,
  bundle: LoadedOrderBundle,
  llave: string,
  receptor: IssueReceptor,
  invoiceParams: ReturnType<typeof buildCreateInvoiceParams>,
) {
  return {
    venueId: original.venueId,
    fiscalEmisorId: original.fiscalEmisorId,
    orderId: original.orderId,
    flow: original.flow ?? 'STAFF_B',
    idempotencyKey: llave,
    // 🔴 El vínculo durable. Se escribe en la reserva, antes de tocar al PAC.
    replacesCfdiId: original.id,
    receptorRfc: receptor.rfc,
    receptorNombre: receptor.razonSocial,
    receptorRegimen: receptor.regimenFiscal,
    receptorCp: receptor.codigoPostal,
    usoCfdi: receptor.usoCfdi,
    formaPago: invoiceParams.formaPago,
    metodoPago: invoiceParams.metodoPago,
    subtotalCents: bundle.subtotalCents,
    taxCents: bundle.taxCents,
    totalCents: bundle.totalCents,
  }
}

function moneyFields(data: Record<string, any>) {
  const keys = ['subtotalCents', 'taxCents', 'totalCents', 'discountCents', 'formaPago', 'metodoPago'] as const
  const out: Record<string, any> = {}
  for (const k of keys) if (data[k] !== undefined) out[k] = data[k]
  return out
}

function stampedFields(data: Record<string, any>) {
  const keys = ['facturapiId', 'uuid', 'serie', 'folio', 'stampedAt', 'xmlUrl', 'pdfUrl'] as const
  const out: Record<string, any> = {}
  for (const k of keys) if (data[k] !== undefined) out[k] = data[k]
  return out
}

const defaultReplaceDeps: ReplaceCfdiDeps = {
  loadCfdi: id => prisma.cfdi.findUnique({ where: { id }, include: { fiscalEmisor: true } }),
  findSustituta: originalCfdiId => prisma.cfdi.findFirst({ where: { replacesCfdiId: originalCfdiId }, orderBy: { createdAt: 'desc' } }),
  loadOrderForCfdi: loadOrderForCfdiFromDb,
  resolveProvider: resolveFiscalProvider,
  reserveCfdi: (data, tx = prisma) => tx.cfdi.create({ data: data as any }),
  persistCfdi: async (data, where) => {
    if (where) {
      const { idempotencyKey, ...changes } = data
      const { count } = await prisma.cfdi.updateMany({ where, data: changes })
      return count === 1 ? prisma.cfdi.findUnique({ where: { idempotencyKey } }) : null
    }
    return prisma.cfdi.upsert({
      where: { idempotencyKey: data.idempotencyKey },
      create: data as any,
      // El dinero se REFRESCA: la fila describe el documento que de verdad se timbró (Codex P2-6).
      update: {
        status: data.status,
        lastError: data.lastError ?? null,
        attempts: { increment: 1 },
        ...moneyFields(data),
        ...stampedFields(data),
      },
    })
  },
  claimCfdi: async (cfdiId, desdeEstados, version) => {
    const { count } = await prisma.cfdi.updateMany({
      where: claimWhere(cfdiId, desdeEstados, version) as any,
      data: { status: 'STAMPING', attempts: { increment: 1 }, updatedAt: new Date() },
    })
    return count === 1
  },
  persistArtifacts: async (idempotencyKey, urls, version) => {
    const { count } = await prisma.cfdi.updateMany({
      where: { idempotencyKey, status: 'STAMPED', ...(version !== undefined ? { attempts: version } : {}) },
      data: urls,
    })
    if (count === 0) logger.warn(`[cfdi] no se guardaron los archivos de ${idempotencyKey}: la fila ya no está timbrada`)
    return prisma.cfdi.findUnique({ where: { idempotencyKey } })
  },
  storeArtifact: (buffer, path, contentType) => uploadFileToStorage(buffer, path, contentType),
  updateCfdi: aplicarCancelacion,
  anotarIntencion: anotarIntencionDeCancelar,
  tomarEnvio,
  dueno: sigoSiendoDueno,
  refresh: (cfdi, opts) => refreshPendingCancellation(cfdi, opts),
}
