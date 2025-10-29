/**
 * Demo Routes (Legacy QR Code Redirects)
 *
 * Redirects for obsolete QR codes printed on merchandise
 * These endpoints no longer exist but need to redirect to prevent 404s
 */

import { Router, Request, Response } from 'express'

const router = Router()

/**
 * @swagger
 * /api/v1/demo/generate:
 *   get:
 *     summary: Legacy QR redirect
 *     description: Redirects obsolete merchandise QR codes to the links hub page
 *     tags:
 *       - Demo
 *     responses:
 *       301:
 *         description: Permanent redirect to links.avoqado.io
 */
router.get('/generate', (req: Request, res: Response) => {
  // Permanent redirect (301) tells browsers/crawlers this is the new location
  res.redirect(301, 'https://links.avoqado.io/')
})

export default router
