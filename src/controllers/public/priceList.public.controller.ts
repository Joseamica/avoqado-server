import { Request, Response, NextFunction } from 'express'
import emailService from '../../services/email.service'
import logger from '../../config/logger'
import AppError from '../../errors/AppError'
import { getPublicPriceList, priceSelection } from '../../services/launchCampaigns/publicPriceList.service'
import { ONBOARDING_NOTIFY_EMAIL, telefonoParaWhatsApp } from './landing.public.controller'

/** /presentacion/precios: the live SUPERADMIN list prices for a prospect (spec 2026-10-26-presentacion-de-precios). */
export async function getPriceList(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await getPublicPriceList()
    res.set('Cache-Control', 'public, max-age=60')
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

/** Recomputes everything from the live list: nothing the browser says about prices is trusted. */
export async function postPriceSelection(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { nombre, telefono, ids, pageUri, offerVersion } = req.body as {
      nombre?: string
      telefono?: string
      ids: string[]
      pageUri?: string
      offerVersion?: unknown
    }
    const list = await getPublicPriceList()
    // Planes editables (B2, Task 10): el esquema deja pasar `offerVersion` tal cual (`z.unknown()`); su forma la revisa `priceSelection`,
    // y sólo si la lista cita su versión (con un valor que no es un entero, 409 como una versión vieja).
    const selection = priceSelection(list, ids, offerVersion as number | undefined)
    const phone = telefonoParaWhatsApp(telefono)
    const sent = await emailService.sendPriceSelectionEmail(ONBOARDING_NOTIFY_EMAIL, {
      nombre: nombre || null,
      telefono: telefono || null,
      whatsappUrl: phone ? `https://wa.me/${phone}` : null,
      pageUri: pageUri ?? null,
      selection,
    })
    if (!sent) {
      logger.warn('Price selection e-mail not sent', { ids })
      throw new AppError('No pudimos enviar tu selección. Intenta de nuevo.', 502, true, 'PRICE_SELECTION_NOT_SENT')
    }
    res.json({
      success: true,
      data: { best: selection.best, savingsCents: selection.savingsCents, chosen: selection.chosen.map(f => f.id) },
    })
  } catch (error) {
    next(error)
  }
}
