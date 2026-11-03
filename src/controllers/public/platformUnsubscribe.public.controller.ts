import { Request, Response } from 'express'
import asyncHandler from '../../utils/asyncHandler'
import logger from '../../config/logger'
import { optOut } from '../../services/crm/email/optOut.service'
import { verifyPlatformUnsubscribeToken } from '../../utils/platformUnsubscribeToken'
import { escapeHtml, page } from './publicHtml'

/**
 * Páginas públicas, sin sesión, de la baja de los correos de Avoqado (campañas del CRM y la prueba a sí mismo).
 *
 * GET  /api/v1/public/avoqado/unsubscribe?token=…  → pregunta y botón. NUNCA cambia nada: los clientes de correo precargan
 *      las ligas, así que un GET tiene que ser inocuo.
 * POST /api/v1/public/avoqado/unsubscribe?token=…  → da de baja. Idempotente, y es el destino del clic de RFC 8058
 *      (`List-Unsubscribe-Post`) que mandan Gmail y Yahoo desde su propio botón.
 *
 * 🔴 Ninguna pantalla muestra el correo, y la respuesta es la misma exista o no la dirección en nuestras bases: el token firmado
 * es lo único que autoriza, y de él sale el correo (nunca del cuerpo ni de la URL).
 */

const INVALID_PAGE = page(
  'Liga no válida',
  `<h1>Esta liga no es válida</h1>
   <p>No pudimos procesar tu solicitud: la liga está incompleta o se cortó. Abre otra vez el enlace desde tu correo.</p>`,
)

/** `req.query.token` puede venir repetido (`?token=a&token=b`) o como objeto: sólo cuenta un texto, y `verify` lo exige. */
const tokenDe = (req: Request) => verifyPlatformUnsubscribeToken(req.query.token)

export const getPlatformUnsubscribePage = asyncHandler(async (req: Request, res: Response) => {
  const data = tokenDe(req)
  if (!data) return res.status(400).type('html').send(INVALID_PAGE)

  // Relativa y construida del token YA verificado (sólo base64url y un punto): no refleja nada más de la URL de la petición.
  const action = escapeHtml(`?token=${encodeURIComponent(String(req.query.token))}`)
  const body = `
    <h1>¿Dejar de recibir los correos de Avoqado?</h1>
    <p>Dejarás de recibir novedades y correos de ventas de Avoqado en este correo. Los avisos de tus operaciones, como
       recibos o reservaciones, no cambian.</p>
    <form method="POST" action="${action}">
      <button type="submit">Sí, darme de baja</button>
    </form>`
  return res.status(200).type('html').send(page('Preferencias de correo', body))
})

export const postPlatformUnsubscribe = asyncHandler(async (req: Request, res: Response) => {
  const data = tokenDe(req)
  if (!data) return res.status(400).type('html').send(INVALID_PAGE)

  // Si la base falla NO se contesta «Listo»: el error sigue su camino (500) y el cliente de correo reintenta.
  await optOut(data.email, 'UN_CLIC')
  logger.info('📧 Avoqado platform email unsubscribe processed')

  const body = `
    <h1>Listo: ya no te llegarán correos de Avoqado</h1>
    <p>Quitamos esta dirección de nuestras listas. Si fue un error, escríbenos a hola@avoqado.io.</p>`
  return res.status(200).type('html').send(page('Baja confirmada', body))
})
