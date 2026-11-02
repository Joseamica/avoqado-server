// src/services/storeCredit/terminalRefundMarker.ts
/**
 * «La terminal está devolviendo este cobro» (spec 2026-10-30-saldo-a-favor §5.5, opción 1 del founder; tarea S7).
 *
 * Abrir una devolución en la TPV no aparta el importe (`requestRefundOnTerminal`) y la terminal devuelve al banco ANTES de avisar
 * (`recordRefund`). Entre las dos, otra cajera podría pasar el mismo cobro a saldo a favor: dinero dos veces. Al mandar el comando a
 * la terminal queda una marca en memoria (3 min) y, mientras vive, el Reembolso a saldo (S4) y el Cambio a saldo (S5) de ese cobro
 * se rechazan con 409 `STORE_CREDIT_TERMINAL_REFUND_IN_PROGRESS`, sin escribir nada. Si la carrera se cuela igual (devolución desde el
 * menú de la terminal, sin el POS), el registro tardío la anota y congela el saldo (`exchangeTerminalRefund.ts`).
 * ponytail: memoria del proceso (una sola instancia, `.claude/rules/una-sola-instancia.md` punto 14); con 2 pods va a una tabla.
 */
import type { Prisma } from '@prisma/client'
import { ConflictError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

const VIGENCIA_MS = 3 * 60_000
const marcas = new Map<string, number>()

/** Los cobros con la marca viva; de paso olvida las vencidas (el mapa no crece sin fin). */
function marcadosVivos(): string[] {
  const ahora = Date.now()
  for (const [paymentId, vence] of marcas) if (vence <= ahora) marcas.delete(paymentId)
  return [...marcas.keys()]
}

/** Al mandar el comando a la terminal. Volver a abrirla renueva los 3 minutos. */
export function marcarDevolucionEnTerminal(paymentId: string): void {
  marcadosVivos()
  marcas.set(paymentId, Date.now() + VIGENCIA_MS)
}

export function hayDevolucionEnTerminal(paymentId: string): boolean {
  return marcadosVivos().includes(paymentId)
}

/**
 * Rechaza (409, sin escribir) si la terminal está devolviendo el cobro —o la RAÍZ de un crédito de cambio, de donde salió su dinero—.
 * `paymentId` para el Reembolso; `orderId` para el Cambio (sus cobros pagan la diferencia). Sin marcas vivas, ni una consulta; con
 * marcas, dos conteos acotados por ellas.
 * 🔴 S10 (I1): se llama DENTRO de la transacción de dinero, bajo su candado y DESPUÉS de reconocer la llave (`db` = esa transacción):
 * una repetición contesta lo que la primera escribió, nunca este 409 mientras la primera todavía puede abonar.
 */
export async function rechazarSiLaTerminalEstaDevolviendo(
  venueId: string,
  de: { paymentId: string } | { orderId: string },
  db: Pick<Prisma.TransactionClient, 'payment' | 'exchangeCreditLink'> = prisma,
): Promise<void> {
  const marcados = marcadosVivos()
  if (marcados.length === 0) return
  const directo =
    'paymentId' in de
      ? marcados.includes(de.paymentId)
      : (await db.payment.count({ where: { venueId, orderId: de.orderId, id: { in: marcados } } })) > 0
  const porLaRaiz =
    !directo &&
    (await db.exchangeCreditLink.count({
      where: {
        venueId,
        originPaymentId: { in: marcados },
        ...('paymentId' in de ? { creditPaymentId: de.paymentId } : { creditPayment: { orderId: de.orderId } }),
      },
    })) > 0
  if (directo || porLaRaiz)
    throw new ConflictError(
      'La terminal está devolviendo este cobro. Espera a que termine y revisa cuánto queda por devolver.',
      'STORE_CREDIT_TERMINAL_REFUND_IN_PROGRESS',
    )
}
