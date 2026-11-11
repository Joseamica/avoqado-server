import cuid from 'cuid'
import { WalletPlatform, type WalletPass } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { apnsAvailable, sendSilentPush } from './apnsClient'
import { getStampCardStatus } from './stampLedger.service'
import { buildLoyaltyObject } from './googleObjectBuilder.service'
import { encolarAvisoDeTarjetaEnTx } from './walletPassOutbox.service'
import { retry, shouldRetryDbConnectionError } from '../../utils/retry'
import { googleWalletAvailable, issuerId, walletBaseUrl, walletClient } from './googleWalletClient'

/**
 * Le avisa a los teléfonos donde vive una tarjeta que su contenido cambió.
 *
 * 🔴 Esto se llama desde el COBRO. Nada de lo que pase aquí puede tumbarlo: un negocio
 * que ni siquiera usa tarjetas digitales no puede quedarse sin cobrar porque un
 * certificado de Apple no esté configurado, o porque APNs no responda.
 */

export interface NotifyResult {
  notified: number
  /**
   * 🔴 Sin esto, `{ notified: 0 }` significaba DOS cosas incompatibles: «este cliente no
   * tenía tarjeta» y «reventó y nadie se enteró». El aviso sigue siendo un extra —el cobro
   * es el negocio— pero quien llame puede ahora distinguirlas.
   */
  failed?: boolean
  ocupado?: boolean
}

/**
 * ¿Es un defecto de DESPLIEGUE y no un tropiezo pasajero?
 *
 * Medido el 3-sep-2026: con el código nuevo arriba y la migración sin correr, la consulta
 * revienta con `Unknown field ... for select statement`. Ese error se veía igual que un
 * timeout de red, así que se trataba como «no había a quién avisar» y los sellos del iPhone
 * se apagaban sin ruido. Un fallo de red se cura solo; éste no se cura NUNCA hasta que
 * alguien corra la migración, y por eso tiene que gritar distinto.
 */
function esDespliegueIncompleto(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const nombre = error.name
  if (nombre === 'PrismaClientValidationError' || nombre === 'PrismaClientInitializationError') return true
  const codigo = (error as { code?: unknown }).code
  // P2021 tabla inexistente · P2022 columna inexistente — la base va atrás del código.
  if (codigo === 'P2021' || codigo === 'P2022') return true
  return /unknown field|unknown arg|does not exist in the current database/i.test(error.message)
}

