/**
 * S5b paso 9, «repetirNoDuplica»: lo que un cuerpo reintentable (`withDeadlockRetry`, 40P01) acumulaba AFUERA nace dentro del intento
 * y sale en su retorno (R65 b). Cada cuerpo con esa nota en `ordenDeCandadosParte2.reviewed.json` debe tener su caso, que corre el cuerpo,
 * lo aborta con 40P01 DESPUÉS de acumular, lo corre otra vez y afirma que lo publicado tras el commit (bitácora, vales, sockets, Wallet,
 * referido, base de lealtad) es SÓLO del intento ganador. Los casos viven junto al andamiaje de mocks de cada servicio (cada archivo trae
 * los suyos) y llevan el rótulo `[repetirNoDuplica:<función>]`; este archivo es el registro que exige que existan.
 *
 * Un caso sirve sólo si FALLA al declarar de nuevo el valor afuera del cuerpo (sabotaje): por eso cada uno afirma valores propios del
 * ganador o un segundo intento que sale antes / cambia el desenlace (ver `fase0-paso9-report.md`).
 */
import fs from 'fs'
import path from 'path'
import revisado from './ordenDeCandadosParte2.reviewed.json'

const RAIZ = path.resolve(__dirname, '../../..')

function archivosDeTest(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return archivosDeTest(p)
    return e.name.endsWith('.test.ts') && e.name !== 'repetirNoDuplica.test.ts' ? [p] : []
  })
}

/** Cuerpos con la nota «repetirNoDuplica» en las aperturas revisadas (la fuente de verdad) + los que no son una apertura sola. */
const DELAS_APERTURAS = Object.entries(revisado.aperturas as Record<string, { nota?: string }>)
  .filter(([, v]) => (v.nota ?? '').includes('repetirNoDuplica'))
  .map(([k]) => k.split('#')[1])
const ADICIONALES = [
  'executeHttpOperation', // 15 handlers de mobile por un solo opener
  'reservation-deposit-webhook', // `released` sale del retorno del CAS (alConfirmar), no del cuerpo
  'reconcileDeliveryOrderFromProvider', // `cerradoEnProveedor` y `selloPorRevertir` nacen dentro del intento
]
const textos = archivosDeTest(path.join(RAIZ, 'tests/unit')).map(f => fs.readFileSync(f, 'utf8'))

describe('repetirNoDuplica: cada cuerpo con «lo de afuera al retorno» tiene su caso con 40P01', () => {
  const esperados = [...new Set([...DELAS_APERTURAS, ...ADICIONALES])]

  it('el registro no está vacío (la nota sigue en el JSON revisado)', () => {
    expect(DELAS_APERTURAS.length).toBeGreaterThanOrEqual(18)
  })

  it.each(esperados)('%s tiene un caso rotulado [repetirNoDuplica:<función>]', funcion => {
    // Sólo cuenta un `it(`/`test(`/`describe(` vivo con el rótulo como título: ni un comentario ni `.skip`/`.todo`.
    const vivo = new RegExp(`\\b(?:it|test|describe)\\(\\s*(['"\`])\\[repetirNoDuplica:${funcion}\\]`)
    const hay = textos.some(t => vivo.test(t))
    expect({ funcion, hay }).toEqual({ funcion, hay: true })
  })

  it('el caso real del motor de descuentos (dos descuentos, el segundo intento deja uno) está rotulado', () => {
    expect(textos.filter(t => /\b(?:it|test)\(\s*['"`]\[repetirNoDuplica:applyAutomaticDiscounts\]/.test(t)).length).toBeGreaterThan(0)
  })
})
