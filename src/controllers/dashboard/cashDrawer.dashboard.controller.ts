// src/controllers/dashboard/cashDrawer.dashboard.controller.ts
//
// Lectura del cajón físico para el dashboard (fase 1 de la unificación de caja).
// Sólo GET. El permiso de entrada es `shifts:read`: es el MISMO dato que ya protege el
// arqueo de la PAX.
//
// 🔴 Pero el EFECTIVO ESPERADO va aparte, detrás de `cash-drawer:view-expected` (MANAGER+).
// `shifts:read` lo tienen CASHIER y WAITER por defecto, así que servirles el esperado
// convertía el conteo ciego del POS en un adorno: bastaba pedir este endpoint con el token
// propio y teclear la cifra en el cierre. La bandera la deja puesta `marcarPermiso` en la
// ruta; aquí sólo se reenvía.

import { NextFunction, Request, Response } from 'express'
import * as cashDrawerService from '../../services/dashboard/cashDrawer.dashboard.service'

export async function getDrawerStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await cashDrawerService.getDrawerStatus(req.params.venueId, (req as any).puedeVerEsperado === true))
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
    res
      .status(200)
      .json(await cashDrawerService.getDrawerSessions(req.params.venueId, { page, pageSize }, (req as any).puedeVerEsperado === true))
  } catch (error) {
    next(error)
  }
}
