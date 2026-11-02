import { BadRequestError } from '../../errors/AppError'
import { esRenglonDeVale } from './renglonDeVale'

/** R14-1 (founder, 17-oct): lo que ve el operador al intentar separar o juntar una cuenta con vales de mostrador. */
export const MENSAJE_CUENTA_CON_VALES =
  'Esta cuenta tiene vales de mostrador: no se puede separar ni juntar. Para pagar entre varios, registra abonos en la misma cuenta.'

/** Lo que se lee de la cuenta, bajo su candado: su sesión de vales y sus renglones con `areaTicketLineId`. */
type Cuenta = {
  areaTicketCheckoutSession?: { id: string } | null
  items?: ReadonlyArray<{ areaTicketLineId?: string | null; releasedAreaTicketLineId?: string | null }>
}

/**
 * 🔴 R14-1 (decisión del founder del 17-oct; Codex r18 #1/#2 y re-revisión r13 (E)): una cuenta con vales NO se separa ni se junta.
 * Dividir o fusionar movía renglones de vale fuera de la sesión, el vale y la reserva que los poseen (doble descuento en una carrera
 * TPV/POS, producto cobrado sin descontar tras cancelar el origen, vale entregado con su renglón sin cobrar, sesión huérfana).
 *
 * «Con vales» = tiene sesión de vales (la venta de vales, también si sólo se mueve un suelto o si recibe otra cuenta) o algún renglón de
 * vale (una cuenta ya dividida antes de este cambio, sin la sesión). Lo llaman los TRES escritores de `OrderItem.orderId`
 * (`splitOrderItemsInTransaction`, `splitOrderBySeatInTransaction`, `mergeOrdersInTransaction`), por donde pasan las rutas, la cola sin red
 * y el MCP. Mover la cuenta entera a otra mesa no mueve renglones: no pasa por aquí. Es un rechazo de negocio (400, como los demás de
 * separar/juntar): la cola sin red lo deja REJECTED, nunca RETRY. Sin bitácora: no muta nada.
 */
export function rechazarSiLaCuentaTieneVales(...cuentas: Cuenta[]): void {
  if (cuentas.some(c => c.areaTicketCheckoutSession != null || c.items?.some(esRenglonDeVale)))
    throw new BadRequestError(MENSAJE_CUENTA_CON_VALES, 'AREA_TICKET_ORDER_NOT_SPLITTABLE')
}
