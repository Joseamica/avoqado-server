import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { createCommercialAcquisitionContext } from '@/controllers/public/commercial.public.controller'
import { validateRequest } from '@/middlewares/validation'
import { commercialAcquisitionContextRequestSchema } from '@/schemas/commercialQuote.schema'
import prisma from '@/utils/prismaClient'

async function main(): Promise<void> {
  const claim = process.env.Q3B_ROUTE_CLAIM
  if (!claim) throw new Error('Q3B_ROUTE_CLAIM_REQUIRED')

  const app = express()
  app.use(express.json())
  app.post(
    '/acquisition-context',
    validateRequest(commercialAcquisitionContextRequestSchema),
    createCommercialAcquisitionContext,
  )
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const normalized = error as { statusCode?: unknown; code?: unknown }
    const statusCode = typeof normalized.statusCode === 'number' ? normalized.statusCode : 500
    res.status(statusCode).json({ code: typeof normalized.code === 'string' ? normalized.code : 'INTERNAL_ERROR' })
  })

  const before = await prisma.commercialAcquisitionContext.count()
  const response = await request(app).post('/acquisition-context').send({ campaignClaim: claim, utmSource: 'q3b-route-wall' })
  const after = await prisma.commercialAcquisitionContext.count()
  process.stdout.write(`${JSON.stringify({ status: response.status, body: response.body, before, after })}\n`)
}

main()
  .catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
