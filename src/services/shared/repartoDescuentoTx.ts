/**
 * IVA por producto, bloque B2: lecturas y la ÚNICA escritura de repartos, con la transacción de quien YA tiene el candado de
 * la orden (o la está creando en privado). Lecturas acotadas a UNA orden; inventariadas en `findManySinTopeGuard`.
 */
import { Prisma } from '@prisma/client'
import { BadRequestError } from '../../errors/AppError'
import { buildItemDiscountRow } from './discount.service'
import {
  aCentavos,
  comoJson,
  impuestoQueSeLlevan,
  leerReparto,
  mismoReparto,
  nuevoRepartoDirigido,
  recorteDeFila,
  reduccionDeImpuestoCobrado,
  reduccionesQueNoVuelven,
  repartosDeLaOrden,
  type FilaParaReparto,
  type RenglonParaReparto,
  type RepartoDescuento,
} from './repartoDescuento'

export const RENGLON_PARA_REPARTO_SELECT = {
  id: true,
  total: true,
  discountAmount: true,
  orderPromotionId: true,
  isCortesia: true,
  taxAmount: true,
  productId: true,
  product: { select: { categoryId: true } },
} as const satisfies Prisma.OrderItemSelect

/**
 * R3-2 (spec §4.1): quitar una fila ESPEJO quita también el descuento que duplicaba en su renglón, en la misma transacción.
 * Con reparto, manda `reparto.espejo`; sin reparto (fila de antes de B2) se reconoce la forma de los dos escritores de
 * espejos: la de `buildItemDiscountRow` (un renglón ligado al mismo descuento) y la cortesía de «Cobrar» (COMP sin
 * `discountId` sobre renglones en cortesía). Devuelve los renglones que cambió.
 */
export async function revertirDescuentoDelRenglon(
  tx: Prisma.TransactionClient,
  orderId: string,
  fila: {
    id: string
    discountId?: string | null
    type?: string
    isComp?: boolean
    amount: unknown
    appliedToItemIds?: string[] | null
    reparto?: unknown
  },
): Promise<string[]> {
  const reparto = leerReparto(fila.reparto)
  if (reparto && !reparto.espejo) return []
  const ids = reparto ? Object.keys(reparto.renglones) : (fila.appliedToItemIds ?? [])
  if (ids.length === 0) return []
  const renglones = await tx.orderItem.findMany({
    where: { orderId, id: { in: ids } },
    select: { id: true, discountAmount: true, appliedDiscountId: true, isCortesia: true },
    take: ids.length,
  })
  const liga = fila.discountId ?? null
  const cortesiaDeCobrar = fila.isComp === true && fila.type === 'COMP'
  const formaVieja =
    !reparto &&
    ((ids.length === 1 && liga !== null && renglones[0]?.appliedDiscountId === liga) ||
      // Codex r1 P2: la cortesía de «Cobrar» nunca lleva `discountId`; una fila COMP del catálogo (de cuenta) sí, y sus
      // renglones pueden tener una cortesía INDEPENDIENTE que no se toca.
      (cortesiaDeCobrar && liga === null && renglones.length === ids.length && renglones.every(x => x.isCortesia)))
  if (!reparto && !formaVieja) return []
  const tocados: string[] = []
  for (const x of renglones) {
    const quitar = reparto ? (reparto.renglones[x.id] ?? 0) : Math.min(aCentavos(x.discountAmount), aCentavos(fila.amount))
    const queda = Math.max(0, aCentavos(x.discountAmount) - quitar)
    // F2b: el espejo que normaliza `conservarDescuentoHistorico` no lleva `discountId`; si deja el renglón sin descuento, la liga
    // del renglón al catálogo ya no describe nada y se limpia igual.
    const sueltaLiga = x.appliedDiscountId !== null && (x.appliedDiscountId === liga || (liga === null && queda === 0))
    await tx.orderItem.update({
      where: { id: x.id },
      data: {
        discountAmount: new Prisma.Decimal(queda).div(100),
        ...(sueltaLiga ? { appliedDiscountId: null } : {}),
        ...(cortesiaDeCobrar && x.isCortesia && x.appliedDiscountId === null ? { isCortesia: false, cortesiaReason: null } : {}),
      },
    })
    tocados.push(x.id)
  }
  return tocados
}

