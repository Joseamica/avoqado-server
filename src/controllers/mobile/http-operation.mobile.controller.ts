import type { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { BadRequestError, UnauthorizedError } from '@/errors/AppError'
import {
  manifestSchema,
  resolveHttpOperation,
  type HttpOperation,
  type OperationReply,
} from '@/services/mobile/http-operation.mobile.service'

const resolveSchema = z.object({ version: z.literal(1), deviceId: z.string().uuid(), manifest: manifestSchema }).strict()

export async function resolveOperation(req: Request, res: Response, next: NextFunction) {
  try {
    const actorId = (req as any).authContext?.userId as string | undefined
    if (!actorId) throw new UnauthorizedError('Autenticación requerida')
    const parsed = resolveSchema.safeParse(req.body)
    const id = z.string().uuid().safeParse(req.params.operationId)
    if (!parsed.success || !id.success) throw new BadRequestError('Manifiesto de operación inválido', 'HTTP_OPERATION_INVALID')
    const operation = { version: 1 as const, id: id.data.toLowerCase(), deviceId: parsed.data.deviceId.toLowerCase() }
    const reply = await resolveHttpOperation({ venueId: req.params.venueId, actorId, operation, manifest: parsed.data.manifest })
    if (reply.kind === 'RETRY') return res.status(503).json({ success: false, outcome: 'RETRY', code: reply.code })
    return res.status(200).json({
      success: true,
      httpOperation: { ...operation, outcome: reply.envelope.outcome },
      receipt: reply.envelope,
      resolvedByStaffId: actorId,
    })
  } catch (error) {
    next(error)
  }
}

export function sendHttpOperationReply(res: Response, operation: HttpOperation, reply: OperationReply): Response {
  if (reply.kind === 'RETRY')
    return res.status(503).json({ success: false, code: reply.code, httpOperation: { ...operation, outcome: 'RETRY' } })
  const e = reply.envelope,
    httpOperation = { ...operation, outcome: e.outcome }
  if (e.outcome === 'REJECTED')
    return res.status(e.rejection.status).json({ success: false, code: e.rejection.code, message: e.rejection.message, httpOperation })
  return res.status(e.originalResponse.status).json({ ...e.originalResponse.body, httpOperation })
}
