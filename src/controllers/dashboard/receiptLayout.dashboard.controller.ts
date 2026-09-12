import { NextFunction, Request, Response } from 'express'
import { logAction } from '@/services/dashboard/activity-log.service'
import { getReceiptLayout, putReceiptLayout, resetReceiptLayout } from '@/services/dashboard/receiptLayout/receiptLayout.service'
import { cargarVenueInfo, getReceiptDevices, getReceiptReadiness } from '@/services/dashboard/receiptLayout/readiness.service'
import { interpret, parseLayoutTolerant, SAMPLE_SALES, TEMPLATES, validateLayout, type PaperWidth } from '@/services/shared/receiptLayout'

/** GET / — la receta vigente más lo que el diseñador necesita para no mentirle al negocio. */
export const get = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const [layout, readiness, devices] = await Promise.all([
      getReceiptLayout(venueId),
      getReceiptReadiness(venueId),
      getReceiptDevices(venueId),
    ])
    res.json({ data: { ...layout, readiness, devices } })
  } catch (error) {
    next(error)
  }
}

/** PUT / — guardar con CAS. El servicio decide; aquí sólo se extrae y se registra. */
export const put = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { userId } = (req as any).authContext
    const guardado = await putReceiptLayout({
      venueId,
      blocks: req.body.blocks,
      expectedRevision: req.body.expectedRevision,
      updatedById: userId,
    })

    // Bitácora BEST EFFORT y declarada (spec § 7.4): va DESPUÉS del guardado y sin encadenar.
    // `logAction` nunca lanza, así que un fallo de bitácora no puede tumbar un guardado bueno.
    void logAction({
      staffId: userId,
      venueId,
      action: 'RECEIPT_LAYOUT_UPDATED',
      entity: 'ReceiptLayout',
      entityId: venueId,
      data: { revision: guardado.revision, bloques: guardado.blocks.length },
    })

    res.json({ data: guardado })
  } catch (error) {
    next(error)
  }
}

/** DELETE / — restablecer a la canónica, con precondición de revisión. */
export const reset = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { userId } = (req as any).authContext
    const { layout, discardedRevision } = await resetReceiptLayout({ venueId, expectedRevision: req.body.expectedRevision })
    // Sólo se audita lo que PASÓ: restablecer algo que ya era la canónica no borró nada. Y se
    // anota qué revisión se tiró, que es lo único que permite saber qué diseño se perdió.
    if (discardedRevision !== null) {
      void logAction({
        staffId: userId,
        venueId,
        action: 'RECEIPT_LAYOUT_RESET',
        entity: 'ReceiptLayout',
        entityId: venueId,
        data: { revisionDescartada: discardedRevision },
      })
    }
    res.json({ data: layout })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /preview — el papel, sin persistir nada.
 *
 * 🔴 TOLERANTE a propósito: se descarta lo ilegible y se REPORTA en `problems`, no se rechaza.
 * El diseñador tiene que poder enseñar el ticket a medio armar; exigir integridad aquí
 * impediría ver lo que se está construyendo hasta terminarlo.
 */
export const preview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { blocks, paperWidth, sample } = req.body
    const { blocks: legibles, dropped } = parseLayoutTolerant(blocks)
    const problems = validateLayout(legibles)
    const width: PaperWidth = paperWidth === 58 ? 32 : 48
    const venue = await cargarVenueInfo(venueId)
    const lines = interpret(legibles, { sale: SAMPLE_SALES[sample as keyof typeof SAMPLE_SALES], venue }, width)
    res.json({ data: { lines, problems, dropped } })
  } catch (error) {
    next(error)
  }
}

/** GET /templates — las cinco semillas con su hash, para el botón «Plantillas». */
export const templates = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({
      data: Object.values(TEMPLATES).map(t => ({ id: t.id, name: t.name, description: t.description, blocks: t.blocks, hash: t.hash })),
    })
  } catch (error) {
    next(error)
  }
}
