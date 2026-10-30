/**
 * Rutas públicas (sin token): estampa el negocio en el contexto en cuanto el parámetro de la URL lo identifica, como los
 * webhooks (`.claude/rules/contexto-de-ejecucion.md`, punto 7). Sirve a los logs y al candado de los negocios demo
 * (capa 2), que sabe de qué negocio es un mensaje por el contexto: sin esto, el portal o el recibo digital de un demo
 * podían mandar un correo o WhatsApp a quien el prospecto escribiera.
 *
 * Se monta con `router.param` en `public.routes.ts`: corre una vez por petición que trae ese parámetro. Nunca falla la
 * petición; si no encuentra el negocio, sigue y el controlador responde como siempre.
 */
import type { RequestParamHandler, Response } from 'express'
import logger from '@/config/logger'
import { enrichContext } from '@/observability/executionContext'
import { getVenueName } from '@/observability/venueNames'
import prisma from '@/utils/prismaClient'
import {
  CODIGO_NEGOCIO_DEMO,
  CODIGO_SIN_CONFIRMAR,
  esNegocioDemo,
  MENSAJE_SIN_CONFIRMAR,
  rutaNormalizada,
} from '@/services/demo/candadoDemo'

type Buscar = (valor: string) => Promise<string | null | undefined>

/** Las rutas públicas que empiezan un cobro (liga de pago, paquete de créditos, checkout del negocio). */
const COBRO = /\/(?:checkout|stripe-checkout|payment-intent|mp-payment-intent|mp-pay|charge)(?:\/|$)/

const respuesta = (res: Response, status: 403 | 503, code: string, message: string) =>
  res.status(status).json({ error: status === 403 ? 'Forbidden' : 'Service Unavailable', code, message })

function estampar(tipo: string, buscar: Buscar): RequestParamHandler {
  return (req, res, next, valor: string) => {
    void (async () => {
      // La ruta como la ve Express (sin importar mayúsculas ni lo codificado): `/CHARGE` también es un cobro.
      const esCobro = req.method === 'POST' && COBRO.test(rutaNormalizada(req.originalUrl ?? req.path ?? '').ruta)
      let venueId: string | null | undefined
      try {
        venueId = await buscar(valor)
        if (venueId) enrichContext({ venueId, venueName: getVenueName(venueId) })
      } catch (error) {
        logger.warn('No se pudo estampar el negocio de una ruta pública', { tipo, error })
        // Un cobro sin saber de qué negocio es no sigue: el candado nunca abre por un error.
        if (esCobro) return void respuesta(res, 503, CODIGO_SIN_CONFIRMAR, MENSAJE_SIN_CONFIRMAR)
        // Lo demás sigue, pero sin poder mandar mensajes: podría ser un demo (Codex r3, 1).
        enrichContext({ negocioSinConfirmar: true })
        return next()
      }
      if (venueId && esCobro) {
        let demo: boolean
        try {
          demo = await esNegocioDemo(venueId)
        } catch {
          return void respuesta(res, 503, CODIGO_SIN_CONFIRMAR, MENSAJE_SIN_CONFIRMAR)
        }
        // Candado de negocios demo (capa 4): una liga o checkout de un demo no cobra, y lo dice antes de tocar al procesador.
        if (demo) {
          return void respuesta(
            res,
            403,
            CODIGO_NEGOCIO_DEMO,
            'Este es un negocio de demostración: aquí no se cobra. En una cuenta de Avoqado sí funciona.',
          )
        }
      }
      next()
    })()
  }
}

export const negocioPorSlug = estampar(
  'venueSlug',
  async slug => (await prisma.venue.findUnique({ where: { slug }, select: { id: true } }))?.id,
)

export const negocioPorLigaDePago = estampar(
  'shortCode',
  async shortCode => (await prisma.paymentLink.findUnique({ where: { shortCode }, select: { venueId: true } }))?.venueId,
)

export const negocioPorReciboDigital = estampar(
  'accessKey',
  async accessKey =>
    (await prisma.digitalReceipt.findUnique({ where: { accessKey }, select: { payment: { select: { venueId: true } } } }))?.payment
      ?.venueId,
)
