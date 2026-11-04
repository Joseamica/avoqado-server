import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { construirXlsxDesdeMatriz, type CabeceraXlsx } from '../services/exports/xlsxDesdeMatriz'

// WHY: sólo SheetJS y la función pura — un import que arrastre Prisma abriría un pool por exporte.
// Las filas llegan página por página: el hilo que cobra nunca clona la matriz entera.
export const EXPORT_XLSX_TASK = 'build-export-xlsx'

if (!isMainThread && parentPort && workerData?.task === EXPORT_XLSX_TASK) {
  const port = parentPort
  const cabecera = workerData.cabecera as CabeceraXlsx
  const filas: (string | number)[][] = []
  port.on('message', (m: { tipo: 'filas'; filas: (string | number)[][] } | { tipo: 'cerrar' }) => {
    if (m.tipo === 'filas') {
      for (const f of m.filas) filas.push(f)
      return
    }
    try {
      const buffer = construirXlsxDesdeMatriz({ ...cabecera, filas })
      const bytes = new ArrayBuffer(buffer.length)
      new Uint8Array(bytes).set(buffer)
      port.postMessage({ ok: true, bytes }, [bytes])
    } catch {
      port.postMessage({ ok: false }) // sin detalle: puede traer datos de cobros
    }
  })
}
