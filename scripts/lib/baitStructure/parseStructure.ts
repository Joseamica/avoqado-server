import * as XLSX from 'xlsx'
import { Puesto, StructureRow } from './types'

const COLUMNS = ['ID', 'Nombre', 'Posición', 'Estado', 'Ciudad', 'ID de Tienda', 'Formato', 'Nombre de la tienda'] as const

/** Mayúsculas sin acentos ni espacios de más. */
function key(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

/** Las celdas de relleno del archivo ("----------------", "Variable") valen null. */
function cell(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  if (/^-+$/.test(raw)) return null
  if (key(raw) === 'VARIABLE') return null
  return raw
}

const PUESTOS: Record<string, Puesto> = {
  SUPERVISOR: 'SUPERVISOR',
  PROMOTOR: 'PROMOTOR',
  'CUBRE DESCANSO': 'CUBRE_DESCANSO',
}

export function parseStructure(workbook: XLSX.WorkBook): StructureRow[] {
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) throw new Error('El archivo no tiene ninguna hoja')

  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: null })

  // El encabezado no está en una fila fija: se busca por contenido.
  const headerIndex = grid.findIndex(row => {
    const cells = (row ?? []).map(key)
    return cells.includes('ID') && cells.includes('NOMBRE') && cells.includes('ID DE TIENDA')
  })
  if (headerIndex === -1) throw new Error(`No encontré el encabezado (se esperaban las columnas: ${COLUMNS.join(', ')})`)

  const header = (grid[headerIndex] ?? []).map(key)
  const at = (row: unknown[], column: (typeof COLUMNS)[number]) => row[header.indexOf(key(column))]

  const rows: StructureRow[] = []
  let supervisorCode: string | null = null

  for (let i = 0; i < grid.slice(headerIndex + 1).length; i++) {
    const raw = grid[headerIndex + 1 + i]
    const row = raw ?? []
    // Fila totalmente vacía: NO avisar (es relleno normal del archivo)
    if (row.every(value => cell(value) === null)) continue

    const employeeCode = cell(at(row, 'ID'))
    const fullName = cell(at(row, 'Nombre'))
    const posicionRaw = String(at(row, 'Posición') ?? '').trim()
    if (!employeeCode || !fullName) {
      const availableData = []
      if (employeeCode) availableData.push(`ID: ${employeeCode}`)
      if (fullName) availableData.push(`Nombre: ${fullName}`)
      if (posicionRaw) availableData.push(`Posición: ${posicionRaw}`)
      const dataStr = availableData.length > 0 ? ` (${availableData.join(', ')})` : ''
      console.warn(`Fila ${headerIndex + 2 + i} descartada: falta ID o Nombre${dataStr}`)
      continue
    }

    const puesto = PUESTOS[key(posicionRaw)]
    if (!puesto) {
      console.warn(`Fila ${headerIndex + 2 + i} descartada: puesto no reconocido "${posicionRaw}"`)
      continue
    }

    if (puesto === 'SUPERVISOR') supervisorCode = employeeCode

    const storeIdRaw = cell(at(row, 'ID de Tienda'))

    rows.push({
      employeeCode,
      fullName,
      puesto,
      estado: cell(at(row, 'Estado')) ?? '',
      ciudad: cell(at(row, 'Ciudad')) ?? '',
      storeId: storeIdRaw && /^\d+$/.test(storeIdRaw) ? storeIdRaw : null,
      formato: cell(at(row, 'Formato')),
      storeName: cell(at(row, 'Nombre de la tienda')),
      supervisorCode: puesto === 'SUPERVISOR' ? null : supervisorCode,
      isVacante: key(fullName).startsWith('VACANTE') || key(employeeCode).startsWith('VACANTE'),
    })
  }

  return rows
}
