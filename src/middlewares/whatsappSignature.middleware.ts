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

// Runs BEFORE the POST body is read (the route takes up to 5 MB for coexistence history): without a well-formed signature
// header it leaves with 403 unread. Stateless on purpose — a concurrency counter took three audit rounds and kept leaking;
// 5 MB is already the server-wide cap for any unsigned body (BODY_URLENCODED_LIMIT), so this route adds no new exposure.
export function requireWhatsappSignatureHeader(req: Request, res: Response, next: NextFunction) {
  if (!SIGNATURE_FORMAT.test(req.header('X-Hub-Signature-256') ?? '')) return res.sendStatus(403)
  next()
}
