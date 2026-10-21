import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError } from '../../errors/AppError'
import { NODE_ENV } from '../../config/env'
import { buildStoragePath, uploadFileToStorage } from '../storage.service'
import { lecturaFiscalDelXml, TOPE_XML_TIMBRADO_PROPIO_BYTES, trasladoDeIva, trasladosDesdeXml } from './cfdiReceived.parser'
import { resolveFiscalProvider } from './fiscalProvider.factory'
import type { FiscalProvider } from './providers/fiscal-provider.interface'
import { leerXmlConceptos, type XmlConceptos } from './saldoFiscal'
import { ProviderHttpError, TIEMPO_LIMITE_CONSULTA_MS } from './providers/facturapi.provider'

type DesgloseIva = Array<{ impuesto: '002'; tipoFactor: 'Tasa' | 'Exento'; tasa: string | null; base: string; importe: string | null }>
const desgloseDeTraslados = (traslados: Array<Record<string, string>>): DesgloseIva =>
  traslados.filter(tr => tr['@_Impuesto'] === '002').map(tr => ({ ...trasladoDeIva(tr), impuesto: '002' as const }))

/** El resumen de traslados de IVA del comprobante (`Cfdi.taxBreakdown`); cada traslado se valida igual que los de cada concepto. */
export function desgloseDesdeXml(xml: string): DesgloseIva {
  return desgloseDeTraslados(trasladosDesdeXml(xml))
}

export interface FinalizarTimbreParams {
  cfdiId: string
  idempotencyKey: string | null
  version: number
  identidad: {
    status: 'valid' | 'pending' | 'canceled'
    facturapiId: string
    uuid: string | null
    serie: string | null
    folio: string | null
    stampedAt: Date | null
  }
}
export type ResultadoFinalizacion = 'FINALIZADO' | 'DUPLICADO' | 'YA_FINALIZADO'
export interface FinalizarTimbreDeps {
  runInTransaction: <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>
}

/** Identidad primero, en una transacción. Los sellos pertenecen a la reserva y nunca se reescriben aquí. */
export async function finalizarTimbre(
  p: FinalizarTimbreParams,
  deps: FinalizarTimbreDeps = { runInTransaction: work => prisma.$transaction(work) },
): Promise<ResultadoFinalizacion> {
  if (p.identidad.status !== 'valid' || !p.identidad.uuid?.trim() || !p.identidad.facturapiId)
    throw new BadRequestError('El PAC aún no confirmó un timbre válido con UUID.')
  return deps.runInTransaction(async tx => {
    const { facturapiId, uuid, serie, folio, stampedAt } = p.identidad
    const identidad = { facturapiId, uuid, serie, folio, stampedAt }
    const { count } = await tx.cfdi.updateMany({
      where: { id: p.cfdiId, idempotencyKey: p.idempotencyKey, attempts: p.version, status: { in: ['STAMPING', 'STAMP_FAILED'] } },
      data: { ...identidad, stampedAt: identidad.stampedAt ?? new Date(), status: 'STAMPED', lastError: null },
    })
    if (count === 1) return 'FINALIZADO'
    const current = await tx.cfdi.findUnique({ where: { id: p.cfdiId } })
    if (
      current?.status === 'STAMPED' &&
      current.attempts === p.version &&
      current.idempotencyKey === p.idempotencyKey &&
      current.uuid === identidad.uuid &&
      current.facturapiId === identidad.facturapiId
    )
      return 'YA_FINALIZADO'
    const data = {
      idempotencyKey: p.idempotencyKey,
      attempts: p.version,
      uuid: identidad.uuid,
      facturapiId: identidad.facturapiId,
      currentAttempts: current?.attempts ?? null,
      currentUuid: current?.uuid ?? null,
      currentStatus: current?.status ?? null,
    }
    logger.error('🚨 CFDI_TIMBRE_DUPLICADO', { cfdiId: p.cfdiId, venueId: current?.venueId, ...data })
    await tx.activityLog.create({
      data: { venueId: current?.venueId, action: 'CFDI_TIMBRE_DUPLICADO', entity: 'Cfdi', entityId: p.cfdiId, data },
    })
    return 'DUPLICADO'
  })
}

