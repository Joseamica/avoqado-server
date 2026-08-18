/**
 * Auto-provisión del tipo de pago de un canal de delivery (spec paso 6).
 *
 * POR QUÉ: sin `tenderTypeId`, el `Payment` de un pedido de delivery nace con
 * `method: OTHER` y se pierden las cuatro semánticas de dinero que viven en
 * `VenueTenderType`: comisión del canal, forma de pago SAT, si cuenta para el
 * arqueo de caja, y si admite propina. Además el reporte por método de pago
 * muestra "OTHER" en vez de "Uber Eats".
 *
 * Regla del repo (`feature-gating.md`): un feature cuyo único switch es un
 * UPDATE en Postgres está incompleto. Obligar al dueño a crear el tipo de pago
 * a mano ANTES de su primer pedido es justo ese defecto — por eso se crea solo
 * al activar el canal.
 *
 * IDEMPOTENTE por diseño: si el dueño ya lo creó a mano (con su comisión y su
 * forma SAT), se REUSA el suyo y no se pisa ni un campo. La carrera entre dos
 * activaciones concurrentes la resuelve el unique de la base, no un chequeo previo.
 */
import { DeliveryProvider, PaymentMethod, Prisma, VenueTenderType } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { normalizeTenderName } from '../../dashboard/tenderType.dashboard.service'

/** Etiqueta visible por proveedor. Es lo que el dueño verá en reportes y en el POS. */
const PROVIDER_LABEL: Record<DeliveryProvider, string> = {
  [DeliveryProvider.UBER_EATS]: 'Uber Eats',
  [DeliveryProvider.RAPPI]: 'Rappi',
  [DeliveryProvider.DIDI_FOOD]: 'DiDi Food',
  [DeliveryProvider.DELIVERECT]: 'Deliverect',
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
}

export function deliveryTenderLabel(provider: DeliveryProvider): string {
  return PROVIDER_LABEL[provider]
}

export async function ensureDeliveryTenderType(venueId: string, provider: DeliveryProvider): Promise<VenueTenderType> {
  const name = deliveryTenderLabel(provider)
  const normalizedName = normalizeTenderName(name)

  const existente = await prisma.venueTenderType.findFirst({ where: { venueId, normalizedName } })
  if (existente) return existente // el del dueño manda: jamás se sobrescribe

  try {
    return await prisma.$transaction(async tx => {
      const creado = await tx.venueTenderType.create({
        data: {
          venueId,
          name,
          normalizedName,
          // El schema exige OTHER para filas custom (las de sistema son CASH/CREDIT_CARD/…)
          baseMethod: PaymentMethod.OTHER,
          isSystem: false,
          // Defaults conservadores: este dinero NO entra al cajón y la propina la
          // liquida la plataforma, no el mesero.
          countsAsPhysicalCash: false,
          captureTip: false,
          // 🔴 Comisión y forma SAT quedan VACÍAS a propósito: son decisiones
          // comercial y fiscal del venue. Inventarlas es peor que dejarlas en
          // blanco — el panel las pide con aviso visible.
          commissionPercent: null,
          satFormaPago: null,
          showOnPos: false, // no es un tender que el cajero elija: lo estampa la ingesta
          revision: 1,
        },
      })
      // Snapshot inicial: es lo que congela comisión y forma SAT en cada cobro.
      await tx.venueTenderTypeRevision.create({
        data: {
          venueId,
          tenderTypeId: creado.id,
          revision: 1,
          name,
          countsAsPhysicalCash: false,
          captureTip: false,
          commissionPercent: null,
          satFormaPago: null,
          createdBy: null,
        },
      })
      return creado
    })
  } catch (error) {
    // Otra activación concurrente ganó la carrera: mismo resultado, se reusa el suyo.
    if (isUniqueViolation(error)) {
      const ganador = await prisma.venueTenderType.findFirst({ where: { venueId, normalizedName } })
      if (ganador) return ganador
    }
    throw error
  }
}
