/**
 * hz:f26b3afc:D4 — La contraseña de los usuarios demo (`@demo.avoqado.io`) es pública. Un camino que crea invitaciones y no
 * rechaza esos correos abre la puerta a un negocio real: dos de ellos (el asistente de SUPERADMIN y el alta) daban la
 * membresía ANTES de aceptar (Codex r1, docs/audit/2026-11-01-demo-sin-invitaciones-reales/codex-r1.md). Esta guardia
 * encuentra todo archivo que crea invitaciones y exige que revise el correo demo antes de crearla; uno nuevo truena aquí.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '../../../src')
const archivos = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? archivos(p) : p.endsWith('.ts') ? [p] : []
  })

const CREA = /\binvitation\.create(Many)?\(/
const creadores = archivos(SRC).filter(f => CREA.test(fs.readFileSync(f, 'utf8')))

it('encuentra los caminos que crean invitaciones (si baja de 3, la búsqueda se rompió)', () => {
  expect(creadores.length).toBeGreaterThanOrEqual(3)
})

it.each(creadores.map(f => path.relative(SRC, f)))('🔴 %s revisa el correo demo antes de crear la invitación', archivo => {
  const fuente = fs.readFileSync(path.join(SRC, archivo), 'utf8')
  const primeraCreacion = fuente.search(/\binvitation\.create(Many)?\(/)
  const revision = fuente.indexOf('esCorreoDemo(')
  expect(revision).toBeGreaterThan(-1)
  expect(revision).toBeLessThan(primeraCreacion)
})

it('🔴 aceptar, el camino de toda invitación, también lo revisa', () => {
  const fuente = fs.readFileSync(path.join(SRC, 'services/invitation.service.ts'), 'utf8')
  const aceptar = fuente.slice(fuente.indexOf('export async function acceptInvitation('))
  expect(aceptar.indexOf('esCorreoDemo(invitation.email)')).toBeGreaterThan(-1)
  expect(aceptar.indexOf('esCorreoDemo(invitation.email)')).toBeLessThan(aceptar.indexOf('tx.staff.findUnique'))
})