export interface CompletarArchivosParams {
  cfdiId: string
  idempotencyKey: string | null
  providerInvoiceId: string
  venueSlug: string
  uuid: string
  version?: number
  provider: Pick<FiscalProvider, 'downloadXml' | 'downloadPdf'>
  /** OF-1 (T7 N1 + M4): la fila ya tiene `xmlConceptos` (legibles o la marca): sólo falta el PDF y el XML no se vuelve a bajar. */
  soloPdf?: boolean
}
/**
 * Lo que se escribe de un CFDI timbrado. C2 (T5): `xmlConceptos` es la evidencia del XML timbrado (totales y cada concepto).
 * C2 · ronda 1 (M6): cada parte es opcional porque se escribe lo que salió bien — la del XML (su URL, el desglose y los conceptos, todo
 * del MISMO texto) y la del PDF van por separado: un PDF que no baja ya no deja a una nota sin la evidencia del XML.
 */
export type ArchivosCfdi = {
  xmlUrl?: string
  pdfUrl?: string
  taxBreakdown?: DesgloseIva
  /** Ronda 1 (I2): o la marca de ilegible (el veredicto persistido). */
  xmlConceptos?: XmlConceptos | MarcaDeXmlIlegible
}
/**
 * C2 T7 (N1 de la re-revisión de la T5): `'XML_ILEGIBLE'` = el XML timbrado SÍ se bajó, pero lo fiscal no se lee (permanente: volver a
 * bajarlo da lo mismo). `'FALLO'` = el PAC o el almacenamiento no respondieron (transitorio: el barrido reintenta).
 */
export type ResultadoDeArchivos = 'OK' | 'FALLO' | 'XML_ILEGIBLE' | 'XML_NO_DISPONIBLE'

/**
 * C2 T7, ronda 1 (I2): el veredicto «ilegible» se PERSISTE en `xmlConceptos` con esta marca (no es un `XmlConceptos`: `leerXmlConceptos` da
 * `null`), para que ninguna vista vuelva a bajar el XML: la nota lo lee y se detiene sin red. Soporte la borra si el XML se corrige.
 */
export type MarcaDeXmlIlegible = { version: 1; ilegible: true; motivo: string; at: string; lector?: number }
/**
 * OF-1 (T7 N1): la versión del lector del XML (`lecturaFiscalDelXml` + `leerXmlConceptos`) que dio el veredicto «ilegible»; va en la marca.
 * ponytail: hoy nadie la compara (no hay marcas en producción). Quien cambie lo que el lector acepta la sube y decide qué hacer con las
 * marcas de un lector anterior (tratarlas como `DbNull` para que se vuelvan a bajar).
 */
export const VERSION_DEL_LECTOR_XML = 1
export function marcaDeXmlIlegible(motivo: string, ahora: Date = new Date()): MarcaDeXmlIlegible {
  return { version: 1, ilegible: true, motivo, at: ahora.toISOString(), lector: VERSION_DEL_LECTOR_XML }
}
export function esMarcaDeXmlIlegible(json: unknown): json is MarcaDeXmlIlegible {
  const m = json as Partial<MarcaDeXmlIlegible> | null | undefined
  return !!m && typeof m === 'object' && !Array.isArray(m) && m.version === 1 && m.ilegible === true && typeof m.motivo === 'string'
}
/** C2 T7, ronda 1 (I2): lo que contesta la reparación compartida; `'EN_CURSO'` = sigue bajando y quien pregunta ya no espera. */
export type ResultadoDeReparacion = ResultadoDeArchivos | 'NO_APLICA' | 'EN_CURSO'
/** Tras un `FALLO` (PAC o almacenamiento caídos), nadie vuelve a pedir esa factura al PAC antes de esto. */
export const ENFRIAMIENTO_TRAS_FALLO_MS = 60_000
/** Lo permanente que no se persiste (`NO_APLICA`, `XML_NO_DISPONIBLE`) y el ilegible se recuerdan en memoria esto. */
export const MEMORIA_DE_LO_PERMANENTE_MS = 60 * 60_000
/**
 * C2 T7, ronda 1 (I2): UNA sola reparación en vuelo por factura, aunque la pidan varias vistas, el MCP y el POST a la vez; cada quien espera
 * lo suyo (`esperaMs`) la MISMA promesa. Recuerda lo permanente y enfría el `FALLO`. En memoria del proceso (con varias instancias, el costo
 * queda acotado por el número de instancias, no por el de vistas).
 */
