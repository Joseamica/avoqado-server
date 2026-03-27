import { Router } from 'express'
import { Request, Response } from 'express'
import * as settlementReportService from '../services/settlement-report.service'

const router = Router()

/**
 * GET /reports/settlement/:token
 * Public route - validates by token, returns JSON data
 * Query params: ?from=2026-03-01&to=2026-03-27
 */
router.get('/:token', async (req: Request, res: Response) => {
  try {
    const aggregator = await settlementReportService.validateReportToken(req.params.token)
    if (!aggregator || !aggregator.active) {
      return res.status(404).json({ error: 'Not found' })
    }

    const from = (req.query.from as string) || new Date().toISOString().slice(0, 10)
    const to = (req.query.to as string) || from

    const [layer1, layer2] = await Promise.all([
      settlementReportService.getLayer1Report(aggregator.id, from, to),
      settlementReportService.getLayer2Report(aggregator.id, from, to),
    ])

    res.json({
      success: true,
      data: {
        aggregator: { id: aggregator.id, name: aggregator.name },
        dateRange: { from, to },
        layer1,
        layer2,
      },
    })
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
