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
import { createHash } from 'crypto'
import { readFileSync } from 'fs'

// 🔴 Importar `../src/lib/permissions` arrastra el logger del server, que al cargarse escribe su
// banner («Logger initialized…») en STDOUT — y este script existe para que su stdout sea JSON y
// NADA más. Con el banner por delante, el `JSON.parse` de los generadores de avoqado-android y
// avoqado-ios revienta con «Unexpected non-whitespace character after JSON at position 4», así que
// los espejos de permisos por rol NO se podían regenerar ni comprobar con `--check`: el detector
// de drift entre repos estaba muerto y fallaba por una causa que no se parece en nada al síntoma.
// No hay variable que lo apague (el banner se emite en las DOS ramas de `logger.ts:128-132`, y
// `LOG_LEVEL` no lo toca), así que se desvía al canal correcto: durante la carga, todo lo que
// alguien escriba en stdout se reenvía a STDERR. No se descarta —el diagnóstico sigue visible y
// los generadores no lo leen— y se restaura antes de imprimir el JSON.
const escrituraReal = process.stdout.write.bind(process.stdout)
process.stdout.write = ((chunk: any, ...resto: any[]) => (process.stderr.write as any)(chunk, ...resto)) as any

const { StaffRole } = require('@prisma/client')

const { DEFAULT_PERMISSIONS, getEffectiveRolePermissions } = require('../src/lib/permissions')

process.stdout.write = escrituraReal

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

for (const role of Object.values(StaffRole) as any[]) {
  const declared = [...(DEFAULT_PERMISSIONS[role] ?? [])].sort()
  const effective = getEffectiveRolePermissions(role, null).slice().sort()
  const declaredSet = new Set(declared)
  roles[role] = { declared, effective, implicit: effective.filter((p: string) => !declaredSet.has(p)) }
}

// 🔴 La huella es del CONTENIDO, nunca del commit de git. Un hash de HEAD marca
// "desactualizado" cada vez que alguien toca cualquier otra cosa de este repo, y un
// detector que grita en falso se aprende a ignorar — que es peor que no tenerlo.
// Con la huella de contenido, el `--check` del cliente sólo se pone rojo cuando los
// PERMISOS cambiaron de verdad.
const payload = { roles, routePermissions }
const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)

console.log(
  JSON.stringify(
    {
      generatedFrom: { repo: 'avoqado-server', fn: 'getEffectiveRolePermissions(role, null)', digest },
      ...payload,
    },
    null,
    2,
  ),
)
