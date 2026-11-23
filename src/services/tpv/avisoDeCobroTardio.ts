/**
 * «Apareció el cobro de una venta que dabas por no cobrada» — el aviso AL CAJERO (plan 18-sep, Task 7).
 *
 * 🔴 El hueco que cierra: el tratamiento de la aprobación tardía ya detectaba este caso, pero lo único que hacía
 * era `sendOpsAlert`, o sea un correo a operaciones. La persona que puede cobrar de nuevo por error —el cajero que
 * declaró— no se enteraba de nada. El mockup que aprobó el founder dibuja exactamente esta pantalla.
 *
 * Va dirigido a QUIEN DECLARÓ, no al venue entero: es su declaración la que el dinero acaba de contradecir, y es
 * quien tiene al cliente enfrente.
 *
 * 🔴 Decisión de compatibilidad, no de estilo: NO se agrega un valor a `NotificationType`. El decoder estricto de
 * iOS tira el arreglo ENTERO al toparse un tipo desconocido (la lección de los conteos cancelados, 7-sep), así que
 * estrenar uno dejaría sin buzón a las apps ya publicadas. Se reusa `PAYMENT_RECEIVED`, que además es literal: un
 * pago entró.
 */
import { NotificationPriority, NotificationType, OrgRole, StaffRole } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import socketManager from '../../communication/sockets'
import { readUnchargedReconciliation } from './uncharged-reconciliation.service'

/**
 * Fire-and-forget: NUNCA lanza y NUNCA corre dentro de la transacción del dinero. Un aviso que falla no puede
 * deshacer el registro de un cobro — ésa es la misma regla que `logAction`.
 */
