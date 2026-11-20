import type { StaffRole, SupportDataResult } from '@prisma/client'
import { permissionListGrants } from '@/lib/permissions'
import { deepFreeze } from '@/utils/deepFreeze'
import type { HelpAccess, HelpGate } from '../access.service'
import type { Rendered } from './check'
import { cashDrawer } from './capabilities/cashDrawer'
import { depositsWeek } from './capabilities/depositsWeek'
import { findPayment } from './capabilities/findPayment'
import { openOrders } from './capabilities/openOrders'
import { paymentInvoice } from './capabilities/paymentInvoice'
import { planStatus } from './capabilities/planStatus'
import { reservationsToday } from './capabilities/reservationsToday'
import { salesToday } from './capabilities/salesToday'
import { supportDataNoPermission, supportDataRefusal, type DataRefusalKey } from './texts'

/** El catálogo de la B: qué datos existen y, para una persona en una sucursal, si cada uno se puede leer. Sin efectos al importarse. */

export interface DataRequest {
  capability: string // llave del catálogo, u 'other' (dato fuera del catálogo)
  day: 'today' | 'yesterday' | 'other' | null // null = no dijo día («esta semana» también llega como null)
  amount: string | null // como lo escribió la persona; el código lo valida contra el mensaje
  time: string | null
  otherVenue: boolean
}
export interface DataScope {
  venueId: string
  organizationId: string
  venueName: string // crudo, de la base: toda plantilla lo imprime con t.text() (la de la caja, con t.strict())
  timezone: string
  day: string // yyyy-mm-dd de hoy en la sucursal (día calendario, T-B9)
  kycVerified: boolean // la regla del panel: verificación aprobada o negocio de prueba
  now: Date
  rows: number // SupportDataConfig.rows
  openOrdersDays: number
  depositGroups: number // SupportDataConfig.depositGroups: tope de grupos de «lo que cae esta semana»
  depositTimeoutMs: number // SupportDataConfig.depositTimeoutMs: el statement_timeout de esa misma lectura
}
/** T-B43: una negativa la elige la capacidad por su llave, nunca la escribe: su texto fijo vive en SUPPORT_DATA_REFUSALS (texts.ts). */
export type ParamsResult<P> = { ok: true; value: P } | { ok: false; refusal: DataRefusalKey }
/** Lo lanza una lectura que prefiere no dar la cifra a darla inexacta. Vive en `readRefusal.ts` (sin dependencias: sin ciclo con las capacidades). */
export { DataReadRefusal } from './readRefusal'
/** UNA capacidad con SUS tipos: `P` es lo que entrega `params` y `R` lo que entrega `read`. Con tipos concretos sólo se escribe al declararla, en su archivo. */
export interface DataCapability<P, R> {
  key: string // 'sales_today'
  label: string // 'ventas de hoy': lista de lo que sí puede, marcador de historial, correo y lista semanal
  object: string // 'las ventas de hoy': «no puedo mostrarte …»
  aiHint: string // el renglón fijo, sin datos, que ve la IA
  permissions: string[] // todos, con permissionListGrants
  roles?: StaffRole[] // sólo si la pantalla del panel pide puesto
  gate?: HelpGate & { refusal: DataRefusalKey } // candado de plan de la pantalla y la llave de su texto
  available?: () => Promise<boolean> // false = todavía apagada (le falta algo de la base): se trata como fuera del catálogo
  notOffered?: (scope: DataScope) => DataRefusalKey | null // antes de leer nada: la llave de su texto si no se ofrece en esa sucursal
  params: (request: DataRequest, message: string, scope: DataScope) => ParamsResult<P>
  read: (scope: DataScope, params: P) => Promise<R>
  render: (scope: DataScope, params: P, result: R) => Rendered
}
/**
 * Una capacidad cualquiera, sin mirar sus tipos. Es el ÚNICO tipo con el que se RECIBE una capacidad: el catálogo, los candados,
 * el orquestador, el worker, la entrega y los barridos guardan juntas capacidades de tipos distintos, y pasan lo que da `params`
 * a `read` y lo que da `read` a `render` sin abrirlo. `DataCapability` no tiene tipos por omisión a propósito: escrito «a secas»
 * no compila, así que nadie lo usa como parámetro por descuido (con `unknown`, una capacidad tipada no cabría: TS2345 y TS2322).
 */
export type AnyDataCapability = DataCapability<any, any>
/** La marca de un catálogo registrado. Sólo existe en los tipos: en ejecución no hay nada. */
declare const REGISTERED: unique symbol
/**
 * Un catálogo REGISTRADO: el de verdad (`DATA_CAPABILITIES`) o el de una prueba (`dataCatalog(fake)`). Sólo `dataCatalog` lo arma: un
 * objeto escrito a mano no compila, así que todo el que lee un catálogo (el orquestador, el worker, la entrega, los avisos y los
 * barridos) lee capacidades congeladas (T-B44, T-B46).
 */
