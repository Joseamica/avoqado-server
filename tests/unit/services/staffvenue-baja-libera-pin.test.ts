import * as fs from 'fs'
import * as path from 'path'

/**
 * Invariante estructural: TODA baja de StaffVenue (active: false) libera el PIN (pin: null).
 *
 * Por qué: el candado de la base es @@unique([venueId, pin]) SIN condición de activo —
 * cuenta también a los dados de baja. Una fila inactiva que retiene su PIN bloquea
 * reasignarlo para siempre, y la asignación revienta con P2002 → 500 opaco. Caso real:
 * PlayTelecom, 2026-08-31 — "No se pudo dar el acceso" en la migración de terminal,
 * porque el PIN de la tienda (1671) lo retenía una persona dada de baja.
 *
 * Excepción deliberada (allowlist): la desactivación por TOPE DE ASIENTOS
 * (seatReconciliation) conserva el PIN porque esas personas NO se fueron — un
 * re-upgrade del plan las reactiva automáticamente y deben conservar su PIN de TPV.
 *
 * Si este test te falló: o agregas `pin: null` al data de tu baja, o —si tu caso es
 * una suspensión temporal que se auto-reactiva— lo documentas y lo añades a la
 * allowlist con su motivo.
 */

const SRC_ROOT = path.resolve(__dirname, '../../../src')
const EXTRA_FILES = [path.resolve(__dirname, '../../../scripts/baja-personal-bait.ts')]

// Archivos donde una desactivación SIN pin:null es deliberada. La lista sólo puede encoger.
const ALLOWLIST: Record<string, string> = {
  'src/services/dashboard/seatReconciliation.service.ts': 'seat-cap: la gente no se fue; el re-upgrade la reactiva y conserva su PIN',
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

interface Violation {
  file: string
  line: number
  window: string
}

function findViolations(): { violations: Violation[]; allowlistedHits: Set<string> } {
  const violations: Violation[] = []
  const allowlistedHits = new Set<string>()
  const files = [...walk(SRC_ROOT), ...EXTRA_FILES.filter(f => fs.existsSync(f))]

  for (const file of files) {
    const rel = path.relative(path.resolve(__dirname, '../../..'), file)
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!/staffVenue\.(update|updateMany)\(/.test(lines[i])) continue
      // Ventana: la llamada + su objeto de datos (los sitios reales caben de sobra en 20 líneas).
      const window = lines.slice(i, i + 20).join('\n')
      // Sólo bajas: el data pone active: false. (Un `active: false` en un where no
      // desactiva nada, pero exigirle pin en ventana no estorba: los sitios legítimos
      // de ese estilo liberan pin justamente.)
      if (!/active:\s*false/.test(window)) continue
      if (/pin:\s*null/.test(window)) continue
      if (ALLOWLIST[rel]) {
        allowlistedHits.add(rel)
        continue
      }
      violations.push({ file: rel, line: i + 1, window })
    }
  }
  return { violations, allowlistedHits }
}

describe('StaffVenue: toda baja libera el PIN', () => {
  it('no hay ninguna desactivación (active: false) que retenga el PIN', () => {
    const { violations } = findViolations()
    const detail = violations.map(v => ` - ${v.file}:${v.line}`).join('\n')
    expect(
      violations.length === 0
        ? ''
        : `Estas bajas de StaffVenue no liberan el PIN (falta pin: null en el data):\n${detail}\n` +
            'El @@unique([venueId, pin]) cuenta filas inactivas: retener el PIN bloquea reasignarlo (P2002 → 500).',
    ).toBe('')
  })

  it('la allowlist es real: cada entrada existe y de verdad desactiva sin liberar PIN', () => {
    const { allowlistedHits } = findViolations()
    for (const rel of Object.keys(ALLOWLIST)) {
      expect(allowlistedHits.has(rel) ? rel : `SIN USO: ${rel} — bórrala de la allowlist`).toBe(rel)
    }
  })
})
