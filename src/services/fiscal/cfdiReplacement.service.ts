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
import { buildStoragePath, uploadFileToStorage } from '../storage.service'
import { resolveFiscalProvider } from './fiscalProvider.factory'
import { buildCreateInvoiceParams } from './cfdiPayloadBuilder'
import { validateBeforeStamp } from './cfdiValidation'
import { assembleSaleInput } from './assembleSaleInput'
import {
  cancelCfdi,
  claimWhere,
  loadOrderForCfdiFromDb,
  totalDelDocumentoCents,
  STAMPING_TTL_MS,
  type LoadedOrderBundle,
  type IssueReceptor,
} from './cfdi.service'

export interface ReplaceCfdiDeps {
  /** La factura ORIGINAL, con su `fiscalEmisor` incluido (lo necesita el conector). */
  loadCfdi: (cfdiId: string) => Promise<any | null>
  /** La sustituta que ya exista para esta original — el intento durable de una corrida anterior. */
  findSustituta: (originalCfdiId: string) => Promise<any | null>
  loadOrderForCfdi: (orderId: string) => Promise<LoadedOrderBundle | null>
  resolveProvider: typeof resolveFiscalProvider
  /** INSERT que reserva la llave de la sustituta. Un P2002 es la carrera con otra petición. */
  reserveCfdi: (data: Record<string, any>) => Promise<any>
  persistCfdi: (data: Record<string, any>) => Promise<any>
  /** Reclamo con la VERSIÓN leída (`attempts`) — ver `claimCfdi` en cfdi.service (Codex P1-1). */
  claimCfdi: (cfdiId: string, desdeEstados: string[], version: number) => Promise<boolean>
  /** Guarda SÓLO las URLs de los archivos; nunca el estado fiscal (Codex P1-4). */
  persistArtifacts: (idempotencyKey: string, urls: { xmlUrl: string; pdfUrl: string }) => Promise<any>
  storeArtifact: (buffer: Buffer, path: string, contentType: string) => Promise<string>
  updateCfdi: (cfdiId: string, data: Record<string, any>) => Promise<any>
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
  deps: ReplaceCfdiDeps = defaultReplaceDeps,
): Promise<ReplaceCfdiResult> {
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
  let sustituta: any | null = null
  let llave: string
  let filaReservada = false

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
  if (original.status !== 'STAMPED') {
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
  if (previa && previa.status === 'STAMPING') {
    const ageMs = Date.now() - new Date(previa.updatedAt ?? previa.createdAt ?? Date.now()).getTime()
    if (ageMs < STAMPING_TTL_MS) throw new Error('Sustitución en proceso para esta factura') // → 409
    logger.warn(`[cfdi] reclamando sustitución STAMPING vieja de ${original.id} (${Math.round(ageMs / 1000)}s)`)
  }
  if (previa) {
    // Reclamo atómico: quien pierde recibe 409 y nunca llama al PAC.
    const mio = await deps.claimCfdi(previa.id, ['STAMPING', 'STAMP_FAILED', 'VALIDATION_FAILED'], previa.attempts ?? 0)
    if (!mio) throw new Error('Sustitución en proceso para esta factura') // → 409
    sustituta = previa
    llave = previa.idempotencyKey ?? siguienteLlaveDeSustitucion(original.idempotencyKey, original.orderId)
    filaReservada = true
  } else {
    llave = siguienteLlaveDeSustitucion(original.idempotencyKey, original.orderId)
  }

  // 4. Armar el documento CORREGIDO con los datos ACTUALES de la orden.
  const bundle = await deps.loadOrderForCfdi(original.orderId)
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
  const documentoCents = totalDelDocumentoCents(bundle.order)
  if (!bundle.unsupportedReasons?.length && bundle.paidCents !== undefined && bundle.paidCents !== documentoCents) {
    const pesos = (c: number) => `$${(c / 100).toFixed(2)}`
    reasons.push(
      `El total de la factura corregida (${pesos(documentoCents)}) no coincide con lo cobrado (${pesos(bundle.paidCents)}). No se sustituyó; revisa la cuenta o repórtala a soporte.`,
    )
  }
  if (reasons.length > 0) {
    return { status: 'VALIDATION_FAILED', sustituta: null, original, cancelStatus: null, cancelPendiente: true, reasons }
  }

  // 6. Reservar la sustituta ANTES del PAC — éste es el intento durable.
  const datosBase = baseSustitutaData(original, bundle, llave, receptor, invoiceParams)
  if (!filaReservada) {
    try {
      sustituta = await deps.reserveCfdi({ ...datosBase, status: 'STAMPING' })
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Carrera: otra petición reservó la misma llave. Nunca se timbra un segundo documento.
        const ahora = await deps.findSustituta(original.id)
        if (ahora?.status === 'STAMPED') return await cancelarOriginal(params, original, ahora, deps, 'REPLACED')
        throw new Error('Sustitución en proceso para esta factura') // → 409
      }
      throw err
    }
  }

  // 7. Timbrar.
  const provider = deps.resolveProvider(bundle.emisor as any, { sandbox: params.sandbox })

  // 🔴 Si esta fila viene de un intento anterior, ese intento PUDO haber timbrado y perder la
  // respuesta (un timeout después de que el PAC contestó). Re-timbrar sin preguntar produciría un
  // TERCER documento fiscal por la misma venta (Codex P1-2).
  if (filaReservada && typeof provider.findByExternalId === 'function') {
    let previo
    try {
      previo = await provider.findByExternalId(llave)
    } catch (err: unknown) {
      logger.error(`[cfdi] no se pudo consultar el PAC antes de reintentar la sustituta ${llave}: ${err instanceof Error ? err.message : String(err)}`)
      throw new Error('Sustitución en proceso para esta factura') // → 409; nunca se timbra a ciegas
    }
    if (previo && previo.status !== 'canceled') {
      logger.warn(`[cfdi] el PAC ya tenía ${previo.uuid} para ${llave}: se completa sin volver a timbrar`)
      const recuperada = await deps.persistCfdi({
        ...datosBase,
        status: 'STAMPED',
        facturapiId: previo.providerInvoiceId,
        uuid: previo.uuid,
        serie: previo.serie,
        folio: previo.folio,
        stampedAt: previo.stampedAt ?? new Date(),
      })
      return await cancelarOriginal(params, original, recuperada, deps, 'REPLACED')
    }
    if (previo?.status === 'canceled') {
      throw new Error(`La sustituta anterior (${previo.uuid ?? previo.providerInvoiceId}) quedó cancelada en el PAC; revísala antes de volver a sustituir.`)
    }
  }

  let timbrada
  try {
    timbrada = await provider.createInvoice(invoiceParams)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdi] falló el timbrado de la sustituta de ${original.id}: ${message}`)
    const fallida = await deps.persistCfdi({ ...datosBase, status: 'STAMP_FAILED', lastError: message })
    // 🔴 La original NO se cancela: sin sustituta, cancelarla dejaría la venta sin ningún comprobante.
    return { status: 'STAMP_FAILED', sustituta: fallida, original, cancelStatus: null, cancelPendiente: true }
  }

  // 8. La identidad del timbre se persiste ANTES de los archivos: el documento ya existe ante el SAT.
  const identidad = {
    facturapiId: timbrada.providerInvoiceId,
    uuid: timbrada.uuid,
    serie: timbrada.serie,
    folio: timbrada.folio,
    stampedAt: timbrada.stampedAt,
  }
  let fila = await deps.persistCfdi({ ...datosBase, status: 'STAMPED', ...identidad })

  try {
    const [xmlBuf, pdfBuf] = await Promise.all([
      provider.downloadXml(timbrada.providerInvoiceId),
      provider.downloadPdf(timbrada.providerInvoiceId),
    ])
    const base = `venues/${bundle.venueSlug}/cfdi/${timbrada.uuid}`
    const [xmlUrl, pdfUrl] = await Promise.all([
      deps.storeArtifact(xmlBuf, buildStoragePath(`${base}.xml`), 'application/xml'),
      deps.storeArtifact(pdfBuf, buildStoragePath(`${base}.pdf`), 'application/pdf'),
    ])
    const guardada = await deps.persistArtifacts(llave, { xmlUrl, pdfUrl })
    // Se FUNDE sobre la fila que ya traía el timbre: `persistArtifacts` sólo escribe URLs y
    // podría devolver una vista parcial; perder aquí el uuid rompería la cancelación de abajo.
    fila = { ...fila, ...(guardada ?? {}), xmlUrl, pdfUrl }
  } catch (err: unknown) {
    // El timbre YA vale; faltan los archivos y NADIE los repone solo (el job de conciliación sólo
    // mira filas `STAMPING`). Hasta que alguien los baje, su descarga contestará 404 (Codex P2-8).
    logger.error(
      `[cfdi] sustituta ${timbrada.uuid} timbrada pero fallaron sus archivos: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // 9. Cancelar la original. Un fallo aquí NO pierde la sustituta: queda pendiente y se reanuda.
  return await cancelarOriginal(params, original, fila, deps, 'REPLACED')
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
  try {
    // 🔴 Se RELEE: entre el timbre de la sustituta y este punto la original pudo cambiar de estado
    // (otra petición la canceló, o una cancelación anterior se resolvió). Usar la foto vieja podría
    // pisar un `cancelSubstituteUuid` bueno o revertir una cancelación aceptada (Codex P2-5).
    const vigente = (await deps.loadCfdi(original.id)) ?? original
    if (vigente.status === 'CANCELLED') {
      return { status, sustituta, original: vigente, cancelStatus: vigente.cancelStatus ?? 'CANCELLED', cancelPendiente: false }
    }
    const res = await cancelCfdi(
      { cfdiId: vigente.id, motivo: '01', substituteUuid: sustituta.uuid, sandbox: params.sandbox, expectedVenueId: params.expectedVenueId },
      { loadCfdi: async () => vigente, resolveProvider: deps.resolveProvider, updateCfdi: deps.updateCfdi },
    )
    return {
      status,
      sustituta,
      original: res.cfdi,
      cancelStatus: res.cancelStatus,
      cancelPendiente: !(res.cancelStatus === 'CANCELLED' || res.cancelStatus === 'ACCEPTED'),
    }
  } catch (err: unknown) {
    // El PAC no contestó. La sustituta YA está timbrada y su vínculo es durable: volver a pedir la
    // sustitución reanuda justo aquí.
    logger.error(
      `[cfdi] sustituta ${sustituta.uuid} timbrada pero falló la cancelación de ${original.id}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { status, sustituta, original, cancelStatus: null, cancelPendiente: true }
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
  reserveCfdi: data => prisma.cfdi.create({ data: data as any }),
  persistCfdi: data =>
    prisma.cfdi.upsert({
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
    }),
  claimCfdi: async (cfdiId, desdeEstados, version) => {
    const { count } = await prisma.cfdi.updateMany({
      where: claimWhere(cfdiId, desdeEstados, version) as any,
      data: { status: 'STAMPING', attempts: { increment: 1 }, updatedAt: new Date() },
    })
    return count === 1
  },
  persistArtifacts: async (idempotencyKey, urls) => {
    const { count } = await prisma.cfdi.updateMany({ where: { idempotencyKey, status: 'STAMPED' }, data: urls })
    if (count === 0) logger.warn(`[cfdi] no se guardaron los archivos de ${idempotencyKey}: la fila ya no está timbrada`)
    return prisma.cfdi.findUnique({ where: { idempotencyKey } })
  },
  storeArtifact: (buffer, path, contentType) => uploadFileToStorage(buffer, path, contentType),
  updateCfdi: (id, data) => prisma.cfdi.update({ where: { id }, data }),
}