export function renglonesParaReparto(tx: Prisma.TransactionClient, orderId: string): Promise<RenglonParaReparto[]> {
  return tx.orderItem.findMany({ where: { orderId }, select: RENGLON_PARA_REPARTO_SELECT })
}

/** Las filas de descuento de UNA orden, bajo el candado de quien llama. */
export function filasDeLaOrden(tx: Prisma.TransactionClient, orderId: string) {
  return tx.orderDiscount.findMany({ where: { orderId } })
}

/**
 * Revisión final de B2 (Codex r1 P1): `Order.discountAmount` puede traer más que la suma de sus filas — una orden anterior a
 * B2 (descuento sólo en la cabecera), un `applyDiscount` sin renglones, la cortesía de `compItems` (hasta B2c), delivery o
 * POS importado. Los recálculos reconstruyen la cabecera desde las filas en cuanto existe UNA, así que la primera fila nueva
 * borraría ese resto (cobro de más). Quien va a crear una fila sobre una orden existente llama esto ANTES, con el tx y bajo
 * el candado que ya tiene, y con la cabecera que leyó bajo él: el resto (centavos enteros, sólo si es mayor que 0) queda en
 * su propia fila FIJA, SIN reparto (D8: importe congelado, nunca se re-deriva ni se le inventa a qué renglones tocó).
 *
 * B2c F2 (Codex r1 #3, #4): ANTES de congelarlo, la parte del resto que es de un renglón IDENTIFICABLE gana su fila espejo — la
 * cortesía vieja de la terminal (COMP, como `compItems`) y el descuento propio de un renglón que no es de promoción (como
 * `buildItemDiscountRow`; la regla de `descuentoPropio` del vale), con total y descuento > 0 y sin espejo (forma nueva o las
 * dos viejas de `revertirDescuentoDelRenglon`) —, tomando sólo del resto y por id. Así el recorte retira ese descuento al borrar
 * el renglón y el vale no lo cuenta dos veces. El cobro no cambia: Σ filas = la cabecera de antes.
 */
export async function conservarDescuentoHistorico(
  tx: Prisma.TransactionClient,
  orderId: string,
  descuentoDeCabecera: unknown,
): Promise<void> {
  const filas = await filasDeLaOrden(tx, orderId)
  let resto = aCentavos(descuentoDeCabecera) - filas.reduce((s, f) => s + aCentavos(f.amount), 0)
  if (resto <= 0) return
  const renglones = await tx.orderItem.findMany({
    where: { orderId },
    select: {
      id: true,
      total: true,
      discountAmount: true,
      orderPromotionId: true,
      isCortesia: true,
      cortesiaReason: true,
      appliedDiscountId: true,
      appliedDiscount: { select: { id: true, type: true, name: true, value: true, compReason: true } },
    },
  })
  const espejados = renglonesConEspejo(filas, renglones)
  for (const r of [...renglones].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (resto <= 0) break
    if (aCentavos(r.total) <= 0 || aCentavos(r.discountAmount) <= 0 || espejados.has(r.id)) continue
    if (!r.isCortesia && r.orderPromotionId) continue
    const cents = Math.min(aCentavos(r.discountAmount), resto)
    resto -= cents
    const monto = new Prisma.Decimal(cents).div(100)
    await tx.orderDiscount.create({
      data: r.isCortesia
        ? {
            orderId,
            type: 'COMP',
            name: 'Cortesía',
            value: new Prisma.Decimal(100),
            amount: monto,
            taxReduction: 0,
            isComp: true,
            isManual: true,
            compReason: r.cortesiaReason,
            appliedById: null,
            appliedToItemIds: [r.id],
            reparto: comoJson(nuevoRepartoDirigido(monto, { [r.id]: monto }, { espejo: true })),
          }
        : buildItemDiscountRow({
            orderId,
            itemId: r.id,
            // F2b (Codex r2): SIN `discountId` aunque venga del catálogo — este espejo nunca consumió un uso; ligado, quitarlo lo
            // «devolvía» (`currentUses` −1) y contaba como uso del cliente. Del catálogo conserva nombre, tipo y valor.
            discount: r.appliedDiscount
              ? { ...r.appliedDiscount, id: null }
              : { id: null, type: 'FIXED_AMOUNT', name: 'Descuento del artículo', value: monto },
            discountAmountPesos: cents / 100,
            appliedById: null,
          }),
    })
  }
  if (resto <= 0) return
  const monto = new Prisma.Decimal(resto).div(100)
  await tx.orderDiscount.create({
    data: { orderId, type: 'FIXED_AMOUNT', name: 'Descuento anterior', value: monto, amount: monto, taxReduction: 0, isManual: true },
  })
}

