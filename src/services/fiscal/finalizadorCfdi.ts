import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError } from '../../errors/AppError'
import { buildStoragePath, uploadFileToStorage } from '../storage.service'
import { trasladosDesdeXml } from './cfdiReceived.parser'
import type { FiscalProvider } from './providers/fiscal-provider.interface'

export function desgloseDesdeXml(
  xml: string,
): Array<{ impuesto: '002'; tipoFactor: 'Tasa' | 'Exento'; tasa: string | null; base: string; importe: string | null }> {
  return trasladosDesdeXml(xml)
    .filter(tr => tr['@_Impuesto'] === '002')
    .map(tr => {
      const tipoFactor = tr['@_TipoFactor']
      const decimal = /^\d+(?:\.\d+)?$/
      if (
        !decimal.test(tr['@_Base'] ?? '') ||
        !['Tasa', 'Exento'].includes(tipoFactor) ||
        (tipoFactor === 'Tasa' && (!decimal.test(tr['@_TasaOCuota'] ?? '') || !decimal.test(tr['@_Importe'] ?? '')))
      ) {
        throw new BadRequestError('El XML contiene un traslado de IVA incompleto.')
      }
      return {
        impuesto: '002',
        tipoFactor: tipoFactor as 'Tasa' | 'Exento',
        base: tr['@_Base'],
        tasa: tipoFactor === 'Exento' ? null : tr['@_TasaOCuota'],
        importe: tipoFactor === 'Exento' ? null : tr['@_Importe'],
      }
    })
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
}
export type ArchivosCfdi = { xmlUrl: string; pdfUrl: string; taxBreakdown: ReturnType<typeof desgloseDesdeXml> }
export interface CompletarArchivosDeps {
  storeArtifact: (buffer: Buffer, path: string, contentType: string) => Promise<string>
  persistArtifacts: (p: CompletarArchivosParams, archivos: ArchivosCfdi) => Promise<boolean>
}
const artifactDeps: CompletarArchivosDeps = {
  storeArtifact: uploadFileToStorage,
  persistArtifacts: async (p, archivos) =>
    (
      await prisma.cfdi.updateMany({
        where: {
          id: p.cfdiId,
          idempotencyKey: p.idempotencyKey,
          facturapiId: p.providerInvoiceId,
          uuid: p.uuid,
          status: 'STAMPED',
          ...(p.version !== undefined ? { attempts: p.version } : {}),
        },
        data: archivos,
      })
    ).count === 1,
}

/** Best-effort después del timbre. El XML es la autoridad del desglose, nunca el catálogo vivo. */
export async function completarArchivos(
  p: CompletarArchivosParams,
  overrides: Partial<CompletarArchivosDeps> = {},
): Promise<'OK' | 'FALLO'> {
  const deps = { ...artifactDeps, ...overrides }
  try {
    const [xml, pdf] = await Promise.all([p.provider.downloadXml(p.providerInvoiceId), p.provider.downloadPdf(p.providerInvoiceId)])
    const taxBreakdown = desgloseDesdeXml(xml.toString('utf8'))
    const base = `venues/${p.venueSlug}/cfdi/${p.uuid}`
    const [xmlUrl, pdfUrl] = await Promise.all([
      deps.storeArtifact(xml, buildStoragePath(`${base}.xml`), 'application/xml'),
      deps.storeArtifact(pdf, buildStoragePath(`${base}.pdf`), 'application/pdf'),
    ])
    return (await deps.persistArtifacts(p, { xmlUrl, pdfUrl, taxBreakdown })) ? 'OK' : 'FALLO'
  } catch (err) {
    logger.error(`[cfdi] timbrado OK pero fallaron los archivos de ${p.uuid}`, {
      cfdiId: p.cfdiId,
      error: err instanceof Error ? err.message : String(err),
    })
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