export type DataCatalog = { readonly [key: string]: Readonly<AnyDataCapability> } & { readonly [REGISTERED]: true }
const TEXT_MEMBERS = ['key', 'label', 'object', 'aiHint'] as const
const REQUIRED_FUNCTIONS = ['params', 'read', 'render'] as const
const OPTIONAL_FUNCTIONS = ['available', 'notOffered'] as const
const CONTRACT = [...TEXT_MEMBERS, 'permissions', 'roles', 'gate', ...REQUIRED_FUNCTIONS, ...OPTIONAL_FUNCTIONS] as const
const GATE_MEMBERS = ['featureCode', 'gateKind', 'activationKey', 'refusal'] as const
/** true si `member` es un getter o un setter, en el objeto o en su prototipo (un getter no se congela: daría otro valor después). */
function isAccessor(o: object, member: string): boolean {
  for (let p: object | null = o; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, member)
    if (d) return !('value' in d)
  }
  return false
}
/**
 * T-B45/T-B46: lo que está mal en la forma de UNA capacidad. Cada miembro del contrato es un valor (nunca un getter), con el tipo que
 * pide el contrato: los cuatro textos, los permisos, el puesto y el candado si están, y las funciones (`params`, `read` y `render`
 * siempre; `available` y `notOffered` si están).
 */
function shapeProblems(c: AnyDataCapability): string[] {
  const gate: object | undefined = typeof c.gate === 'object' && c.gate !== null ? c.gate : undefined
  return [
    ...CONTRACT.filter(m => isAccessor(c, m)),
    ...(gate ? GATE_MEMBERS.filter(m => isAccessor(gate, m)).map(m => `gate.${m}`) : []),
    ...TEXT_MEMBERS.filter(m => typeof c[m] !== 'string'),
    ...(Array.isArray(c.permissions) ? [] : ['permissions']),
    ...(c.roles === undefined || Array.isArray(c.roles) ? [] : ['roles']),
    ...(c.gate === undefined || gate ? [] : ['gate']),
    ...REQUIRED_FUNCTIONS.filter(m => typeof c[m] !== 'function'),
    ...OPTIONAL_FUNCTIONS.filter(m => c[m] !== undefined && typeof c[m] !== 'function'),
  ]
}
/**
 * T-B46: registra las capacidades, en el orden en que se listan a la persona. Sin copia: se revisa la forma de cada una (si algo falta o
 * no es del tipo del contrato, lanza al cargar: falla cerrado), se congela a fondo EN SU LUGAR y el catálogo guarda ESE mismo objeto.
 * Así un método ve lo mismo que escribió quien la hizo (su `this`, sus banderas), y nada cambia después: las negativas, la lista de
 * «fuera del catálogo», la marca del historial, los renglones para la IA y los avisos leen la capacidad congelada. Una vez, al cargar el
 * módulo (o al armar el catálogo de una prueba); nunca por petición. Dos con la misma llave no se registran.
 */
export function dataCatalog(...capabilities: AnyDataCapability[]): DataCatalog {
  for (const c of capabilities) {
    const wrong = shapeProblems(c)
    if (wrong.length) throw new Error(`Support data: capability ${String(c.key)} cannot be registered: ${wrong.join(', ')}`)
  }
  const keys = capabilities.map(c => c.key)
  if (new Set(keys).size !== keys.length) throw new Error(`Support data: two capabilities with the same key (${keys.join(', ')})`)
  return deepFreeze(Object.fromEntries(capabilities.map(c => [c.key, c]))) as unknown as DataCatalog
}
/**
 * En el orden en que se listan a la persona: sales_today, deposits_week, find_payment, payment_invoice, cash_drawer,
 * open_orders, reservations_today, plan_status. Cada tarea C agrega su capacidad en SU lugar de esa lista:
 * `dataCatalog(salesToday, depositsWeek, …)`.
 */
export const DATA_CAPABILITIES: DataCatalog = dataCatalog(
  salesToday,
  depositsWeek,
  findPayment,
  paymentInvoice,
  cashDrawer,
  openOrders,
  reservationsToday,
  planStatus,
)
/** El `label` congelado de una llave guardada en la base; null si ya no está en el catálogo (sólo llaves propias). */
export const dataLabel = (capabilities: DataCatalog, key: string): string | null =>
  Object.prototype.hasOwnProperty.call(capabilities, key) ? capabilities[key].label : null
/** El renglón fijo, sin datos, que ve la IA por cada capacidad. */
export interface DataAiRow {
  capability: string
  description: string
}
export const dataCatalogForAi = (capabilities: DataCatalog = DATA_CAPABILITIES): DataAiRow[] =>
  Object.values(capabilities).map(c => ({ capability: c.key, description: c.aiHint }))

export type GateRefusal = { result: Extract<SupportDataResult, 'NO_PERMISSION' | 'PLAN_REQUIRED'>; text: string }
/** El candado de plan con el que se lee el acceso (`resolveHelpAccess`) para esta capacidad. */
export const capabilityGates = (def: AnyDataCapability): HelpGate[] => (def.gate ? [def.gate] : [])

/**
 * Permiso, puesto y plan de UNA capacidad contra un acceso leído con capabilityGates(def). null = puede.
 * `access.permissions` ya viene resuelta: se mira con permissionListGrants y nunca se expande otra vez (expandirla dos veces
 * concede permisos que el panel niega). Un candado de plan sin su código no deja pasar. Las dos negativas son textos fijos (T-B43).
 */
export function checkCapabilityAccess(def: AnyDataCapability, access: HelpAccess): GateRefusal | null {
  // every() sobre una lista vacía es true: una capacidad sin permisos no se concede a nadie
  const permitted =
    def.permissions.length > 0 &&
    def.permissions.every(p => permissionListGrants(access.permissions, p)) &&
    (!def.roles || def.roles.includes(access.role))
  if (!permitted) return { result: 'NO_PERMISSION', text: supportDataNoPermission(def.object) }
  if (def.gate && !(def.gate.featureCode && access.features[def.gate.featureCode]?.included))
    return { result: 'PLAN_REQUIRED', text: supportDataRefusal(def.gate.refusal) }
  return null
}
