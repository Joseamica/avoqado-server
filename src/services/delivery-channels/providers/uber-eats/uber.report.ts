/**
 * El reporte financiero de Uber: la ÚNICA vía por la que nos enteramos de un reembolso.
 *
 * 🔴 POR QUÉ ES OBLIGATORIO Y NO UN EXTRA. La propia guía de Uber lo dice: *"Refunds/
 * chargebacks appear only in Reporting—not Orders API"*. Si Uber le devuelve dinero a un
 * cliente por un error del pedido, por la API de pedidos NUNCA nos enteramos: la venta queda
 * en Avoqado como cobrada, el dinero se descuenta del depósito, y los libros del comercio
 * quedan mal. Es la fuga que la industria documenta como ~3% de diferencia entre el estado
 * de cuenta y lo que llega al banco.
 *
 * 🔴 ESCRITO CONTRA UN REPORTE REAL (descargado el 2026-08-21), no contra documentación —
 * que además no publica este contrato. Tres cosas que sólo se saben mirándolo:
 *
 *   1. El CSV trae **DOS filas de encabezado**: la primera son descripciones largas de
 *      párrafo ("Amount merchants are responsible for refunding customers when…"), la
 *      SEGUNDA son los nombres cortos reales ("Chargeback Amount (incl. VAT)"). Un
 *      `DictReader` ingenuo toma la primera y lee la segunda como si fuera un dato.
 *   2. El `download_url` viene FIRMADO y CADUCA (`Expires=` en la query). No se puede
 *      guardar para después: se baja al recibir el aviso o se pierde.
 *   3. Los montos vienen con el signo desde Uber; `Total payout` es negativo cuando el
 *      pedido le costó dinero al comercio.
 */
import logger from '@/config/logger'

/** Los nombres CORTOS de la segunda fila de encabezado. */
export interface UberReportRow {
  orderId: string
  status: string
  salesInclVat: string
  chargebackInclVat: string
  totalPayout: string
  payoutDate: string
  payoutRef: string
}

/** Nombres cortos exactos del reporte real. Si Uber los cambia, esto falla RUIDOSO, no en silencio. */
const COL = {
  orderId: 'Order ID',
  status: 'Order Status',
  sales: 'Sales (incl. VAT)',
  chargeback: 'Chargeback Amount (incl. VAT)',
  payout: 'Total payout',
  payoutDate: 'Payout Date',
  payoutRef: 'Payout reference ID',
} as const

/**
 * Partidor de CSV que respeta las comillas.
 *
 * Hace falta de verdad: los encabezados de Uber traen comas DENTRO de comillas
 * ("Either: Completed, Cancelled, Refund…"), así que un `split(',')` desalinea todas las
 * columnas — y un reporte desalineado no falla, sólo lee el importe equivocado.
 */
function partirLinea(linea: string): string[] {
  const campos: string[] = []
  let actual = ''
  let enComillas = false

  for (let i = 0; i < linea.length; i++) {
    const c = linea[i]
    if (c === '"') {
      // Comilla doble dentro de comillas = comilla literal.
      if (enComillas && linea[i + 1] === '"') {
        actual += '"'
        i++
      } else {
        enComillas = !enComillas
      }
    } else if (c === ',' && !enComillas) {
      campos.push(actual)
      actual = ''
    } else {
      actual += c
    }
  }
  campos.push(actual)
  return campos.map(v => v.trim())
}

/**
 * CSV crudo → filas con nombres cortos.
 *
 * 🔴 Salta DOS encabezados. Ver la nota (1) de arriba: leer la segunda como dato metería un
 * "pedido" llamado `Order ID` con importes de texto.
 */
export function parseUberReportCsv(csv: string): UberReportRow[] {
  // El BOM del archivo se pega al primer encabezado y rompe el match por nombre.
  //
  // `\uFEFF` escapado y NO el carácter pegado tal cual: es INVISIBLE, así que en el código se
  // lee como un regex vacío que no borra nada, y el siguiente que pase por aquí lo "limpia"
  // sin saber que acaba de romper el parseo. Por eso `no-irregular-whitespace` lo prohíbe.
  const lineas = csv
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(l => l.trim().length > 0)
  if (lineas.length < 3) return [] // dos encabezados y nada más: reporte vacío, no un error

  const nombres = partirLinea(lineas[1])
  const idx = (col: string) => nombres.findIndex(n => n === col)

  const iOrder = idx(COL.orderId)
  const iStatus = idx(COL.status)
  if (iOrder < 0 || iStatus < 0) {
    // Sin las columnas que identifican el pedido no se puede hacer nada útil, y adivinar
    // por posición sería peor: aplicaría importes al pedido equivocado.
    throw new Error(`El reporte de Uber no trae las columnas esperadas. Encabezados: ${nombres.slice(0, 8).join(' | ')}`)
  }

  const iSales = idx(COL.sales)
  const iCharge = idx(COL.chargeback)
  const iPayout = idx(COL.payout)
  const iPayoutDate = idx(COL.payoutDate)
  const iPayoutRef = idx(COL.payoutRef)
  const val = (campos: string[], i: number) => (i >= 0 ? (campos[i] ?? '') : '')

  return lineas.slice(2).flatMap(linea => {
    const c = partirLinea(linea)
    const orderId = val(c, iOrder)
    if (!orderId) return []
    return [
      {
        orderId,
        status: val(c, iStatus),
        salesInclVat: val(c, iSales),
        chargebackInclVat: val(c, iCharge),
        totalPayout: val(c, iPayout),
        payoutDate: val(c, iPayoutDate),
        payoutRef: val(c, iPayoutRef),
      },
    ]
  })
}

/** ¿Este renglón dice que al comercio le quitaron dinero? */
export function esReembolso(fila: UberReportRow): boolean {
  const monto = Number(fila.chargebackInclVat.replace(/[^0-9.-]/g, ''))
  // El ESTADO manda tanto como el monto: un pedido marcado "Refund" con importe 0 no le
  // costó dinero al comercio, y un cargo > 0 sin ese estado sigue siendo dinero que sale.
  return (Number.isFinite(monto) && monto > 0) || /refund/i.test(fila.status)
}

/**
 * Baja el CSV que anunció el webhook.
 *
 * La URL viene firmada y CADUCA — si ya expiró NO se reintenta a ciegas: hay que volver a
 * pedir el reporte. Distinguirlo importa porque un 403 aquí no es un fallo de red.
 */
export async function descargarReporte(url: string): Promise<string> {
  const r = await fetch(url)
  if (!r.ok) {
    const caducado = r.status === 403 || r.status === 401
    throw new Error(
      caducado
        ? `El enlace del reporte de Uber ya caducó (HTTP ${r.status}). Hay que volver a pedirlo, no reintentar este.`
        : `No se pudo descargar el reporte de Uber: HTTP ${r.status}`,
    )
  }
  const texto = await r.text()
  logger.info('📄 [UberReport] reporte descargado', { bytes: texto.length })
  return texto
}