export async function repararArchivosCompartido(
  cfdiId: string,
  opts: { sandbox?: boolean; esperaMs: number; insistir?: boolean },
  overrides: Partial<RepararArchivosDeps> = {},
): Promise<ResultadoDeReparacion> {
  const recordado = recordados.get(cfdiId)
  if (recordado && Date.now() < recordado.hasta && (recordado.permanente || !opts.insistir)) return recordado.resultado
  let trabajo = enVuelo.get(cfdiId)
  if (!trabajo) {
    // El trabajo de verdad, con SU límite (`LIMITE_REPARACION_MS`): quien pregunta sólo decide cuánto lo espera.
    trabajo = repararArchivosDe(cfdiId, { sandbox: opts.sandbox }, overrides).then(r => {
      enVuelo.delete(cfdiId)
      recordar(cfdiId, r)
      return r
    })
    enVuelo.set(cfdiId, trabajo)
  }
  return conLimiteDeTiempo<ResultadoDeReparacion>(trabajo, opts.esperaMs, () => 'EN_CURSO')
}
const enVuelo = new Map<string, Promise<ResultadoDeArchivos | 'NO_APLICA'>>()
const recordados = new Map<string, { resultado: ResultadoDeArchivos | 'NO_APLICA'; hasta: number; permanente: boolean }>()
function recordar(cfdiId: string, r: ResultadoDeArchivos | 'NO_APLICA'): void {
  if (r === 'OK') recordados.delete(cfdiId)
  else if (r === 'FALLO') recordados.set(cfdiId, { resultado: r, hasta: Date.now() + ENFRIAMIENTO_TRAS_FALLO_MS, permanente: false })
  else recordados.set(cfdiId, { resultado: r, hasta: Date.now() + MEMORIA_DE_LO_PERMANENTE_MS, permanente: true })
  // Acotado: nunca más de 1,000 facturas recordadas (las más viejas salen primero).
  while (recordados.size > 1_000) recordados.delete(recordados.keys().next().value!)
}
/** Para pruebas: olvida las reparaciones en vuelo y lo recordado. */
export function olvidarReparaciones(): void {
  enVuelo.clear()
  recordados.clear()
}
export interface CompletarArchivosDeps {
  storeArtifact: (buffer: Buffer, path: string, contentType: string) => Promise<string>
  persistArtifacts: (p: CompletarArchivosParams, archivos: ArchivosCfdi) => Promise<boolean>
}
const artifactDeps: CompletarArchivosDeps = {
  storeArtifact: uploadFileToStorage,
  // C2 · ronda 1 (M5): escritura idempotente por CAS. La condición fija la identidad del timbre (id, llave, `facturapiId`, `uuid`), el
  // estado `STAMPED` y la versión (`attempts`). Repetirla —un reintento, el barrido, la espera de una nota, o una escritura que llega
  // después del límite de tiempo— escribe lo MISMO, sacado del MISMO XML del PAC; si la fila cambió (cancelada, otra versión), no escribe
  // nada. Sólo lleva las partes que salieron bien (M6): nunca escribe `null` encima de un archivo que ya estaba.
  persistArtifacts: async (p, archivos) => {
    const where: Prisma.CfdiWhereInput = {
      id: p.cfdiId,
      idempotencyKey: p.idempotencyKey,
      facturapiId: p.providerInvoiceId,
      uuid: p.uuid,
      status: 'STAMPED',
      ...(p.version !== undefined ? { attempts: p.version } : {}),
    }
    if (!esMarcaDeXmlIlegible(archivos.xmlConceptos)) return (await prisma.cfdi.updateMany({ where, data: archivos })).count === 1
    // OF-1 (T7 N1): lo que sale de un XML ilegible (la marca y, si se leyó el resumen, su URL y su desglose) se escribe SÓLO donde
    // `xmlConceptos` está vacío: nunca encima de unos conceptos legibles (de otra reparación a la vez, o de una vuelta anterior) ni de otra
    // marca. Un 200 basura del PAC (mantenimiento) ya no deja detenida para siempre una factura legible. El PDF va aparte, con el CAS.
    const { pdfUrl, ...delXml } = archivos
    await prisma.cfdi.updateMany({ where: { ...where, xmlConceptos: { equals: Prisma.DbNull } }, data: delXml })
    return pdfUrl === undefined || (await prisma.cfdi.updateMany({ where, data: { pdfUrl } })).count === 1
  },
}

