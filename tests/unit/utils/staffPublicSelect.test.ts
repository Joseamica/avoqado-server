import fs from 'fs'
import path from 'path'
import { Prisma } from '@prisma/client'
import { STAFF_PUBLIC_SELECT, STAFF_SECRET_FIELDS } from '@/utils/staffPublicSelect'

/**
 * El empleado que viaja como relación en una respuesta HTTP nunca lleva sus secretos.
 *
 * 🔴 Defecto (30-sep-2026, prueba de avoqado-android en Windows): el cobro rápido respondía
 * `data.processedBy` con la fila ENTERA de `Staff` — hash de la contraseña, `resetToken`,
 * `emailVerificationCode` — a cada tablet, iPad y TPV. Codex encontró el mismo
 * `include: { … : true }` en el listado de pagos y órdenes del dashboard, en los turnos de la
 * TPV y en el detalle de un clawback.
 */
describe('STAFF_PUBLIC_SELECT', () => {
  const publicos = Object.keys(STAFF_PUBLIC_SELECT)
  const escalares = Object.values(Prisma.StaffScalarFieldEnum) as string[]

  it('no deja salir ningún secreto', () => {
    for (const secreto of STAFF_SECRET_FIELDS) expect(publicos).not.toContain(secreto)
    expect(publicos).not.toContain('password')
    expect(publicos).not.toContain('resetToken')
    expect(publicos).not.toContain('emailVerificationCode')
  })

  it('cada campo de Staff está decidido: público o secreto (un campo nuevo obliga a elegir)', () => {
    const decididos = new Set<string>([...publicos, ...STAFF_SECRET_FIELDS])
    const sinDecidir = escalares.filter(campo => !decididos.has(campo))
    expect(sinDecidir).toEqual([])
    // Y nada inventado: todo lo listado existe en el modelo.
    for (const campo of decididos) expect(escalares).toContain(campo)
  })

  it('conserva lo que las apps leen del empleado (id y nombre)', () => {
    expect(STAFF_PUBLIC_SELECT).toMatchObject({ id: true, firstName: true, lastName: true })
  })
})

/**
 * Guardia estructural: en los servicios cuya respuesta sale por HTTP, una relación a `Staff` nunca
 * se incluye entera. Se busca el patrón literal porque es exactamente el que produjo la fuga.
 */
describe('servicios que responden por HTTP no incluyen un Staff entero', () => {
  const raiz = path.resolve(__dirname, '../../..')
  const archivos = [
    'src/services/tpv/payment.tpv.service.ts',
    'src/services/dashboard/payment.dashboard.service.ts',
    'src/services/dashboard/order.dashboard.service.ts',
    'src/services/tpv/shift.tpv.service.ts',
    'src/services/dashboard/commission/commission-clawback.service.ts',
  ]
  const relacionEntera = /\b(processedBy|createdBy|servedBy|staff)\s*:\s*true\b/

  it.each(archivos)('%s', archivo => {
    const lineas = fs.readFileSync(path.join(raiz, archivo), 'utf8').split('\n')
    const culpables = lineas
      .map((linea, i) => ({ linea: linea.trim(), n: i + 1 }))
      .filter(({ linea }) => !linea.startsWith('//') && !linea.startsWith('*') && relacionEntera.test(linea))
      .map(({ linea, n }) => `${archivo}:${n}  ${linea}`)
    expect(culpables).toEqual([])
  })
})
