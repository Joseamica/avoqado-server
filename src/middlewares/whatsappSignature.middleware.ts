import { createHmac, timingSafeEqual } from 'crypto'

import { NextFunction, Request, Response } from 'express'

import { getWhatsappAppSecret } from '@/config/whatsappCloud'

// Verify Meta's X-Hub-Signature-256 HMAC against the raw request body.
// Mounts AFTER express.raw({ type: 'application/json' }) — body must be a
// Buffer (not parsed JSON), otherwise the signature won't match what Meta
// computed on its end. Per spec §POST /api/v1/webhooks/whatsapp.
export function verifyWhatsappSignature(req: Request, res: Response, next: NextFunction) {
  const sig = req.header('X-Hub-Signature-256')
  if (!sig) return res.sendStatus(403)
  if (!Buffer.isBuffer(req.body)) return res.sendStatus(403)

  const expected = 'sha256=' + createHmac('sha256', getWhatsappAppSecret()).update(req.body).digest('hex')
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length) return res.sendStatus(403)
  if (!timingSafeEqual(sigBuf, expBuf)) return res.sendStatus(403)

  next()
}

const SIGNATURE_FORMAT = /^sha256=[0-9a-f]{64}$/
const SMALL_BODY_BYTES = 100 * 1024
let bigBodiesInFlight = 0

// Runs BEFORE the POST body is read. The route accepts 20 MB (a coexistence history delivery «could describe thousands of
// messages»), so anything without a well-formed signature leaves with 403 unread, and only ONE big, unsized or compressed
// body (2 KB of gzip can inflate to 2 MB) is in flight at a time; the next one gets 503 and Meta retries it. Normal
// messages are small and never wait. The controller holds the slot until it has stored everything, even if Meta hangs up
// mid-store; when the controller never ran (aborted upload, 413, bad signature) closing the response frees it.
// ponytail: in-process counter — fine for our single Render instance; a second instance would need a shared gate.
export function gateWhatsappBody(req: Request, res: Response, next: NextFunction) {
  if (!SIGNATURE_FORMAT.test(req.header('X-Hub-Signature-256') ?? '')) return res.sendStatus(403)
  const length = Number(req.header('content-length'))
  const compressed = (req.header('content-encoding') ?? 'identity').toLowerCase() !== 'identity'
  if (!compressed && length > 0 && length <= SMALL_BODY_BYTES) return next()
  if (bigBodiesInFlight >= 1) return res.sendStatus(503)
  bigBodiesInFlight++
  let held = true
  res.locals.releaseWhatsappBody = () => {
    if (held) bigBodiesInFlight--
    held = false
  }
  res.once('close', () => {
    if (!res.locals.whatsappHandling) res.locals.releaseWhatsappBody()
  })
  next()
}