/**
 * Best-effort después del timbre. El XML es la autoridad del desglose, nunca el catálogo vivo.
 * C2 · ronda 1: el XML y el PDF van por separado (M6) y se escriben juntos en UNA escritura con CAS (M5); el XML se lee una sola vez (M2).
 * `'OK'` sólo si se escribió TODO (las dos URLs, el desglose y los conceptos); si no, `'FALLO'` con lo que sí salió ya guardado.
 */
export async function completarArchivos(
  p: CompletarArchivosParams,
  overrides: Partial<CompletarArchivosDeps> = {},
): Promise<ResultadoDeArchivos> {
  const deps = { ...artifactDeps, ...overrides }
  const base = `venues/${p.venueSlug}/cfdi/${p.uuid}`
  // OF-1 (M4): con `soloPdf` el XML ni se pide: un 200 basura del PAC no puede llegar a una fila que ya tiene sus conceptos.
  const [xml, pdf]: ParteDeArchivos[] = await Promise.all([
    p.soloPdf ? { archivos: {}, completa: true } : parteDelXml(p, deps, base),
    parteDelPdf(p, deps, base),
  ])
  const archivos: ArchivosCfdi = { ...xml.archivos, ...pdf.archivos }
  // C2 T7 (N1): un XML que SÍ se bajó y no se lee es permanente; se dice aparte (la nota se detiene), después de guardar lo que sí salió
  // (con la marca de ilegible, ronda 1). Ronda 1 (M1): el PAC que ya no lo entrega, también aparte.
  const permanente = xml.ilegible ? 'XML_ILEGIBLE' : xml.noDisponible ? 'XML_NO_DISPONIBLE' : null
  if (Object.keys(archivos).length === 0) return permanente ?? 'FALLO'
  try {
    const escrito = await deps.persistArtifacts(p, archivos)
    if (permanente) return permanente
    return escrito && xml.completa && pdf.completa ? 'OK' : 'FALLO'
  } catch (err) {
    logger.error(`[cfdi] timbrado OK pero no se pudieron guardar los archivos de ${p.uuid}`, { cfdiId: p.cfdiId, error: mensaje(err) })
    return 'FALLO'
  }
}

/**
 * C2 T7 (N1): `ilegible` = el XML se bajó y lo fiscal no se lee (permanente; se persiste la marca). Ronda 1 (M1): `noDisponible` = el PAC
 * contestó 404/401/403 (ya no lo entrega: permanente, pero NO se persiste: un permiso se arregla). Sin marca, una falla es de red o de
 * almacenamiento (transitoria).
 */
type ParteDeArchivos = { archivos: ArchivosCfdi; completa: boolean; ilegible?: true; noDisponible?: true }
const mensaje = (err: unknown) => (err instanceof Error ? err.message : String(err))
/** Ronda 1 (M1): respuestas del PAC que dicen que ese XML ya no se entrega (no está, o esta llave no lo puede ver). */
const PAC_NO_LO_ENTREGA = new Set([401, 403, 404])

/**
 * El XML y lo que sale de él, de UNA lectura (M2). Sin un resumen legible no se guarda nada del XML (como siempre). Los conceptos se guardan
 * sólo si se leyeron completos y tienen la forma que lee la T4 (`leerXmlConceptos`); si no, se guarda lo demás y se registra el motivo (M3).
 * Ronda 1 (I2): cuando el XML no se lee, en `xmlConceptos` queda la MARCA de ilegible (con su motivo): ninguna vista lo vuelve a bajar.
 */
