import { BadRequestError } from '../../errors/AppError'
import { esFilaDeValeV7 } from './repartoDescuento'
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

/**
 * Tarjeta na24531d: lo que ve quien intenta quitar el descuento de un producto en una venta de vales, en TODAS las versiones de la TPV,
 * de ANDROID/WINDOWS y de iOS (el texto del 400). Pizarrón D14, 18-nov (Codex r2 #3 y #4): debe dar una salida que exista.
 *   - «ármala sin ese descuento» no la daba: volver a leer el MISMO vale copia otra vez su descuento (`buildOrderItemsData`).
 *   - Cancelar el cobro de los vales sólo se puede SIN pagos (`cancelAreaTicketCheckout` → `CHECKOUT_HAS_PAYMENT`); con pagos, el
 *     camino es terminar la venta y devolver.
 */
export const MENSAJE_DESCUENTO_DE_VENTA_DE_VALES =
  'Este descuento quedó fijo al cobrar los vales y no se quita desde la caja. Si está mal y la venta va sin pagos, cancela el cobro de los vales y vuelve a armarlo (si el error viene en el vale, pide en el área un vale nuevo). Si ya tiene pagos, termina la venta y corrige con un reembolso.'

/**
 * 🔴 Tarjeta na24531d (Codex r1 #1-#2, r2 #1, r3 #1-#2): la venta de vales V7 nace con la fila ESPEJO de cada descuento de producto
 * (para que salga en «Descuentos») y TODAS esas filas llevan la marca `deValeV7` en su reparto. Una fila marcada no se puede QUITAR desde
 * la caja (TPV) ni desde el POS: antes no había fila que quitar, y quitarla subiría el saldo de una venta con el cobro del vale ya
 * preparado por el monto viejo y bajaría `Discount.currentUses` por un uso que la venta de vales nunca sumó. Se queda como hoy: para
 * cambiar un descuento de una venta de vales se cancela y se vuelve a armar (el vale congeló su precio al emitirse).
 *
 * La marca decide, no se adivina: ni por `discountId` (una cortesía del catálogo que el dueño borró queda sin liga) ni por los renglones
 * que queden en la cuenta (quitar el renglón de vale no libera la fila del suelto). Una fila SIN la marca se quita como siempre: la
 * cortesía que la caja da después, un descuento de cuenta, un canje. No aplica a la anulación (`porAnulacion`, que sólo regresa canjes).
 * Es un rechazo de negocio (400), antes de cualquier efecto, bajo el candado de la cuenta que ya tiene quien llama; no consulta nada.
 */
export function rechazarSiQuitaUnDescuentoDeVale(fila: { reparto: unknown }): void {
  if (esFilaDeValeV7(fila.reparto)) throw new BadRequestError(MENSAJE_DESCUENTO_DE_VENTA_DE_VALES, 'AREA_TICKET_DISCOUNT_FROZEN')
}
