/**
 * IVA por producto, plan 6b (spec D11, D21, §5.2b): las facturas HEREDADAS (sin `protocoloIva`, timbradas por la ruta vieja) no sellaron
 * sus renglones. Aquí se sellan con la tasa ÚNICA de su XML, que es lo que tiene el SAT, aunque el producto hoy diga otra cosa. Lo usan
 * el encendido (Tarea 6: una no sellable lo detiene y la nombra) y la puesta al día de los negocios ya encendidos (Tarea 10: se lista).
 * El XML se lee FUERA del candado (puede pedirlo al PAC) y se revalida DENTRO con su huella.
 */
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'

import { writeLegacyActivityAuditTx } from '@/services/activityAudit.service'
import prisma from '@/utils/prismaClient'
import { esMarcaDeXmlIlegible, repararArchivosDe } from './finalizadorCfdi'
import { leerXmlConceptos } from './saldoFiscal'
import { sellarRenglones } from './sellosIva'

export type TratamientoDelXml = 'IVA_16' | 'IVA_0' | 'EXENTO'
export type Sellable = {
  cfdiId: string
  folio: string
  orderId: string
  attempts: number
  huellaXml: string
  tratamiento: TratamientoDelXml
}
export type NoSellable = { cfdiId: string; folio: string; motivo: string }
export type PlanDeSellado = { venueId: string; sellables: Sellable[]; noSellables: NoSellable[] }

export const MOTIVO_XML_ILEGIBLE = 'No se pudo leer su XML'
export const MOTIVO_XML_SIN_TASA_UNICA = 'Su XML no trae una sola tasa de IVA (16 %, 0 % o exento)'
export const MOTIVO_NO_INDIVIDUAL = 'Es una factura global o una nota de crédito heredada'
export const MOTIVO_SELLO_DISTINTO = 'Un renglón de esa venta ya está sellado con otra tasa por otro documento'
export const MOTIVO_CAMBIO_AL_REVISAR = 'La factura cambió mientras se revisaba; vuelve a guardar'
/** Codex código r1 #1 (Ruling CX-1): sellarla exigiría la admisión de otra organización, que el encendido nunca pide. */
export const MOTIVO_ORDEN_EN_OTRA_ORGANIZACION = 'Su venta pertenece a otra organización; pide ayuda a soporte'
export const SIN_REPARAR = async (): Promise<undefined> => undefined
const VIVAS = ['STAMPED', 'CANCEL_REQUESTED'] as const
const PAGINA = 200

export class SelloHeredadoDivergente extends Error {
  constructor(public folio: string) {
    super(`SELLO_DIVERGENTE en la factura heredada ${folio}`)
  }
}

const huella = (xml: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(xml ?? null))
    .digest('hex')
const nombre = (f: { id: string; serie: string | null; folio: string | null }) => [f.serie, f.folio].filter(Boolean).join('-') || f.id

export function tratamientoUnicoDelXml(xmlConceptos: unknown): { tratamiento: TratamientoDelXml } | { motivo: string } {
  if (xmlConceptos == null || esMarcaDeXmlIlegible(xmlConceptos)) return { motivo: MOTIVO_XML_ILEGIBLE }
  const xml = leerXmlConceptos(xmlConceptos)
  if (!xml || xml.conceptos.length === 0) return { motivo: MOTIVO_XML_ILEGIBLE }
  const vistos = new Set<string>()
  for (const c of xml.conceptos) {
    const iva = c.traslados.filter(t => t.impuesto === '002')
    if (c.objetoImp !== '02' || iva.length !== 1) return { motivo: MOTIVO_XML_SIN_TASA_UNICA }
    const t = iva[0]
    vistos.add(t.tipoFactor === 'Exento' ? 'EXENTO' : Number(t.tasa) === 0.16 ? 'IVA_16' : Number(t.tasa) === 0 ? 'IVA_0' : 'OTRA')
  }
  const [unico] = [...vistos]
  if (vistos.size !== 1 || unico === 'OTRA') return { motivo: MOTIVO_XML_SIN_TASA_UNICA }
  return { tratamiento: unico as TratamientoDelXml }
}

/**
 * Fuera de toda transacción. `deps.reparar`: pide el XML al PAC si la fila no lo tiene (por omisión `repararArchivosDe`, que ESCRIBE
 * archivos y `xmlConceptos`: quien sólo quiere mirar pasa `SIN_REPARAR`).
 */
