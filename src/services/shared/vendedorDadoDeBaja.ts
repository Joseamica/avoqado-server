/**
 * D13 «C» (founder, 21-nov-2026): la venta de un vendedor que dieron de baja ya no se atora. El vendedor lo manda el aparato
 * («Vendiendo: …»), así que el servidor sólo le cree lo que él mismo ya guardó:
 *   · la cuenta YA estaba guardada a su nombre (la venta a medias de WINDOWS) ⇒ su cobro queda a nombre del vendedor, sin plazo;
 *   · la venta viene de la cola sin red ⇒ queda a nombre de la SESIÓN que la sube (Q110, 20-oct: «a nombre de quien lo termina»).
 * Fingir «vengo de la cola» sólo pone la venta a nombre de la propia sesión. Una venta NUEVA en vivo sigue con el 400 de hoy.
 * No depende de `StaffVenue.endDate` (desde D19 la base la sella en toda baja, pero esta regla no la necesita). Promesa: docs/audit/2026-11-21-vendedor-dado-de-baja.
 */
import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { validateStaffVenue } from '../../utils/staff-venue.util'
import { writeLegacyActivityAuditTx } from '../activityAudit.service'
import type { TxConReintento } from '../../utils/serializableRetry'

export interface VendedorDeBaja {
  /** A nombre de quién queda la venta. */
  staffId: string
  caso: 'ORDEN_DEL_VENDEDOR' | 'COLA_A_LA_SESION'
  /** El vendedor que dijo el aparato (dado de baja en este negocio). */
  vendedor: string
}

export interface OpcionesDelVendedor {
  /** La sesión del token (nunca del cuerpo). */
  sesion?: string
  /** La venta viene de la cola sin red (`isOfflineReplay`, lo dice el aparato). */
  deLaCola: boolean
  /** La cuenta ya está guardada en el servidor a nombre de este vendedor (`servedById` o `createdById`). */
  laCuentaEsSuya?: boolean
}

/**
 * `validateStaffVenue` del vendedor con las dos salidas de D13. Sin salida, el MISMO error de hoy.
 *   · Caso 2: basta que la cuenta ya esté a su nombre en el servidor (también si lo ELIMINARON del equipo, Codex r1 #4).
 *   · Caso 1: sólo un vendedor dado de baja en ESTE negocio (membresía inactiva); un id ajeno o inventado sigue con el 400.
 * Una caída de la base nunca se vuelve 400: sube tal cual (500), y la cola reintenta (Codex r1 #5).
 */
export async function validarVendedor(
  vendedor: string | undefined,
  venueId: string,
  userId: string | undefined,
  opciones: OpcionesDelVendedor,
): Promise<{ staffId: string | undefined; deBaja: VendedorDeBaja | null }> {
  try {
    return { staffId: await validateStaffVenue(vendedor, venueId, userId), deBaja: null }
  } catch (error) {
    const deBaja = error instanceof BadRequestError && vendedor ? await salidaDelVendedorDeBaja(vendedor, venueId, opciones) : null
    if (!deBaja) throw error
    return { staffId: deBaja.staffId, deBaja }
  }
}

async function salidaDelVendedorDeBaja(vendedor: string, venueId: string, o: OpcionesDelVendedor): Promise<VendedorDeBaja | null> {
  if (o.laCuentaEsSuya) return { staffId: vendedor, caso: 'ORDEN_DEL_VENDEDOR', vendedor }
  if (!o.deLaCola || !o.sesion || o.sesion === vendedor) return null
  const deBaja = await prisma.staffVenue.findFirst({ where: { staffId: vendedor, venueId, active: false }, select: { id: true } })
  if (!deBaja) return null
  const sesion = await validateStaffVenue(o.sesion, venueId).catch(error => {
    if (error instanceof BadRequestError) return undefined
    throw error
  })
  return sesion ? { staffId: sesion, caso: 'COLA_A_LA_SESION', vendedor } : null
}

/** La nota de la bitácora, en la MISMA transacción que crea la cuenta o el cobro (un reintento sale antes y no la repite). */
export async function anotarVendedorDeBajaEnTx(
  tx: Pick<TxConReintento, 'activityLog'>,
  venueId: string,
  deBaja: VendedorDeBaja,
  donde: { orderId: string; paymentId?: string; sesion?: string | null },
): Promise<void> {
  await writeLegacyActivityAuditTx(tx, {
    staffId: donde.sesion ?? null,
    venueId,
    action: 'VENDEDOR_DADO_DE_BAJA',
    entity: donde.paymentId ? 'Payment' : 'Order',
    entityId: donde.paymentId ?? donde.orderId,
    data: {
      caso: deBaja.caso,
      elAparatoDijo: deBaja.vendedor,
      quedoANombreDe: deBaja.staffId,
      orderId: donde.orderId,
      ...(donde.paymentId ? { paymentId: donde.paymentId } : {}),
    },
  })
}
