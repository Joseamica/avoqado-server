import { NextFunction, Request, Response } from 'express'
import { normalizeLocalId } from '../services/mobile/cash-drawer.mobile.service'

/** Llave que no encaja con ninguna autorización atada: un token suelto nunca autoriza un retiro. */
export const LLAVE_SIN_RETIRO = 'pay-out:sin-llave'

/**
 * Llave de UN retiro de caja: `pay-out:<localId>:<centavos>`. Ata la autorización del gerente a ese retiro
 * (mismo id del aparato y mismo monto). `n = Number(amount)` igual que el controlador (número o texto numérico).
 * Sin `localId` válido o sin monto positivo → el centinela, que no encaja con nada.
 */
export function llaveDelRetiro(localId: string, amount: unknown): string {
  const n = Number(amount)
  let id: string | null = null
  try {
    id = normalizeLocalId(localId)
  } catch {
    id = null
  }
  if (!id || !(n > 0)) return LLAVE_SIN_RETIRO
  return `pay-out:${id}:${Math.round(n * 100)}`
}

/**
 * SIEMPRE deja `req.llaveDeOperacion` (venga o no la llave en el cuerpo): así `checkPermission` consume con llave y
 * un token suelto jamás autoriza `/pay-out`.
 */
export const ponerLlaveDelRetiro = (req: Request, _res: Response, next: NextFunction) => {
  ;(req as any).llaveDeOperacion = llaveDelRetiro(req.body?.localId, req.body?.amount)
  next()
}
