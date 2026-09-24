/**
 * 🔴 Codex ronda 3, hallazgo 13 (P1): el wizard de superadmin comprobaba las filas de plan dentro de una transacción
 * con el candado del negocio y CREABA las filas después, fuera. Un candado que se suelta antes de escribir no sirve:
 * dos altas simultáneas leen «libre» las dos y crean después sus dos planes.
 *
 * Esta guarda es de ESTRUCTURA a propósito: el wizard es una orquestación larga (venue, staff, invitaciones,
 * features…) cuyo montaje completo en un test unitario costaría más de lo que protege. Lo que no puede volver a
 * pasar es que la creación de features salga de la transacción, y eso sí se puede fijar leyendo el archivo.
 */
import fs from 'fs'
import path from 'path'

const ARCHIVO = path.join(__dirname, '../../../src/controllers/superadmin/onboarding.controller.ts')

describe('el wizard crea las filas de plan DENTRO del candado', () => {
  const fuente = fs.readFileSync(ARCHIVO, 'utf8')

  it('🔴 la creación de features usa el cliente de la transacción, nunca el global', () => {
    const bloque = fuente.slice(fuente.indexOf('Step 5b: Features'), fuente.indexOf("steps.push({\n          step: 'features'"))
    expect(bloque).toContain('tx.venueFeature.create')
    expect(bloque).not.toContain('prisma.venueFeature.create')
  })

  it('🔴 y la comprobación de choque y la creación viven en la MISMA transacción', () => {
    const bloque = fuente.slice(fuente.indexOf('Step 5b: Features'), fuente.indexOf("steps.push({\n          step: 'features'"))
    const tx = bloque.indexOf('prisma.$transaction')
    const guard = bloque.indexOf('exigirQueSePuedaConceder')
    const crea = bloque.indexOf('await crearFilas(tx)')
    expect(tx).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(tx)
    expect(crea).toBeGreaterThan(guard)
  })
})
