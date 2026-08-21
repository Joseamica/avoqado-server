/**
 * Del aviso "tu reporte está listo" a los reembolsos reflejados en los libros del comercio.
 *
 * 🔴 Es la ÚNICA vía por la que nos enteramos de un reembolso: la API de pedidos no los
 * reporta. Sin esto, un reembolso de Uber se descuenta del depósito del comercio y en
 * Avoqado la venta sigue contando completa.
 */
import { DeliveryOrderEventStatus } from '@prisma/client'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

import { applyDeliveryRefund } from '../../core/applyDeliveryRefund.service'
import { markEventResult } from '../../core/deliveryWebhookEvent.service'
import { descargarReporte, esReembolso, parseUberReportCsv } from './uber.report'

export interface ReportProcessResult {
  outcome: 'PROCESSED' | 'SIN_DESCARGA' | 'FAILED'
  reembolsos?: number
  filas?: number
  error?: string
}

export async function processUberReport(eventRowId: string): Promise<ReportProcessResult> {
  const evento = await prisma.deliveryOrderEvent.findUnique({ where: { id: eventRowId }, select: { payload: true, status: true } })
  if (!evento) return { outcome: 'FAILED', error: 'EVENTO_NO_EXISTE' }
  if (evento.status === DeliveryOrderEventStatus.PROCESSED) return { outcome: 'PROCESSED', reembolsos: 0 }

  const p = evento.payload as { report_metadata?: { sections?: Array<{ download_url?: string }> } }
  const url = p?.report_metadata?.sections?.[0]?.download_url
  if (!url) {
    await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, undefined, 'REPORTE_SIN_URL')
    return { outcome: 'SIN_DESCARGA', error: 'REPORTE_SIN_URL' }
  }

  try {
    // 🔴 Se baja AHORA: la URL viene firmada y caduca. Guardarla para después es perderla.
    const filas = parseUberReportCsv(await descargarReporte(url))
    const conReembolso = filas.filter(esReembolso)

    let aplicados = 0
    for (const f of conReembolso) {
      // Aislamiento por fila: un pedido que no podamos aplicar NO puede impedir que los
      // demás reembolsos del reporte se registren.
      try {
        const r = await applyDeliveryRefund({
          externalOrderId: f.orderId,
          provider: 'UBER_EATS',
          montoDevuelto: f.chargebackInclVat.replace(/[^0-9.-]/g, '') || '0',
          motivo: `reporte de Uber: ${f.status || 'reembolso'}`,
        })
        if (r.outcome === 'APPLIED') aplicados++
      } catch (err) {
        logger.error('🚨 [UberReport] no se pudo aplicar un reembolso del reporte', {
          eventRowId,
          orderId: f.orderId,
          error: err instanceof Error ? err.message : err,
        })
      }
    }

    await markEventResult(eventRowId, DeliveryOrderEventStatus.PROCESSED)
    logger.info('📄 [UberReport] reporte procesado', { eventRowId, filas: filas.length, conReembolso: conReembolso.length, aplicados })
    return { outcome: 'PROCESSED', filas: filas.length, reembolsos: aplicados }
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err)
    // Un enlace caducado NO se reintenta: hay que volver a PEDIR el reporte. Queda FAILED
    // con el motivo para que se vea, en vez de reintentar algo que nunca va a funcionar.
    logger.error('🚨 [UberReport] falló el procesamiento del reporte', { eventRowId, error: mensaje })
    await markEventResult(eventRowId, DeliveryOrderEventStatus.FAILED, undefined, mensaje.slice(0, 500))
    return { outcome: 'FAILED', error: mensaje }
  }
}