async function parteDelXml(p: CompletarArchivosParams, deps: CompletarArchivosDeps, base: string): Promise<ParteDeArchivos> {
  let xml: Buffer
  try {
    xml = await p.provider.downloadXml(p.providerInvoiceId)
  } catch (err) {
    logger.error(`[cfdi] timbrado OK pero falló el XML de ${p.uuid}`, { cfdiId: p.cfdiId, error: mensaje(err) })
    if (err instanceof ProviderHttpError && PAC_NO_LO_ENTREGA.has(err.status)) return { archivos: {}, completa: false, noDisponible: true }
    return { archivos: {}, completa: false } // transitorio: el PAC no respondió
  }
  // C2 T7 (N1): lo que sigue lee el MISMO texto: si no se lee, volver a bajarlo da lo mismo ⇒ ilegible (permanente).
  let lectura: ReturnType<typeof lecturaFiscalDelXml>
  let taxBreakdown: DesgloseIva
  try {
    lectura = lecturaFiscalDelXml(xml.toString('utf8'))
    taxBreakdown = desgloseDeTraslados(lectura.resumen)
  } catch (err) {
    logger.error(`[cfdi] el XML timbrado de ${p.uuid} no se puede leer`, { cfdiId: p.cfdiId, error: mensaje(err) })
    const marca = marcaDeXmlIlegible(mensaje(err))
    // C2 · OF-2 (T8 M4): uno MÁS GRANDE que el tope del lector (una global enorme) sí es el XML del PAC: se guarda el archivo, para que la
    // factura conserve su XML descargable, aunque sus conceptos no se lean. Lo demás que no se lee (p. ej. una página de mantenimiento) no
    // se guarda como XML.
    if (xml.length > TOPE_XML_TIMBRADO_PROPIO_BYTES) {
      try {
        const xmlUrl = await deps.storeArtifact(xml, buildStoragePath(`${base}.xml`), 'application/xml')
        return { archivos: { xmlUrl, xmlConceptos: marca }, completa: false, ilegible: true }
      } catch (e) {
        // Ronda de la ola (review-OF m3): el almacenamiento no respondió (transitorio). Sin la marca, la fila vuelve al barrido y el XML
        // se guarda en otra pasada; con ella nunca tendría su `xmlUrl`.
        logger.error(`[cfdi] no se pudo guardar el XML (sin leer) de ${p.uuid}`, { cfdiId: p.cfdiId, error: mensaje(e) })
        return { archivos: {}, completa: false }
      }
    }
    return { archivos: { xmlConceptos: marca }, completa: false, ilegible: true }
  }
  const conceptos = lectura.conceptos
  const legibles = !('invalido' in conceptos) && !!leerXmlConceptos(conceptos)
  const marca = legibles
    ? null
    : marcaDeXmlIlegible('invalido' in conceptos ? conceptos.invalido : 'Los conceptos leídos no tienen la forma de `xmlConceptos`.')
  if (marca)
    // Defensa (la segunda rama): hoy el lector ya impide unos conceptos que `leerXmlConceptos` (T4) rechace.
    logger.error(`[cfdi] el XML de ${p.uuid} no deja guardar xmlConceptos; se guardan los demás archivos`, {
      cfdiId: p.cfdiId,
      motivo: marca.motivo,
    })
  try {
    const xmlUrl = await deps.storeArtifact(xml, buildStoragePath(`${base}.xml`), 'application/xml')
    if (!marca) return { archivos: { xmlUrl, taxBreakdown, xmlConceptos: conceptos as XmlConceptos }, completa: true }
    return { archivos: { xmlUrl, taxBreakdown, xmlConceptos: marca }, completa: false, ilegible: true }
  } catch (err) {
    logger.error(`[cfdi] timbrado OK pero no se pudo guardar el XML de ${p.uuid}`, { cfdiId: p.cfdiId, error: mensaje(err) })
    // El almacenamiento no respondió: transitorio, también cuando los conceptos no se leen. Ronda de la ola (review-OF m3): sin la marca,
    // la fila vuelve al barrido y la otra pasada guarda el XML, su desglose y la marca; con ella, nunca tendría su `xmlUrl`.
    return { archivos: {}, completa: false }
  }
}

/** El PDF, aparte del XML (M6): uno que falla no frena al otro. */
async function parteDelPdf(p: CompletarArchivosParams, deps: CompletarArchivosDeps, base: string): Promise<ParteDeArchivos> {
  try {
    const pdf = await p.provider.downloadPdf(p.providerInvoiceId)
    return { archivos: { pdfUrl: await deps.storeArtifact(pdf, buildStoragePath(`${base}.pdf`), 'application/pdf') }, completa: true }
  } catch (err) {
    logger.error(`[cfdi] timbrado OK pero falló el PDF de ${p.uuid}`, { cfdiId: p.cfdiId, error: mensaje(err) })
    return { archivos: {}, completa: false }
  }
}

/** C2 (T5): lo que se lee de una fila para volver a bajar y guardar sus archivos (el reconciliador y la espera de una nota). */
export const SELECCION_DE_REPARACION = {
  id: true,
  status: true,
  stampedAt: true,
  idempotencyKey: true,
  attempts: true,
  facturapiId: true,
  uuid: true,
  venue: { select: { slug: true } },
  fiscalEmisor: { select: { id: true, provider: true, providerKeyEnc: true } },
} satisfies Prisma.CfdiSelect
export type FilaDeReparacion = Prisma.CfdiGetPayload<{ select: typeof SELECCION_DE_REPARACION }>

