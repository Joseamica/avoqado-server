import * as XLSX from 'xlsx'
// WHY: módulo sin Prisma ni pdfkit: lo importa el worker thread.

export interface CabeceraXlsx {
  encabezados: string[]
  formatos: (string | undefined)[]
  hoja: string
}
export interface MatrizXlsx extends CabeceraXlsx {
  filas: (string | number)[][]
}

/**
 * Nombre de hoja válido para Excel: sin `\ / ? * [ ] :`, a lo más 31 caracteres y, si hubo que cortar, en un límite de
 * palabra y sin separador colgando («Recibo de Carlos Rodríguez ·» → «Recibo de Carlos Rodríguez»).
 */
export function nombreDeHoja(title: string): string {
  let s = title
    .replace(/[\\/?*[\]:]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length > 31) {
    const corte = s.slice(0, 32).lastIndexOf(' ')
    s = s.slice(0, corte > 0 ? corte : 31)
  }
  return s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu, '') || 'Export'
}

export function construirXlsxDesdeMatriz({ encabezados, formatos, filas, hoja }: MatrizXlsx): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet([encabezados, ...filas])
  formatos.forEach((fmt, c) => {
    if (!fmt) return
    for (let r = 1; r <= filas.length; r++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })]
      if (cell?.t === 'n') cell.z = fmt
    }
  })
  // Roughly autofit columns based on header + first 50 row widths.
  ;(sheet as any)['!cols'] = encabezados.map((label, c) => {
    let max = String(label).length
    for (let i = 0; i < Math.min(filas.length, 50); i++) {
      const v = filas[i][c]
      const len = v === null || v === undefined ? 0 : String(v).length
      if (len > max) max = len
    }
    return { wch: Math.min(Math.max(max + 2, 10), 40) }
  })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet, nombreDeHoja(hoja))
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}
