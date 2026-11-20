import type { NextFunction, Request, Response } from 'express'

import prisma from '../utils/prismaClient'
import { checkPermission } from './checkPermission.middleware'

/**
 * El permiso de un reembolso según CON QUÉ sale el dinero y DE QUÉ cobro. UNA sola revisión por petición: el código del encargado
 * (`x-permission-override`) es de un solo uso y de UN permiso (dos revisiones encadenadas lo gastaban en la primera).
 *
 *  · «Devolver con: Efectivo de la caja» (`refundMethod: 'CASH'`) en las apps pide `payments:refund-to-cash` EN LUGAR de
 *    `payments:refund` (founder, 1-oct-2026; la dependencia refund-to-cash → refund deja la autorización equivalente).
 *  · 🔴 Máquina de efectivo (Codex r1 #14, decisión c del founder): devolver en efectivo una venta de la QuickPay saca billetes de una
 *    gaveta en la que nunca entraron. Pide `payments:refund-to-cash` igual con el medio VACÍO («por el mismo medio», lo que manda el
 *    POS por default) que con `'CASH'`, en el POS, el panel y la terminal. Por transferencia o a saldo a favor, `payments:refund`.
 *  · «Saldo a favor» (`STORE_CREDIT`) pide `payments:refund`: no sale dinero del cajón (spec 2026-10-30-saldo-a-favor §5.5).
 *
 * Sin el permiso no se bloquea: es el 403 de siempre, que el POS convierte en el código del encargado.
 */
const revisarReembolso = checkPermission('payments:refund')
const revisarDevolverEnEfectivo = checkPermission('payments:refund-to-cash')

/** ¿El cobro es una venta de la máquina? Si la lectura falla se exige el permiso más alto: nunca se concede acceso por un fallo. */
async function esVentaDeLaMaquina(venueId: string | undefined, paymentId: unknown): Promise<boolean> {
  if (!venueId || typeof paymentId !== 'string' || !paymentId) return false
  try {
    const cobro = await prisma.payment.findFirst({ where: { id: paymentId, venueId }, select: { cashMachineRef: true } })
    return !!cobro?.cashMachineRef
  } catch {
    return true
  }
}

/**
 * `paymentIdDe`: dónde viene el cobro en esa ruta. `efectivoEscogidoPide`: en las apps (`/mobile`), escoger «Efectivo» pide el permiso
 * aunque el cobro no sea de la máquina; el panel y la terminal conservan su regla de siempre para lo demás.
 */
export function permisoDeReembolsoSegunElCobro(opciones: { paymentIdDe: (req: Request) => unknown; efectivoEscogidoPide: boolean }) {
  return Object.assign(
    async (req: Request, res: Response, next: NextFunction) => {
      const metodo = (req.body as { refundMethod?: unknown } | undefined)?.refundMethod
      const enEfectivo = metodo == null || metodo === 'CASH'
      const pideEfectivo =
        (opciones.efectivoEscogidoPide && metodo === 'CASH') ||
        (enEfectivo && (await esVentaDeLaMaquina(req.params?.venueId, opciones.paymentIdDe(req))))
      return pideEfectivo ? revisarDevolverEnEfectivo(req, res, next) : revisarReembolso(req, res, next)
    },
    // Para la inspección de rutas: el permiso base. El de efectivo lo ven el audit y los fixtures por el literal de arriba.
    { requiredPermission: 'payments:refund' as const },
  )
}