/** C2 (T5): las filas timbradas a las que les falta algún archivo; el reconciliador las recorre con cursor `(stampedAt, id)`. */
export function dondeFaltanArchivos(cutoff: Date, cursor: { stampedAt: Date; id: string } | null): Prisma.CfdiWhereInput {
  return {
    status: 'STAMPED',
    stampedAt: { lt: cutoff },
    // C2 (T5): también las timbradas sin `xmlConceptos` (las de antes de la T5); se vuelven a bajar XML y PDF.
    // ponytail: si el relleno pesara (medido 8-oct: 47 filas timbradas en producción), una variante sólo-XML.
    // Ronda 1 (M6): el XML y el PDF ya se escriben por separado, así que también las que quedaron sin PDF.
    // OF-1 (M4): sin `xmlConceptos` cubre a las de sin desglose o sin URL del XML (los conceptos legibles siempre se escriben con los dos). Con
    // la marca de ilegible ya no vuelven cada 5 min por un XML que da lo mismo (soporte borra la marca si se corrige); sólo por su PDF.
    OR: [{ xmlConceptos: { equals: Prisma.DbNull } }, { pdfUrl: null }],
    ...(cursor ? { AND: [{ OR: [{ stampedAt: { gt: cursor.stampedAt } }, { stampedAt: cursor.stampedAt, id: { gt: cursor.id } }] }] } : {}),
  }
}

export interface RepararArchivosDeps {
  /** OF-1 (M4): `yaTieneXmlConceptos` = la fila ya tiene conceptos (legibles o la marca); sin el dato, se baja todo como antes. */
  leerFila: (cfdiId: string) => Promise<(FilaDeReparacion & { yaTieneXmlConceptos?: boolean }) | null>
  resolverProveedor: (emisor: FilaDeReparacion['fiscalEmisor'], opts: { sandbox: boolean }) => CompletarArchivosParams['provider']
  completar: (p: CompletarArchivosParams) => Promise<ResultadoDeArchivos>
}
const repararDeps: RepararArchivosDeps = {
  leerFila: async cfdiId => {
    const fila = await prisma.cfdi.findUnique({ where: { id: cfdiId }, select: SELECCION_DE_REPARACION })
    if (!fila) return null
    // OF-1 (M4): `xmlConceptos` pesa (~1 MiB en una global): sólo se pregunta si está vacío. Sólo un 0 seguro evita bajar el XML.
    const vacios = await prisma.cfdi.count({ where: { id: cfdiId, xmlConceptos: { equals: Prisma.DbNull } } })
    return { ...fila, yaTieneXmlConceptos: vacios === 0 }
  },
  resolverProveedor: resolveFiscalProvider,
  completar: p => completarArchivos(p),
}

/** C2 · OF-2 (T5 N4): lo que se le da a guardar los archivos (subirlos y escribir la fila) después de bajarlos del PAC. */
export const MARGEN_PARA_GUARDAR_ARCHIVOS_MS = 15_000
/**
 * C2 · ronda 1 (I1): lo más que espera una reparación (bajar XML y PDF, subirlos y escribir). C2 · OF-2 (T5 N4): DERIVADO del tiempo límite
 * de la bajada (`downloadXml` usa `TIEMPO_LIMITE_CONSULTA_MS`; el PDF va en paralelo) más el margen para guardar: 30 s + 15 s = 45 s.
 */
export const LIMITE_REPARACION_MS = TIEMPO_LIMITE_CONSULTA_MS + MARGEN_PARA_GUARDAR_ARCHIVOS_MS

/**
 * C2 · ronda 1 (I1): el trabajo o, si vence antes, lo que diga `alVencer`. El trabajo que pierde sigue solo (no se puede abortar: el SDK de
 * Facturapi no acepta `signal`); el reloj se limpia en cuanto hay respuesta.
 */
export function conLimiteDeTiempo<T>(trabajo: Promise<T>, ms: number, alVencer: () => T): Promise<T> {
  let reloj: ReturnType<typeof setTimeout> | undefined
  const vence = new Promise<T>(resolve => {
    reloj = setTimeout(() => resolve(alVencer()), ms)
  })
  return Promise.race([trabajo, vence]).finally(() => clearTimeout(reloj))
}

