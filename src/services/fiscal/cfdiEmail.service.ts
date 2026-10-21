/**
 * Facturas por correo (auditoría 2026-09-30, H24 → D23). La pantalla prometía «Le enviaremos la factura a este correo» y nadie
 * la enviaba: el correo sólo viajaba como dato del receptor a Facturapi, que no envía solo. Un fallo del correo NUNCA cambia
 * el estado de la factura.
 */
import logger from '@/config/logger'
import { BadRequestError, NotFoundError, ProviderUnavailableError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'
import { resolveFiscalProvider } from './fiscalProvider.factory'
import type { FiscalProvider } from './providers/fiscal-provider.interface'

export type CfdiEmailOrigin = 'EMISION' | 'REENVIO' | 'MCP'
type Proveedor = Pick<FiscalProvider, 'sendInvoiceByEmail'>

export interface SendCfdiEmailParams {
  cfdiId: string
  venueId: string
  sandbox: boolean
  origin: Exclude<CfdiEmailOrigin, 'EMISION'>
  staffId?: string | null
  /** Sin correo, va al que el receptor dio al facturar. */
  email?: string
}

/** El correo que el receptor dio al facturar, tal como quedó congelado en la entrada del documento. */
export function correoCapturado(entrada: unknown): string | undefined {
  const email = (entrada as { params?: { receptor?: { email?: unknown } } } | null)?.params?.receptor?.email
  return typeof email === 'string' && email.trim() ? email.trim() : undefined
}

/**
 * A qué correo va un documento por default: el que el receptor dio en SU factura. Una nota de crédito (egreso) va al de la
 * factura ORIGINAL que acredita, del mismo negocio: las capturadas antes del 30-sep traían el de un perfil por RFC, que podía
 * ser de otra persona. Sin fuente fiable, `undefined` (no se adivina).
 */
async function correoDelReceptor(entrada: unknown, venueId: string): Promise<string | undefined> {
  const egreso = entrada as { tipo?: unknown; originalCfdiId?: unknown } | null
  if (egreso?.tipo !== 'EGRESO') return correoCapturado(entrada)
  if (typeof egreso.originalCfdiId !== 'string') return undefined
  const original = await prisma.cfdi.findFirst({ where: { id: egreso.originalCfdiId, venueId }, select: { entrada: true } })
  return correoCapturado(original?.entrada)
}

const cargar = (cfdiId: string, venueId: string) =>
  prisma.cfdi.findFirst({
    where: { id: cfdiId, venueId },
    select: {
      id: true,
      status: true,
      facturapiId: true,
      serie: true,
      folio: true,
      uuid: true,
      entrada: true,
      fiscalEmisor: { select: { provider: true, providerKeyEnc: true } },
    },
  })

async function enviar(
  cfdi: NonNullable<Awaited<ReturnType<typeof cargar>>>,
  provider: Proveedor,
  p: { venueId: string; origin: CfdiEmailOrigin; staffId?: string | null; email?: string },
): Promise<{ folio: string; destination: string | null }> {
  if (cfdi.status !== 'STAMPED' || !cfdi.facturapiId) {
    throw new BadRequestError('Sólo se puede enviar por correo una factura timbrada.')
  }
  if (!provider.sendInvoiceByEmail) throw new BadRequestError('El proveedor de facturación no permite enviar por correo.')

  const folio = [cfdi.serie, cfdi.folio].filter(Boolean).join('-') || cfdi.uuid || cfdi.id
  // Sin correo capturado (facturas anteriores al protocolo), el proveedor usa el del cliente que tiene registrado.
  const destination = p.email ?? null
  const audit = (action: 'CFDI_EMAIL_SENT' | 'CFDI_EMAIL_FAILED', extra: Record<string, unknown> = {}) =>
    void logAction({
      staffId: p.staffId ?? null,
      venueId: p.venueId,
      action,
      entity: 'Cfdi',
      entityId: cfdi.id,
      data: { folio, destination: destination ?? 'registrado en el proveedor', origin: p.origin, ...extra },
    })

  try {
    await provider.sendInvoiceByEmail(cfdi.facturapiId, p.email)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    audit('CFDI_EMAIL_FAILED', { error: message })
    throw new ProviderUnavailableError(`No se pudo enviar la factura por correo: ${message}`)
  }
  audit('CFDI_EMAIL_SENT')
  return { folio, destination }
}

/** Reenvío pedido por una persona (dashboard) o por el MCP. */
export async function sendCfdiByEmail(params: SendCfdiEmailParams): Promise<{ folio: string; destination: string | null }> {
  const cfdi = await cargar(params.cfdiId, params.venueId)
  if (!cfdi) throw new NotFoundError('Factura no encontrada')
  return enviar(cfdi, resolveFiscalProvider(cfdi.fiscalEmisor, { sandbox: params.sandbox }), {
    ...params,
    email: params.email ?? (await correoDelReceptor(cfdi.entrada, params.venueId)),
  })
}

/**
 * Lo llama SÓLO quien finaliza el timbre (`FINALIZADO`): una vez por factura, venga del dashboard, la autofactura, una
 * sustitución, una nota de crédito o la conciliación. Va al correo que el receptor dio al facturar — nunca al de un reintento
 * posterior —; sin correo, no hace nada. Nunca lanza: un correo fallido no deshace una factura.
 */
export async function sendNewCfdiByEmail(params: { cfdiId: string; venueId: string; provider: Proveedor }): Promise<void> {
  try {
    const cfdi = await cargar(params.cfdiId, params.venueId)
    if (!cfdi) return
    const email = await correoDelReceptor(cfdi.entrada, params.venueId)
    if (!email) return
    await enviar(cfdi, params.provider, { venueId: params.venueId, origin: 'EMISION', staffId: null, email })
  } catch (err) {
    logger.warn('[CFDI] La factura se timbró pero no se pudo enviar por correo', {
      cfdiId: params.cfdiId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
