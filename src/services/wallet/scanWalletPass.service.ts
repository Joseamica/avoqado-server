import { StampRewardStatus, StampRewardType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { conPlazo } from '../../utils/conPlazo'
import { leerPrograma, topeDelDiaAlcanzado } from '../shared/loyaltyOnLateCustomer'
import { getStampCardStatus } from './stampLedger.service'

/**
 * Resuelve el QR de la tarjeta de un cliente, escaneado desde la terminal.
 *
 * 🔴 El código del QR lo puede leer CUALQUIERA que vea la pantalla del cliente — la
 * mesa de al lado, alguien en la fila, una foto. Por eso hay dos candados que no se
 * relajan: esto sólo lo llama personal autenticado del negocio, y sólo resuelve
 * tarjetas de ESE negocio. Sin el filtro por venue, el QR de un cliente de otra
 * sucursal identificaría a alguien que no es cliente de aquí.
 *
 * 🔴 Y devuelve el NOMBRE del cliente, nada más. El cajero necesita saber a quién le
 * está cobrando; su teléfono y su correo no hacen falta para eso, y la pantalla de una
 * terminal la ve cualquiera que esté en el mostrador.
 */

export interface ScanWalletPassResult {
  found: boolean
  /**
   * 🔴 El nombre puede venir VACÍO: un cliente creado desde un cobro rápido no
   * siempre lo tiene. Se devuelve tal cual, en vez de inventar un "Cliente" o dejar
   * que la terminal pinte "undefined undefined" delante de la persona.
   */
  customer?: { id: string; firstName: string | null; lastName: string | null }
  stampsEarned?: number
  stampsRequired?: number
  rewardLabel?: string
  /**
   * Premios ya ganados y sin cobrar. Es lo que el cajero tiene que ver de inmediato.
   *
   * `rewardType` y `rewardValue` (aditivos) dejan que la caja muestre el descuento en la
   * cuenta ANTES de cobrar, como Square y Toast. Es un estimado: el monto que manda es el
   * que confirma el servidor al crear la venta (`stampReward.discountAmount`).
   */
  rewardsToClaim?: { id: string; rewardLabel: string; rewardType: StampRewardType; rewardValue: number | null }[]
  /**
   * D50 (hz:b37dd7ea:D50, aditivo): si una venta de AHORA le suma sello, con la MISMA regla que `grantStamp` (plan con lealtad,
   * interruptor de sellos y tope del día del negocio). Es un pronóstico, no una reserva: dos ventas a la vez las ordena `grantStamp`.
   * Una app vieja lo ignora y sigue con su «esta compra le suma otro». `UNCHECKED` = no se pudo comprobar a tiempo: la app no
   * promete ni niega el sello (sólo enseña el avance).
   */
  stampThisSale?: { willStamp: boolean; reason?: 'DAILY_LIMIT_REACHED' | 'STAMPS_DISABLED' | 'UNCHECKED' }
}

/** El pronóstico no puede atrasar al cajero: si no contesta en este plazo, el escaneo sale con `UNCHECKED` (Codex D50 r1 #1). */
const PLAZO_DEL_PRONOSTICO_MS = 1000
const SIN_COMPROBAR = { willStamp: false, reason: 'UNCHECKED' } as const

async function pronosticoDelSello(venueId: string, customerId: string): Promise<NonNullable<ScanWalletPassResult['stampThisSale']>> {
  const programa = await leerPrograma(venueId)
  if (!programa.stampsEnabled) return { willStamp: false, reason: 'STAMPS_DISABLED' }
  if (await topeDelDiaAlcanzado(venueId, customerId, programa, new Date())) return { willStamp: false, reason: 'DAILY_LIMIT_REACHED' }
  return { willStamp: true }
}

export async function scanWalletPass(venueId: string, qrToken: string): Promise<ScanWalletPassResult> {
  const pass = await prisma.walletPass.findFirst({
    where: { qrToken, venueId, active: true },
    select: { customerId: true },
  })
  // Un código de otro negocio, uno revocado o basura escaneada: todos igual. No se
  // distingue entre ellos ni en la respuesta ni en el mensaje.
  if (!pass) return { found: false }

  const [customer, estado, premios, stampThisSale] = await Promise.all([
    prisma.customer.findFirst({
      where: { id: pass.customerId, venueId },
      // 🔴 Sólo el nombre. Ver la nota de privacidad arriba.
      select: { id: true, firstName: true, lastName: true },
    }),
    getStampCardStatus(venueId, pass.customerId),
    prisma.stampReward.findMany({
      where: { venueId, customerId: pass.customerId, status: StampRewardStatus.PENDING },
      select: { id: true, rewardLabel: true, rewardType: true, rewardValue: true },
      orderBy: { createdAt: 'asc' },
    }),
    // Si el pronóstico falla o tarda, el escaneo sale igual, con `UNCHECKED` (la app ni promete ni niega): nunca lo tumba ni lo atrasa.
    conPlazo(pronosticoDelSello(venueId, pass.customerId), PLAZO_DEL_PRONOSTICO_MS).catch(() => SIN_COMPROBAR),
  ])

  if (!customer) return { found: false }

  return {
    found: true,
    // 🔴 Se reconstruye campo por campo en vez de devolver la fila tal cual. El
    // `select` de arriba ya acota lo que viaja desde la base, pero eso depende de que
    // nadie lo amplíe "para reusar la consulta" — y el día que alguien agregue el
    // teléfono ahí, se filtraría por aquí sin que nada avise. Dos candados: la
    // consulta y el mapeo.
    customer: { id: customer.id, firstName: customer.firstName, lastName: customer.lastName },
    stampsEarned: estado.stampsEarned,
    stampsRequired: estado.stampsRequired,
    rewardLabel: estado.rewardLabel,
    // 🔴 Número, no Decimal: en JSON un Decimal sale como texto y la caja lo leería como cero.
    rewardsToClaim: premios.map(p => ({
      id: p.id,
      rewardLabel: p.rewardLabel,
      rewardType: p.rewardType,
      rewardValue: p.rewardValue == null ? null : Number(p.rewardValue),
    })),
    stampThisSale,
  }
}
