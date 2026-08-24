/**
 * Guardar lo que DiDi manda, ANTES de intentar entenderlo.
 *
 * Mismo principio que Uber: el evento se persiste crudo apenas se verifica la firma. Si
 * después el procesamiento falla, el pedido sigue existiendo en la base y se puede
 * reprocesar — un pedido que el cliente ya pagó no se pierde porque nuestro mapper tuviera
 * un bug.
 */
import { DeliveryProvider } from '@prisma/client'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

import { parseDidiPayload } from './didi.json'
import { verifyDidiSignature } from './didi.signature'

/** El sobre que DiDi pone alrededor de TODOS sus eventos. */
export interface DidiEnvelope {
  app_id?: string | number
  app_shop_id?: string
  type?: string
  timestamp?: number
  data?: { order_id?: string | number } & Record<string, unknown>
}

export type DidiIngressOutcome = 'STORED' | 'DUPLICATE' | 'INVALID_SIGNATURE' | 'MALFORMED'

export interface DidiIngressResult {
  outcome: DidiIngressOutcome
  eventRowId?: string
  type?: string
}

/**
 * 🔴 DiDi NO manda un id de evento. Uber sí (`event_id`) y con él se deduplica solo; aquí
 * hay que fabricarlo, porque reintentan cuando no reciben `errno:0`.
 *
 * `tipo:pedido:timestamp` es la combinación correcta, y el `timestamp` es la parte sutil:
 *  · Un REINTENTO del mismo aviso trae el mismo timestamp ⇒ se deduplica. Que es el punto.
 *  · Pero `orderCancelApply` llega 6 veces cada 2 minutos, y `orderRefundApply` 25 veces
 *    cada hora: ésos son avisos DISTINTOS del mismo pedido, con timestamps distintos, y
 *    tienen que guardarse por separado o perderíamos el rastro de que el cliente insistió.
 */
function claveDedup(sobre: DidiEnvelope): string {
  const pedido = sobre.data?.order_id ?? 'sin-pedido'
  return `DIDI_FOOD:${sobre.type}:${pedido}:${sobre.timestamp ?? 0}`
}

export async function persistDidiWebhookEvent(input: {
  rawBody: Buffer
  signatureHeader?: string
  appSecret: string
}): Promise<DidiIngressResult> {
  if (!verifyDidiSignature(input.rawBody, input.signatureHeader, input.appSecret)) {
    return { outcome: 'INVALID_SIGNATURE' }
  }

  let sobre: DidiEnvelope
  try {
    // 🔴 `parseDidiPayload`, NUNCA `JSON.parse`: los ids de DiDi son enteros de 64 bits y
    // `JSON.parse` los redondea sin avisar. Ver `didi.json.ts`.
    sobre = parseDidiPayload<DidiEnvelope>(input.rawBody)
  } catch {
    return { outcome: 'MALFORMED' }
  }

  const tipo = typeof sobre.type === 'string' ? sobre.type : ''
  // Sin `type` no hay nada que hacer con el evento. Un `type` DESCONOCIDO en cambio sí se
  // guarda: DiDi documenta que puede agregar eventos nuevos, y descartarlos nos dejaría sin
  // rastro de algo que quizá importaba.
  if (!tipo) return { outcome: 'MALFORMED' }

  const appShopId = typeof sobre.app_shop_id === 'string' ? sobre.app_shop_id : null
  const externalOrderId = sobre.data?.order_id != null ? String(sobre.data.order_id) : null

  // `app_shop_id` es el id que NOSOTROS elegimos para la tienda al ligarla, y DiDi lo
  // devuelve en cada evento: es la llave para saber de qué venue es esto. Puede no
  // resolver (una tienda que alguien ligó a mano); el evento se guarda igual con venue
  // nulo — un pedido real jamás se tira por no encontrar su venue.
  const link = appShopId
    ? await prisma.deliveryChannelLink.findUnique({
        where: { provider_externalLocationId: { provider: DeliveryProvider.DIDI_FOOD, externalLocationId: appShopId } },
        select: { id: true, venueId: true },
      })
    : null

  const dedupKey = claveDedup(sobre)

  try {
    const fila = await prisma.deliveryOrderEvent.create({
      data: {
        provider: DeliveryProvider.DIDI_FOOD,
        externalEventId: dedupKey,
        eventType: tipo,
        channelLinkId: link?.id ?? null,
        venueId: link?.venueId ?? null,
        externalOrderId,
        dedupKey,
        // El sobre COMPLETO, tal cual. Es la única evidencia de qué mandó DiDi si algo no
        // cuadra después — y con `orderNew` es además el pedido entero, porque a diferencia
        // de Uber ellos SÍ mandan el contenido y no un puntero.
        payload: JSON.parse(JSON.stringify(sobre)),
      },
      select: { id: true },
    })
    return { outcome: 'STORED', eventRowId: fila.id, type: tipo }
  } catch (error) {
    // P2002 = ya lo teníamos. Es un reintento de DiDi porque no alcanzó a leer nuestro
    // `errno:0`; no es un error.
    if ((error as { code?: string }).code === 'P2002') {
      logger.info('[DidiWebhook] evento repetido, ya estaba guardado', { dedupKey })
      return { outcome: 'DUPLICATE', type: tipo }
    }
    throw error
  }
}
