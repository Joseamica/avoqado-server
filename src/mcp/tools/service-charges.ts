import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { planGateMessage } from '../planGate'
import { listServiceCharges, applyServiceCharge } from '@/services/mobile/service-charge.mobile.service'

export function registerServiceChargeTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'service_charges',
    'Los cobros por servicio configurados en un local al que tienes acceso: propina automática por grupo grande, descorche, cargo por entrega, etc. Para cada uno devuelve si es porcentaje o monto fijo, su valor, si causa IVA, y a partir de cuántos comensales se aplica solo. A DIFERENCIA de la propina (que va al mesero y no causa IVA), un cobro por servicio es ingreso GRAVABLE del negocio y suma al total de la cuenta. Responde "¿cobro servicio a grupos? ¿cuánto es el descorche?".',
    {
      venueId: z.string().describe('Venue whose service charges to read (must be in your scope)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      const gate = await planGateMessage(venueId, 'TABLE_SERVICE', 'El servicio de mesas')
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const charges = await listServiceCharges(venueId)
      if (charges.length === 0) {
        return text({ ok: true, charges: [], message: 'Este local no tiene cobros por servicio configurados.' })
      }
      return text({
        ok: true,
        charges: charges.map(c => ({
          id: c.id,
          nombre: c.name,
          valor: c.type === 'PERCENTAGE' ? `${c.value}%` : `$${c.value.toFixed(2)}`,
          causaIva: c.taxable,
          automatico: c.autoApplyMinCovers ? `desde ${c.autoApplyMinCovers} comensales` : 'solo manual',
        })),
      })
    },
  )

  server.tool(
    'apply_service_charge',
    '🔴 CRITICAL (mueve dinero en una cuenta abierta). Aplica un cobro por servicio (descorche, cargo por entrega, propina de grupo…) a una cuenta ABIERTA de un local al que tienes acceso: SUMA al total y cuenta como ingreso gravable del negocio. Pasa el orderId de la cuenta y el serviceChargeId del catálogo (usa service_charges para verlos). Por DEFECTO solo hace PREVIEW (total actual → total nuevo); llama otra vez con confirm:true para aplicarlo. Los cobros con regla por comensales se aplican SOLOS al cambiar el conteo, no hace falta esta herramienta. ESCRIBE — requiere orders:update.',
    {
      venueId: z.string().describe('Venue that owns the check (must be in your scope)'),
      orderId: z.string().describe('The OPEN order/check to charge'),
      serviceChargeId: z.string().describe('Catalog service-charge id (from service_charges)'),
      confirm: z.boolean().optional().describe('Must be true to actually apply; without it you get a preview'),
    },
    async ({ venueId, orderId, serviceChargeId, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('orders:update', venueId)
      const gate = await planGateMessage(venueId, 'TABLE_SERVICE', 'El servicio de mesas')
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const order = await prisma.order.findFirst({
        where: { id: orderId, venueId },
        select: { id: true, subtotal: true, discountAmount: true, total: true, paymentStatus: true },
      })
      if (!order) return text({ ok: false, error: 'No encontré esa cuenta en este local.' })
      if (order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIAL') {
        return text({ ok: false, error: 'Esa cuenta ya está pagada; no se le pueden agregar cobros.' })
      }

      const charge = await prisma.serviceCharge.findFirst({ where: { id: serviceChargeId, venueId, active: true } })
      if (!charge) return text({ ok: false, error: 'No encontré ese cobro por servicio en el catálogo del local.' })

      if (!confirm) {
        const base = Math.max(0, Number(order.subtotal) - Number(order.discountAmount))
        const amount = charge.type === 'PERCENTAGE' ? Math.round(((base * Number(charge.value)) / 100) * 100) / 100 : Number(charge.value)
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: {
            cobro: charge.name,
            monto: amount,
            totalActual: Number(order.total),
            totalNuevo: Math.round((Number(order.total) + amount) * 100) / 100,
          },
          message: `Esto agregará "${charge.name}" por $${amount.toFixed(2)} a la cuenta (total ${Number(order.total).toFixed(2)} → ${(Number(order.total) + amount).toFixed(2)}). Vuelve a llamar con confirm:true para aplicarlo.`,
        })
      }

      try {
        const totals = await applyServiceCharge(venueId, orderId, serviceChargeId, scope.staffId)
        await auditMcpWrite(scope, {
          action: 'ORDER_SERVICE_CHARGE_APPLIED',
          entity: 'Order',
          entityId: orderId,
          venueId,
          data: { serviceChargeId, name: charge.name },
        })
        return text({
          ok: true,
          cobro: charge.name,
          cargosTotales: totals.serviceChargeAmount,
          totalCuenta: totals.total,
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
