import type { NextFunction, Request, Response } from 'express'

import {
  decidirDestinoDelReembolso,
  errorDeNoAdmitido,
  medioQueLlegaAlEscritor,
  origenDelDinero,
  type DestinoDelReembolso,
  type EntradaDelReembolso,
} from '../services/shared/destinoDelReembolso'
import prisma from '../utils/prismaClient'
import { checkPermission } from './checkPermission.middleware'

/**
 * El permiso de un reembolso según CON QUÉ sale el dinero y DE QUÉ cobro. UNA sola revisión por petición: el código del encargado
 * (`x-permission-override`) es de un solo uso y de UN permiso (dos revisiones encadenadas lo gastaban en la primera).
 *
 * Lo decide `decidirDestinoDelReembolso` (Codex servidor r2, familia B), la MISMA función que usa el escritor, con lo que de verdad le
 * llega al escritor desde esta entrada (`medioQueLlegaAlEscritor`: el panel y la TPV no escogen medio) y el origen real del dinero
 * (`origenDelDinero`: la venta de la QuickPay, directa o por la cadena de un Cambio). La decisión queda en `req.destinoDelReembolso`
 * para que el controlador se la pase al escritor, que se niega a sacar de la gaveta si el permiso concedido no alcanza.
 *
 *  · «Devolver con: Efectivo de la caja» (`refundMethod: 'CASH'`) en las apps pide `payments:refund-to-cash` EN LUGAR de
 *    `payments:refund` (founder, 1-oct-2026; la dependencia refund-to-cash → refund deja la autorización equivalente).
 *  · 🔴 Máquina de efectivo (decisión c del founder): sacar billetes de la gaveta por una venta de la QuickPay pide
 *    `payments:refund-to-cash` en el POS, el panel y la terminal, con el medio vacío o `'CASH'`, también para lo que se pagó con el
 *    crédito de un Cambio de esa venta (r2 #2). Por transferencia o a saldo a favor, `payments:refund`.
 *
 * Sin el permiso no se bloquea: es el 403 de siempre, que el POS convierte en el código del encargado.
 *
 *  · D5 (Codex servidor r3 #12, r6 caso 7) y F10 (r4): lo que esta entrada no admite (lo pagado con crédito de Cambio en la terminal,
 *    o con «Efectivo» o transferencia escogidos; lo pagado con saldo con cualquier medio escogido) pasa SÓLO por la autorización básica (`payments:refund`: sucursal y devolución) y se
 *    contesta 400 `NO_ADMITIDO_EN_ESTA_ENTRADA` con `details.dondeIr`. Nunca se pide antes el permiso especial ni el PIN del encargado
 *    para acabar en el mismo rechazo del escritor. Sigue siendo UNA sola revisión.
 */
const revisarReembolso = checkPermission('payments:refund')
const revisarDevolverEnEfectivo = checkPermission('payments:refund-to-cash')

export type ConDestinoDelReembolso = Request & { destinoDelReembolso?: DestinoDelReembolso }

/** El permiso que concedió este middleware (lo que el controlador le pasa al escritor). */
export const permisoConcedidoDe = (req: Request) => (req as ConDestinoDelReembolso).destinoDelReembolso?.permisoRequerido

export function permisoDeReembolsoSegunElCobro(opciones: { paymentIdDe: (req: Request) => unknown; entrada: EntradaDelReembolso }) {
  return Object.assign(
    async (req: Request, res: Response, next: NextFunction) => {
      // Si la lectura falla se exige el permiso más alto: nunca se concede acceso por un fallo.
      const { origen, esCreditoDeCambio, esSaldo, cobro } = await origenDelDinero(
        prisma,
        req.params?.venueId,
        opciones.paymentIdDe(req),
      ).catch(() => ({ origen: 'MAQUINA' as const, esCreditoDeCambio: false, esSaldo: undefined, cobro: undefined }))
      const metodo = (req.body as { refundMethod?: unknown } | undefined)?.refundMethod
      // H7: con el cobro tal cual, lo admitido sale de las funciones de ruteo de los escritores.
      const decision = decidirDestinoDelReembolso({
        entrada: opciones.entrada,
        origen,
        medio: medioQueLlegaAlEscritor(opciones.entrada, metodo),
        esCreditoDeCambio,
        esSaldo,
        cobro,
      })
      if (!decision.admitido) {
        return revisarReembolso(req, res, (error?: unknown) => next(error ?? errorDeNoAdmitido(decision)))
      }
      ;(req as ConDestinoDelReembolso).destinoDelReembolso = decision
      return decision.permisoRequerido === 'payments:refund-to-cash'
        ? revisarDevolverEnEfectivo(req, res, next)
        : revisarReembolso(req, res, next)
    },
    // Para la inspección de rutas: el permiso base. El de efectivo lo ven el audit y los fixtures por el literal de arriba.
    { requiredPermission: 'payments:refund' as const },
  )
}
