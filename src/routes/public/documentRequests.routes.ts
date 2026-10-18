import { Router, Request } from 'express'
import multer from 'multer'
import cors from 'cors'
import { preserveContext } from '../../observability/preserveContext'
import rateLimit from 'express-rate-limit'
import * as service from '../../services/document-requests/documentRequests.service'
import { LIMITS } from '../../services/document-requests/policy'
import { BadRequestError, TooManyRequestsError } from '../../errors/AppError'

const router = Router()
router.use(
  cors({
    origin: '*',
    credentials: false,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Document-Token'],
  }),
)
const token = (req: Request) => req.get('X-Document-Token') || ''
const limiter = rateLimit({
  windowMs: 60000,
  max: 180,
  keyGenerator: req => req.socket.remoteAddress || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  validate: { ip: false, xForwardedForHeader: false },
})
router.use((_req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' })
  next()
})
router.use(limiter)
let concurrent = 0
const multipart = preserveContext(
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: LIMITS.maxFileBytes, files: 1, fields: 1, parts: 3, fieldSize: 64, fieldNameSize: 64 },
  }).single('file'),
)
router.get('/:id', async (req, res) => {
  res.json(await service.getPublicRequest(req.params.id, token(req)))
})
router.post('/:id/documents/:key', async (req, res, next) => {
  if (concurrent >= 4) throw new TooManyRequestsError('Hay varias cargas en curso; reintenta en un momento')
  concurrent++
  let admission: service.UploadAdmission | undefined
  let releasePromise: Promise<void> | undefined
  let writing = false
  const timeout = setTimeout(() => req.destroy(), 120000)
  timeout.unref()
  const release = () => {
    if (!releasePromise)
      releasePromise = (async () => {
        clearTimeout(timeout)
        try {
          if (admission) await service.releaseUpload(req.params.id, admission)
        } finally {
          concurrent--
        }
      })()
    return releasePromise
  }
  res.once('close', () => {
    if (!writing) void release().catch(() => {})
  })
  try {
    admission = await service.admitUpload(req.params.id, token(req))
    if (res.destroyed) {
      await service.releaseUpload(req.params.id, admission)
      await release()
      return
    }
    req.setTimeout(120000, () => req.destroy())
    multipart(req, res, async error => {
      try {
        if (error) throw new BadRequestError('La carga excede los límites permitidos')
        if (!req.file || typeof req.body.uploadId !== 'string') throw new BadRequestError('Falta el archivo o identificador de carga')
        writing = true
        const result = await service.uploadDocument(req.params.id, token(req), req.params.key, req.body.uploadId, req.file, admission!)
        await release()
        res.status(201).json(result)
      } catch (error) {
        await release().catch(() => {})
        next(error)
      }
    })
  } catch (error) {
    await release().catch(() => {})
    next(error)
  }
})
router.delete('/:id/documents/:documentId', async (req, res) => {
  res.json(await service.deleteDocument(req.params.id, token(req), req.params.documentId))
})
router.delete('/:id/uploads/:uploadId', async (req, res) => {
  res.json(await service.discardUpload(req.params.id, token(req), req.params.uploadId))
})
router.post('/:id/submit', async (req, res) => {
  res.json(await service.submitRequest(req.params.id, token(req), req.body))
})
export default router
