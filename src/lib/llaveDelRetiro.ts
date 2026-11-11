import { NextFunction, Request, Response } from 'express'
import { normalizeLocalId } from '../services/mobile/cash-drawer.mobile.service'

/** Llave que no encaja con ninguna autorización atada: un token suelto nunca autoriza un retiro. */
export const LLAVE_SIN_RETIRO = 'pay-out:sin-llave'

/**
 * El importe de un retiro en centavos enteros, o `null` si no es un monto positivo. 🔴 Es el ÚNICO número del que salen
 * la llave (`pay-out:<id>:<centavos>`) y lo que se guarda (`centavos / 100`): si cada uno redondeara por su cuenta,
 * `2.675` quedaba atado como `:268` y registrado como $2.67 (H2, auditoría final).
 */
export function centavosDelRetiro(amount: unknown): number | null {
  const n = Number(amount)
  if (!Number.isFinite(n) || !(n > 0)) return null
  const cents = Math.round(n * 100)
  return cents >= 1 ? cents : null
}

/**
 * Llave de UN retiro de caja: `pay-out:<localId>:<centavos>`. Ata la autorización del gerente a ese retiro
 * (mismo id del aparato y mismo monto). `n = Number(amount)` igual que el controlador (número o texto numérico).
 * Sin `localId` válido o sin monto positivo → el centinela, que no encaja con nada.
 */
export function llaveDelRetiro(localId: string, amount: unknown): string {
  const cents = centavosDelRetiro(amount)
  let id: string | null = null
  try {
    id = normalizeLocalId(localId)
  } catch {
    id = null
  }
  if (!id || cents === null) return LLAVE_SIN_RETIRO
  return `pay-out:${id}:${cents}`
}

/**
 * SIEMPRE deja `req.llaveDeOperacion` (venga o no la llave en el cuerpo): así `checkPermission` consume con llave y
 * un token suelto jamás autoriza `/pay-out`.
 */
export const ponerLlaveDelRetiro = (req: Request, _res: Response, next: NextFunction) => {
  ;(req as any).llaveDeOperacion = llaveDelRetiro(req.body?.localId, req.body?.amount)
  next()
}
