/**
 * C2 · Tarea 7: el XML que timbraría el PAC para unos conceptos, con la MISMA regla de la 6b (`conceptoSegunElPac`, `documentoSegunElPac`,
 * `resumenSegunElPac`): las pruebas nunca fijan millonésimas a mano. Sirve a dos lados:
 * - unitarias: `xmlConceptosDe(items)` pasa ese XML por los lectores REALES (`conceptosFiscalesDesdeXml`, `desgloseDesdeXml`) y devuelve
 *   lo que guardaría la fila (`xmlConceptos` y `taxBreakdown`);
 * - integración: `xmlDeLaFila(facturapiId)` arma el XML de la fila timbrada con ese id desde su entrada (lo que se le mandó al PAC), para
 *   el `downloadXml` del doble del PAC.
 * Forma medida en el sandbox (T1 de C2 y B3a T1b): importes y traslados del concepto a 6 decimales; SubTotal, Descuento, Total y el resumen a 2;
 * sin `Descuento` cuando es cero; sin `NoIdentificacion` sin `sku`; un concepto de base 0 (regalado) sale `ObjetoImp 01`, sin traslado.
 */
import { Prisma } from '@prisma/client'
import { conceptosFiscalesDesdeXml, trasladoDeIva, trasladosDesdeXml } from '@/services/fiscal/cfdiReceived.parser'
import { conceptoSegunElPac, conceptosDesdeElPayload, documentoSegunElPac, resumenSegunElPac } from '@/services/fiscal/reglaDelPac'
import type { CfdiItemInput } from '@/services/fiscal/providers/fiscal-provider.interface'
import type { XmlConceptos } from '@/services/fiscal/saldoFiscal'

const D = Prisma.Decimal
const seis = (d: Prisma.Decimal) => d.toFixed(6)
const dos = (c: number) => (c / 100).toFixed(2)
const attr = (o: Record<string, string | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ')

/** El XML (texto) de un comprobante con esos conceptos, como lo timbraría el PAC. */
export function xmlDelPac(items: CfdiItemInput[], o: { tipo?: 'I' | 'E' } = {}): string {
  const conceptos = items.map(it => {
    const partes = conceptosDesdeElPayload(it)
    const xs = partes.map(c => ({ c, x: conceptoSegunElPac(c) }))
    const importe = xs.reduce((s, p) => s.plus(p.x.importe), new D(0))
    const descuento = xs.reduce((s, p) => s.plus(p.x.descuento), new D(0))
    const conTraslado = xs.filter(p => p.c.traslado && !p.x.base.isZero())
    const objetoImp = it.objetoImp === '02' && conTraslado.length ? '02' : '01'
    const traslados =
      objetoImp === '02'
        ? conTraslado
            .map(({ c, x }) =>
              c.traslado!.factor === 'Exento'
                ? `<cfdi:Traslado ${attr({ Base: seis(x.base), Impuesto: '002', TipoFactor: 'Exento' })}/>`
                : `<cfdi:Traslado ${attr({ Base: seis(x.base), Impuesto: '002', TipoFactor: 'Tasa', TasaOCuota: new D(c.traslado!.tasa).toFixed(6), Importe: seis(x.traslado) })}/>`,
            )
            .join('')
        : ''
    const a = attr({
      ClaveProdServ: it.satProductKey,
      NoIdentificacion: it.sku || undefined,
      Cantidad: String(it.quantity),
      ClaveUnidad: it.satUnitKey,
      Descripcion: it.description,
      ValorUnitario: seis(importe.div(new D(String(it.quantity)))),
      Importe: seis(importe),
      Descuento: descuento.isZero() ? undefined : seis(descuento),
      ObjetoImp: objetoImp,
    })
    return traslados
      ? `<cfdi:Concepto ${a}><cfdi:Impuestos><cfdi:Traslados>${traslados}</cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>`
      : `<cfdi:Concepto ${a}/>`
  })
  const cs = items.flatMap(conceptosDesdeElPayload)
  const doc = documentoSegunElPac(cs)
  const resumen = resumenSegunElPac(cs)
  const conTasa = resumen.some(r => r.tipoFactor === 'Tasa')
  const impuestos = resumen.length
    ? `<cfdi:Impuestos ${attr({ TotalImpuestosTrasladados: conTasa ? dos(doc.ivaCents) : undefined })}><cfdi:Traslados>${resumen
        .map(r =>
          r.tipoFactor === 'Exento'
            ? `<cfdi:Traslado ${attr({ Base: dos(r.baseCents), Impuesto: '002', TipoFactor: 'Exento' })}/>`
            : `<cfdi:Traslado ${attr({ Base: dos(r.baseCents), Impuesto: '002', TipoFactor: 'Tasa', TasaOCuota: r.tasa!, Importe: dos(r.importeCents!) })}/>`,
        )
        .join('')}</cfdi:Traslados></cfdi:Impuestos>`
    : ''
  const comprobante = attr({
    'xmlns:cfdi': 'http://www.sat.gob.mx/cfd/4',
    Version: '4.0',
    SubTotal: dos(doc.subtotalCents),
    Descuento: doc.descuentoCents ? dos(doc.descuentoCents) : undefined,
    Total: dos(doc.totalCents),
    Moneda: 'MXN',
    TipoDeComprobante: o.tipo ?? 'I',
  })
  return `<?xml version="1.0" encoding="UTF-8"?><cfdi:Comprobante ${comprobante}><cfdi:Conceptos>${conceptos.join('')}</cfdi:Conceptos>${impuestos}</cfdi:Comprobante>`
}

/**
 * Lo que guardaría la fila timbrada (`xmlConceptos`, `taxBreakdown`), leído con los lectores REALES del XML del PAC. El desglose es el de
 * `desgloseDesdeXml` (`finalizadorCfdi.ts`: los traslados `002` del resumen con `trasladoDeIva`), sin importar ese módulo (carga el entorno).
 */
export function xmlConceptosDe(items: CfdiItemInput[]): { xmlConceptos: XmlConceptos; taxBreakdown: unknown[] } {
  const xml = xmlDelPac(items)
  const taxBreakdown = trasladosDesdeXml(xml)
    .filter(tr => tr['@_Impuesto'] === '002')
    .map(tr => ({ ...trasladoDeIva(tr), impuesto: '002' as const }))
  return { xmlConceptos: conceptosFiscalesDesdeXml(xml), taxBreakdown }
}

/**
 * Integración: el XML de la fila timbrada con ese `facturapiId`, armado de lo que se le mandó al PAC (`entrada.params.items`). Sin
 * entrada (una histórica), un comprobante vacío: el lector lo rechaza, como un XML ilegible.
 */
export async function xmlDeLaFila(db: { cfdi: { findFirst: (a: any) => Promise<any> } }, facturapiId: string): Promise<Buffer> {
  const fila = await db.cfdi.findFirst({ where: { facturapiId }, orderBy: { createdAt: 'desc' }, select: { entrada: true, type: true } })
  const items = (fila?.entrada as { params?: { items?: CfdiItemInput[] } } | null)?.params?.items
  return Buffer.from(items?.length ? xmlDelPac(items, { tipo: fila.type === 'EGRESO' ? 'E' : 'I' }) : '<Comprobante/>')
}
