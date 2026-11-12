// src/services/online-ordering/cuentaConBeneficios.ts
/**
 * D16: ¿la tienda invita a «Entrar»? Responde `false` sólo si NINGUNA clienta de este negocio podría ver o usar algo de su cuenta
 * (regla del founder, 5-nov: los mensajes de premios sólo salen si la función está prendida). Es un superconjunto a propósito de lo que
 * enseñan «Mi cuenta» (`getCustomerPortal`) y la oferta de la tienda (`ofertaDeBeneficios`): `false` nunca esconde algo real.
 *  - Puntos (`LoyaltyConfig.active`) o sellos (`stampsEnabled`; el portal enseña la cartilla sin mirar `active`).
 *  - Tarjetas de regalo prendidas, o cualquier tarjeta o sobre de saldo a favor del negocio (ese saldo se honra aunque se apaguen).
 *  - Un paquete ACTIVE sin vencer.
 *  - Un descuento activo y vigente hoy, de un grupo o con una asignación activa (lo que lista el portal).
 *  - Un cupón que la tienda aplicaría (el MISMO filtro que `ofertaDeBeneficios`; la tienda sólo aplica cupones con sesión).
 * Sólo lee, en UNA consulta de `EXISTS` sobre índices por negocio (`/ordering/info` es pública y se llama en cada carga de la tienda).
 * Sin caché: prender o apagar algo se ve en la siguiente carga.
 */
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'

export async function cuentaConBeneficios(venueId: string, ahora: Date = new Date()): Promise<boolean> {
  const t = utcTs(ahora)
  const [fila] = await prisma.$queryRaw<Array<{ si: boolean }>>`
    SELECT (
      EXISTS (SELECT 1 FROM "LoyaltyConfig" l WHERE l."venueId" = ${venueId} AND (l.active OR l."stampsEnabled"))
      OR EXISTS (SELECT 1 FROM "GiftCardSettings" s WHERE s."venueId" = ${venueId} AND s.enabled)
      OR EXISTS (SELECT 1 FROM "GiftCard" g WHERE g."venueId" = ${venueId})
      OR EXISTS (
        SELECT 1 FROM "CreditPackPurchase" p
        WHERE p."venueId" = ${venueId} AND p.status = 'ACTIVE' AND (p."expiresAt" IS NULL OR p."expiresAt" > ${t})
      )
      OR EXISTS (
        SELECT 1 FROM "Discount" d
        WHERE d."venueId" = ${venueId} AND d.active
          AND (d."validFrom" IS NULL OR d."validFrom" <= ${t}) AND (d."validUntil" IS NULL OR d."validUntil" >= ${t})
          AND (d."customerGroupId" IS NOT NULL OR EXISTS (SELECT 1 FROM "CustomerDiscount" cd WHERE cd."discountId" = d.id AND cd.active))
      )
      OR EXISTS (
        SELECT 1 FROM "CouponCode" c JOIN "Discount" d ON d.id = c."discountId"
        WHERE d."venueId" = ${venueId} AND c.active AND d.active
          AND d.scope = 'ORDER' AND d."requiresApproval" = false AND d.type <> 'COMP'
          AND (c."validFrom" <= ${t} OR (c."validFrom" IS NULL AND (d."validFrom" IS NULL OR d."validFrom" <= ${t})))
          AND (c."validUntil" >= ${t} OR (c."validUntil" IS NULL AND (d."validUntil" IS NULL OR d."validUntil" >= ${t})))
      )
    ) AS si`
  return fila?.si === true
}