/** Los renglones cuyo descuento ya duplica una fila espejo: con reparto, la marca; sin él, las dos formas viejas de revertir. */
function renglonesConEspejo(
  filas: Array<{ type: string; isComp: boolean; discountId: string | null; appliedToItemIds: string[]; reparto: unknown }>,
  renglones: Array<{ id: string; appliedDiscountId: string | null; isCortesia: boolean }>,
): Set<string> {
  const porId = new Map(renglones.map(r => [r.id, r] as const))
  const con = new Set<string>()
  for (const f of filas) {
    const reparto = leerReparto(f.reparto)
    const ids = f.appliedToItemIds ?? []
    if (reparto) {
      if (reparto.espejo) Object.keys(reparto.renglones).forEach(id => con.add(id))
    } else if (ids.length === 1 && f.discountId && porId.get(ids[0])?.appliedDiscountId === f.discountId) con.add(ids[0])
    else if (f.isComp && f.type === 'COMP' && !f.discountId && ids.length > 0 && ids.every(id => porId.get(id)?.isCortesia))
      ids.forEach(id => con.add(id))
  }
  return con
}

/**
 * Deja los repartos de la orden en su forma canónica. Quien ya leyó renglones y filas los pasa (un recálculo, que además pasa
 * los importes que re-derivó); si no, se leen aquí. UNA actualización por fila: el importe re-derivado (siempre que lo haya,
 * como hoy), el reparto (si cambió) y la reducción de impuesto de D16 (si cambió). Lo que esa reducción devuelve a
 * `Order.taxAmount` (o le quita) se escribe aquí mismo y se devuelve en `impuestoDevuelto`: quien guarda el total lo suma.
 * Un error de base sale tal cual.
 */
export async function sincronizarRepartos(
  tx: Prisma.TransactionClient,
  orderId: string,
  o: { renglones?: RenglonParaReparto[]; filas?: FilaParaReparto[]; montosRederivados?: ReadonlyMap<string, number> } = {},
): Promise<{ repartos: Map<string, RepartoDescuento>; impuestoDevuelto: Prisma.Decimal }> {
  const renglones = o.renglones ?? (await renglonesParaReparto(tx, orderId))
  const leidas = o.filas ?? (await filasDeLaOrden(tx, orderId))
  const montos = o.montosRederivados ?? new Map<string, number>()
  const filas = leidas.map(f => (montos.has(f.id) ? { ...f, amount: montos.get(f.id) } : f))
  const finales = repartosDeLaOrden(renglones, filas, { rederivadas: new Set(montos.keys()) })
  // B2b (D16; Codex r1 #3, r2 N3, r3 V3/V4): la reducción de una fila que PARTICIPA en D16 (su reparto lo marca; la guardada
  // puede ser 0) se recalcula en CADA sincronización si la orden cobra el impuesto aparte —aunque su reparto no cambie: D16
  // depende también del importe y del impuesto de cada renglón (V4)— y éste es el ÚNICO lugar que la escribe, también la
  // primera vez: la fila nueva del motor nace en 0 (V3). Se escribe sólo si cambia, y la diferencia vuelve a `Order.taxAmount`
  // aquí mismo. Las que no participan (las viejas del 16 % incluidas) conservan lo que restaron. El tope de cabecera se gasta
  // en orden de `id` (preflight R-8: determinista; sólo pesa si la cabecera topa).
  const nuevasReducciones = new Map<string, number>()
  let impuestoDevuelto = new Prisma.Decimal(0)
  const participan = filas.filter(f => finales.get(f.id)?.reduceImpuesto === true).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (participan.length > 0) {
    const orden = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { contratoDePrecio: true, taxAmount: true } })
    if (orden.contratoDePrecio === 'IVA_APARTE') {
      const guardadaDe = (f: FilaParaReparto) => new Prisma.Decimal(String(f.taxReduction ?? 0))
      let disponible = participan.reduce((s, f) => s.plus(guardadaDe(f)), new Prisma.Decimal(orden.taxAmount))
      for (const f of participan) {
        const nueva = reduccionDeImpuestoCobrado(orden.contratoDePrecio, finales.get(f.id)!.renglones, renglones, disponible)
        disponible = disponible.minus(nueva)
        if (guardadaDe(f).equals(nueva)) continue
        nuevasReducciones.set(f.id, nueva)
        impuestoDevuelto = impuestoDevuelto.plus(guardadaDe(f)).minus(nueva)
      }
    }
  }
  for (const fila of filas) {
    const final = finales.get(fila.id)
    const cambia = final && !mismoReparto(leerReparto(fila.reparto), final)
    const data: Prisma.OrderDiscountUpdateInput = {}
    if (montos.has(fila.id)) data.amount = montos.get(fila.id)
    if (cambia) data.reparto = comoJson(final)
    if (nuevasReducciones.has(fila.id)) data.taxReduction = nuevasReducciones.get(fila.id)
    if (Object.keys(data).length > 0) await tx.orderDiscount.update({ where: { id: fila.id }, data })
  }
  if (!impuestoDevuelto.isZero()) await tx.order.update({ where: { id: orderId }, data: { taxAmount: { increment: impuestoDevuelto } } })
  return { repartos: finales, impuestoDevuelto }
}

