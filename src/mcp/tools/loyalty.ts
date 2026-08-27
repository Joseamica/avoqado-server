import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { adjustPoints, updateLoyaltyConfig } from '@/services/dashboard/loyalty.dashboard.service'
import { getCardDesign, saveCardDesign } from '@/services/wallet/cardDesign.service'
import { getStampCardStatus } from '@/services/wallet/stampLedger.service'
import { redeemStampReward } from '@/services/wallet/redeemStampReward.service'
import { getCustomerLoyalty, redeemPointsToOrder } from '@/services/mobile/loyalty.mobile.service'
import { planGateMessage } from '../planGate'

export function registerLoyaltyTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'loyalty_status',
    'The loyalty / rewards program settings for a venue you can access: whether it is active, points earned per dollar spent and per visit, the redemption rate (money value of one point), the minimum points needed to redeem, and after how many days points expire. Answers "¿cómo funciona mi programa de recompensas? ¿cuántos puntos doy por compra?". Pass venueId. (A specific customer\'s point balance is in find_customer.)',
    {
      venueId: z.string().describe('Venue whose loyalty program to read (must be in your scope)'),
    },
    async ({ venueId }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('loyalty:read', venueId) // WHY: mirror the dashboard's loyalty:read gate — loyalty economics (points rate, redemption) aren't free-for-all
      const gate = await planGateMessage(venueId, 'LOYALTY_PROGRAM', 'El programa de lealtad') // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      // Read the config directly (NOT the get-or-create service) so this read never writes a default row.
      const cfg = await prisma.loyaltyConfig.findFirst({
        where,
        select: {
          active: true,
          pointsPerDollar: true,
          pointsPerVisit: true,
          redemptionRate: true,
          minPointsRedeem: true,
          pointsExpireDays: true,
          stampsEnabled: true,
          stampsRequired: true,
          maxStampsPerDay: true,
          stampRewardType: true,
          stampRewardValue: true,
          stampRewardProductId: true,
          stampRewardLabel: true,
        },
      })
      return text({
        venueId,
        configured: !!cfg,
        program: cfg
          ? {
              active: cfg.active,
              pointsPerDollar: Number(cfg.pointsPerDollar),
              pointsPerVisit: cfg.pointsPerVisit,
              redemptionRate: Number(cfg.redemptionRate), // money value of 1 point
              minPointsToRedeem: cfg.minPointsRedeem,
              pointsExpireDays: cfg.pointsExpireDays, // null = never expire
            }
          : null,
      })
    },
  )

  server.tool(
    'adjust_loyalty_points',
    '🔴 CRITICAL (moves customer value). Manually add or remove loyalty points on a customer of a venue you can access — e.g. a goodwill bonus or correcting an error. Find the customer by name/email/phone; points is the CHANGE (positive adds, negative removes; balance can never go below 0); a reason is required. By DEFAULT this only PREVIEWS (current balance → new balance); to actually apply it call again with confirm:true. This WRITES — requires loyalty:adjust.',
    {
      venueId: z.string().describe('Venue that owns the customer (must be in your scope)'),
      search: z.string().min(1).describe('Customer name, email or phone (partial, case-insensitive)'),
      points: z.number().int().describe('Point CHANGE: positive adds (e.g. 100), negative removes (e.g. -50). NOT the new total.'),
      reason: z.string().min(1).describe('Why — required for the audit trail (e.g. "compensación por demora")'),
      confirm: z.boolean().optional().describe('Must be true to actually apply; without it you get a preview'),
    },
    async ({ venueId, search, points, reason, confirm }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('loyalty:adjust', venueId) // write gate (per-venue role)
      const gate = await planGateMessage(venueId, 'LOYALTY_PROGRAM', 'El programa de lealtad') // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      if (points === 0) return text({ ok: false, error: 'points no puede ser 0.' })

      const matches = await prisma.customer.findMany({
        where: {
          ...base,
          OR: [
            { firstName: { contains: search, mode: 'insensitive' as const } },
            { lastName: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
            { phone: { contains: search } },
          ],
        },
        select: { id: true, firstName: true, lastName: true, loyaltyPoints: true },
        orderBy: { totalSpent: 'desc' },
        take: 5,
      })
      if (matches.length === 0) {
        return text({ ok: false, error: `No encontré ningún cliente que coincida con "${search}" en este local.` })
      }
      if (matches.length > 1) {
        return text({
          ok: false,
          ambiguous: true,
          error: `"${search}" coincide con varios clientes — sé más específico.`,
          matches: matches.map(m => `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || '(sin nombre)'),
        })
      }

      const c = matches[0]
      const name = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || '(sin nombre)'
      const newBalance = c.loyaltyPoints + points
      if (newBalance < 0) {
        return text({ ok: false, error: `No se puede: dejaría el balance en ${newBalance} (tiene ${c.loyaltyPoints} puntos).` })
      }

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { customer: name, currentPoints: c.loyaltyPoints, change: points, newBalance, reason },
          message: `Esto ${points > 0 ? 'AGREGARÁ' : 'QUITARÁ'} ${Math.abs(points)} puntos a ${name} (${c.loyaltyPoints} → ${newBalance}). Vuelve a llamar con confirm:true para aplicar.`,
        })
      }

      // WHY: LoyaltyTransaction.createdById FKs to StaffVenue.id (NOT Staff.id). Passing
      // scope.staffId (a Staff.id) violates the FK → P2003 → the whole $transaction rolls
      // back, so the confirmed adjustment SILENTLY never persisted. Resolve the caller's
      // staff-venue row first, exactly like redeem_credit / the dashboard controller.
      const sv = await prisma.staffVenue.findFirst({ where: { staffId: scope.staffId, venueId }, select: { id: true } })
      if (!sv) return text({ ok: false, error: 'No pude resolver tu asignación a este local para registrar el ajuste de puntos.' })

      try {
        const result = await adjustPoints(venueId, c.id, points, reason, sv.id) // service re-validates + self-audits
        await auditMcpWrite(scope, {
          action: 'LOYALTY_POINTS_ADJUSTED',
          entity: 'Customer',
          entityId: c.id,
          venueId,
          data: { points, reason, newBalance: result.newBalance },
        })
        return text({ ok: true, customer: name, change: points, newBalance: result.newBalance })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'redeem_loyalty_on_check',
    '🔴 CRITICAL (moves customer value AND money on an open check). Redeem a customer\'s loyalty points as a discount on an OPEN check of a venue you can access — the POS "Recompensas" action. Find the customer by name/email/phone and pass the orderId of the open check. Points are burned and the matching discount is applied to the check in ONE transaction; if the points are worth more than the check, only the points actually needed are burned and the rest stay in the balance. Removing that discount later refunds the points automatically. By DEFAULT this only PREVIEWS (points → discount → new balance); call again with confirm:true to apply. This WRITES — requires orders:update.',
    {
      venueId: z.string().describe('Venue that owns the check and the customer (must be in your scope)'),
      orderId: z.string().describe('The OPEN order/check to discount'),
      search: z.string().min(1).describe('Customer name, email or phone (partial, case-insensitive)'),
      points: z.number().int().positive().describe('Points to redeem (positive integer)'),
      confirm: z.boolean().optional().describe('Must be true to actually apply; without it you get a preview'),
    },
    async ({ venueId, orderId, search, points, confirm }) => {
      const base = guard.venueFilter(venueId)
      guard.requirePermission('orders:update', venueId)
      const gate = await planGateMessage(venueId, 'LOYALTY_PROGRAM', 'El programa de lealtad')
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const matches = await prisma.customer.findMany({
        where: {
          ...base,
          OR: [
            { firstName: { contains: search, mode: 'insensitive' as const } },
            { lastName: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
            { phone: { contains: search } },
          ],
        },
        select: { id: true, firstName: true, lastName: true, loyaltyPoints: true },
        orderBy: { totalSpent: 'desc' },
        take: 5,
      })
      if (matches.length === 0) {
        return text({ ok: false, error: `No encontré ningún cliente que coincida con "${search}" en este local.` })
      }
      if (matches.length > 1) {
        return text({
          ok: false,
          ambiguous: true,
          error: `"${search}" coincide con varios clientes — sé más específico.`,
          matches: matches.map(m => `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || '(sin nombre)'),
        })
      }

      const c = matches[0]
      const name = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || '(sin nombre)'

      if (!confirm) {
        try {
          const status = await getCustomerLoyalty(venueId, c.id, orderId)
          const rate = status.redemptionRate
          const wouldBurn = Math.min(points, status.maxRedeemablePoints)
          return text({
            ok: false,
            requiresConfirmation: true,
            preview: {
              customer: name,
              currentPoints: status.balance,
              pointsToRedeem: wouldBurn,
              discount: Math.round(wouldBurn * rate * 100) / 100,
              newBalance: status.balance - wouldBurn,
              minPointsRedeem: status.minPointsRedeem,
            },
            message: `Esto canjeará ${wouldBurn} puntos de ${name} por $${(Math.round(wouldBurn * rate * 100) / 100).toFixed(2)} de descuento en la cuenta (quedaría con ${status.balance - wouldBurn}). Vuelve a llamar con confirm:true para aplicar.`,
          })
        } catch (err) {
          return text({ ok: false, error: (err as Error).message })
        }
      }

      try {
        const result = await redeemPointsToOrder(venueId, orderId, c.id, points, scope.staffId)
        await auditMcpWrite(scope, {
          action: 'LOYALTY_POINTS_REDEEMED',
          entity: 'Order',
          entityId: orderId,
          venueId,
          data: { customerId: c.id, points: result.pointsRedeemed, discountAmount: result.discountAmount },
        })
        return text({
          ok: true,
          customer: name,
          pointsRedeemed: result.pointsRedeemed,
          discountAmount: result.discountAmount,
          newBalance: result.newBalance,
          orderTotal: result.order.total,
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'configure_loyalty',
    "Configure (or activate/deactivate) the loyalty / rewards PROGRAM of a venue you can access: points earned per dollar spent, points per visit, the redemption rate (money value of one point, e.g. 0.05 = 5 centavos per point), the minimum points to redeem, and after how many days points expire (null/omit = never). Only the fields you pass are changed. Because this changes the program's MONEY economics (earning + redemption value), by DEFAULT it only PREVIEWS (current → new per field); call again with confirm:true to apply. This WRITES program settings (does NOT touch any customer's points — use adjust_loyalty_points for that); requires loyalty:update.",
    {
      venueId: z.string().describe('Venue whose program to configure (must be in your scope)'),
      active: z.boolean().optional().describe('Turn the program on/off'),
      pointsPerDollar: z.number().min(0).optional().describe('Points earned per $1 spent'),
      pointsPerVisit: z.number().int().min(0).optional().describe('Points earned per visit'),
      redemptionRate: z.number().min(0).optional().describe('Money value of 1 point (e.g. 0.05)'),
      minPointsToRedeem: z.number().int().min(0).optional().describe('Minimum points required to redeem'),
      pointsExpireDays: z.number().int().positive().nullable().optional().describe('Days until points expire; null = never'),
      stampsEnabled: z.boolean().optional().describe('Turn the STAMP card on/off (buy N, get a reward)'),
      stampsRequired: z.number().int().min(2).max(50).optional().describe('Stamps needed to fill one card'),
      maxStampsPerDay: z.number().int().min(1).optional().describe('Max stamps one customer earns per day'),
      stampRewardType: z
        .enum(['FREE_PRODUCT', 'FIXED_AMOUNT', 'PERCENTAGE'])
        .optional()
        .describe('What a full card wins: FREE_PRODUCT (priciest item on the check), FIXED_AMOUNT or PERCENTAGE'),
      stampRewardValue: z.number().min(0).nullable().optional().describe('Amount ($) or percentage (0-100) of the reward'),
      stampRewardProductId: z.string().nullable().optional().describe('Product the reward refers to; must belong to the venue'),
      stampRewardLabel: z.string().min(1).max(60).optional().describe('How the reward reads on the wallet card'),
      confirm: z.boolean().optional().describe('Must be true to actually apply; without it you get a preview (current → new)'),
    },
    async ({
      venueId,
      active,
      pointsPerDollar,
      pointsPerVisit,
      redemptionRate,
      minPointsToRedeem,
      pointsExpireDays,
      stampsEnabled,
      stampsRequired,
      maxStampsPerDay,
      stampRewardType,
      stampRewardValue,
      stampRewardProductId,
      stampRewardLabel,
      confirm,
    }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('loyalty:update', venueId) // write gate (per-venue role)
      const planGate = await planGateMessage(venueId, 'LOYALTY_PROGRAM', 'El programa de lealtad') // PRO tier
      if (planGate) return text({ ok: false, planRequired: true, error: planGate })
      const data = {
        ...(active !== undefined ? { active } : {}),
        ...(pointsPerDollar !== undefined ? { pointsPerDollar } : {}),
        ...(pointsPerVisit !== undefined ? { pointsPerVisit } : {}),
        ...(redemptionRate !== undefined ? { redemptionRate } : {}),
        ...(minPointsToRedeem !== undefined ? { minPointsRedeem: minPointsToRedeem } : {}),
        ...(pointsExpireDays !== undefined ? { pointsExpireDays } : {}),
        ...(stampsEnabled !== undefined ? { stampsEnabled } : {}),
        ...(stampsRequired !== undefined ? { stampsRequired } : {}),
        ...(maxStampsPerDay !== undefined ? { maxStampsPerDay } : {}),
        ...(stampRewardType !== undefined ? { stampRewardType } : {}),
        ...(stampRewardValue !== undefined ? { stampRewardValue } : {}),
        ...(stampRewardProductId !== undefined ? { stampRewardProductId } : {}),
        ...(stampRewardLabel !== undefined ? { stampRewardLabel } : {}),
      }
      if (Object.keys(data).length === 0) return text({ ok: false, error: 'No pasaste ningún campo para configurar.' })

      if (!confirm) {
        // Money economics change → preview current → new so a typo (e.g. redemptionRate 0.05 → 100) is caught.
        // Read DIRECTLY (not getLoyaltyConfig, which get-or-CREATEs an active program) so a PREVIEW
        // never writes/activates a live loyalty program on a venue that has none. Mirrors loyalty_status.
        const cur = (await prisma.loyaltyConfig.findFirst({
          where,
          select: {
            active: true,
            pointsPerDollar: true,
            pointsPerVisit: true,
            redemptionRate: true,
            minPointsRedeem: true,
            pointsExpireDays: true,
          },
        })) as Record<string, unknown> | null
        const LBL: Record<string, string> = {
          active: 'Programa activo',
          pointsPerDollar: 'Puntos por $1',
          pointsPerVisit: 'Puntos por visita',
          redemptionRate: 'Valor de 1 punto ($)',
          minPointsRedeem: 'Mínimo para canjear',
          pointsExpireDays: 'Días para expirar',
          stampsEnabled: 'Tarjeta de sellos activa',
          stampsRequired: 'Sellos para llenar la cartilla',
          maxStampsPerDay: 'Tope de sellos por dia',
          stampRewardType: 'Tipo de premio',
          stampRewardValue: 'Valor del premio',
          stampRewardProductId: 'Producto del premio',
          stampRewardLabel: 'Como se lee el premio',
        }
        const num = (v: unknown) => (v != null && typeof v === 'object' && 'toString' in v ? Number(v) : v)
        const changes = Object.entries(data).map(([k, to]) => ({ label: LBL[k] ?? k, from: cur ? (num(cur[k]) ?? null) : null, to }))
        return text({
          ok: false,
          requiresConfirmation: true,
          changes,
          message: `Esto cambiará la economía del programa de lealtad:\n${changes.map(c => `• ${c.label}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`).join('\n')}\n\nConfirma con el operador; luego vuelve a llamar con confirm:true.`,
        })
      }

      try {
        const cfg = await updateLoyaltyConfig(venueId, data) // service validates non-negative etc.
        await auditMcpWrite(scope, {
          action: 'LOYALTY_CONFIG_UPDATED',
          entity: 'LoyaltyConfig',
          entityId: (cfg as { id?: string })?.id ?? venueId,
          venueId,
          data,
        })
        return text({
          ok: true,
          program: {
            active: (cfg as { active: boolean }).active,
            pointsPerDollar: Number((cfg as { pointsPerDollar: unknown }).pointsPerDollar),
            pointsPerVisit: (cfg as { pointsPerVisit: number }).pointsPerVisit,
            redemptionRate: Number((cfg as { redemptionRate: unknown }).redemptionRate),
            minPointsToRedeem: (cfg as { minPointsRedeem: number }).minPointsRedeem,
            pointsExpireDays: (cfg as { pointsExpireDays: number | null }).pointsExpireDays,
          },
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  // ==========================================
  // CREDENCIAL DEL CLIENTE — como se VE la tarjeta
  // ==========================================

  server.tool(
    'wallet_card_design',
    "Read how a venue's customer wallet card LOOKS: its colours (card background, text, labels, the stamp band, and the stamps themselves), the shape of the stamps, and whether the venue uploaded its own logo and icon. This is the card customers keep in Apple Wallet, so it carries the VENUE's branding, not Avoqado's. A venue that never configured it returns the default theme colours rather than an error. Read-only; requires loyalty:read.",
    {
      venueId: z.string().describe('Venue whose card design to read (must be in your scope)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('loyalty:read', venueId)
      const planGate = await planGateMessage(venueId, 'LOYALTY_PROGRAM', 'La credencial del cliente')
      if (planGate) return text({ ok: false, planRequired: true, error: planGate })

      const design = await getCardDesign(venueId)
      return text({
        ok: true,
        design,
        // Se dice explicitamente: un operador que pregunta por su tarjeta quiere
        // saber si esta saliendo con la marca de Avoqado o con la suya.
        usandoLogoPropio: Boolean(design.logoUrl),
        usandoIconoPropio: Boolean(design.iconUrl),
      })
    },
  )

  server.tool(
    'configure_wallet_card',
    "Change how a venue's customer wallet card LOOKS: its colours (given as #RRGGBB), the shape of the stamps (CIRCLE, STAR, HEART or SQUARE), and the URLs of its own logo and icon images. Only the fields you pass change; anything you omit keeps its current value. Because EVERY customer of that venue sees this card on their phone, by DEFAULT it only PREVIEWS (current → new per field); call again with confirm:true to apply. Requires loyalty:update.",
    {
      venueId: z.string().describe('Venue whose card to restyle (must be in your scope)'),
      backgroundColor: z.string().optional().describe('Card background, #RRGGBB'),
      textColor: z.string().optional().describe('Colour of the values, #RRGGBB'),
      labelColor: z.string().optional().describe('Colour of the small labels, #RRGGBB'),
      stripColor: z.string().optional().describe('Background of the stamp band, #RRGGBB'),
      stampFilledColor: z.string().optional().describe('Colour of an earned stamp, #RRGGBB'),
      stampEmptyColor: z.string().nullable().optional().describe('Outline of a missing stamp; null = derive it from the earned colour'),
      stampShape: z.enum(['CIRCLE', 'STAR', 'HEART', 'SQUARE']).optional().describe('Shape of each stamp'),
      logoUrl: z.string().nullable().optional().describe("https URL of the venue's own logo image; null removes it"),
      iconUrl: z.string().nullable().optional().describe("https URL of the venue's own icon image; null removes it"),
      confirm: z.boolean().optional().describe('Must be true to actually apply; without it you get a preview (current → new)'),
    },
    async ({ venueId, confirm, ...campos }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('loyalty:update', venueId)
      const planGate = await planGateMessage(venueId, 'LOYALTY_PROGRAM', 'La credencial del cliente')
      if (planGate) return text({ ok: false, planRequired: true, error: planGate })

      const patch = Object.fromEntries(Object.entries(campos).filter(([, v]) => v !== undefined))
      if (Object.keys(patch).length === 0) return text({ ok: false, error: 'No pasaste ningún campo para cambiar.' })

      const actual = await getCardDesign(venueId)

      const LBL: Record<string, string> = {
        backgroundColor: 'Fondo de la tarjeta',
        textColor: 'Color del texto',
        labelColor: 'Color de las etiquetas',
        stripColor: 'Fondo de la banda de sellos',
        stampFilledColor: 'Sello ganado',
        stampEmptyColor: 'Sello que falta',
        stampShape: 'Forma del sello',
        logoUrl: 'Logo del negocio',
        iconUrl: 'Icono del negocio',
      }

      if (!confirm) {
        // 🔴 Vista previa obligatoria: esto lo ve TODO cliente del negocio en su
        // telefono, y un color equivocado no da ningun error — Apple lo ignora y
        // pinta la tarjeta gris. Que un humano lea el cambio antes es la unica
        // barrera contra una peticion vaga malinterpretada.
        const changes = Object.entries(patch).map(([k, to]) => ({
          label: LBL[k] ?? k,
          from: (actual as unknown as Record<string, unknown>)[k] ?? null,
          to,
        }))
        return text({
          ok: false,
          requiresConfirmation: true,
          changes,
          message: `Esto cambiará cómo ven su tarjeta TODOS los clientes de este negocio:\n${changes
            .map(c => `• ${c.label}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`)
            .join('\n')}\n\nConfirma con el operador; luego vuelve a llamar con confirm:true.`,
        })
      }

      try {
        // El servicio valida el formato de cada color: un valor invalido se rechaza
        // aqui y nunca llega a la tarjeta de nadie.
        const design = await saveCardDesign(venueId, patch as Parameters<typeof saveCardDesign>[1])
        await auditMcpWrite(scope, {
          action: 'WALLET_CARD_DESIGN_UPDATED',
          entity: 'WalletCardDesign',
          entityId: venueId,
          venueId,
          data: patch,
        })
        return text({ ok: true, design })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  // ==========================================
  // CARTILLA DE SELLOS — avance y canje del premio
  // ==========================================

  server.tool(
    'stamp_card_status',
    "Read a customer's stamp card at a venue: how many stamps they have on the card in progress, how many that card needs, what the reward is, and how many rewards they already earned but have not claimed yet. Note the required count comes from the CARD, not from the current settings — a card keeps the rule it was opened with, so a customer half-way through is not affected when the venue changes the target. Read-only; requires loyalty:read.",
    {
      venueId: z.string().describe('Venue whose card to read (must be in your scope)'),
      customerId: z.string().describe('Customer whose card to read'),
    },
    async ({ venueId, customerId }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('loyalty:read', venueId)
      const planGate = await planGateMessage(venueId, 'LOYALTY_PROGRAM', 'El programa de lealtad')
      if (planGate) return text({ ok: false, planRequired: true, error: planGate })

      const estado = await getStampCardStatus(venueId, customerId)
      const pendientes = await prisma.stampReward.findMany({
        where: { venueId, customerId, status: 'PENDING' },
        select: { id: true, rewardLabel: true, rewardType: true, expiresAt: true },
        orderBy: { createdAt: 'asc' },
      })

      return text({ ok: true, ...estado, rewardsToClaim: pendientes })
    },
  )

  server.tool(
    'redeem_stamp_reward',
    "Apply a customer's earned stamp-card reward to an OPEN bill, as a discount. This LOWERS what the customer pays, so by DEFAULT it only PREVIEWS what would happen; call again with confirm:true to actually apply it. It refuses on a bill that is already paid or partly paid, on a reward that was already claimed or has expired, and on a bill with nothing left to discount. A percentage reward is computed on the bill, and a free-product reward takes the most expensive item on it so the customer never pays a difference. Requires loyalty:redeem.",
    {
      venueId: z.string().describe('Venue where the bill is open (must be in your scope)'),
      orderId: z.string().describe('The open bill to apply the reward to'),
      rewardId: z.string().describe('The earned reward to claim (see stamp_card_status)'),
      confirm: z.boolean().optional().describe('Must be true to actually apply it; without it you get a preview'),
    },
    async ({ venueId, orderId, rewardId, confirm }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('loyalty:redeem', venueId) // 🔴 dinero: permiso propio, no `loyalty:update`
      const planGate = await planGateMessage(venueId, 'LOYALTY_PROGRAM', 'El programa de lealtad')
      if (planGate) return text({ ok: false, planRequired: true, error: planGate })

      if (!confirm) {
        // 🔴 Vista previa obligatoria: esto REGALA producto. Un id equivocado
        // interpretado de una petición vaga sale del inventario de alguien.
        const premio = await prisma.stampReward.findFirst({
          where: { id: rewardId, ...where },
          select: { rewardLabel: true, status: true, expiresAt: true },
        })
        if (!premio) return text({ ok: false, error: 'Ese premio no existe en este negocio.' })

        const cuenta = await prisma.order.findFirst({
          where: { id: orderId, ...where },
          select: { orderNumber: true, total: true, paymentStatus: true },
        })
        if (!cuenta) return text({ ok: false, error: 'Esa cuenta no existe en este negocio.' })

        return text({
          ok: false,
          requiresConfirmation: true,
          reward: premio.rewardLabel,
          rewardStatus: premio.status,
          order: { number: cuenta.orderNumber, total: Number(cuenta.total), paymentStatus: cuenta.paymentStatus },
          message:
            `Vas a aplicar "${premio.rewardLabel}" a la cuenta ${cuenta.orderNumber}, que hoy va en $${Number(cuenta.total).toFixed(2)}.\n` +
            'El premio se quema y no se puede volver a usar. Confirma con el operador; luego vuelve a llamar con confirm:true.',
        })
      }

      try {
        const r = await redeemStampReward(venueId, orderId, rewardId, { staffId: scope.staffId })
        // El servicio ya escribe su propio ActivityLog; esto deja además el rastro
        // de que la acción vino del MCP y no del mostrador.
        await auditMcpWrite(scope, {
          action: 'STAMP_REWARD_REDEEMED',
          entity: 'StampReward',
          entityId: rewardId,
          venueId,
          data: { orderId, discountAmount: r.discountAmount },
        })
        return text({ ok: true, applied: r.rewardLabel, discountAmount: r.discountAmount })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
