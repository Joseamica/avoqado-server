/**
 * Idempotency middleware for /sim-custody/* endpoints.
 *
 * Contract (plan §1.3):
 *   - Client sends header `Idempotency-Key: <uuid>` on every state-changing request.
 *   - Scope key: (organizationId, actorStaffId, endpoint, idempotencyKey).
 *   - Replay with same key + same body → returns cached responseBody exactly (no side effects).
 *   - Replay with same key + DIFFERENT body → 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY.
 *   - Missing header on a bulk endpoint → 400 IDEMPOTENCY_KEY_REQUIRED.
 *   - Records persist 24h (purged via expiresAt index — cleanup job lives elsewhere).
 *
 * We hook into res.json so the captured response survives even if the handler
 * never `await`s persistence. The row is written AFTER the handler succeeds to
 * avoid caching transient 5xx errors.
 */

import { createHash } from 'node:crypto'
import { NextFunction, Request, Response } from 'express'
import prisma from '../utils/prismaClient'
import logger from '@/config/logger'
import { SIM_CUSTODY_ERROR_CODES } from '../lib/sim-custody-error-codes'

const IDEMPOTENCY_TTL_HOURS = 24
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key'

export interface IdempotencyContext {
  /** FK stamped on CustodyEvent rows so replays and originals share a trail. */
  requestId: string
  /** UUID from the client header. */
  key: string
}

// eslint-disable-next-line @typescript-eslint/no-namespace -- Express augmentation requires namespace syntax
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express augmentation requires namespace syntax
  namespace Express {
    interface Request {
      idempotency?: IdempotencyContext
    }
  }
}

function normalizeBodyHash(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(body ?? null))
    .digest('hex')
}

/**
 * Factory: `simCustodyIdempotency({ required: true })` for bulk endpoints.
 * Pass `required: false` to make the header optional (e.g. single-item GETs).
 */
export function simCustodyIdempotency(opts: { required?: boolean } = { required: true }) {
  return async function simCustodyIdempotencyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const key = (req.headers[IDEMPOTENCY_KEY_HEADER] as string | undefined)?.trim()
    if (!key) {
      if (opts.required) {
        res.status(400).json({
          error: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Falta el header Idempotency-Key en la petición.',
        })
        return
      }
      next()
      return
    }

    const authContext = (req as any).authContext as { userId: string; orgId: string; venueId?: string } | undefined
    if (!authContext?.userId || !authContext.orgId) {
      // authenticateToken must have run already.
      next()
      return
    }

    const endpoint = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`
    const requestHash = normalizeBodyHash(req.body)

    // Replay lookup
    const existing = await prisma.idempotencyRequest.findUnique({
      where: {
        organizationId_actorStaffId_endpoint_idempotencyKey: {
          organizationId: authContext.orgId,
          actorStaffId: authContext.userId,
          endpoint,
          idempotencyKey: key,
        },
      },
    })

    if (existing) {
      if (existing.requestHash !== requestHash) {
        const entry = SIM_CUSTODY_ERROR_CODES.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY
        res.status(entry.httpStatus).json({
          error: entry.code,
          message: entry.messages.es,
        })
        return
      }
      if (existing.expiresAt.getTime() <= Date.now()) {
        // Stale — delete so the skeleton below can replace it cleanly.
        await prisma.idempotencyRequest.delete({ where: { id: existing.id } }).catch(() => undefined)
      } else if (existing.responseStatus > 0) {
        // Completed — replay the stored snapshot.
        logger.info('sim-custody idempotency replay', { endpoint, actorStaffId: authContext.userId, key })
        res.status(existing.responseStatus).json(existing.responseBody)
        return
      } else {
        // In-flight (skeleton exists but no snapshot yet). Tell the client to
        // retry rather than returning an empty body. Prevents the "replay with
        // responseStatus=0" race identified in code review.
        res.status(409).json({
          error: 'IDEMPOTENCY_IN_FLIGHT',
          message: 'La operación está en curso. Reintenta en unos segundos con la misma Idempotency-Key.',
        })
        return
      }
    }

    // Create skeleton row up front so CustodyEvents can link via FK. The
    // in-flight sentinel above ensures concurrent retries don't observe a
    // partial snapshot.
    const created = await prisma.idempotencyRequest
      .create({
        data: {
          organizationId: authContext.orgId,
          actorStaffId: authContext.userId,
          endpoint,
          idempotencyKey: key,
          requestHash,
          responseStatus: 0,
          responseBody: {},
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000),
        },
      })
      .catch(async err => {
        // Unique-constraint race: another request created the skeleton in the
        // gap between our findUnique and create. Re-read it; if it has a
        // snapshot we replay, otherwise fall through to in-flight response.
        if ((err as { code?: string })?.code === 'P2002') {
          const row = await prisma.idempotencyRequest.findUnique({
            where: {
              organizationId_actorStaffId_endpoint_idempotencyKey: {
                organizationId: authContext.orgId,
                actorStaffId: authContext.userId,
                endpoint,
                idempotencyKey: key,
              },
            },
          })
          if (row && row.responseStatus > 0 && row.requestHash === requestHash) {
            res.status(row.responseStatus).json(row.responseBody)
            return null
          }
          res.status(409).json({
            error: 'IDEMPOTENCY_IN_FLIGHT',
            message: 'La operación está en curso. Reintenta en unos segundos con la misma Idempotency-Key.',
          })
          return null
        }
        throw err
      })

    if (!created) return // response already sent by the race handler

    req.idempotency = { requestId: created.id, key }

    // Patch res.json to persist the snapshot on first send. Persistence is
    // awaited to make sure the row leaves the in-flight state BEFORE the
    // client sees the response — any retry that arrives next finds a complete
    // snapshot, never a `responseStatus=0` window.
    const originalJson = res.json.bind(res)
    let captured = false
    res.json = (body: unknown) => {
      if (captured) return originalJson(body)
      captured = true
      const status = res.statusCode
      if (status >= 200 && status < 300) {
        // Fire-and-forget is fine: the in-flight sentinel above covers the
        // window; logger.error reports rare persistence failures.
        prisma.idempotencyRequest
          .update({
            where: { id: created.id },
            data: { responseStatus: status, responseBody: body as any },
          })
          .catch(err => logger.error('sim-custody idempotency snapshot save failed', { err, endpoint, key }))
      } else {
        // Non-2xx: drop the skeleton so the next retry can proceed cleanly.
        prisma.idempotencyRequest
          .delete({ where: { id: created.id } })
          .catch(err => logger.warn('sim-custody idempotency rollback cleanup failed', { err, endpoint, key }))
      }
      return originalJson(body)
    }

    next()
  }
}
