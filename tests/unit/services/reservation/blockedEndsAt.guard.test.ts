/**
 * Guardarraíl: `endsAt` y `blockedEndsAt` se mueven JUNTOS.
 *
 * Por qué existe este test y no basta con la revisión humana: en un `create`
 * TypeScript exige `blockedEndsAt` porque la columna es NOT NULL, así que un
 * sitio nuevo de creación no puede olvidarla. Pero un `update` es PARCIAL —
 * mover `endsAt` sin `blockedEndsAt` compila perfecto y deja la cita bloqueando
 * su horario ANTERIOR mientras libera el nuevo. Ese hueco es invisible hasta
 * que alguien reserva encima.
 *
 * Mismo patrón que los guardarraíles de `preserveContext` (multer) y
 * `scheduleJob` (cron): el compilador no puede verlo, así que lo ve un test.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '../../../../src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

/**
 * Recorta el bloque `data: { ... }` de un `reservation.update(` a partir del
 * índice de apertura, balanceando llaves. Devuelve null si no hay bloque data.
 */
function extractUpdateDataBlock(source: string, fromIndex: number): string | null {
  const dataIdx = source.indexOf('data:', fromIndex)
  if (dataIdx === -1) return null
  const open = source.indexOf('{', dataIdx)
  if (open === -1) return null

  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return null
}

describe('guardarraíl: endsAt y blockedEndsAt viajan juntos', () => {
  it('ningún reservation.update mueve endsAt sin recalcular blockedEndsAt', () => {
    const offenders: string[] = []

    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8')
      let cursor = source.indexOf('reservation.update(')

      while (cursor !== -1) {
        const block = extractUpdateDataBlock(source, cursor)
        if (block && /\bendsAt:/.test(block) && !/\bblockedEndsAt:/.test(block)) {
          const line = source.slice(0, cursor).split('\n').length
          offenders.push(`${file.replace(SRC, 'src')}:${line}`)
        }
        cursor = source.indexOf('reservation.update(', cursor + 1)
      }
    }

    expect(offenders).toEqual([])
  })
})