/**
 * C2 (T5): vuelve a bajar y guardar los archivos de UNA fila timbrada (con el CAS de `completarArchivos`). Nunca lanza.
 * C2 · ronda 1 (I1): con límite de tiempo (`opts.limiteMs`, por omisión `LIMITE_REPARACION_MS`). Al vencer devuelve `'FALLO'`; la
 * reparación que siguió sola, si escribe, escribe con el MISMO CAS lo MISMO del MISMO XML (M5): no puede dejar nada distinto.
 */
export async function repararArchivosDe(
  cfdiId: string,
  opts: { sandbox?: boolean; limiteMs?: number } = {},
  overrides: Partial<RepararArchivosDeps> = {},
): Promise<ResultadoDeArchivos | 'NO_APLICA'> {
  const deps: RepararArchivosDeps = { ...repararDeps, ...overrides }
  const limiteMs = opts.limiteMs ?? LIMITE_REPARACION_MS
  return conLimiteDeTiempo(reparar(cfdiId, opts.sandbox, deps), limiteMs, () => {
    logger.warn(`[cfdi] la reparación de archivos de cfdi=${cfdiId} no terminó en ${limiteMs} ms; queda para el barrido`)
    return 'FALLO'
  })
}

async function reparar(
  cfdiId: string,
  sandbox: boolean | undefined,
  deps: RepararArchivosDeps,
): Promise<ResultadoDeArchivos | 'NO_APLICA'> {
  try {
    const fila = await deps.leerFila(cfdiId)
    // La fila fresca decide: sólo una timbrada con su identidad del PAC tiene archivos que bajar.
    if (!fila || fila.status !== 'STAMPED' || !fila.facturapiId || !fila.uuid) return 'NO_APLICA'
    return await deps.completar({
      cfdiId: fila.id,
      idempotencyKey: fila.idempotencyKey,
      version: fila.attempts,
      providerInvoiceId: fila.facturapiId,
      uuid: fila.uuid,
      venueSlug: fila.venue.slug,
      provider: deps.resolverProveedor(fila.fiscalEmisor, { sandbox: sandbox ?? NODE_ENV !== 'production' }),
      // OF-1 (M4): una fila con conceptos que sólo vuelve por su PDF no vuelve a bajar el XML (ni cada 5 min en el barrido).
      ...(fila.yaTieneXmlConceptos ? { soloPdf: true } : {}),
    })
  } catch (err) {
    logger.error(`[cfdi] no se pudieron reparar los archivos cfdi=${cfdiId}`, { error: mensaje(err) })
    return 'FALLO'
  }
}

/** Compartido por consulta y barrido; el bloqueo del CFDI evita dos alertas para la misma versión. */
export async function escalarIntentoIncierto(
  cfdi: { id: string; attempts: number; protocoloIva: number | null; enviadoAt: Date | null; falloDefinitivo: boolean },
  now = new Date(),
  deps: FinalizarTimbreDeps = { runInTransaction: work => prisma.$transaction(work) },
): Promise<void> {
  if (
    cfdi.protocoloIva !== 1 ||
    !cfdi.enviadoAt ||
    cfdi.falloDefinitivo ||
    now.getTime() - new Date(cfdi.enviadoAt).getTime() < 60 * 60_000
  )
    return
  await deps.runInTransaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Cfdi" WHERE id = ${cfdi.id} FOR UPDATE`
    const current = await tx.cfdi.findUnique({ where: { id: cfdi.id } })
    if (!current || current.attempts !== cfdi.attempts || !['STAMPING', 'STAMP_FAILED'].includes(current.status) || current.falloDefinitivo)
      return
    const action = 'CFDI_INTENTO_INCIERTO_ESCALADO'
    if (
      await tx.activityLog.findFirst({
        where: { venueId: current.venueId, entityId: current.id, action, data: { path: ['attempts'], equals: current.attempts } },
      })
    )
      return
    const data = { orderId: current.orderId, idempotencyKey: current.idempotencyKey, attempts: current.attempts }
    await tx.activityLog.create({ data: { venueId: current.venueId, action, entity: 'Cfdi', entityId: current.id, data } })
    logger.error('🚨 CFDI_INTENTO_INCIERTO_ESCALADO', { venueId: current.venueId, ...data })
  })
}
