/**
 * Multer breaks the execution context, and it does it silently.
 *
 * Measured in production (2026-08-12): of 139 requests in one 15-minute window, exactly 2
 * carried no `source` and no `entrypoint` — both of them KYC document uploads. The service
 * that failed logged `Failed to upload KYC document ... for venue cms1qzg6o02jxi32bkm2ta66g`
 * with no tenant attached at all, so the alert could not say which business it was.
 *
 * The cause is that multer resumes the request from the body stream, whose async resource
 * predates the context the request logger opened — so `next()` runs outside it and every
 * `logger.*` below loses the venue. Every other middleware in the codebase preserves it;
 * this is specific to consuming the request stream.
 *
 * `preserveContext` re-enters the captured context when the wrapped middleware hands control
 * back. It is generic on purpose: any future middleware that consumes the body has the same
 * problem, and the guardrail test at the bottom makes forgetting it impossible rather than
 * merely detectable.
 */

import express from 'express'
import multer from 'multer'
import request from 'supertest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { requestLoggerMiddleware } from '@/middlewares/requestLogger'
import { enrichContext, getContext } from '@/observability/executionContext'
import { preserveContext } from '@/observability/preserveContext'
import { contextFormat } from '@/observability/logContext'
import { getVenueName, primeVenueNames } from '@/observability/venueNames'
import prisma from '@/utils/prismaClient'

const prismaMock = prisma as unknown as { venue: { findMany: jest.Mock } }

const buildApp = (uploadMiddleware: express.RequestHandler) => {
  const app = express()
  app.use(requestLoggerMiddleware)
  app.put('/upload', uploadMiddleware, (_req, res) => {
    const ctx = getContext()
    res.json({ entrypoint: ctx?.entrypoint ?? null, source: ctx?.source ?? null })
  })
  return app
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } })

const putFile = (app: express.Express) =>
  request(app).put('/upload').attach('file', Buffer.from('%PDF-1.4 fake'), { filename: 'x.pdf', contentType: 'application/pdf' })

describe('🔴 execution context across a multipart upload', () => {
  it('reproduces the production bug: raw multer loses the context', async () => {
    // This is the failing behaviour, pinned so nobody "simplifies" the wrapper away later.
    const response = await putFile(buildApp(upload.single('file')))
    expect(response.body.entrypoint).toBeNull()
  })

  it('preserveContext keeps the tenant thread alive through the upload', async () => {
    const response = await putFile(buildApp(preserveContext(upload.single('file'))))

    expect(response.body.entrypoint).toBe('PUT /upload')
    expect(response.body.source).toBe('http')
  })

  it('does not swallow the error a middleware reports — the wrapper is transparent', async () => {
    const boom = new Error('archivo demasiado grande')
    const failing: express.RequestHandler = (_req, _res, next) => next(boom)

    const app = express()
    app.use(requestLoggerMiddleware)
    app.put('/upload', preserveContext(failing), (_req, res) => res.json({ reached: true }))
    app.use(((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      // The context must still be readable here — that is the whole point for error paths.
      res.status(500).json({ message: err.message, entrypoint: getContext()?.entrypoint ?? null })
    }) as express.ErrorRequestHandler)

    const response = await request(app).put('/upload').send()

    expect(response.body.message).toBe('archivo demasiado grande')
    expect(response.body.entrypoint).toBe('PUT /upload')
  })

  it('is a no-op when there is no context to restore, instead of inventing one', async () => {
    const app = express() // no requestLogger mounted
    app.put('/upload', preserveContext(upload.single('file')), (_req, res) => res.json({ ctx: getContext() ?? null }))

    const response = await putFile(app)

    expect(response.status).toBe(200)
    expect(response.body.ctx).toBeNull()
  })
})

describe('🔴 the production scenario, end to end', () => {
  /**
   * Reconstructs the exact log line that started this: a KYC upload that fails with 400,
   * three layers deep in a service. It used to arrive with no tenant at all; the reader had
   * to guess. Now it names the business.
   */
  it('a failed upload logs the venue NAME, all the way from the service', async () => {
    prismaMock.venue.findMany.mockResolvedValue([{ id: 'cms1qzg6o02jxi32bkm2ta66g', name: 'Testarudo Cafe' }])
    await primeVenueNames()

    const app = express()
    app.use(requestLoggerMiddleware)
    app.put(
      '/api/v1/dashboard/venues/:venueId/kyc/document/:key',
      // Stands in for authenticateTokenMiddleware.
      (req, _res, next) => {
        enrichContext({ venueId: req.params.venueId, venueName: getVenueName(req.params.venueId) })
        next()
      },
      preserveContext(upload.single('file')),
      (_req, res) => {
        // Stands in for venueKyc.service throwing "Cannot upload documents".
        res.status(400).json(contextFormat().transform({ level: 'error', message: 'Failed to upload KYC document' } as never))
      },
    )

    const response = await request(app)
      .put('/api/v1/dashboard/venues/cms1qzg6o02jxi32bkm2ta66g/kyc/document/comprobanteDomicilioUrl')
      .attach('file', Buffer.from('%PDF-1.4 fake'), { filename: 'x.pdf', contentType: 'application/pdf' })

    expect(response.body).toMatchObject({
      message: 'Failed to upload KYC document',
      venueName: 'Testarudo Cafe',
      venueId: 'cms1qzg6o02jxi32bkm2ta66g',
      source: 'http',
      entrypoint: 'PUT /api/v1/dashboard/venues/:id/kyc/document/:id',
    })
  })
})

describe('🔴 guardrail: every multer middleware is wrapped', () => {
  /** Walks src/ collecting .ts files, so a new upload route cannot slip past this test. */
  const collectSourceFiles = (dir: string, found: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) collectSourceFiles(full, found)
      else if (full.endsWith('.ts')) found.push(full)
    }
    return found
  }

  it('no route calls .single/.array/.fields/.any outside preserveContext', () => {
    const offenders: string[] = []
    // Whitespace is collapsed first so a wrapper split across lines still reads as one
    // expression — `preserveContext(\n  documentUpload.fields([...])\n)` is correctly wrapped.
    const handlerCall = /(.{0,20})\b(\w*[Uu]pload\w*)\.(single|array|fields|any)\(/g

    for (const file of collectSourceFiles(join(process.cwd(), 'src'))) {
      const contents = readFileSync(file, 'utf8')
      if (!contents.includes('multer')) continue

      const flattened = contents.replace(/\s+/g, ' ')
      for (const [, before, instance, method] of flattened.matchAll(handlerCall)) {
        if (!before.includes('preserveContext(')) {
          offenders.push(`${file.replace(process.cwd() + '/', '')} → ${instance}.${method}(`)
        }
      }
    }

    // An unwrapped upload silently strips the venue from every log line below it.
    expect(offenders).toEqual([])
  })
})
