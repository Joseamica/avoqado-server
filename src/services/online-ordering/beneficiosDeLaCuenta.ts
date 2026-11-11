// src/services/online-ordering/beneficiosDeLaCuenta.ts
/**
 * Tienda híbrida S14 (P2-3, P2-5, P2-8): de quién es la cuenta de un pedido en línea, qué beneficios trae y lo que le dio a su clienta;
 * D10: a qué hora se pagó (`horaDelPago`). Lo leen la Bandeja, «Por pagar» y «Por entregar», el seguimiento y el MCP. Sólo lee. 🔴 Nunca el teléfono ni el correo de la clienta:
 * de su ficha salen su id y su nombre corto. Módulo hoja (sin servicios de pedidos) para que la bandeja y el seguimiento lo compartan
 * sin ciclos de importación.
 */
import { LoyaltyTransactionType, Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { beneficiarioDeLaVenta } from '@/services/shared/beneficiarioDeLaVenta'
import { MOTIVO_BENEFICIO_REGRESADO } from './cortesiaDeFolio'

/** R1: las filas de descuento que se publican por cuenta; las demás se cuentan en `beneficiosTotal` («y N más»), nunca se esconden. */
export const MAX_BENEFICIOS = 10

/** R2: nombre de pila e inicial del apellido («Ana L.»); sin apellido, sólo el nombre; sin nombre, «Sin nombre». */
export function nombreCorto(c: { firstName: string | null; lastName: string | null }): string {
  const nombre = c.firstName?.trim()
  if (!nombre) return 'Sin nombre'
  const [inicial] = c.lastName?.trim() ?? ''
  return inicial ? `${nombre} ${inicial.toLocaleUpperCase('es-MX')}.` : nombre
}

const FICHA = { id: true, firstName: true, lastName: true } as const
/** Codex r1 #1: el primario de las ligas de la cuenta (lo que escribe la TPV al ligar), en la misma lectura de quien lista. */
const PRIMARIO = { where: { isPrimary: true }, orderBy: [{ addedAt: 'asc' as const }, { id: 'asc' as const }], take: 1 }

/** S14 (R2): de la ficha, sólo id y nombre; la del primario y la heredada, para decidir con la regla del otorgamiento. */
export const CLIENTA_SELECT = {
  customer: { select: FICHA },
  orderCustomers: { ...PRIMARIO, select: { customer: { select: FICHA } } },
} satisfies Prisma.OrderSelect

/** El seguimiento sólo necesita el id de la clienta (para «Sumaste»), con la misma regla. */
export const CLIENTA_ID_SELECT = {
  customerId: true,
  orderCustomers: { ...PRIMARIO, select: { customerId: true } },
} satisfies Prisma.OrderSelect

/** Codex r1 #1: la clienta es la misma que recibe la lealtad (`beneficiarioDeLaVenta`): el primario y, sin él, `Order.customerId`. */
export function clientaDeLaCuenta(
  o: Partial<Prisma.OrderGetPayload<{ select: typeof CLIENTA_SELECT }>>,
): { id: string; nombre: string } | null {
  const ficha = beneficiarioDeLaVenta(o.orderCustomers?.[0]?.customer, o.customer)
  return ficha ? { id: ficha.id, nombre: nombreCorto(ficha) } : null
}

export const clientaIdDeLaCuenta = (o: Partial<Prisma.OrderGetPayload<{ select: typeof CLIENTA_ID_SELECT }>>): string | null =>
  beneficiarioDeLaVenta(o.orderCustomers?.[0]?.customerId, o.customerId)

/** Las filas de descuento de la cuenta, en el orden en que se aplicaron, y cuántas son: en la MISMA consulta de quien lista (sin N+1). */
export const BENEFICIOS_SELECT = {
  orderDiscounts: {
    take: MAX_BENEFICIOS,
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    select: { name: true, amount: true, isComp: true, compReason: true },
  },
  _count: { select: { orderDiscounts: true } },
} satisfies Prisma.OrderSelect

type Filas = Prisma.OrderGetPayload<{ select: typeof BENEFICIOS_SELECT }>

export interface BeneficiosDeLaCuenta {
  beneficios: Array<{ nombre: string; monto: number }>
  beneficiosTotal: number
}

/** D10: hasta cuántos cobros se leen para decidir la hora; con más, no se sabe y se queda la llegada (como hoy). */
export const MAX_COBROS_DE_LA_HORA = 5

/**
 * D10: lo que decide el «Pagado a las…», en la MISMA lectura de quien lista (sin consulta por folio): los cobros reales (COMPLETED que
 * no son REFUND; `type` es nullable y `<> 'REFUND'` también descartaría NULL, como en `orderBalance`), el más reciente primero.
 */
export const HORA_DEL_PAGO_SELECT = {
  paymentStatus: true,
  loyaltySaleAt: true,
  payments: {
    where: { status: 'COMPLETED' as const, OR: [{ type: null }, { type: { not: 'REFUND' as const } }] },
    orderBy: { createdAt: 'desc' as const },
    take: MAX_COBROS_DE_LA_HORA,
    select: { createdAt: true, updatedAt: true },
  },
} satisfies Prisma.OrderSelect

/**
 * D10 (tienda híbrida, 11-nov): el «Pagado a las…» que se MUESTRA, igual en la Bandeja, «Por pagar»/«Por entregar» (TPV, POS y panel),
 * el MCP y el seguimiento de la clienta. `llegada` = el último cobro COMPLETED (lo de siempre). Si la caja de las apps saldó la cuenta
 * con un cobro de la cola sin red, `Order.loyaltySaleAt` guarda la hora del APARATO (acotada por arriba a su llegada, `horaDeLaVenta`):
 * esa se muestra, para que un folio cobrado a tiempo no parezca cobrado tarde. Sólo si se le puede creer, como en la regla C
 * (`cobradoATiempoEnTx`): no es anterior al folio (reloj del aparato sin hora) y, desde esa hora, sólo UN cobro nació o cambió, el que
 * saldó (Codex D10 r2: si otra caja cobró la otra mitad después y subió antes, la cuenta quedó pagada más tarde). Si no, la llegada. No
 * pagada o sin cobro legible: `null`. Instante ISO en UTC; cada app lo pinta en la zona del negocio. Sólo lee: cómo se guardan
 * `loyaltySaleAt` y los cobros no cambia.
 */
export function horaDelPago(
  o: { paymentStatus: string; loyaltySaleAt?: Date | null; payments?: Array<{ createdAt: Date; updatedAt?: Date }> },
  folioCreadoEn: Date,
): string | null {
  const cobros = o.payments ?? []
  const llegada = o.paymentStatus === 'PAID' ? cobros[0]?.createdAt : undefined
  if (!llegada) return null
  const t = o.loyaltySaleAt
  const despues = t ? cobros.filter(c => c.createdAt > t || (c.updatedAt ?? c.createdAt) > t).length : 0
  const creible = t && t >= folioCreadoEn && t <= llegada && despues === 1 && cobros.length < MAX_COBROS_DE_LA_HORA
  return (creible ? t : llegada).toISOString()
}

/** En pesos. `?? []`: una lectura sin la relación (un doble viejo) no tumba la lista; en Prisma siempre llega. */
export function beneficiosDeLaCuenta(o: Partial<Filas>): BeneficiosDeLaCuenta {
  const filas = o.orderDiscounts ?? []
  return {
    beneficios: filas.map(f => ({ nombre: f.name, monto: Number(new Prisma.Decimal(f.amount).toFixed(2)) })),
    beneficiosTotal: Math.max(o._count?.orderDiscounts ?? 0, filas.length),
  }
}

/**
 * P2-5: ¿lo que la clienta usó en este folio ya regresó a ella? S9 deja su fila como cortesía con `MOTIVO_BENEFICIO_REGRESADO`. Si la
 * cuenta trae más filas de las publicadas, se le pregunta a la base (R1: nunca se adivina por las primeras 10).
 */
export async function beneficioRegresado(orderId: string, o: Partial<Filas>): Promise<boolean> {
  const filas = o.orderDiscounts ?? []
  if (filas.some(f => f.isComp && f.compReason === MOTIVO_BENEFICIO_REGRESADO)) return true
  if ((o._count?.orderDiscounts ?? 0) <= filas.length) return false
  const fila = await prisma.orderDiscount.findFirst({
    where: { orderId, isComp: true, compReason: MOTIVO_BENEFICIO_REGRESADO },
    select: { id: true },
  })
  return fila !== null
}

/**
 * Codex r1 #3: el sello de la venta (su EARN) y si una devolución lo quitó (su REVERSAL): dos búsquedas, cada una por SU índice
 * parcial único `(venueId, orderId)` (`StampEvent_venueId_orderId_earn_unique` y `…_reversal_unique`). El tipo va escrito en el
 * texto, no como parámetro: así el planificador prueba el predicado del índice también con un plan genérico. Codex r1 #2: de la
 * cartilla que acreditó ese EARN sale su contador CANÓNICO de hoy (`stampsEarned`, el que cada movimiento mueve en su transacción) y su
 * meta congelada; nunca se reconstruye por fechas (el EARN guarda la hora de la venta, no la del otorgamiento).
 */
export const sqlSelloDeLaVenta = (venueId: string, orderId: string) => Prisma.sql`
  SELECT sc."customerId", sc."stampsEarned", sc."stampsRequired",
    EXISTS (
      SELECT 1 FROM "StampEvent" r WHERE r."venueId" = ${venueId} AND r."orderId" = ${orderId} AND r."type" = 'REVERSAL'
    ) AS "revertido"
  FROM "StampEvent" se
  JOIN "StampCard" sc ON sc."id" = se."stampCardId"
  WHERE se."venueId" = ${venueId} AND se."orderId" = ${orderId} AND se."type" = 'EARN'
  LIMIT 1`

interface SelloDeLaVenta {
  customerId: string
  stampsEarned: number
  stampsRequired: number
  revertido: boolean
}

export interface LealtadDeLaCuenta {
  sello?: { ganados: number; meta: number }
  puntos?: number
}

/**
 * P2-8, «Sumaste…»: lo que ESTA cuenta le dio a su clienta (la de `clientaIdDeLaCuenta`, la misma que recibió la lealtad). El sello,
 * si su EARN es de ella y una devolución no lo quitó, con el avance de HOY de la cartilla donde cayó («llevas 7 de 10»). Si esa
 * cartilla ya se llenó, dice «10 de 10»: es la verdad de esa cartilla y su premio nació ahí; el avance de la cartilla nueva no se mezcla
 * con esta venta. Si una devolución reabrió la cartilla, dice lo que quedó. Los puntos, de su EARN. Sólo con clienta y con el programa
 * prendido (`active`; el sello además con `stampsEnabled`). `null` si no hay nada que decir: nunca «no sumaste».
 * ponytail: los puntos son los del EARN; una devolución parcial posterior no se descuenta aquí (sí en «Mi cuenta»).
 */
export async function lealtadDeLaCuenta(p: {
  venueId: string
  orderId: string
  customerId: string | null
}): Promise<LealtadDeLaCuenta | null> {
  const customerId = p.customerId
  if (!customerId) return null
  const config = await prisma.loyaltyConfig.findUnique({ where: { venueId: p.venueId }, select: { active: true, stampsEnabled: true } })
  if (!config?.active) return null
  const [sellos, puntos] = await Promise.all([
    config.stampsEnabled ? prisma.$queryRaw<SelloDeLaVenta[]>(sqlSelloDeLaVenta(p.venueId, p.orderId)) : Promise.resolve([]),
    prisma.loyaltyTransaction.findFirst({
      where: { orderId: p.orderId, customerId, type: LoyaltyTransactionType.EARN },
      select: { points: true },
    }),
  ])
  const lealtad: LealtadDeLaCuenta = {}
  const [sello] = sellos ?? []
  if (sello && sello.customerId === customerId && !sello.revertido) {
    lealtad.sello = { ganados: sello.stampsEarned, meta: sello.stampsRequired }
  }
  if (puntos && puntos.points > 0) lealtad.puntos = puntos.points
  return lealtad.sello || lealtad.puntos ? lealtad : null
}
