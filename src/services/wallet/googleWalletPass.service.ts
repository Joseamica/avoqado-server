import { randomUUID } from 'crypto'
import { WalletPlatform } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { randomBytes } from 'crypto'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { getCardDesign } from './cardDesign.service'
import { getStampCardStatus } from './stampLedger.service'
import { buildLoyaltyClass, googleClassId } from './googleClassBuilder.service'
import { buildLoyaltyObject, googleObjectId } from './googleObjectBuilder.service'
import { googleWalletAvailable, googleWalletCredentials, issuerId, walletBaseUrl, walletClient } from './googleWalletClient'

/**
 * Emisión de la tarjeta de Google — espejo de `walletPass.service.ts` + `issuePass.service.ts`
 * del lado de Apple.
 */

/** 24 bytes → 48 hex, misma forma que el token de Apple: el POS filtra por esa forma. */
function opaqueSecret(): string {
  return randomBytes(24).toString('hex')
}

/**
 * Asegura que la plantilla del negocio existe en Google — y si ya existe, la ACTUALIZA.
 *
 * 🔴 Se pregunta antes de insertar: `insert` sobre una clase que ya existe devuelve
 * error 409 y abortaría la emisión de un cliente que no tiene la culpa.
 *
 * 🔴 Sin el `patch` del bloque de abajo, la plantilla se crea UNA vez y nunca se vuelve
 * a tocar: si el negocio cambia su logo, colores o premio en el diseñador, el pase de
 * Apple lo relee en cada emisión pero el de Android queda congelado para siempre en
 * como estaba el día de la primera tarjeta. Rompe la paridad justo donde nadie mira.
 */
