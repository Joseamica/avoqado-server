import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import * as XLSX from 'xlsx'

export const SETTLEMENT_XLSX_TASK = 'build-settlement-report-xlsx'
export interface CargaDelLibro {
  hoja: string
  encabezado: string[]
  columnas: Array<{ label: string; tipo: 'texto' | 'dinero' }>
  filas: Array<Array<string | number | null>>
}

export function construirLibro(c: CargaDelLibro): Buffer {
  const aoa: Array<Array<string | number | null>> = [...c.encabezado.map(l => [l]), [], c.columnas.map(x => x.label), ...c.filas]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const primeraFila = c.encabezado.length + 2
  c.columnas.forEach((col, ci) => {
    for (let r = primeraFila; r < primeraFila + c.filas.length; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: ci })]
      if (!cell) continue
      if (col.tipo === 'texto') {
        cell.t = 's' // conserva ceros iniciales de folio/autorización
        cell.v = String(cell.v)
      } else if (cell.t === 'n') cell.z = '$#,##0.00'
    }
  })
  ws['!cols'] = c.columnas.map(x => ({ wch: Math.min(Math.max(x.label.length + 2, 12), 40) }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, c.hoja)
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

if (!isMainThread && parentPort && workerData?.task === SETTLEMENT_XLSX_TASK) {
  try {
    const buf = construirLibro(workerData.data as CargaDelLibro)
    const bytes = new ArrayBuffer(buf.length)
    new Uint8Array(bytes).set(buf)
    parentPort.postMessage({ ok: true, bytes }, [bytes])
  } catch {
    parentPort.postMessage({ ok: false }) // el detalle no viaja: puede traer datos del tenant
  }
}
