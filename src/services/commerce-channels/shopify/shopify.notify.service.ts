// src/services/commerce-channels/shopify/shopify.notify.service.ts
import { NotificationChannel, NotificationPriority, NotificationType, StaffRole } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { sendNotification } from '@/services/dashboard/notification.service'

export type ShopifyAviso =
  | 'REVOCADA'
  | 'ATORADOS'
  | 'RETRASO'
  | 'SOBREVENTA'
  | 'POR_REVISAR'
  | 'FALTA_PERMISO'
  | 'CONTEO_NO_APLICADO'
  | 'BARRIDO_OMITIDO'
/** `motivo` (sólo CONTEO_NO_APLICADO): por qué no se aplicó la línea del conteo (§12.1); cambia lo que hay que hacer. */
type Datos = { productName?: string; count?: number; productId?: string; motivo?: 'ENVIO_EN_CAMINO' | 'DUDA_POR_REVISAR' }

const TANDA = 50
/** Avisos que se deduplican por producto además de por día (§12.1): un conteo no aplicado de otro producto sí avisa. */
const POR_PRODUCTO: ReadonlySet<ShopifyAviso> = new Set<ShopifyAviso>(['CONTEO_NO_APLICADO'])

function cuantos(n: number | undefined, singular: string, plural: string): string {
  if (n === undefined || n < 1) return `algunos ${plural}`
  return n === 1 ? `1 ${singular}` : `${n} ${plural}`
}

const TEXTOS: Record<ShopifyAviso, (d: Datos) => { title: string; message: string; priority: NotificationPriority }> = {
  REVOCADA: () => ({
    title: 'Shopify desconectó a Avoqado',
    message:
      'La tienda de Shopify ya no le da acceso a Avoqado. Tus ventas siguen funcionando, pero el stock no se sincroniza hasta que la vuelvas a conectar en Integraciones → Shopify.',
    priority: NotificationPriority.HIGH,
  }),
  ATORADOS: d => ({
    title: 'Cambios de stock atorados con Shopify',
    message: `No pudimos mandar a Shopify ${cuantos(d.count, 'cambio de stock', 'cambios de stock')} después de varios intentos. Revísalo en Integraciones → Shopify → Por revisar.`,
    priority: NotificationPriority.HIGH,
  }),
  RETRASO: () => ({
    title: 'Shopify va atrasado',
    message:
      'Hay cambios de stock esperando más de 15 minutos para llegar a Shopify. Seguimos intentando; si no se resuelve, aparecerán en Por revisar.',
    priority: NotificationPriority.NORMAL,
  }),
  SOBREVENTA: d => ({
    title: 'Se vendió dos veces la misma pieza',
    message: `${d.productName ?? 'Un producto'} quedó en negativo: se vendió en la tienda y en línea a la vez. Revisa la existencia y, si hace falta, avísale al cliente del pedido en línea.`,
    priority: NotificationPriority.HIGH,
  }),
  POR_REVISAR: d => ({
    title: 'Hay stock por revisar con Shopify',
    message: `Hay que revisar ${cuantos(d.count, 'producto', 'productos')}: el número de Avoqado y el de Shopify no coinciden. Elige el bueno en Integraciones → Shopify → Por revisar.`,
    priority: NotificationPriority.NORMAL,
  }),
  FALTA_PERMISO: () => ({
    title: 'Falta un permiso en Shopify',
    message:
      'Shopify no le deja a Avoqado cambiar el stock. Vuelve a conectar la tienda en Integraciones → Shopify y acepta todos los permisos que pide.',
    priority: NotificationPriority.HIGH,
  }),
  CONTEO_NO_APLICADO: d => ({
    title: 'Un conteo no se aplicó',
    message:
      d.motivo === 'DUDA_POR_REVISAR'
        ? `El conteo de ${d.productName ?? 'un producto'} no se aplicó: Shopify tiene una revisión pendiente de este producto. Resuélvela en Integraciones → Shopify → Por revisar y después vuelve a contarlo.`
        : `El conteo de ${d.productName ?? 'un producto'} no se aplicó: había un cambio en camino a Shopify. Vuelve a contarlo en unos minutos.`,
    priority: NotificationPriority.HIGH,
  }),
  // FF-I2: el barrido no vio casi nada de la tienda (la búsqueda de Shopify pudo fallar en silencio) y no dio de baja nada.
  BARRIDO_OMITIDO: d => ({
    title: 'No pudimos revisar tu catálogo de Shopify',
    message: `Shopify no nos mostró ${cuantos(d.count, 'producto', 'productos')} de tu tienda, así que esta vez no dimos de baja ninguno en Avoqado. Tus ventas y el stock se siguen sincronizando. Si los quitaste de Shopify a propósito, se darán de baja conforme Shopify nos avise de cada uno.`,
    priority: NotificationPriority.NORMAL,
  }),
}

