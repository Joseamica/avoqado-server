// tests/integration/staffPay/_ventas.ts — ventas, comisiones y propinas para las pruebas del sobre (fase 3).
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import type { Mundo } from './_mundo'

let n = 0
type PagoRef = { id: string; orderId: string; venueId: string }

/**
 * Activa pago al personal desde `desde` como lo hace la activación real (B9-B11): las sedes (`sedes`, por defecto la del
 * mundo) quedan ACTIVAS desde ese día (`StaffPayVenueWindow [desde, ∞)`) y, salvo `propinasDesde: null`, abre una ventana de
 * propinas (1-ago 00:00 CDMX). Desde B11 una venta o clase sin ancla desde el inicio exige que su sede esté activa ese día.
 */
export async function activar(m: Mundo, o: { desde?: string; propinasDesde?: string | null; sedes?: string[] } = {}) {
  const desde = o.desde ?? '2026-08-01'
  await prisma.organization.update({ where: { id: m.orgId }, data: { staffPayStartDate: fechaComoDbDate(desde) } })
  for (const venueId of o.sedes ?? [m.venueId]) await sedeActiva(m, venueId, desde)
  if (o.propinasDesde !== null) await ventana(m, o.propinasDesde ?? '2026-08-01T06:00:00Z', null)
}

/** Una ventana de participación de la sede: activa del día `desde` al `hasta` (incluido; null = sin fin). */
export const sedeActiva = (m: Mundo, venueId: string, desde: string, hasta: string | null = null) =>
  prisma.staffPayVenueWindow.create({
    data: {
      organizationId: m.orgId,
      venueId,
      desde: fechaComoDbDate(desde),
      hasta: hasta ? fechaComoDbDate(hasta) : null,
      activadaPor: m.owner,
      desactivadaPor: hasta ? m.owner : null,
    },
  })

export const ventana = (m: Mundo, desdeIso: string, hastaIso: string | null) =>
  prisma.staffPayTipWindow.create({
    data: {
      organizationId: m.orgId,
      startsAt: new Date(desdeIso),
      endsAt: hastaIso ? new Date(hastaIso) : null,
      startedById: m.owner,
      endedById: hastaIso ? m.owner : null,
    },
  })

/**
 * Un esquema de 3 %. E6a-fix F13: el nombre ya no trae la tasa («Lagree + Merch 3 %»): el recibo la lee de la comisión, así
 * que «Comisión Lagree + Merch 3 % · …» prueba que llegó de ahí y no del nombre.
 */
export async function esquema(m: Mundo, venueId = m.venueId, name = 'Lagree + Merch') {
  return (await prisma.commissionConfig.create({ data: { venueId, orgId: m.orgId, name, defaultRate: 0.03, createdById: m.owner } })).id
}

/** Una orden con su cobro. `servedById` / `processedById` deciden de quién es la propina. */
export async function cobro(
  m: Mundo,
  o: {
    iso: string
    monto?: number
    propina?: number
    servedById?: string | null
    processedById?: string | null
    venueId?: string
    type?: 'REGULAR' | 'FAST' | 'TEST'
    status?: 'COMPLETED' | 'FAILED'
  },
) {
  const venueId = o.venueId ?? m.venueId
  const monto = o.monto ?? 100
  const orden = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `${m.key}-${++n}`,
      subtotal: monto,
      taxAmount: 0,
      total: monto,
      servedById: o.servedById ?? null,
      createdAt: new Date(o.iso),
    },
  })
  return prisma.payment.create({
    data: {
      venueId,
      orderId: orden.id,
      amount: monto,
      tipAmount: o.propina ?? 0,
      method: 'CASH',
      status: o.status ?? 'COMPLETED',
      type: o.type ?? 'REGULAR',
      processedById: o.processedById ?? null,
      feePercentage: 0,
      feeAmount: 0,
      netAmount: monto + (o.propina ?? 0),
      createdAt: new Date(o.iso),
    },
  })
}

/** Un reembolso de `original` como lo guardan el dashboard y la TPV: venta y propina en negativo, `originalPaymentId`. */
export function reembolso(_m: Mundo, original: PagoRef, o: { iso: string; monto?: number; propina?: number }) {
  return prisma.payment.create({
    data: {
      venueId: original.venueId,
      orderId: original.orderId,
      amount: -(o.monto ?? 0),
      tipAmount: -(o.propina ?? 0),
      method: 'CASH',
      status: 'COMPLETED',
      type: 'REFUND',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: -((o.monto ?? 0) + (o.propina ?? 0)),
      processorData: { originalPaymentId: original.id },
      createdAt: new Date(o.iso),
    },
  })
}

/** Una fila de comisión ya calculada. Con `pago` = un reembolso, es el reverso de la comisión del cobro original. */
export function comision(
  m: Mundo,
  o: {
    configId: string
    staffId: string
    iso: string
    neto: number
    base?: number
    pago?: { id: string; orderId: string }
    venueId?: string
    status?: 'CALCULATED' | 'AGGREGATED' | 'VOIDED'
  },
) {
  return prisma.commissionCalculation.create({
    data: {
      venueId: o.venueId ?? m.venueId,
      staffId: o.staffId,
      configId: o.configId,
      paymentId: o.pago?.id ?? null,
      orderId: o.pago?.orderId ?? null,
      baseAmount: new Prisma.Decimal(o.base ?? 3000).times(Math.sign(o.neto) || 1),
      effectiveRate: 0.03,
      grossCommission: o.neto,
      netCommission: o.neto,
      calcType: 'PERCENTAGE',
      status: o.status ?? 'CALCULATED',
      calculatedAt: new Date(o.iso),
      ...(o.status === 'VOIDED' ? { voidedAt: new Date(o.iso), voidedBy: m.owner, voidReason: 'QA' } : {}),
    },
  })
}

/** Una línea ya congelada en un periodo (para probar «ya pagada»). */
export function congelar(
  m: Mundo,
  periodId: string,
  o: {
    fuente: 'COMMISSION' | 'TIP'
    sourceId: string
    staffId: string
    monto: number
    concepto?: 'SERVICE' | 'RECONCILE'
    venueId?: string
  },
) {
  return prisma.serviceEarning.create({
    data: {
      organizationId: m.orgId,
      venueId: o.venueId ?? m.venueId,
      periodId,
      staffId: o.staffId,
      concept: o.concepto ?? 'SERVICE',
      sourceType: o.fuente,
      sourceId: o.sourceId,
      amount: o.monto,
      descriptor: {
        fecha: '2026-08-05',
        hora: '12:00',
        sede: 'PN',
        persona: 'QA',
        orden: null,
        esquema: null,
        base: null,
        motivo: 'VENTA',
      },
    },
  })
}
