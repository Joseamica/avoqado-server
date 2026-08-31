import * as XLSX from 'xlsx'
import { Puesto, StructureRow } from './types'

/**
 * Lector del "Estructura BAIT.xlsx" que manda el cliente.
 *
 * 🔴 El archivo CAMBIA DE FORMA entre entregas y nadie avisa. Van dos versiones
 * medidas (Asana 1217743599033214):
 *
 *   | campo lógico    | 22-ago                | 31-ago              |
 *   |-----------------|-----------------------|---------------------|
 *   | número de Bait  | `ID`                  | `ID Promotoría`     |
 *   | id de tienda    | `ID de Tienda`        | `ID único Tienda`   |
 *   | jerarquía       | (por orden de filas)  | `Reporta`           |
 *   | plaza           | `Estado` + `Ciudad`   | (ya no vienen)      |
 *   | nombre de tienda| `Nombre de la tienda` | `Nombre` ← colisión |
 *
 * Por eso cada campo se busca por una LISTA de alias y no por un nombre fijo: la
 * versión de agosto abortaba entera con "No encontré el encabezado".
 */

const COLUMNS = ['ID', 'Nombre', 'Posición', 'ID de Tienda', 'Formato', 'Nombre de la tienda'] as const

/** Los nombres —ya normalizados— con los que cada campo ha llegado. */
const ALIASES = {
  id: ['ID', 'ID PROMOTORIA'],
  nombre: ['NOMBRE'],
  posicion: ['POSICION'],
  reporta: ['REPORTA'],
  estado: ['ESTADO'],
  ciudad: ['CIUDAD'],
  tiendaId: ['ID DE TIENDA', 'ID UNICO TIENDA'],
  formato: ['FORMATO'],
  tiendaNombre: ['NOMBRE DE LA TIENDA'],
} as const

type Campo = keyof typeof ALIASES

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
  // Apareció en la entrega del 31-ago para Braulio, que ya era promotor sin tienda
  // fija. Es un título comercial, no un nivel de la jerarquía: sigue colgando de un
  // supervisor. Tratarlo como PROMOTOR conserva exactamente lo que ya estaba.
  'EXCELENCIA VENTAS': 'PROMOTOR',
}

export function parseStructure(workbook: XLSX.WorkBook): StructureRow[] {
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) throw new Error('El archivo no tiene ninguna hoja')

  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: null })

  const columnIndex = (header: string[], campo: Campo): number => {
    for (const alias of ALIASES[campo]) {
      const i = header.indexOf(alias)
      if (i !== -1) return i
    }
    return -1
  }

  // El encabezado no está en una fila fija: se busca por contenido, tolerando alias.
  const headerIndex = grid.findIndex(row => {
    const cells = (row ?? []).map(key)
    return columnIndex(cells, 'id') !== -1 && columnIndex(cells, 'nombre') !== -1 && columnIndex(cells, 'tiendaId') !== -1
  })
  if (headerIndex === -1) throw new Error(`No encontré el encabezado (se esperaban las columnas: ${COLUMNS.join(', ')})`)

  const header = (grid[headerIndex] ?? []).map(key)
  const columns = Object.fromEntries((Object.keys(ALIASES) as Campo[]).map(campo => [campo, columnIndex(header, campo)])) as Record<
    Campo,
    number
  >

  // 🔴 En la versión de agosto la tienda también se llama "Nombre", así que
  // `indexOf` devolvería la columna de la PERSONA y cada promotor se llamaría como
  // su sucursal. La tienda es siempre la columna que sigue a "Formato" — cierto en
  // las dos versiones del archivo.
  if (columns.tiendaNombre === -1 && columns.formato !== -1) {
    columns.tiendaNombre = columns.formato + 1
  }

  const at = (row: unknown[], campo: Campo) => (columns[campo] === -1 ? null : row[columns[campo]])

  interface Cruda {
    employeeCode: string
    fullName: string
    puesto: Puesto
    reporta: string | null
    estado: string
    ciudad: string
    storeId: string | null
    formato: string | null
    storeName: string | null
    isVacante: boolean
  }

  const crudas: Cruda[] = []

  for (let i = 0; i < grid.slice(headerIndex + 1).length; i++) {
    const raw = grid[headerIndex + 1 + i]
    const row = raw ?? []
    // Fila totalmente vacía: NO avisar (es relleno normal del archivo)
    if (row.every(value => cell(value) === null)) continue

    const employeeCode = cell(at(row, 'id'))
    const fullName = cell(at(row, 'nombre'))
    const posicionRaw = String(at(row, 'posicion') ?? '').trim()
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

    const storeIdRaw = cell(at(row, 'tiendaId'))

    crudas.push({
      employeeCode,
      fullName,
      puesto,
      reporta: cell(at(row, 'reporta')),
      estado: cell(at(row, 'estado')) ?? '',
      ciudad: cell(at(row, 'ciudad')) ?? '',
      storeId: storeIdRaw && /^\d+$/.test(storeIdRaw) ? storeIdRaw : null,
      formato: cell(at(row, 'formato')),
      storeName: cell(at(row, 'tiendaNombre')),
      isVacante: key(fullName).startsWith('VACANTE') || key(employeeCode).startsWith('VACANTE'),
    })
  }

  // Los supervisores del propio archivo, por nombre normalizado. Es lo que permite
  // resolver la columna "Reporta", que trae el NOMBRE y no el número de empleado.
  const supervisorPorNombre = new Map<string, string>()
  for (const fila of crudas) {
    if (fila.puesto === 'SUPERVISOR') supervisorPorNombre.set(key(fila.fullName), fila.employeeCode)
  }

  const rows: StructureRow[] = []
  let supervisorCode: string | null = null

  for (const fila of crudas) {
    if (fila.puesto === 'SUPERVISOR') supervisorCode = fila.employeeCode

    // 🔴 "Reporta" MANDA sobre el orden de las filas. El orden es una convención de
    // quien arma el Excel; la columna es una afirmación explícita. Cuando el archivo
    // no la trae (versión de 22-ago) o nombra a alguien que no es supervisor aquí
    // —los supervisores "reportan" al dueño—, se cae al orden en vez de perder la fila.
    const porReporta = fila.reporta ? supervisorPorNombre.get(key(fila.reporta)) : undefined

    rows.push({
      employeeCode: fila.employeeCode,
      fullName: fila.fullName,
      puesto: fila.puesto,
      estado: fila.estado,
      ciudad: fila.ciudad,
      storeId: fila.storeId,
      formato: fila.formato,
      storeName: fila.storeName,
      supervisorCode: fila.puesto === 'SUPERVISOR' ? null : (porReporta ?? supervisorCode),
      isVacante: fila.isVacante,
    })
  }

  return rows
}
