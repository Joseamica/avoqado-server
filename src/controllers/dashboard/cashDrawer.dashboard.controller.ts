// src/controllers/dashboard/cashDrawer.dashboard.controller.ts
//
// Lectura del cajón físico para el dashboard (fase 1 de la unificación de caja).
// Sólo GET. El permiso es `shifts:read`: es el MISMO dato que ya protege el arqueo de la
// PAX (fondo, esperado, contado, diferencia), así que no se inventa un permiso nuevo.

import { NextFunction, Request, Response } from 'express'
import * as cashDrawerService from '../../services/dashboard/cashDrawer.dashboard.service'

export async function getDrawerStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await cashDrawerService.getDrawerStatus(req.params.venueId))
  } catch (error) {
    next(error)
  }
}

export async function getDrawerSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const page = Number(req.query.page || '1')
    const pageSize = Number(req.query.pageSize || '20')
    if (!Number.isInteger(page) || !Number.isInteger(pageSize) || page <= 0 || pageSize <= 0 || pageSize > 100) {
      res.status(400).json({ error: 'page y pageSize deben ser enteros positivos (pageSize máximo 100)' })
      return
    }
    res.status(200).json(await cashDrawerService.getDrawerSessions(req.params.venueId, { page, pageSize }))
  } catch (error) {
    next(error)
  }
}
