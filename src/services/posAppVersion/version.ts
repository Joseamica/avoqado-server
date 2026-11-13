// Comparación de nombres de versión (iOS). Funciones puras, sin dependencias.

/** De 1 a 4 partes numéricas de hasta 6 dígitos: "1", "1.16", "1.16.0.3". */
export const VERSION_NAME_RE = /^\d{1,6}(\.\d{1,6}){0,3}$/

/** Rellena a 4 partes con ceros ("1.16" -> [1,16,0,0]). Devuelve null si no cumple el formato. */
export function normalizeVersionName(name: string): [number, number, number, number] | null {
  if (typeof name !== 'string' || !VERSION_NAME_RE.test(name)) return null
  const parts = name.split('.').map(p => parseInt(p, 10))
  while (parts.length < 4) parts.push(0)
  return [parts[0], parts[1], parts[2], parts[3]]
}

/** Compara parte por parte. Lanza si alguno no cumple el formato: quien llama ya validó. */
export function compareVersionNames(a: string, b: string): -1 | 0 | 1 {
  const na = normalizeVersionName(a)
  const nb = normalizeVersionName(b)
  if (!na || !nb) throw new Error(`Nombre de versión inválido: "${na ? b : a}"`)
  for (let i = 0; i < 4; i++) {
    if (na[i] < nb[i]) return -1
    if (na[i] > nb[i]) return 1
  }
  return 0
}
