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

const CREA = /\binvitation\.create(Many|ManyAndReturn)?\(/
const creadores = archivos(SRC).filter(f => CREA.test(fs.readFileSync(f, 'utf8')))

/** Inicio de la función de nivel superior que contiene `pos` (exportada o no, declarada o flecha). */
const INICIO_DE_FUNCION = /^(export )?(async )?function \w+|^(export )?const \w+ = (async )?\(/gm
function inicioDeSuFuncion(fuente: string, pos: number): number {
  let inicio = 0
  for (const m of fuente.matchAll(INICIO_DE_FUNCION)) if (m.index! < pos) inicio = m.index!
  return inicio
}
/** Una salida temprana real: `if (esCorreoDemo(...))` o `if (correoDemo)` seguida de `throw` o `continue` (Codex r2). */
const SALIDA_POR_CORREO_DEMO =
  /if \((esCorreoDemo\([^)]*\)|correoDemo)\)\s*(\{\s*)?(\/\/[^\n]*\n\s*)*(logger\.\w+\([^\n]*\)\s*)?(throw|continue)\b/

it('encuentra los caminos que crean invitaciones (si baja de 3, la búsqueda se rompió)', () => {
  expect(creadores.length).toBeGreaterThanOrEqual(3)
})

const sitios = creadores.flatMap(f => {
  const fuente = fs.readFileSync(f, 'utf8')
  return [...fuente.matchAll(new RegExp(CREA.source, 'g'))].map(m => ({ archivo: path.relative(SRC, f), pos: m.index! }))
})

it.each(sitios.map(s => [`${s.archivo} @${s.pos}`, s] as const))(
  '🔴 %s: su función sale antes de crear la invitación si el correo es demo',
  (_nombre, { archivo, pos }) => {
    const fuente = fs.readFileSync(path.join(SRC, archivo), 'utf8')
    const tramo = fuente.slice(inicioDeSuFuncion(fuente, pos), pos)
    expect(tramo).toMatch(SALIDA_POR_CORREO_DEMO)
  },
)

it('🔴 aceptar, el camino de toda invitación, también lo revisa', () => {
  const fuente = fs.readFileSync(path.join(SRC, 'services/invitation.service.ts'), 'utf8')
  const aceptar = fuente.slice(fuente.indexOf('export async function acceptInvitation('))
  expect(aceptar.indexOf('esCorreoDemo(invitation.email)')).toBeGreaterThan(-1)
  expect(aceptar.indexOf('esCorreoDemo(invitation.email)')).toBeLessThan(aceptar.indexOf('tx.staff.findUnique'))
})