/**
 * R9 (Codex r4 R4-1): baja `Order.taxAmount` por el IVA que se llevan los renglones que SALEN, en la transacción y bajo el
 * candado de quien llama, y devuelve lo retirado (≥ 0; ya escrito). Quien llama la corre ANTES de cualquier devolución o
 * re-reparto de reducciones (el recorte de B2c, `sincronizarRepartos`): así ninguno cuenta como disponible el IVA de lo que se
 * va. Sin IVA en lo que sale —toda venta nativa— no lee ni escribe nada. Con una reducción heredada en la orden rechaza la
 * operación ANTES de escribir (Codex r5 #1): el operador quita primero ese descuento, que devuelve lo suyo.
 */
export async function retirarImpuestoDeRenglones(
  tx: Prisma.TransactionClient,
  orderId: string,
  salen: Array<{ taxAmount?: unknown }>,
): Promise<Prisma.Decimal> {
  const cero = new Prisma.Decimal(0)
  if (!salen.some(r => new Prisma.Decimal(String(r.taxAmount ?? 0)).gt(0))) return cero
  const orden = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { contratoDePrecio: true, taxAmount: true } })
  if (orden.contratoDePrecio === 'IVA_INCLUIDO') return cero
  const filas = await filasDeLaOrden(tx, orderId)
  const heredadas = reduccionesQueNoVuelven(orden.contratoDePrecio, filas)
  if (heredadas.length > 0) {
    throw new BadRequestError(
      'Esta cuenta tiene un descuento que restó IVA con la regla anterior. Quita primero ese descuento (su IVA regresa a la cuenta) y vuelve a quitar el artículo.',
      'DESCUENTO_CON_IVA_ANTERIOR',
      { descuentos: heredadas.map(f => ({ id: f.id, name: f.name })) },
    )
  }
  // Ya sin heredadas, toda reducción que quede vuelve en esta transacción (la sincronización o el recorte la recalculan).
  const retirado = impuestoQueSeLlevan(
    orden.contratoDePrecio,
    { taxAmount: orden.taxAmount, reduccionesQueVuelven: filas.map(f => f.taxReduction) },
    salen,
  )
  if (retirado.gt(0)) await tx.order.update({ where: { id: orderId }, data: { taxAmount: { increment: retirado.negated() } } })
  return retirado
}

export type ResultadoDeRecorte = {
  recortadoPesos: number
  impuestoDevuelto: Prisma.Decimal
  retiradas: Array<{ id: string; name: string; pointsRefunded: number; stampRewardReturned: string | null }>
  benefits?: Array<{
    orderDiscountId: string
    loyaltyRefund: { pointsRefunded: number; customerId: string; transactionId: string } | null
    stampRefund: { rewardId: string; customerId: string; rewardLabel: string } | null
  }>
}

/**
 * B2c (P4, P5; founder 1-oct): antes de borrar, anular o regalar renglones, las filas DIRIGIDAS a ellos se recortan por su
 * parte guardada o se retiran — devolviendo puntos, premio (las mismas funciones que el móvil) y la reducción de impuesto
 * (B2b) —, en la transacción y bajo el candado de quien llama. Va ANTES de tocar los renglones: reconocer un espejo viejo
 * necesita leerlos. Un error de base sale tal cual.
 */
