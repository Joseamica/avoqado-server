import { timingSafeEqual } from 'crypto'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'

/**
 * El servicio que APPLE llama para mantener viva una tarjeta.
 *
 * 🔴 Estos endpoints son públicos por definición: los invoca el iPhone del cliente, no
 * nuestro dashboard, así que no hay sesión que exigir. Lo ÚNICO que los protege es el
 * token que viaja dentro del propio pase.
 *
 * 🔴 Y un fallo aquí no se ve en ninguna pantalla: se ve en que las tarjetas de todos
 * los clientes dejan de actualizarse, semanas después y sin un solo error en el log.
 * Por eso cada camino devuelve el código EXACTO que Apple espera — un 200 donde iba un
 * 204 pone al teléfono a preguntar en bucle.
 *
 * El protocolo, en corto: el teléfono se registra y deja un `pushToken`; cuando algo
 * cambia se le manda un sobre VACÍO por APNs; el teléfono despierta, pregunta qué
 * seriales cambiaron, y se baja el pase completo. El contenido nunca viaja en el push.
 */

export interface PassKitResult<T = unknown> {
  status: number
  body?: T
}

/**
 * 🔴 Comparación en tiempo constante. Un `===` tarda distinto según cuántos caracteres
 * coincidan, y con suficientes intentos eso deja adivinar el token carácter por
 * carácter. Es barato hacerlo bien.
 */
function tokenValido(recibido: string, esperado: string): boolean {
  const a = Buffer.from(recibido)
  const b = Buffer.from(esperado)
  // `timingSafeEqual` exige la misma longitud; distinta longitud ya es un no.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Resuelve el pase y verifica el token de una sola vez.
 *
 * 🔴 Devuelve null tanto si el serial NO existe como si el token está mal, y quien
 * llama contesta 401 en los dos casos. Un 404 confirmaría qué seriales son reales:
 * contestar siempre lo mismo no le dice nada a quien esté probando a ciegas.
 */
export async function resolvePassForDownload(serialNumber: string, authToken: string) {
  return resolverPase(serialNumber, authToken)
}

async function resolverPase(serialNumber: string, authToken: string) {
  const pass = await prisma.walletPass.findFirst({
    where: { serialNumber, active: true },
    select: { id: true, authToken: true, venueId: true, customerId: true },
  })
  if (!pass || !tokenValido(authToken, pass.authToken)) return null
  return pass
}

/** POST …/v1/devices/{device}/registrations/{passTypeId}/{serial} */
export async function registerDevice(
  deviceLibraryIdentifier: string,
  serialNumber: string,
  pushToken: string,
  authToken: string,
): Promise<PassKitResult> {
  const pass = await resolverPase(serialNumber, authToken)
  if (!pass) return { status: 401 }

  // 🔴 Upsert y no create: Apple ROTA el `pushToken` del mismo aparato. Con una fila
  // nueva por rotación, el aviso se mandaría a un token muerto y la tarjeta quedaría
  // congelada sin que nadie lo note.
  const existia = await prisma.walletPassRegistration.upsert({
    where: { deviceLibraryIdentifier_walletPassId: { deviceLibraryIdentifier, walletPassId: pass.id } },
    create: { deviceLibraryIdentifier, walletPassId: pass.id, pushToken },
    update: { pushToken },
    select: { createdAt: true, updatedAt: true },
  })

  logger.info('Aparato registrado para actualizaciones de tarjeta', {
    venueId: pass.venueId,
    serialNumber,
    deviceLibraryIdentifier,
  })

  // Apple distingue: 201 cuando el registro es nuevo, 200 cuando ya existía.
  const esNuevo = existia.createdAt.getTime() === existia.updatedAt.getTime()
  return { status: esNuevo ? 201 : 200 }
}

/** DELETE …/v1/devices/{device}/registrations/{passTypeId}/{serial} */
export async function unregisterDevice(deviceLibraryIdentifier: string, serialNumber: string, authToken: string): Promise<PassKitResult> {
  const pass = await resolverPase(serialNumber, authToken)
  if (!pass) return { status: 401 }

  await prisma.walletPassRegistration.deleteMany({
    where: { deviceLibraryIdentifier, walletPassId: pass.id },
  })

  return { status: 200 }
}

export interface UpdatedSerials {
  serialNumbers: string[]
  lastUpdated: string
}

/**
 * GET …/v1/devices/{device}/registrations/{passTypeId}?passesUpdatedSince=
 *
 * 🔴 Este NO lleva token: Apple lo llama sin `Authorization`. Lo que lo acota es que
 * sólo devuelve los pases que ESE aparato ya registró — y para registrarlos sí tuvo
 * que presentar el token de cada uno.
 */
export async function listUpdatedSerials(
  deviceLibraryIdentifier: string,
  passesUpdatedSince?: string,
): Promise<PassKitResult<UpdatedSerials>> {
  // `passesUpdatedSince` es la marca que devolvimos la vez pasada. Un valor ilegible
  // se ignora y se manda todo: repetir es inofensivo, perderse un cambio no.
  const desde = passesUpdatedSince ? new Date(Number(passesUpdatedSince) * 1000) : null
  const valido = desde && !Number.isNaN(desde.getTime()) ? desde : null

  const registros = await prisma.walletPassRegistration.findMany({
    where: {
      deviceLibraryIdentifier,
      walletPass: { active: true, ...(valido ? { updatedAt: { gt: valido } } : {}) },
    },
    select: { walletPass: { select: { serialNumber: true, updatedAt: true } } },
    orderBy: { walletPass: { updatedAt: 'asc' } },
  })

  // 🔴 204 y no un 200 con lista vacía: Apple los trata distinto, y con el 200 el
  // aparato vuelve a preguntar en bucle.
  if (registros.length === 0) return { status: 204 }

  const ultimo = registros.reduce((max, r) => Math.max(max, r.walletPass.updatedAt.getTime()), 0)

  return {
    status: 200,
    body: {
      serialNumbers: registros.map(r => r.walletPass.serialNumber),
      // Apple lo devuelve tal cual la próxima vez; se manda en segundos.
      lastUpdated: String(Math.floor(ultimo / 1000)),
    },
  }
}
