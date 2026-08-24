import { StructureRow } from './types'

export interface ProdStaff {
  id: string
  firstName: string
  lastName: string
  employeeCode: string | null
  active: boolean
  /** Cuenta de servicio de una terminal (email tpv-…@internal.avoqado.io). Nunca es una persona. */
  isTerminalAccount: boolean
}

export type MatchResult =
  | { status: 'MATCHED'; staffId: string; via: 'employeeCode' | 'exactName' | 'looseName' }
  | { status: 'AMBIGUOUS'; candidates: string[] }
  | { status: 'NOT_FOUND' }

/** Mayúsculas, sin acentos, sin puntuación, espacios colapsados. */
export function norm(value: string): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

/**
 * El ID de tienda vive entre paréntesis al final del nombre del venue:
 * "BAE RANCHO SAN PEDRO (2978)" → "2978". Es la llave más estable que existe hoy.
 */
export function extractStoreId(venueName: string): string | null {
  const match = /\((\d+)\)\s*$/.exec(venueName ?? '')
  return match ? match[1] : null
}

const PARTICULAS = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'Y', 'DA', 'DOS', 'MA'])

/** Tokens con los que vale la pena comparar: ≥3 letras y que no sean partículas. */
function tokens(name: string): string[] {
  return norm(name)
    .split(' ')
    .filter(token => token.length >= 3 && !PARTICULAS.has(token))
}

function fullName(staff: ProdStaff): string {
  return `${staff.firstName} ${staff.lastName}`
}

function decide(matches: ProdStaff[], via: 'employeeCode' | 'exactName' | 'looseName'): MatchResult | null {
  if (matches.length === 1) return { status: 'MATCHED', staffId: matches[0].id, via }
  if (matches.length > 1) return { status: 'AMBIGUOUS', candidates: matches.map(m => m.id) }
  return null
}

export function matchStaff(row: StructureRow, pool: ProdStaff[]): MatchResult {
  // Las cuentas de terminal no son personas: nunca son candidatas.
  // Tampoco las personas desactivadas: evita resucitar bajas de personal, pruebas o duplicados.
  const candidates = pool.filter(staff => !staff.isTerminalAccount && staff.active)

  if (row.employeeCode) {
    const byCode = candidates.filter(s => s.employeeCode && norm(s.employeeCode) === norm(row.employeeCode))
    const result = decide(byCode, 'employeeCode')
    if (result) return result
  }

  const byExact = candidates.filter(s => norm(fullName(s)) === norm(row.fullName))
  const exact = decide(byExact, 'exactName')
  if (exact) return exact

  // Laxo: TODOS los tokens significativos del nombre en prod aparecen en el nombre del Excel.
  // Exige al menos 2 tokens para no emparejar por un solo apellido común.
  const excelTokens = new Set(tokens(row.fullName))
  const byLoose = candidates.filter(staff => {
    const prodTokens = tokens(fullName(staff))
    return prodTokens.length >= 2 && prodTokens.every(token => excelTokens.has(token))
  })
  const loose = decide(byLoose, 'looseName')
  if (loose) return loose

  return { status: 'NOT_FOUND' }
}