export async function notifyPassUpdated(walletPassId: string): Promise<NotifyResult> {
  try {
    if (!apnsAvailable()) return { notified: 0 }

    const registros = await prisma.walletPassRegistration.findMany({
      where: { walletPassId },
      select: { id: true, pushToken: true, deviceLibraryIdentifier: true },
    })
    if (registros.length === 0) return { notified: 0 }

    // 🔴 Se TOCA el pase antes de avisar. El aparato despierta y pregunta "¿qué
    // cambió desde tal fecha?": si el pase no quedó marcado como modificado, el
    // servicio contesta 204 y el teléfono se vuelve a dormir con el saldo viejo. El
    // push por sí solo no actualiza nada.
    const { venueId } = await prisma.walletPass.update({
      where: { id: walletPassId },
      data: { updatedAt: new Date() },
      select: { venueId: true },
    })

    // En paralelo: son llamadas de red independientes y el mismo cliente puede tener
    // la tarjeta en varios aparatos.
    const resultados = await Promise.all(registros.map(r => sendSilentPush(r.pushToken, venueId).then(res => ({ r, res }))))

    // 🔴 Los aparatos que ya no tienen la tarjeta se olvidan. Sin esto se les manda
    // avisos para siempre, y Apple penaliza a quien insiste contra tokens muertos.
    const muertos = resultados.filter(x => x.res.gone).map(x => x.r.id)
    if (muertos.length > 0) {
      await prisma.walletPassRegistration.deleteMany({ where: { id: { in: muertos } } })
      logger.info('Aparatos que ya no tienen la tarjeta, olvidados', { walletPassId, cuantos: muertos.length })
    }

    return { notified: resultados.filter(x => x.res.ok).length, failed: resultados.some(x => !x.res.ok && !x.res.gone && !x.res.omitido) }
  } catch (error) {
    // El aviso es un extra; el cobro es el negocio.
    logger.error('No se pudo avisar de la actualización de una tarjeta', {
      walletPassId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { notified: 0, failed: true }
  }
}

/**
 * Le avisa a Google que una tarjeta cambió.
 *
 * 🔴 No hay push ni registro de aparatos, a diferencia de Apple: se actualiza el objeto
 * y Google reparte. Por eso `WalletPassRegistration` no participa.
 *
 * 🔴 La revisión sube ANTES de armar el objeto: la URL de la franja la lleva dentro, y
 * es lo único que obliga a Google a redescargar la imagen en vez de servir la vieja.
 */
const PLAZO_GOOGLE_MS = 20_000
const LIMITE_DE_ENVIO_MS = 60_000

type Pase = Pick<WalletPass, 'id' | 'venueId' | 'customerId' | 'serialNumber' | 'qrToken' | 'googleObjectId'>

function objetoGoogle(pass: Pase, stamps: Awaited<ReturnType<typeof getStampCardStatus>>, revision: number) {
  return buildLoyaltyObject({
    issuerId: issuerId(),
    venueId: pass.venueId,
    walletPassId: pass.id,
    serialNumber: pass.serialNumber,
    qrToken: pass.qrToken,
    revision,
    baseUrl: walletBaseUrl()!,
    content: stamps,
  })
}

async function notifyGooglePass(pass: Pase): Promise<{ ok: boolean; huella?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (!googleWalletAvailable() || !pass.googleObjectId || !walletBaseUrl()) return { ok: false }
    // El race abarca también la credencial. Sólo deja de esperar: la petición puede publicar después.
    return await Promise.race([
      (async () => {
        const actualizado = await prisma.walletPass.update({
          where: { id: pass.id },
          data: { revision: { increment: 1 } },
          select: { revision: true },
        })
        const stamps = await getStampCardStatus(pass.venueId, pass.customerId)
        const huella = JSON.stringify(objetoGoogle(pass, stamps, 0)) // incluye heroImage, sin su revisión variable
        const client = await walletClient(pass.venueId)
        await client.loyaltyobject.patch(
          { resourceId: pass.googleObjectId!, requestBody: objetoGoogle(pass, stamps, actualizado.revision) as any },
          { timeout: PLAZO_GOOGLE_MS },
        )
        return { ok: true, huella }
      })(),
      new Promise<{ ok: false }>(resolve => {
        timer = setTimeout(() => resolve({ ok: false }), 25_000)
      }),
    ])
  } catch (error) {
    logger.error('No se pudo avisarle a Google de la actualización de una tarjeta', {
      walletPassId: pass.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}

async function reclamarAvisos(venueId: string, customerId: string, token: string) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'avoqado:aviso-tarjeta:v1:' + venueId + ':' + customerId}, 0))`
    const [estado] = await tx.$queryRaw<{ ocupado: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM "WalletPassOutbox" WHERE "venueId" = ${venueId} AND "customerId" = ${customerId}
        AND "reclamadoHasta" > (clock_timestamp() AT TIME ZONE 'UTC')) AS ocupado`
    if (estado?.ocupado) return null
    return tx.$queryRaw<{ id: string; intentos: number }[]>`
      UPDATE "WalletPassOutbox" SET "reclamadoPor" = ${token}, "reclamadoHasta" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '2 minutes'
      WHERE id IN (SELECT id FROM "WalletPassOutbox" WHERE "venueId" = ${venueId} AND "customerId" = ${customerId}
        AND ("reclamadoHasta" IS NULL OR "reclamadoHasta" <= (clock_timestamp() AT TIME ZONE 'UTC'))
        AND "siguienteIntentoAt" <= (clock_timestamp() AT TIME ZONE 'UTC') ORDER BY id LIMIT 200)
      RETURNING id, intentos`
  })
}

