import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prismaClient'
import { BadRequestError } from '../../errors/AppError'
import crypto from 'crypto'

const router = Router()

/**
 * Partner API Key Management
 * Base path: /api/v1/superadmin/partner-keys
 *
 * All routes require SUPERADMIN role (enforced by parent router middleware)
 */

/**
 * POST /
 * Body: { organizationId, name, sandboxMode? }
 *
 * Generates a new partner API key for an organization.
 * Returns the secret key ONCE — it cannot be retrieved again.
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { organizationId, name, sandboxMode = true } = req.body

    if (!organizationId || !name) {
      throw new BadRequestError('organizationId and name are required')
    }

    // Verify org exists
    const org = await prisma.organization.findUnique({ where: { id: organizationId } })
    if (!org) {
      throw new BadRequestError('Organization not found')
    }

    // Generate key using same pattern as EcommerceMerchant
    const mode = sandboxMode ? 'test' : 'live'
    const randomPart = crypto.randomBytes(32).toString('hex')
    const secretKey = `sk_${mode}_${randomPart}`
    const secretKeyHash = crypto.createHash('sha256').update(secretKey).digest('hex')

    const partnerKey = await prisma.partnerAPIKey.create({
      data: {
        organizationId,
        name,
        secretKeyHash,
        sandboxMode,
        createdById: req.authContext?.userId,
      },
    })

    // Return secret key ONCE — it cannot be retrieved again
    res.status(201).json({
      success: true,
      data: {
        id: partnerKey.id,
        name: partnerKey.name,
        secretKey, // Show only once
        sandboxMode,
        message: 'Store this key securely. It cannot be retrieved again.',
      },
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /
 * Query: { organizationId? }
 *
 * List partner API keys (without the secret).
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { organizationId } = req.query
    const where = organizationId ? { organizationId: organizationId as string } : {}

    const keys = await prisma.partnerAPIKey.findMany({
      where,
      select: {
        id: true,
        name: true,
        organizationId: true,
        organization: { select: { name: true } },
        sandboxMode: true,
        active: true,
        lastUsedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    res.json({ success: true, data: keys })
  } catch (error) {
    next(error)
  }
})

/**
 * DELETE /:id
 * Deactivate (soft-delete) a partner API key.
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await prisma.partnerAPIKey.update({
      where: { id: req.params.id },
      data: { active: false },
    })
    res.json({ success: true, message: 'Partner API key deactivated' })
  } catch (error) {
    next(error)
  }
})

export default router
