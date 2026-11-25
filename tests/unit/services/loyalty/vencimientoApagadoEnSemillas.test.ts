/**
 * D27, decisión del founder (25-nov): el vencimiento de puntos viene APAGADO. Las semillas de los demos (el alta de prueba y los
 * negocios demo por giro) tampoco lo prenden: si lo hicieran, el job lo tomaría como elegido y arrancaría el reloj, y una conversión de
 * demo a real que no alcanzara a borrar esa configuración lo pasaría a un negocio real (Codex r10 #3). Estructural, como otras pruebas
 * del repo que leen el código.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const SEMILLAS = ['src/services/onboarding/demoSeed.service.ts', 'src/services/demo/negociosDemo.service.ts']

describe.each(SEMILLAS)('%s', ruta => {
  const fuente = readFileSync(join(__dirname, '../../../../', ruta), 'utf8')
  const creaciones = [...fuente.matchAll(/loyaltyConfig\.create\(\{[\s\S]*?\n\s*\}\)/g)].map(m => m[0])

  it('crea su configuración de lealtad con la expiración apagada', () => {
    expect(creaciones.length).toBeGreaterThan(0)
    for (const c of creaciones) expect(c).toMatch(/pointsExpireDays: null/)
  })
})
