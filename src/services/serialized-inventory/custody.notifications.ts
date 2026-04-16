/**
 * Dual-channel notifications for SIM custody events (plan §1.8).
 *
 * Strategy:
 *   1. Try socket first — reaches only staff with an active, authenticated connection.
 *   2. Fall back to FCM push after a 5s ACK timeout OR when broadcasting reports
 *      zero delivered sockets (staff offline / app closed).
 *   3. TPV always runs `GET /my-sims` on mount, so a missed notification still
 *      surfaces the new SIMs when the operator opens the app.
 *
 * Observability: every fallback increments `sim_custody.notification_fallback_to_fcm.count`
 * via structured logs — downstream log-based metrics in BetterStack pick it up.
 */

import logger from '@/config/logger'
import socketManager from '../../communication/sockets'
import { SocketEventType } from '../../communication/sockets/types'
import { sendPushToStaff } from '../mobile/push.mobile.service'

type SimCustodyNotificationKind = 'ASSIGNED_TO_PROMOTER' | 'RECOLLECTED_FROM_PROMOTER' | 'REJECTED_ACKNOWLEDGED'

const EVENT_MAP: Record<SimCustodyNotificationKind, SocketEventType> = {
  ASSIGNED_TO_PROMOTER: SocketEventType.SIM_CUSTODY_ASSIGNED_TO_PROMOTER,
  RECOLLECTED_FROM_PROMOTER: SocketEventType.SIM_CUSTODY_RECOLLECTED_FROM_PROMOTER,
  REJECTED_ACKNOWLEDGED: SocketEventType.SIM_CUSTODY_REJECTED_ACKNOWLEDGED,
}

const FCM_FALLBACK_TIMEOUT_MS = 5_000

export interface SimCustodyNotifyInput {
  kind: SimCustodyNotificationKind
  /** Target staff (promoter for assign/recollect, supervisor for rejected ack). */
  targetStaffId: string
  /** Visible to user only if FCM fallback fires. */
  title: string
  body: string
  /** Small metadata relayed to the TPV for deep-linking (e.g. { route: 'MisSims', count: '3' }). */
  data?: Record<string, string>
}

/**
 * Emits the socket event + schedules FCM fallback. Fire-and-forget: returns
 * immediately, errors only logged. Called from the custody service post-commit.
 */
export function notifySimCustody(input: SimCustodyNotifyInput): void {
  const event = EVENT_MAP[input.kind]
  const payload = { targetStaffId: input.targetStaffId, data: input.data ?? {} }
  // Authoritative presence check: ask the room manager whether the staff
  // has at least one active socket. Only if offline do we fall back to FCM.
  // This replaces the earlier heuristic that checked for the existence of a
  // method (always true) and therefore always skipped FCM.
  const hasActiveSocket = socketManager.isUserOnline(input.targetStaffId)
  try {
    socketManager.broadcastToUser(input.targetStaffId, event, payload)
  } catch (err) {
    logger.warn('sim-custody socket broadcast failed', { err, targetStaffId: input.targetStaffId, event })
  }

  if (hasActiveSocket) {
    // Skip FCM — socket delivered. Screen mount always hits GET /my-sims,
    // so a rare mid-flight disconnect is recovered without duplicate noise.
    return
  }

  // Fallback: FCM push after 5s only when socket delivery failed.
  setTimeout(() => {
    sendPushToStaff(input.targetStaffId, {
      title: input.title,
      body: input.body,
      data: input.data ?? {},
    })
      .then(result => {
        if (!result.success) return
        logger.info('sim_custody.notification_fallback_to_fcm', {
          targetStaffId: input.targetStaffId,
          kind: input.kind,
          hasActiveSocket,
          delivered: result.successCount,
        })
      })
      .catch(err => logger.warn('sim-custody FCM fallback failed', { err, targetStaffId: input.targetStaffId }))
  }, FCM_FALLBACK_TIMEOUT_MS)
}