/** Único enviador por clienta. Dinero sólo inserta; aquí, después del commit, se habla a los proveedores. Nunca lanza. */
export async function notifyCustomerPassUpdated(venueId: string, customerId: string): Promise<NotifyResult> {
  let notified = 0
  for (let vuelta = 0; vuelta < 3; vuelta++) {
    const token = cuid()
    let idReparacion: string | null = null
    try {
      const filas = await reclamarAvisos(venueId, customerId, token)
      if (filas === null) return { notified, ocupado: true }
      if (filas.length === 0) return { notified }
      const limite = Date.now() + LIMITE_DE_ENVIO_MS
      const passes = await prisma.walletPass.findMany({
        where: { venueId, customerId, active: true },
        select: {
          id: true,
          platform: true,
          venueId: true,
          customerId: true,
          serialNumber: true,
          qrToken: true,
          revision: true,
          googleObjectId: true,
        },
      })
      if (passes.length > 0) {
        idReparacion = cuid()
        const intentos = Math.max(...filas.map(f => f.intentos)) + 1
        // R65: sin este rastro ANTES del proveedor, un PATCH abandonado podría dejar el pase viejo sin obligación pendiente.
        await prisma.$executeRaw`
          INSERT INTO "WalletPassOutbox" (id, "venueId", "customerId", motivo, "createdAt", intentos, "siguienteIntentoAt")
          VALUES (${idReparacion}, ${venueId}, ${customerId}, 'REPARACION', (clock_timestamp() AT TIME ZONE 'UTC'), ${intentos},
            (clock_timestamp() AT TIME ZONE 'UTC') + greatest(interval '2 minutes', least(2 ^ ${Math.min(intentos, 6)}, 60) * interval '1 minute'))`
        const enviados: { pass: Pase; huella: string }[] = []
        for (const pass of passes) {
          if (Date.now() > limite) throw new Error('Se agotó el presupuesto del aviso de Wallet')
          if (pass.platform === WalletPlatform.APPLE) {
            const r = await notifyPassUpdated(pass.id)
            notified += r.notified
            if (r.failed) throw new Error('Falló un aviso de Apple Wallet')
          } else if (pass.platform === WalletPlatform.GOOGLE) {
            const r = await notifyGooglePass(pass)
            if (!r.ok || !r.huella) throw new Error('Falló un aviso de Google Wallet')
            notified++
            enviados.push({ pass, huella: r.huella })
          }
        }
        for (const { pass, huella } of enviados) {
          const vigente = await getStampCardStatus(venueId, customerId)
          if (JSON.stringify(objetoGoogle(pass, vigente, 0)) !== huella)
            await encolarAvisoDeTarjetaEnTx(prisma, { venueId, customerId, motivo: 'RELECTURA' })
        }
      }
      // Sólo SUS filas y SU rastro: lo nuevo y lo reclamado por otro token sobreviven.
      await prisma.$executeRaw`DELETE FROM "WalletPassOutbox" WHERE "venueId" = ${venueId} AND "customerId" = ${customerId}
        AND ("reclamadoPor" = ${token} OR id = ${idReparacion})`
    } catch (error) {
      await prisma.$executeRaw`UPDATE "WalletPassOutbox" SET "reclamadoPor" = NULL, "reclamadoHasta" = NULL,
        "intentos" = "intentos" + 1,
        "siguienteIntentoAt" = (clock_timestamp() AT TIME ZONE 'UTC') + least(2 ^ least("intentos", 6), 60) * interval '1 minute'
        WHERE "venueId" = ${venueId} AND "customerId" = ${customerId} AND "reclamadoPor" = ${token}`.catch(soltarError =>
        logger.warn('No se pudo soltar el reclamo de Wallet; vencerá solo', { venueId, customerId, error: String(soltarError) }),
      )
      const despliegueIncompleto = esDespliegueIncompleto(error)
      logger.error(
        despliegueIncompleto
          ? '🔴 DESPLIEGUE INCOMPLETO: el esquema de la base no coincide con el código y los sellos NO están llegando a las tarjetas'
          : 'No se pudo resolver la tarjeta de un cliente para avisarle',
        { venueId, customerId, despliegueIncompleto, error: error instanceof Error ? error.message : String(error) },
      )
      return { notified, failed: true }
    }
  }
  return { notified }
}

/** Una página por pasada: un fallo no se vuelve a reclamar en esta misma vuelta. */
export async function reintentarAvisosDeTarjeta(limite = 50): Promise<{ avisados: number; fallidos: number; ocupados: number }> {
  const take = Number.isFinite(limite) ? Math.max(0, Math.min(50, Math.floor(limite))) : 50
  const candidatos = await retry(
    () => prisma.$queryRaw<{ venueId: string; customerId: string }[]>`
    SELECT o."venueId", o."customerId" FROM "WalletPassOutbox" o
    WHERE o."siguienteIntentoAt" < (clock_timestamp() AT TIME ZONE 'UTC') - interval '60 seconds' AND o.intentos < 10
      AND NOT EXISTS (SELECT 1 FROM "WalletPassOutbox" vivo WHERE vivo."venueId" = o."venueId" AND vivo."customerId" = o."customerId"
        AND vivo."reclamadoHasta" > (clock_timestamp() AT TIME ZONE 'UTC'))
    GROUP BY o."venueId", o."customerId" ORDER BY min(o."siguienteIntentoAt"), min(o.id) LIMIT ${take}`,
    { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'wallet-outbox.find' },
  )
  const [agotados] = await prisma.$queryRaw<
    { cantidad: bigint }[]
  >`SELECT count(*) AS cantidad FROM "WalletPassOutbox" WHERE intentos >= 10`
  if (Number(agotados?.cantidad) > 0)
    logger.warn('Avisos de Wallet sin confirmar tras diez intentos', { cantidad: Number(agotados.cantidad) })
  const resultado = { avisados: 0, fallidos: 0, ocupados: 0 }
  for (const c of candidatos) {
    const r = await notifyCustomerPassUpdated(c.venueId, c.customerId)
    if (r.ocupado) resultado.ocupados++
    else if (r.failed) resultado.fallidos++
    else resultado.avisados++
  }
  return resultado
}
