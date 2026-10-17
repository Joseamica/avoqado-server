// tests/unit/architecture/seleccionDeContratoHibrido.test.ts
/**
 * ⭐ (C2 r1) El historial de selección de un contrato híbrido (`HybridContractSelection`) tiene una regla que sólo vivía en
 * comentarios: las fronteras de periodo son segundos enteros (Stripe) y las ampliaciones de la puesta al día de funciones de plan
 * viven DENTRO del segundo que empieza en la frontera (+1 ms…), que la entrega lee como de la frontera. Nadie más escribe
 * `effectiveAt` con milisegundos. Esta guarda deja la regla en código:
 *  - sólo dos archivos escriben el historial (la entrega y la puesta al día);
 *  - los dos miden la ventana con el MISMO segundo (`finDelSegundoDeLaFrontera`), no con un literal propio.
 */
import fs from 'fs'
import path from 'path'

const RAIZ = path.join(__dirname, '../../..')
const ENTREGA = 'src/services/launchCampaigns/hybridDelivery.service.ts'
const PUESTA_AL_DIA = 'src/services/launchCampaigns/hybridPlanCatchUp.ts'
const ESCRITORES = new Set([ENTREGA, PUESTA_AL_DIA])
const leer = (archivo: string) => fs.readFileSync(path.join(RAIZ, archivo), 'utf8')

function archivosTs(dir: string): string[] {
  return fs.readdirSync(path.join(RAIZ, dir), { withFileTypes: true }).flatMap(e => {
    const ruta = `${dir}/${e.name}`
    if (e.isDirectory()) return archivosTs(ruta)
    return e.name.endsWith('.ts') ? [ruta] : []
  })
}

const ESCRIBE_EL_HISTORIAL = /\bhybridContractSelection\s*\.\s*(create|createMany|upsert)\b|INSERT\s+INTO\s+"HybridContractSelection"/

describe('historial de selección de contratos híbridos', () => {
  it('sólo la entrega y la puesta al día lo escriben (src y scripts)', () => {
    const archivos = [...archivosTs('src'), ...archivosTs('scripts')]
    expect(archivos.length).toBeGreaterThan(100) // la guarda de verdad recorrió el código
    const escritores = archivos.filter(a => ESCRIBE_EL_HISTORIAL.test(leer(a)))
    expect(escritores.filter(a => !ESCRITORES.has(a))).toEqual([])
    expect(escritores.sort()).toEqual([...ESCRITORES].sort())
  })

  it('los dos miden la ventana de la frontera con el mismo segundo, sin un literal propio', () => {
    const entrega = leer(ENTREGA)
    expect(entrega).toMatch(/\bfinDelSegundoDeLaFrontera\(/)
    expect(entrega).not.toMatch(/\+\s*1\s*\)\s*\*\s*1000/)
    const puesta = leer(PUESTA_AL_DIA)
    expect(puesta).toMatch(/export const SEGUNDO_DE_LA_FRONTERA_MS = 1000\b/)
    expect(puesta).toMatch(/export function finDelSegundoDeLaFrontera\(/)
    expect(puesta).toMatch(/\bfinDelSegundoDeLaFrontera\(frontera\)/)
  })
})
