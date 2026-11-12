// src/services/online-ordering/cuentaConBeneficios.ts
/**
 * D16: ¿la tienda invita a «Entrar»? La garantía va en UNA dirección: `false` NUNCA esconde algo que una clienta pueda usar con su
 * cuenta (regla del founder, 5-nov: los mensajes de premios sólo salen si la función está prendida). `true` de más es aceptable: la
 * tienda invita como antes. Sus pedidos, sus reservas y lo ya muerto (una tarjeta cancelada, vencida o en $0; un descuento o cupón
 * vencido o agotado) no cuentan. Es un superconjunto de lo vivo que enseñan «Mi cuenta» (`getCustomerPortal`) y la cotización con
 * sesión (`cotizarConBeneficios`: la oferta y el motor de descuentos).
 *  - Puntos (`LoyaltyConfig.active`) o sellos (`stampsEnabled`; el portal enseña la cartilla sin mirar `active`).
 *  - Tarjetas de regalo prendidas, o una tarjeta o sobre de saldo a favor con dinero y sin vencer, activa (la de nadie se puede
 *    guardar) o bloqueada con dueña (sale en su cuenta); se honra aunque se apaguen.
 *  - Un paquete ACTIVE sin vencer.
 *  - Un descuento activo, vigente hoy y no agotado que sea AUTOMÁTICO (en la tienda, el motor sólo lo aplica con sesión; su horario
 *    y su compra mínima no se miran), de un grupo con alguien o con una asignación vigente y no agotada (el tope por clienta, que
 *    pide su historial, no se mira).
 *  - Un cupón que la tienda ofrecería (el filtro de `ofertaDeBeneficios`) y que no esté agotado (los límites con los que el canje lo
 *    rechaza: los usos del código y el total del descuento).
 * Sólo lee, en UNA consulta de `EXISTS` sobre índices por negocio (`/ordering/info` es pública y se llama en cada carga de la tienda).
 * Sin caché: prender o apagar algo se ve en la siguiente carga.
 * ponytail: la tarjeta «con dinero» recorre las ACTIVE/BLOCKED del negocio por `[venueId, status]` hasta hallar una con saldo; con
 * decenas de miles de tarjetas gastadas, índice parcial `(venueId) WHERE balance > 0` o cachear el resultado unos segundos.
 */
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'

export async function cuentaConBeneficios(venueId: string, ahora: Date = new Date()): Promise<boolean> {
  const [fila] = await prisma.$queryRaw<Array<{ si: boolean }>>`
    SELECT (
      EXISTS (SELECT 1 FROM "LoyaltyConfig" l WHERE l."venueId" = ${venueId} AND (l.active OR l."stampsEnabled"))
      OR EXISTS (SELECT 1 FROM "GiftCardSettings" s WHERE s."venueId" = ${venueId} AND s.enabled)
      OR EXISTS (
        SELECT 1 FROM "GiftCard" g
        WHERE g."venueId" = ${venueId} AND (g.status = 'ACTIVE' OR (g.status = 'BLOCKED' AND g."customerId" IS NOT NULL)) AND g.balance > 0
          AND (g."expiresAt" IS NULL OR g."expiresAt" > ${utcTs(ahora)})
      )
      OR EXISTS (
        SELECT 1 FROM "CreditPackPurchase" p
        WHERE p."venueId" = ${venueId} AND p.status = 'ACTIVE' AND (p."expiresAt" IS NULL OR p."expiresAt" > ${utcTs(ahora)})
      )
      OR EXISTS (
        SELECT 1 FROM "Discount" d
        WHERE d."venueId" = ${venueId} AND d.active
          AND (d."validFrom" IS NULL OR d."validFrom" <= ${utcTs(ahora)}) AND (d."validUntil" IS NULL OR d."validUntil" >= ${utcTs(ahora)})
          AND (d."maxTotalUses" IS NULL OR d."currentUses" < d."maxTotalUses")
          AND (
            d."isAutomatic"
            OR EXISTS (SELECT 1 FROM "Customer" c WHERE c."customerGroupId" = d."customerGroupId" AND c."venueId" = d."venueId")
            OR EXISTS (
              SELECT 1 FROM "CustomerDiscount" cd
              WHERE cd."discountId" = d.id AND cd.active
                AND (cd."validFrom" IS NULL OR cd."validFrom" <= ${utcTs(ahora)}) AND (cd."validUntil" IS NULL OR cd."validUntil" >= ${utcTs(ahora)})
                AND (cd."maxUses" IS NULL OR cd."usageCount" < cd."maxUses")
            )
          )
      )
      OR EXISTS (
        SELECT 1 FROM "CouponCode" c JOIN "Discount" d ON d.id = c."discountId"
        WHERE d."venueId" = ${venueId} AND c.active AND d.active
          AND d.scope = 'ORDER' AND d."requiresApproval" = false AND d.type <> 'COMP'
          AND (c."maxUses" IS NULL OR c."currentUses" < c."maxUses") AND (d."maxTotalUses" IS NULL OR d."currentUses" < d."maxTotalUses")
          AND (c."validFrom" <= ${utcTs(ahora)} OR (c."validFrom" IS NULL AND (d."validFrom" IS NULL OR d."validFrom" <= ${utcTs(ahora)})))
          AND (c."validUntil" >= ${utcTs(ahora)} OR (c."validUntil" IS NULL AND (d."validUntil" IS NULL OR d."validUntil" >= ${utcTs(ahora)})))
      )
    ) AS si`
  return fila?.si === true
}
