import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { apnsAvailable, sendSilentPush } from './apnsClient'

/**
 * Le avisa a los teléfonos donde vive una tarjeta que su contenido cambió.
 *
 * 🔴 Esto se llama desde el COBRO. Nada de lo que pase aquí puede tumbarlo: un negocio
 * que ni siquiera usa tarjetas digitales no puede quedarse sin cobrar porque un
 * certificado de Apple no esté configurado, o porque APNs no responda.
 */

export interface NotifyResult {
  notified: number
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
    await prisma.walletPass.update({ where: { id: walletPassId }, data: { updatedAt: new Date() } })

    // En paralelo: son llamadas de red independientes y el mismo cliente puede tener
    // la tarjeta en varios aparatos.
    const resultados = await Promise.all(registros.map(r => sendSilentPush(r.pushToken).then(res => ({ r, res }))))

    // 🔴 Los aparatos que ya no tienen la tarjeta se olvidan. Sin esto se les manda
    // avisos para siempre, y Apple penaliza a quien insiste contra tokens muertos.
    const muertos = resultados.filter(x => x.res.gone).map(x => x.r.id)
    if (muertos.length > 0) {
      await prisma.walletPassRegistration.deleteMany({ where: { id: { in: muertos } } })
      logger.info('Aparatos que ya no tienen la tarjeta, olvidados', { walletPassId, cuantos: muertos.length })
    }

    return { notified: resultados.filter(x => x.res.ok).length }
  } catch (error) {
    // El aviso es un extra; el cobro es el negocio.
    logger.error('No se pudo avisar de la actualización de una tarjeta', {
      walletPassId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { notified: 0 }
  }
}

/**
 * Avisa a los teléfonos de UN cliente en UN negocio.
 *
 * 🔴 Es el punto que llaman el sellado, el canje y la reversión. Cada uno de esos
 * cambia lo que la tarjeta debe mostrar, y sin este aviso el cliente sigue viendo el
 * número anterior hasta que vuelva a descargarla — que en la práctica no ocurre nunca.
 *
 * Como todo en este archivo: nunca lanza. Se llama desde el camino del cobro.
 */
export async function notifyCustomerPassUpdated(venueId: string, customerId: string): Promise<NotifyResult> {
  try {
    if (!apnsAvailable()) return { notified: 0 }

    const pass = await prisma.walletPass.findFirst({
      where: { venueId, customerId, active: true },
      select: { id: true },
    })
    if (!pass) return { notified: 0 }

    return notifyPassUpdated(pass.id)
  } catch (error) {
    logger.error('No se pudo resolver la tarjeta de un cliente para avisarle', {
      venueId,
      customerId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { notified: 0 }
  }
}
