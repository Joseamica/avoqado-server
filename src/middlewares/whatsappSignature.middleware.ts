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