export async function recortarDescuentosDeRenglones(
  tx: Prisma.TransactionClient,
  orderId: string,
  o: { renglones: string[]; venueId: string; staffId?: string | null; captureBenefits?: boolean },
): Promise<ResultadoDeRecorte> {
  const resultado: ResultadoDeRecorte = { recortadoPesos: 0, impuestoDevuelto: new Prisma.Decimal(0), retiradas: [] }
  if (o.captureBenefits) resultado.benefits = []
  if (o.renglones.length === 0) return resultado
  const cambian = await tx.orderItem.findMany({
    where: { orderId, id: { in: o.renglones } },
    select: { id: true, appliedDiscountId: true, isCortesia: true, discountAmount: true },
    take: o.renglones.length,
  })
  const decisiones = (await filasDeLaOrden(tx, orderId))
    .map(fila => ({ fila, recorte: recorteDeFila(fila, cambian) }))
    .filter(d => d.recorte.accion !== 'NADA')
    .sort((a, b) => (a.fila.id < b.fila.id ? -1 : a.fila.id > b.fila.id ? 1 : 0))
  if (decisiones.length === 0) return resultado
  // Import dinámico: los dos módulos importan éste (ciclo).
  const { refundLoyaltyForOrderDiscount } = await import('../mobile/loyalty.mobile.service')
  const { refundStampRewardForOrderDiscount } = await import('../wallet/redeemStampReward.service')
  let recortadoCents = 0
  let impuesto = new Prisma.Decimal(0)
  let orden: { contratoDePrecio: string | null; taxAmount: Prisma.Decimal } | null = null
  let vivos: RenglonParaReparto[] | null = null
  let disponible = new Prisma.Decimal(0)
  for (const { fila, recorte } of decisiones) {
    if (recorte.accion === 'NADA') continue
    recortadoCents += recorte.quitaCents
    const guardada = new Prisma.Decimal(fila.taxReduction ?? 0)
    if (recorte.accion === 'RETIRAR') {
      const puntos = await refundLoyaltyForOrderDiscount(tx, o.venueId, fila, o.staffId ?? undefined)
      const premio = await refundStampRewardForOrderDiscount(tx, o.venueId, fila)
      if (o.captureBenefits) resultado.benefits!.push({ orderDiscountId: fila.id, loyaltyRefund: puntos, stampRefund: premio })
      await tx.orderDiscount.delete({ where: { id: fila.id } })
      impuesto = impuesto.plus(guardada)
      resultado.retiradas.push({
        id: fila.id,
        name: fila.name,
        pointsRefunded: puntos?.pointsRefunded ?? 0,
        stampRewardReturned: premio?.rewardId ?? null,
      })
      continue
    }
    const data: Prisma.OrderDiscountUpdateInput = {
      amount: new Prisma.Decimal(recorte.amountCents).div(100),
      appliedToItemIds: recorte.appliedToItemIds,
      ...(recorte.reparto ? { reparto: comoJson(recorte.reparto) } : {}),
    }
    // Codex r2 N3: se recalcula la fila que PARTICIPA en D16 (su marca), aunque su reducción guardada sea 0. Provisional a
    // propósito (preflight T-3): `disponible` no suma lo que devuelven las retiradas de este mismo bucle; la
    // `sincronizarRepartos` que todo llamador corre después recalcula cada fila marcada partiendo de lo guardado aquí.
    if (recorte.reparto?.reduceImpuesto === true) {
      if (!orden) {
        orden = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { contratoDePrecio: true, taxAmount: true } })
        disponible = new Prisma.Decimal(orden.taxAmount)
      }
      if (orden.contratoDePrecio === 'IVA_APARTE') {
        vivos ??= await renglonesParaReparto(tx, orderId)
        disponible = disponible.plus(guardada)
        const nueva = reduccionDeImpuestoCobrado(orden.contratoDePrecio, recorte.reparto.renglones, vivos, disponible)
        disponible = disponible.minus(nueva)
        data.taxReduction = nueva
        impuesto = impuesto.plus(guardada).minus(nueva)
      }
    }
    await tx.orderDiscount.update({ where: { id: fila.id }, data })
  }
  if (!impuesto.isZero()) await tx.order.update({ where: { id: orderId }, data: { taxAmount: { increment: impuesto } } })
  return { ...resultado, recortadoPesos: recortadoCents / 100, impuestoDevuelto: impuesto }
}