export async function ensureLoyaltyClass(venueId: string): Promise<string> {
  const client = await walletClient()
  const classId = googleClassId(issuerId(), venueId)

  let yaExiste = false
  try {
    await client.loyaltyclass.get({ resourceId: classId })
    yaExiste = true
  } catch (error: any) {
    const codigo = error?.code ?? error?.response?.status
    // 🔴 Sólo un 404 significa «no existe, créala». Un 403 o un fallo de red significan que
    // NO pudimos saberlo: crear a ciegas produce un 409 cuyo mensaje apunta al lugar
    // equivocado y esconde el problema real (permisos del service account, casi siempre).
    if (codigo !== 404) throw error
  }

  // 🔴 `rewardLabel` sale de `LoyaltyConfig`, NO de `getStampCardStatus(venueId, '')`: esa
  // función lee la cartilla de un CLIENTE, y aquí todavía no hay ninguno — se está creando
  // la plantilla del NEGOCIO. Mismo respaldo que usa `getStampCardStatus` cuando el negocio
  // no configuró nada.
  //
  // 🔴 `select` amplía a `logo`: es el respaldo del logo cuando el negocio no subió uno al
  // diseñador (ver `googleClassBuilder.service.ts`).
  const [venue, design, config] = await Promise.all([
    prisma.venue.findFirst({ where: { id: venueId, active: true }, select: { name: true, logo: true } }),
    getCardDesign(venueId),
    prisma.loyaltyConfig.findUnique({ where: { venueId } }),
  ])
  const rewardLabel = config?.stampRewardLabel ?? 'Un producto gratis'

  const requestBody = buildLoyaltyClass({
    issuerId: issuerId(),
    venueId,
    venueName: venue?.name ?? 'Avoqado',
    design,
    rewardLabel,
    venueLogo: venue?.logo ?? null,
  }) as any

  if (yaExiste) {
    // 🔴 Un fallo del patch NO debe impedir emitir: el cliente prefiere una tarjeta con
    // el logo/colores viejos que ninguna tarjeta. Se registra y se sigue con la clase que
    // ya existe en Google.
    try {
      await client.loyaltyclass.patch({ resourceId: classId, requestBody })
    } catch (error) {
      logger.error('No se pudo actualizar la plantilla de Google Wallet del negocio; se sigue con la existente', {
        venueId,
        classId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return classId
  }

  await client.loyaltyclass.insert({ requestBody })

  return classId
}

/**
 * Emite (o recupera) el pase de Google de un cliente en un negocio.
 *
 * 🔴 Idempotente por (venueId, customerId, GOOGLE) — el filtro incluye `platform` y
 * `active`: sin `platform` devolvería el pase de Apple como si fuera el de Google.
 */
export async function issueGooglePass(venueId: string, customerId: string) {
  const existing = await prisma.walletPass.findFirst({
    where: { venueId, customerId, platform: WalletPlatform.GOOGLE, active: true },
  })
  if (existing?.googleObjectId) {
    return {
      id: existing.id,
      serialNumber: existing.serialNumber,
      qrToken: existing.qrToken,
      googleObjectId: existing.googleObjectId,
    }
  }

  const pass =
    existing ??
    (await prisma.walletPass.create({
      data: {
        venueId,
        customerId,
        platform: WalletPlatform.GOOGLE,
        serialNumber: `AVQ-${randomUUID()}`,
        authToken: opaqueSecret(),
        qrToken: opaqueSecret(),
      },
    }))

  const objectId = googleObjectId(issuerId(), pass.id)
  await ensureLoyaltyClass(venueId)

  const stamps = await getStampCardStatus(venueId, customerId)

  const client = await walletClient()
  try {
    await client.loyaltyobject.insert({
      requestBody: buildLoyaltyObject({
        issuerId: issuerId(),
        venueId,
        walletPassId: pass.id,
        serialNumber: pass.serialNumber,
        qrToken: pass.qrToken,
        revision: pass.revision,
        // 🔴 `walletBaseUrl()`, no `env.BASE_URL as string`: BASE_URL es opcional en el
        // schema de env, y el cast mentía. Aquí es seguro porque `buildSaveJwt` — la
        // única entrada de producción — ya llamó `googleWalletAvailable()`, que ahora
        // exige una URL pública válida antes de llegar hasta acá.
        baseUrl: walletBaseUrl() as string,
        content: stamps,
      }) as any,
    })
  } catch (error: any) {
    // 🔴 409 = el objeto YA existe con este id. Pasa cuando un intento anterior lo creó en
    // Google y murió antes de guardar el id en la base (p.ej. el `update` de abajo falló).
    // El id es determinista, así que el objeto que existe es EXACTAMENTE el que queríamos
    // crear: seguir adelante y guardar el id es lo correcto. Sin esto, ese cliente no puede
    // volver a guardar su tarjeta nunca — cada intento recalcula el mismo id, Google
    // vuelve a responder 409, y no hay salida.
    const codigo = error?.code ?? error?.response?.status
    if (codigo !== 409) throw error
    logger.info('El objeto de Google ya existía; se reusa', { objectId, venueId, customerId })
  }

  await prisma.walletPass.update({ where: { id: pass.id }, data: { googleObjectId: objectId } })

  return { id: pass.id, serialNumber: pass.serialNumber, qrToken: pass.qrToken, googleObjectId: objectId }
}

/** El JWT del botón «Guardar», más el id del pase — que el llamador necesita para auditar. */
export interface SaveJwtResult {
  jwt: string
  passId: string
}

/**
 * El JWT que firma el botón «Guardar en Google Wallet».
 *
 * Devuelve null —en vez de lanzar— cuando el negocio o el cliente no existen, o cuando
 * la cuenta de Google no está configurada: el llamador responde un 404 entendible.
 *
 * 🔴 Devuelve también `passId`, no sólo el JWT: el llamador (el controlador público)
 * escribe un `ActivityLog` con `entity: 'WalletPass'`, y ese registro sólo resuelve si
 * `entityId` es el id REAL de esa tabla — el JWT no vive en ninguna.
 */
export async function buildSaveJwt(venueId: string, customerId: string): Promise<SaveJwtResult | null> {
  if (!googleWalletAvailable()) {
    logger.warn('Google Wallet no está configurado; no se puede emitir la tarjeta', { venueId })
    return null
  }

  const [venue, customer] = await Promise.all([
    prisma.venue.findFirst({ where: { id: venueId, active: true }, select: { id: true } }),
    prisma.customer.findFirst({ where: { id: customerId, venueId }, select: { id: true } }),
  ])
  if (!venue || !customer) return null

  const pass = await issueGooglePass(venueId, customerId)
  const creds = googleWalletCredentials()
  if (!creds) return null

  const signedJwt = jwt.sign(
    {
      iss: creds.client_email,
      aud: 'google',
      typ: 'savetowallet',
      // Se manda sólo el id: el objeto ya está creado con su contenido al día.
      payload: { loyaltyObjects: [{ id: pass.googleObjectId }] },
    },
    creds.private_key,
    { algorithm: 'RS256' },
  )

  return { jwt: signedJwt, passId: pass.id }
}