export async function avisarCobroTardioAlCajero(ctx: {
  requestId: string
  venueId: string
  paymentId: string
  terminalId: string | null
  orderId: string | null
}): Promise<void> {
  try {
    const row = await prisma.terminalPaymentRequest.findFirst({
      where: { requestId: ctx.requestId, venueId: ctx.venueId },
      // El id y el importe se leen de la MISMA fila: así el sitio que engancha esto sólo pasa lo que ya tiene.
      select: { id: true, amountCents: true, operatorReconciliation: true },
    })
    // Sólo este caso: la declaración del CAJERO. La de gerencia («no se presentó tarjeta») tiene su propio
    // tratamiento, y una liberación por ventana no tiene a quién avisarle en particular.
    const declaracion = readUnchargedReconciliation(row?.operatorReconciliation)
    if (!declaracion?.staffId) return

    // 🔴 P2 de Codex (18-sep): el importe es el REGISTRADO, no el solicitado. La solicitud del incidente
    // decía $65.00 y el banco aprobó $74.75 con la propina: decir «el banco aprobó $65.00» miente sobre
    // dinero, y es justo el número con el que el cajero decide si cobra otra vez. Si no se puede leer el
    // pago no se inventa ninguno: se omite el importe.
    const pago = await prisma.payment.findFirst({
      where: { id: ctx.paymentId, venueId: ctx.venueId },
      select: { amount: true, tipAmount: true },
    })
    const totalRegistrado = pago ? Number(pago.amount) + Number(pago.tipAmount ?? 0) : null
    const importe = totalRegistrado === null ? null : totalRegistrado.toFixed(2)
    const notificacion = await prisma.notification.create({
      data: {
        recipientId: declaracion.staffId,
        venueId: ctx.venueId,
        type: NotificationType.PAYMENT_RECEIVED,
        priority: NotificationPriority.HIGH,
        title: 'Apareció el cobro de una venta anterior',
        message:
          (importe === null
            ? 'El banco aprobó un cobro de una venta que habías dado por no cobrada. '
            : `El banco aprobó $${importe} de una venta que habías dado por no cobrada. `) +
          'Avoqado ya lo registró: no lo cobres otra vez.',
        entityType: 'TerminalPaymentRequest',
        entityId: row?.id ?? null,
        metadata: {
          requestId: ctx.requestId,
          paymentId: ctx.paymentId,
          terminalId: ctx.terminalId,
          orderId: ctx.orderId,
          resolutionId: declaracion.id,
        },
      },
    })
    // 🔴 Guardar no es avisar: un buzón que nadie abre no le dice nada al cajero que está por cobrar otra vez.
    // Se emite EN VIVO por el mismo canal que el resto de las notificaciones.
    //
    // 🔴 Y por eso NO se usa `createNotification` del dashboard, que sí emitiría: esa función LANZA si el
    // usuario tiene el tipo deshabilitado o está en horas de silencio. Un aviso de DINERO no se puede poder
    // silenciar — es la misma regla de los anuncios: la fila siempre existe, sólo la entrega respeta preferencias.
    try {
      socketManager.getBroadcastingService()?.broadcastNewNotification({
        notificationId: notificacion.id,
        recipientId: notificacion.recipientId,
        venueId: notificacion.venueId || '',
        userId: notificacion.recipientId,
        type: notificacion.type,
        title: notificacion.title,
        message: notificacion.message,
        priority: 'HIGH',
        isRead: false,
        metadata: (notificacion.metadata as Record<string, unknown>) || undefined,
      })
    } catch (err) {
      // La fila ya está guardada: el cajero la verá al abrir el buzón aunque el socket esté caído.
      logger.warn('⚠️ [TerminalPayment] el aviso quedó GUARDADO pero no se pudo emitir en vivo', {
        requestId: ctx.requestId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    logger.warn('🧾 [TerminalPayment] cobro tardío sobre una declaración del cajero — avisado en el aparato', {
      requestId: ctx.requestId,
      venueId: ctx.venueId,
      staffId: declaracion.staffId,
      paymentId: ctx.paymentId,
    })
  } catch (err) {
    logger.warn('⚠️ [TerminalPayment] no se pudo avisar al cajero del cobro tardío — el dinero SÍ quedó registrado', {
      requestId: ctx.requestId,
      venueId: ctx.venueId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Cómo se devuelve un cobro de más, por procesador (diseño §6; Norman 19-nov para AngelPay; Blumon pide la tarjeta presente). */
export function comoDevolverlo(procesador: 'ANGELPAY' | 'BLUMON' | null): string {
  if (procesador === 'ANGELPAY')
    return 'Para devolverlo: cancélalo desde la terminal el mismo día antes de las 22:59; después, hazle una devolución desde la terminal o con soporte de AngelPay.'
  if (procesador === 'BLUMON')
    return 'Para devolverlo: hazle una devolución desde la terminal con la tarjeta del cliente; si no se puede, devuélvelo en efectivo.'
  return 'Para devolverlo: hazle una devolución desde la terminal o devuélvelo en efectivo.'
}

/**
 * Cobro simple · S1.6 (22-nov): «el banco aprobó tarde un cobro que se había dado por no cobrado» — el aviso al DUEÑO y a los
 * GERENTES del negocio (no al cajero: desde S1 nadie declara; lo que pudo pasar es que la cajera cobrara otra vez, y quien devuelve
 * es el negocio). Campanita (`PAYMENT_RECEIVED`, el tipo que ya existe: iOS tira el arreglo con un tipo nuevo), en vivo, y correo.
 * Un aviso de DINERO no se silencia: la fila siempre se crea. Fire-and-forget: NUNCA lanza ni corre dentro de la transacción.
 */
export async function avisarAprobadoTardio(ctx: {
  venueId: string
  orderId: string | null
  orderNumber?: string | null
  paymentId: string
  montoPesos: number
  procesador: 'ANGELPAY' | 'BLUMON' | null
  /** Otros cobros con tarjeta del MISMO importe en el negocio desde el «no cobrado» (la cuenta pudo cobrarse en otra). */
  cobrosMismoImporte: { orderNumber: string; at: Date }[]
  requestId?: string | null
}): Promise<void> {
  try {
    const destinatarios = await duenosYGerentes(ctx.venueId)
    if (destinatarios.length === 0) return
    const monto = '$' + ctx.montoPesos.toFixed(2)
    const cuenta = ctx.orderNumber ? ` de la cuenta ${ctx.orderNumber}` : ''
    const otros = ctx.cobrosMismoImporte.length
      ? ` Cobros de ${monto} con tarjeta desde entonces: ${ctx.cobrosMismoImporte.map(c => c.orderNumber).join(', ')}.`
      : ''
    const title = 'El banco aprobó tarde un cobro'
    const message =
      `El banco aprobó tarde un cobro de ${monto}${cuenta} que se había dado por no cobrado. Ya quedó registrado. ` +
      `Si el cliente pagó otra vez, devuélvele ${monto}.${otros} ${comoDevolverlo(ctx.procesador)}`
    for (const d of destinatarios) {
      const notificacion = await prisma.notification.create({
        data: {
          recipientId: d.staffId,
          venueId: ctx.venueId,
          type: NotificationType.PAYMENT_RECEIVED,
          priority: NotificationPriority.HIGH,
          title,
          message,
          entityType: 'Payment',
          entityId: ctx.paymentId,
          metadata: { paymentId: ctx.paymentId, orderId: ctx.orderId, requestId: ctx.requestId ?? null, cobroTardio: true },
        },
      })
      try {
        socketManager.getBroadcastingService()?.broadcastNewNotification({
          notificationId: notificacion.id,
          recipientId: notificacion.recipientId,
          venueId: ctx.venueId,
          userId: notificacion.recipientId,
          type: notificacion.type,
          title,
          message,
          priority: 'HIGH',
          isRead: false,
          metadata: (notificacion.metadata as Record<string, unknown>) || undefined,
        })
      } catch {
        // La fila ya está guardada: la verá al abrir el buzón.
      }
      if (d.email) {
        const { sendNotificationEmail } = await import('../resend.service')
        await sendNotificationEmail(d.email, `${title}: ${monto}`, title, message).catch(() => false)
      }
    }
    logger.warn('🧾 [TerminalPayment] aprobado tardío — avisado al dueño y a los gerentes', {
      venueId: ctx.venueId,
      paymentId: ctx.paymentId,
      destinatarios: destinatarios.length,
    })
  } catch (err) {
    logger.warn('⚠️ [TerminalPayment] no se pudo avisar al dueño del aprobado tardío — el dinero SÍ quedó registrado', {
      venueId: ctx.venueId,
      paymentId: ctx.paymentId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Dueños, administradores y gerentes activos de la sucursal, más los dueños de la organización. Nunca el cajero. Con tope. */
async function duenosYGerentes(venueId: string): Promise<{ staffId: string; email: string | null }[]> {
  const deLaSucursal = await prisma.staffVenue.findMany({
    where: { venueId, active: true, role: { in: [StaffRole.OWNER, StaffRole.ADMIN, StaffRole.MANAGER] }, staff: { active: true } },
    select: { staffId: true, staff: { select: { email: true } } },
    orderBy: { staffId: 'asc' },
    take: 50,
  })
  const deLaOrganizacion = await prisma.staffOrganization.findMany({
    where: { role: OrgRole.OWNER, isActive: true, staff: { active: true }, organization: { venues: { some: { id: venueId } } } },
    select: { staffId: true, staff: { select: { email: true } } },
    orderBy: { staffId: 'asc' },
    take: 50,
  })
  const porPersona = new Map<string, string | null>()
  for (const f of [...deLaSucursal, ...deLaOrganizacion]) porPersona.set(f.staffId, f.staff.email ?? null)
  return [...porPersona].map(([staffId, email]) => ({ staffId, email }))
}

/**
 * Lo que arma el aviso a partir de la SOLICITUD que se reabrió (la llama `avisarAprobacionTardiaTrasVentana` tras el commit): el
 * importe REGISTRADO (con propina), el procesador de la cuenta del cobro y los cobros con tarjeta del mismo importe desde el
 * «no cobrado» (Review Focus 5). Nunca lanza.
 */
export async function avisarAprobadoTardioDeLaSolicitud(ctx: {
  requestId: string
  venueId: string
  paymentId: string
  orderId: string | null
  /** Desde cuándo se dio por no cobrado. */
  desde: Date | null
}): Promise<void> {
  try {
    const pago = await prisma.payment.findFirst({
      where: { id: ctx.paymentId, venueId: ctx.venueId },
      select: {
        amount: true,
        tipAmount: true,
        order: { select: { orderNumber: true } },
        merchantAccount: { select: { provider: { select: { code: true } } } },
      },
    })
    if (!pago) return
    const codigo = pago.merchantAccount?.provider.code ?? null
    const total = pago.amount.add(pago.tipAmount ?? 0)
    // Codex S1 r1 #4: el mismo TOTAL (venta + propina), no sólo la venta. Acotado: los primeros 50 cobros con tarjeta desde el «no
    // cobrado»; de ésos, los del mismo total (a lo más 10 en el texto).
    const mismos = ctx.desde
      ? (
          await prisma.payment.findMany({
            where: {
              venueId: ctx.venueId,
              id: { not: ctx.paymentId },
              status: 'COMPLETED',
              method: { in: ['CREDIT_CARD', 'DEBIT_CARD'] },
              createdAt: { gte: ctx.desde },
              OR: [{ type: null }, { type: { not: 'REFUND' } }],
            },
            select: { createdAt: true, amount: true, tipAmount: true, order: { select: { orderNumber: true } } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: 50,
          })
        )
          .filter(m => m.amount.add(m.tipAmount ?? 0).equals(total))
          .slice(0, 10)
      : []
    await avisarAprobadoTardio({
      venueId: ctx.venueId,
      orderId: ctx.orderId,
      orderNumber: pago.order?.orderNumber ?? null,
      paymentId: ctx.paymentId,
      montoPesos: Number(pago.amount) + Number(pago.tipAmount ?? 0),
      procesador: codigo === 'ANGELPAY' || codigo === 'BLUMON' ? codigo : null,
      cobrosMismoImporte: mismos.map(m => ({ orderNumber: m.order?.orderNumber ?? 'sin número', at: m.createdAt })),
      requestId: ctx.requestId,
    })
  } catch (err) {
    logger.warn('⚠️ [TerminalPayment] no se pudo armar el aviso del aprobado tardío', {
      requestId: ctx.requestId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
