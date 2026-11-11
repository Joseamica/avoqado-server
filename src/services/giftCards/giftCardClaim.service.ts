// src/services/giftCards/giftCardClaim.service.ts
/**
 * «Guardar en mi cuenta» (tienda híbrida S13, P2-6): la clienta con sesión liga a su ficha una tarjeta de regalo probando su código.
 * Nunca mueve saldo (CLAIM con monto 0).
 *
 * Orden de candados (tabla «Orden de candados de la parte 2»): `Customer` (rango 8) → `GiftCard` (rango 9, `lockGiftCardsForUpdate`).
 *  - R1/R1' (Codex s13-r0 #1, r1 #1): la ficha va `FOR SHARE`, no `KEY SHARE`: choca con el `FOR NO KEY UPDATE` de S8
 *    (`cambiarTelefonoEnTx`) y con el panel que la desactiva. Bajo ese candado se revalida la sesión (sucursal, activa, versión y
 *    contactos); si ya no vale, 401 `CUSTOMER_REAUTH_REQUIRED` sin escribir ni revelar nada.
 *  - codex-plan2-r1 #1: bajo el candado de la tarjeta se juzga otra vez la prueba (`prueba.vigente`): si el gerente repuso el código
 *    mientras se esperaba, el código viejo ya no guarda (el 404 de siempre).
 *  - R6: sólo una tarjeta ACTIVA y vigente; cualquier otra (bloqueada, sin activar, desactivada, vencida) y un sobre de saldo a favor
 *    responden el MISMO 404 del código inválido, para no revelar su estado.
 */
import { Prisma } from '@prisma/client'
import { ConflictError, UnauthorizedError } from '@/errors/AppError'
import type { CustomerAuthContext } from '@/middlewares/customerAuth.middleware'
import { sesionSigueEnLaFicha } from '@/services/public/sesionDeCliente.service'
import { ORDER_LOCK_WAIT_BUDGET } from '@/services/shared/paymentShiftClaim'
import { withDeadlockRetry, type TxConReintento } from '@/utils/serializableRetry'
import { esSobreDeSaldoAFavor, lockGiftCardsForUpdate } from './giftCardLedger'
import { resolverPrueba } from './giftCardProof'

export type SesionDeLaClienta = Pick<CustomerAuthContext, 'customerId' | 'contactos' | 'v' | 'verifiedPhone'>

const reautenticar = () => new UnauthorizedError('Tu sesión cambió. Entra otra vez.', 'CUSTOMER_REAUTH_REQUIRED')

/**
 * R1/R1': toma la ficha de la sesión `FOR SHARE` (rango 8) y comprueba, bajo ese candado, que exista en ESTA sucursal, que siga activa
 * y que la sesión siga valiendo (`sesionSigueEnLaFicha`, la misma regla del middleware). Lo primero de toda transacción sensible de S13.
 */
export async function revalidarSesionEnTx(tx: TxConReintento, venueId: string, sesion: SesionDeLaClienta): Promise<void> {
  const [ficha] = await tx.$queryRaw<Array<{ active: boolean; versionDeSesion: number; phone: string | null; email: string | null }>>`
    SELECT "active", "versionDeSesion", "phone", "email" FROM "Customer"
    WHERE "id" = ${sesion.customerId} AND "venueId" = ${venueId}
    FOR SHARE`
  if (!ficha || !ficha.active || !sesionSigueEnLaFicha(ficha, sesion)) throw reautenticar()
}

export interface TarjetaGuardada {
  giftCardId: string
  last4: string
  saldo: number
}

/**
 * POST /public/venues/:venueSlug/customer/gift-cards/claim. El código se resuelve antes de la transacción (`resolverPrueba`: mal formado
 * o de otro negocio ⇒ 404). Sin dueña: la liga, escribe `CLAIM` y `GIFT_CARD_CLAIMED`. Ya suya: responde igual, sin otra actividad.
 * De otra clienta: 409 `GIFT_CARD_ALREADY_SAVED`.
 */
export async function guardarTarjetaEnMiCuenta(
  venueId: string,
  sesion: SesionDeLaClienta,
  code: string,
  ctx: { ip?: string | null },
): Promise<TarjetaGuardada> {
  const prueba = await resolverPrueba(venueId, { kind: 'CODE', code }, { deviceId: null })
  return withDeadlockRetry(
    async tx => {
      await revalidarSesionEnTx(tx, venueId, sesion)
      const [card] = await lockGiftCardsForUpdate(tx, [prueba.giftCardId])
      const ahora = new Date()
      const viva = card && card.status === 'ACTIVE' && (card.expiresAt === null || card.expiresAt.getTime() > ahora.getTime())
      if (!card || card.venueId !== venueId || !prueba.vigente(card, ahora) || !viva) throw prueba.rechazo()
      if (await esSobreDeSaldoAFavor(tx, card.id)) throw prueba.rechazo()
      const guardada = { giftCardId: card.id, last4: prueba.last4, saldo: card.balance.toNumber() }
      if (card.customerId === sesion.customerId) return guardada
      if (card.customerId) {
        throw new ConflictError('Esta tarjeta ya está guardada en otra cuenta.', 'GIFT_CARD_ALREADY_SAVED')
      }
      const r = await tx.giftCard.updateMany({
        where: { id: card.id, venueId, customerId: null },
        data: { customerId: sesion.customerId },
      })
      if (r.count !== 1) throw prueba.rechazo()
      await tx.giftCardActivity.create({
        data: { giftCardId: card.id, venueId, type: 'CLAIM', amount: new Prisma.Decimal(0), balanceAfter: card.balance },
      })
      await tx.activityLog.create({
        data: {
          venueId,
          action: 'GIFT_CARD_CLAIMED',
          entity: 'GiftCard',
          entityId: card.id,
          data: { customerId: sesion.customerId, last4: prueba.last4 },
          ipAddress: ctx.ip ?? null,
        },
      })
      return guardada
    },
    { etiqueta: 'guardarTarjetaEnMiCuenta', ...ORDER_LOCK_WAIT_BUDGET },
  )
}