/**
 * Aviso inmediato del conector (ajuste 12 bis.8): a OWNER y ADMIN activos de la sucursal, uno por persona y por día.
 * Recorre a la gente por tandas con cursor y deduplica cada tanda con una consulta agrupada: ni un destinatario 101 se
 * queda fuera, ni las filas repetidas de una persona esconden a otra (N8). Nunca lanza.
 *
 * ⚠️ LÍMITE DECLARADO (mismo que attendance-late-alert): el dedup consulta-luego-escribe y no es atómico; dos llamadas
 * simultáneas pueden repetir un aviso. Se acepta: el daño es una repetición, nunca una pérdida.
 */
export async function notifyShopify(venueId: string, aviso: ShopifyAviso, data: Datos = {}): Promise<void> {
  try {
    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { slug: true, timezone: true } })
    if (!venue) return
    const dia = formatInTimeZone(new Date(), venue.timezone || 'America/Mexico_City', 'yyyy-MM-dd')
    // Una duda por revisar lleva su motivo en la llave: el aviso de «en unos minutos» de la mañana no esconde que hay que
    // ir a «Por revisar». El envío en camino conserva la llave de siempre.
    const motivo = data.motivo === 'DUDA_POR_REVISAR' ? `:${data.motivo}` : ''
    const llave =
      POR_PRODUCTO.has(aviso) && data.productId ? `${aviso}:${venueId}:${data.productId}${motivo}:${dia}` : `${aviso}:${venueId}:${dia}`
    const texto = TEXTOS[aviso](data)
    let cursor: string | undefined
    for (;;) {
      const tanda = await prisma.staffVenue.findMany({
        where: { venueId, active: true, role: { in: [StaffRole.OWNER, StaffRole.ADMIN] }, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: { id: true, staffId: true },
        orderBy: { id: 'asc' },
        take: TANDA,
      })
      if (tanda.length === 0) return
      const ids = [...new Set(tanda.map(t => t.staffId))]
      const ya = await prisma.notification.groupBy({
        by: ['recipientId'],
        where: { venueId, type: NotificationType.ALERT, entityType: 'ShopifyAviso', entityId: llave, recipientId: { in: ids } },
      })
      const avisados = new Set(ya.map(n => n.recipientId))
      for (const staffId of ids) {
        if (avisados.has(staffId)) continue
        try {
          await sendNotification({
            recipientId: staffId,
            venueId,
            type: NotificationType.ALERT,
            title: texto.title,
            message: texto.message,
            actionUrl: `/venues/${venue.slug}/settings/integrations/shopify`,
            actionLabel: 'Ver Shopify',
            entityType: 'ShopifyAviso',
            entityId: llave,
            priority: texto.priority,
            channels: [NotificationChannel.IN_APP],
            metadata: { aviso, ...data },
          })
        } catch (err) {
          logger.error(`[SHOPIFY] no se pudo avisar ${aviso} a ${staffId}: ${(err as Error).message}`)
        }
      }
      if (tanda.length < TANDA) return
      cursor = tanda[tanda.length - 1].id
    }
  } catch (err) {
    logger.error(`[SHOPIFY] no se pudo avisar ${aviso} al negocio ${venueId}: ${(err as Error).message}`)
  }
}
