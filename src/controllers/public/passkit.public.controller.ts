import { Request, Response } from 'express'
import {
  listUpdatedSerials,
  registerDevice,
  resolvePassForDownload,
  unregisterDevice,
} from '../../services/wallet/passkitWebService.service'
import { buildAndSignPassForCustomer } from '../../services/wallet/issuePass.service'
import logger from '../../config/logger'

/**
 * Los endpoints que llama APPLE, no nuestro dashboard.
 *
 * 🔴 Son públicos por definición: el que llama es el iPhone del cliente, sin sesión.
 * Lo único que los protege es el token que viaja DENTRO del pase, y por eso el
 * servicio contesta 401 tanto ante un token equivocado como ante un serial que no
 * existe: un 404 confirmaría qué seriales son reales.
 *
 * 🔴 Los códigos de estado importan más de lo normal aquí. Apple los interpreta y
 * ajusta su comportamiento: un 200 donde iba un 204 pone al teléfono a preguntar en
 * bucle. No hay pantalla donde ver el error — se ve en que las tarjetas dejan de
 * actualizarse.
 */

/** El token viaja como `Authorization: ApplePass <token>`. */
function leerToken(req: Request): string {
  const header = req.headers.authorization ?? ''
  const match = /^ApplePass\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : ''
}

export async function registerDeviceHandler(req: Request, res: Response) {
  const { deviceLibraryIdentifier, serialNumber } = req.params
  const pushToken = String((req.body ?? {}).pushToken ?? '')

  if (!pushToken) return res.sendStatus(400)

  const r = await registerDevice(deviceLibraryIdentifier, serialNumber, pushToken, leerToken(req))
  return res.sendStatus(r.status)
}

export async function unregisterDeviceHandler(req: Request, res: Response) {
  const { deviceLibraryIdentifier, serialNumber } = req.params

  const r = await unregisterDevice(deviceLibraryIdentifier, serialNumber, leerToken(req))
  return res.sendStatus(r.status)
}

export async function listUpdatedSerialsHandler(req: Request, res: Response) {
  const { deviceLibraryIdentifier } = req.params
  const desde = req.query.passesUpdatedSince ? String(req.query.passesUpdatedSince) : undefined

  const r = await listUpdatedSerials(deviceLibraryIdentifier, desde)
  if (r.status === 204) return res.sendStatus(204)
  return res.status(r.status).json(r.body)
}

/**
 * POST …/v1/log — Apple manda aquí lo que le salió mal de SU lado.
 *
 * 🔴 Es el único lugar donde se entera uno de que las tarjetas no se están
 * actualizando. Sin este endpoint, un `webServiceURL` mal formado o un certificado
 * vencido son invisibles: Apple lo reporta, nadie lo escucha, y las tarjetas se
 * quedan congeladas sin una sola señal.
 */
export async function passkitLogHandler(req: Request, res: Response) {
  const logs: unknown[] = Array.isArray((req.body ?? {}).logs) ? (req.body as any).logs : []
  // Nivel warn a propósito: si Apple se está quejando, alguien tiene que verlo.
  if (logs.length > 0) logger.warn('Apple reportó problemas con nuestras tarjetas', { logs: logs.slice(0, 20) })
  return res.sendStatus(200)
}

/**
 * GET …/v1/passes/{passTypeId}/{serial} — el pase con su contenido AL DÍA.
 *
 * 🔴 Aquí es donde de verdad se actualiza la tarjeta. El aviso por APNs sólo despierta
 * al teléfono; el saldo nuevo viaja por esta respuesta. Si esto devolviera el pase
 * viejo, el push funcionaría perfecto y la tarjeta seguiría sin cambiar.
 */
export async function downloadUpdatedPassHandler(req: Request, res: Response) {
  const { serialNumber } = req.params

  const pass = await resolvePassForDownload(serialNumber, leerToken(req))
  if (!pass) return res.sendStatus(401)

  const buffer = await buildAndSignPassForCustomer(pass.venueId, pass.customerId)
  if (!buffer) return res.sendStatus(500)

  res.setHeader('Content-Type', 'application/vnd.apple.pkpass')
  res.setHeader('Last-Modified', new Date().toUTCString())
  return res.send(buffer)
}
