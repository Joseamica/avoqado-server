import fs from 'fs'
import path from 'path'
import { isHoldout } from '../../../../src/services/upsell/upsellImpression.service'

/**
 * 🔴 Los vectores COMPARTIDOS con avoqado-android y avoqado-ios.
 *
 * Spec: Avoqado-HQ/specs/upsell-pantalla-cliente-2026-08-03.md (decisión R5)
 *
 * Este archivo es la ANCLA. El sorteo del grupo de control se calcula por separado
 * en TypeScript, Kotlin y Swift; los tres leen este mismo JSON. Si alguien "mejora"
 * `isHoldout` aquí, este test truena ANTES de que el reparto se desalinee con los
 * dos POS — que es un fallo que no se ve: nada peta, sólo el reporte de aumento
 * empieza a comparar dos poblaciones distintas y da un número creíble y falso.
 *
 * Si este test truena, la pregunta NO es "¿actualizo los vectores?" sino
 * "¿por qué cambió el reparto?". Actualizarlos a ciegas desalinea los tres repos.
 */
const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../src/services/upsell/upsell-test-vectors.json'), 'utf8'))

describe('Upsell — vectores compartidos (server / android / ios)', () => {
  describe('holdout', () => {
    const cases: Array<{ impressionId: string; bucket: number; holdoutAt10: boolean }> = vectors.holdout.cases

    it('el archivo de vectores tiene contenido real', () => {
      // Sin esto, un JSON vacío o mal leído haría pasar el describe entero.
      expect(cases.length).toBeGreaterThanOrEqual(10)
    })

    it('reparte a AMBOS lados (si no, un `return false` pasaría el test)', () => {
      const dentro = cases.filter(c => c.holdoutAt10).length
      expect(dentro).toBeGreaterThanOrEqual(3)
      expect(dentro).toBeLessThan(cases.length)
    })

    it.each(cases)('"$impressionId" → holdout al 10% = $holdoutAt10', ({ impressionId, holdoutAt10 }) => {
      expect(isHoldout(impressionId, 10)).toBe(holdoutAt10)
    })

    it('el porcentaje 0 deja a TODOS fuera del grupo de control', () => {
      // Es la palanca de apagado del experimento: subirlo a 0 debe servir todas
      // las tarjetas, no "casi todas".
      cases.forEach(c => expect(isHoldout(c.impressionId, 0)).toBe(false))
    })

    it('el porcentaje 100 mete a TODOS', () => {
      cases.forEach(c => expect(isHoldout(c.impressionId, 100)).toBe(true))
    })

    it('el mismo id siempre cae del mismo lado (determinista)', () => {
      const id = 'estabilidad-del-sorteo'
      const primera = isHoldout(id, 10)
      for (let i = 0; i < 50; i++) expect(isHoldout(id, 10)).toBe(primera)
    })
  })

  describe('externalId', () => {
    // El server no construye el externalId (lo manda el POS), pero el formato es
    // contrato: de él depende que el ingreso se ate a la línea REAL cobrada.
    it.each(vectors.externalId.cases as Array<{ impressionId: string; index: number; expected: string }>)(
      '$impressionId[$index] → $expected',
      ({ impressionId, index, expected }) => {
        expect(`upsell:${impressionId}:${index}`).toBe(expected)
      },
    )
  })
})
