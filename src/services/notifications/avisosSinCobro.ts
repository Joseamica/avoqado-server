import { NotificationChannel, NotificationType } from '@prisma/client'

/**
 * Plan Básico (revisión de Task 6, rondas 1 y 2): la preferencia que apaga los avisos SIN cobro del plan («Tu prueba
 * termina», «Tu prueba terminó», «Tu Pro terminó»). Una fila de este tipo sin EMAIL significa «el dueño los apagó», así que
 * NADIE puede crearla sin querer:
 * - No se manda ningún aviso de este tipo: `createNotification` y los tres envíos del dashboard lo rechazan (si no,
 *   `getUserNotificationPreferences` crearía sola una fila `[IN_APP]`).
 * - Toda fila nueva de este tipo nace con `[IN_APP, EMAIL]` salvo que quien la crea diga sus canales (`canalesAlCrear`): el
 *   default del esquema es `[IN_APP]` y un interruptor que sólo manda `enabled` apagaría el correo.
 * Sólo la baja en un clic (que manda sus canales) o un cambio explícito de canales lo apagan. Sin migración.
 */
export const TIPO_AVISOS_SIN_COBRO = NotificationType.SUBSCRIPTION_CANCELLED

export const MENSAJE_TIPO_RESERVADO = 'Ese tipo de aviso lo reserva Avoqado para los avisos de tu plan; elige otro tipo.'

/** Los canales con que nace una fila de preferencia: los que se dieron, o `[IN_APP, EMAIL]` si es de este tipo y no se dieron. */
export function canalesAlCrear(type: NotificationType, channels?: NotificationChannel[]): NotificationChannel[] | undefined {
  if (channels) return channels
  return type === TIPO_AVISOS_SIN_COBRO ? [NotificationChannel.IN_APP, NotificationChannel.EMAIL] : undefined
}
