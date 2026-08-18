/**
 * Vuelca, en JSON, los permisos que el server manda DE VERDAD a cada rol.
 *
 * Es la fuente del fixture `PermisosRealesDelServer` de avoqado-android y de
 * `PermisosRealesDelServer.swift` de avoqado-ios. Esos fixtures NO se escriben
 * a mano: uno escrito a mano ya mintió una vez —era una lista corta "con los
 * permisos importantes" que omitía justo las dependencias IMPLÍCITAS que este
 * archivo expande—, y un fixture que miente deja pasar en verde un gate que en
 * el aparato hace lo contrario.
 *
 * `customPermissions = null` a propósito: es lo que recibe un venue SIN
 * Permission Sets, o sea la matriz por default que aplica a la inmensa mayoría.
 * Un venue con permisos personalizados manda otra cosa y por eso el cliente
 * NUNCA debe decidir por rol: decide por la lista efectiva que le llegó.
 *
 *   npx tsx scripts/dump-effective-role-permissions.ts
 *
 * Salida: { generatedFrom, roles: { <ROL>: { declared, effective, implicit } } }
 *   declared  = DEFAULT_PERMISSIONS[rol] tal cual está escrito
 *   effective = getEffectiveRolePermissions(rol, null) — lo que viaja al cliente
 *   implicit  = effective − declared (lo que nadie concedió a mano)
 *
 * Y además `routePermissions`: todo permiso que un `checkPermission(...)` de las
 * rutas que consumen los POS puede rechazar. Es lo que hace que la cobertura de
 * ETIQUETAS del cliente se pueda verificar sola: sin esto, la lista vivía escrita
 * a mano en un test y envejecía en silencio — el día que el server estrenó
 * `estimates:create`, `orders:cancel-unpaid` y `tables:pay-any`, el modal empezó a
 * enseñar el código pelón y ningún test se enteró.
 */
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { StaffRole } from '@prisma/client'
import { DEFAULT_PERMISSIONS, getEffectiveRolePermissions } from '../src/lib/permissions'

function serverCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: `${__dirname}/..`, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

/** Rutas que consumen los POS (Android, iOS, TPV). El dashboard web va aparte. */
const ROUTE_FILES = ['mobile.routes.ts', 'tpv.routes.ts', 'pos-sync.routes.ts'] as const

function permissionsCheckedIn(file: string): string[] {
  const src = readFileSync(`${__dirname}/../src/routes/${file}`, 'utf8')
  // `checkPermission(` a veces trae el argumento en la línea siguiente.
  const found = [...src.matchAll(/checkPermission\(\s*'([^']+)'/g)].map(m => m[1])
  return [...new Set(found)].sort()
}

const routePermissions: Record<string, string[]> = {}
for (const file of ROUTE_FILES) routePermissions[file] = permissionsCheckedIn(file)

const roles: Record<string, { declared: string[]; effective: string[]; implicit: string[] }> = {}

for (const role of Object.values(StaffRole) as StaffRole[]) {
  const declared = [...(DEFAULT_PERMISSIONS[role] ?? [])].sort()
  const effective = getEffectiveRolePermissions(role, null).slice().sort()
  const declaredSet = new Set(declared)
  roles[role] = { declared, effective, implicit: effective.filter(p => !declaredSet.has(p)) }
}

console.log(
  JSON.stringify(
    {
      generatedFrom: { repo: 'avoqado-server', commit: serverCommit(), fn: 'getEffectiveRolePermissions(role, null)' },
      roles,
      routePermissions,
    },
    null,
    2,
  ),
)
