// src/controllers/mobile/tenderType.mobile.controller.ts

/**
 * Catálogo de tipos de pago para el POS (Android / iOS) — SOLO LECTURA.
 *
 * Es la puerta que le faltaba al POS: hasta ahora su pantalla de "ya pagó de otra
 * forma" pintaba una lista FIJA escrita en la app (`ManualPaymentMethod`), así que
 * un negocio con dos terminales ajenas las veía como un solo "Tarjeta (otra
 * terminal)" y un vale caía en "Otro medio" sin poder contarse en el cajón.
 *
 * Devuelve SOLO lo que el POS necesita para pintar y para referenciar el tender al
 * cobrar — `{ id, revision }`. **Jamás manda semántica de dinero que el cliente
 * pueda devolver**: la comisión y el "¿entra al cajón?" los resuelve el server
 * desde `VenueTenderTypeRevision` al registrar el pago (hallazgo P0 de la auditoría
 * v4: un POS con bug o alterado no puede inventar una comisión).
 *
 * Los campos que SÍ viajan son de presentación (`name`, `posSection`, `displayOrder`)
 * más `captureTip`, que la UI necesita para decidir si pide propina ANTES de cobrar.
 */

import { Request, Response, NextFunction } from 'express'
import { listTenderTypes } from '@/services/dashboard/tenderType.dashboard.service'

/**
 * GET /api/v1/mobile/venues/:venueId/tender-types
 *
 * Sólo los activos y visibles en el POS: un tender apagado o con `showOnPos=false`
 * (existe para que cuadren los reportes, no para que el cajero lo toque) no se manda.
 */
export async function listTenderTypesForPos(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const all = await listTenderTypes(venueId)

    const tenderTypes = all
      .filter(t => t.active && t.showOnPos)
      .map(t => ({
        id: t.id,
        // 🔑 El POS referencia {id, revision} al cobrar; el server resuelve el resto.
        revision: t.revision,
        name: t.name,
        isSystem: t.isSystem,
        baseMethod: t.baseMethod,
        captureTip: t.captureTip,
        posSection: t.posSection,
        displayOrder: t.displayOrder,
      }))

    res.json({ tenderTypes })
  } catch (error) {
    next(error)
  }
}