export async function planDeSelladoHeredado(
  venueId: string,
  deps: { reparar?: (cfdiId: string) => Promise<unknown> } = {},
): Promise<PlanDeSellado> {
  const reparar = deps.reparar ?? ((id: string) => repararArchivosDe(id))
  const plan: PlanDeSellado = { venueId, sellables: [], noSellables: [] }
  const organizacion = (await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } }))?.organizationId
  for (let cursor = ''; ; ) {
    const pagina = await prisma.cfdi.findMany({
      where: { venueId, protocoloIva: null, status: { in: [...VIVAS] }, id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: PAGINA,
      select: {
        id: true,
        serie: true,
        folio: true,
        orderId: true,
        isGlobal: true,
        type: true,
        attempts: true,
        xmlConceptos: true,
        order: { select: { venue: { select: { organizationId: true } } } },
      },
    })
    for (const f of pagina) {
      if (f.isGlobal || f.type !== 'INGRESO' || !f.orderId) {
        plan.noSellables.push({ cfdiId: f.id, folio: nombre(f), motivo: MOTIVO_NO_INDIVIDUAL })
        continue
      }
      // Ya sellada por completo (la A-36, sellada a mano el 30-sep): nada que hacer.
      const faltan = await prisma.orderItem.count({ where: { orderId: f.orderId, sellosIva: { none: { cfdiId: f.id } } } })
      if (faltan === 0) continue
      // Antes del XML (es por su contenido, no hace falta el PAC): la venta se movió a otra organización (Ruling CX-1).
      if (f.order && f.order.venue.organizationId !== organizacion) {
        plan.noSellables.push({ cfdiId: f.id, folio: nombre(f), motivo: MOTIVO_ORDEN_EN_OTRA_ORGANIZACION })
        continue
      }
      let xml: unknown = f.xmlConceptos
      if (xml == null) {
        await reparar(f.id)
        xml = (await prisma.cfdi.findUnique({ where: { id: f.id }, select: { xmlConceptos: true } }))?.xmlConceptos ?? null
      }
      const r = tratamientoUnicoDelXml(xml)
      if ('motivo' in r) {
        plan.noSellables.push({ cfdiId: f.id, folio: nombre(f), motivo: r.motivo })
        continue
      }
      const distintos = await prisma.orderItem.count({
        where: { orderId: f.orderId, AND: [{ ivaTratamiento: { not: null } }, { ivaTratamiento: { not: r.tratamiento } }] },
      })
      if (distintos > 0) plan.noSellables.push({ cfdiId: f.id, folio: nombre(f), motivo: MOTIVO_SELLO_DISTINTO })
      else
        plan.sellables.push({
          cfdiId: f.id,
          folio: nombre(f),
          orderId: f.orderId,
          attempts: f.attempts,
          huellaXml: huella(xml),
          tratamiento: r.tratamiento,
        })
    }
    if (pagina.length < PAGINA) return plan
    cursor = pagina[pagina.length - 1].id
  }
}

/**
 * DENTRO de la transacción del que sella, con las órdenes del plan ya bloqueadas. Revalida cada factura (sigue heredada y viva, mismo
 * intento, mismo XML) y sella TODOS los renglones de su orden con la tasa del XML. Una que se canceló en medio ya no necesita sello; una
 * que cambió va a `cambiaron`. Un sello distinto aparecido en medio lanza `SelloHeredadoDivergente` (el que llama revierte todo).
 */
export async function aplicarSelladoHeredado(
  tx: Prisma.TransactionClient,
  plan: PlanDeSellado,
  p: { staffId: string | null; origen: 'ENCENDIDO' | 'PUESTA_AL_DIA' },
) {
  const sellados: Array<{ cfdiId: string; folio: string; tratamiento: TratamientoDelXml; renglones: number }> = []
  const cambiaron: NoSellable[] = []
  for (const s of plan.sellables) {
    const fila = await tx.cfdi.findUnique({
      where: { id: s.cfdiId },
      select: { protocoloIva: true, status: true, attempts: true, xmlConceptos: true },
    })
    if (!fila || fila.status === 'CANCELLED') continue
    if (
      fila.protocoloIva != null ||
      !(VIVAS as readonly string[]).includes(fila.status) ||
      fila.attempts !== s.attempts ||
      huella(fila.xmlConceptos) !== s.huellaXml
    ) {
      cambiaron.push({ cfdiId: s.cfdiId, folio: s.folio, motivo: MOTIVO_CAMBIO_AL_REVISAR })
      continue
    }
    // ponytail: los renglones de UNA orden, sin tope; una cuenta con miles de renglones haría una sentencia por renglón (sellarRenglones).
    const renglones = await tx.orderItem.findMany({ where: { orderId: s.orderId }, select: { id: true }, orderBy: { id: 'asc' } })
    try {
      await sellarRenglones(tx, {
        cfdiId: s.cfdiId,
        intento: s.attempts,
        renglones: renglones.map(r => ({ orderItemId: r.id, tratamiento: s.tratamiento })),
      })
    } catch (e) {
      if ((e as Error).message === 'SELLO_DIVERGENTE') throw new SelloHeredadoDivergente(s.folio)
      throw e
    }
    await writeLegacyActivityAuditTx(tx, {
      staffId: p.staffId,
      venueId: plan.venueId,
      action: 'CFDI_HEREDADA_SELLADA',
      entity: 'Cfdi',
      entityId: s.cfdiId,
      data: { factura: s.folio, tratamiento: s.tratamiento, renglones: renglones.length, origen: p.origen },
    })
    sellados.push({ cfdiId: s.cfdiId, folio: s.folio, tratamiento: s.tratamiento, renglones: renglones.length })
  }
  return { sellados, cambiaron }
}
