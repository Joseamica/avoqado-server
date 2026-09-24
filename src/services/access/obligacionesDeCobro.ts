/**
 * Núcleo PURO de la compra (diseño v5, V5-A; autorizado con cambios por Codex el 22-sep-2026).
 *
 * Sin base ni Stripe a propósito: la regla de qué puede convivir con qué vive en UN sitio y se prueba entera.
 * Quien llama trae lo que Stripe tiene VIVO para el negocio (no el acceso local: un plan suspendido que sigue
 * cobrando es una obligación aunque no dé acceso) y el vínculo de cada fila.
 */

export type Tier = 'PRO' | 'PREMIUM'

export type Proyeccion =
  | { tipo: 'PLAN'; tier: Tier }
  | { tipo: 'FUNCION'; featureCode: string }
  | { tipo: 'AJENO'; productId: string }
  /** Nadie lo reconoce. NUNCA equivale a «no hay obligación»: bloquea. */
  | { tipo: 'DESCONOCIDO'; productId: string | null }

export interface CatalogoDeCobro {
  /** `Feature.stripeProductId` → `Feature.code` (incluye `PLAN_PRO` / `PLAN_PREMIUM`). */
  productoAFuncion: Record<string, string>
  /** Productos nuestros que no dan acceso a nada del catálogo (reservado; hoy vacío en producción). */
  productosAjenos: Set<string>
}

export interface ItemDeSuscripcion {
  priceId: string
  productId: string
  lookupKey: string | null
}

const PLAN_POR_LOOKUP = /^plan_(pro|premium)_/

/**
 * Qué vende una suscripción. El plan se reconoce también por el `lookup_key` de su precio, para que un precio
 * histórico que ya no está en el catálogo siga contando como plan.
 */
export function clasificarSuscripcion(
  items: ItemDeSuscripcion[],
  catalogo: CatalogoDeCobro,
): { proyecciones: Proyeccion[]; variosItems: boolean } {
  if (items.length === 0) return { proyecciones: [{ tipo: 'DESCONOCIDO', productId: null }], variosItems: false }
  const proyecciones = items.map((it): Proyeccion => {
    const porLookup = it.lookupKey?.match(PLAN_POR_LOOKUP)
    if (porLookup) return { tipo: 'PLAN', tier: porLookup[1] === 'premium' ? 'PREMIUM' : 'PRO' }
    const code = catalogo.productoAFuncion[it.productId]
    if (code === 'PLAN_PRO') return { tipo: 'PLAN', tier: 'PRO' }
    if (code === 'PLAN_PREMIUM') return { tipo: 'PLAN', tier: 'PREMIUM' }
    if (code) return { tipo: 'FUNCION', featureCode: code }
    if (catalogo.productosAjenos.has(it.productId)) return { tipo: 'AJENO', productId: it.productId }
    return { tipo: 'DESCONOCIDO', productId: it.productId }
  })
  return { proyecciones, variosItems: items.length > 1 }
}

export type EstadoDeCobro = 'HABILITANTE' | 'RECUPERABLE' | 'TERMINAL'

/**
 * `active`/`trialing` habilitan; `canceled`/`incomplete_expired` terminaron; todo lo demás —incluido un estado
 * que Stripe añada mañana— puede volver a cobrar, y se trata como recuperable.
 */
export function clasificarEstado(status: string): EstadoDeCobro {
  if (status === 'active' || status === 'trialing') return 'HABILITANTE'
  if (status === 'canceled' || status === 'incomplete_expired') return 'TERMINAL'
  return 'RECUPERABLE'
}

export interface ObligacionViva {
  subscriptionId: string
  proyecciones: Proyeccion[]
}

export type Intencion =
  | { tipo: 'PLAN'; tier: Tier }
  | { tipo: 'FUNCION'; featureCode: string }
  /** Sustituir el precio de UNA suscripción de plan identificada; no es añadir otro plan. */
  | { tipo: 'CAMBIO_DE_PLAN'; subscriptionId: string; tierDestino: Tier }

export type CodigoDeIncompatibilidad =
  | 'OBLIGACION_DESCONOCIDA'
  | 'PLAN_YA_CONTRATADO'
  | 'PLAN_ABSORBE_SUELTA'
  | 'FUNCION_YA_CONTRATADA'
  | 'INCLUIDA_EN_EL_PLAN'
  | 'OTRO_PLAN_VIVO'
  | 'SIN_PLAN_QUE_CAMBIAR'
  | 'CAMBIO_AMBIGUO'
  /** Lo que YA cobra el negocio rompe la regla (dos planes, una función dos veces): no se abre nada encima. */
  | 'OBLIGACIONES_INCOMPATIBLES'

export type Compatibilidad = { ok: true } | { ok: false; codigo: CodigoDeIncompatibilidad; suscripciones: string[] }

/**
 * ¿Puede abrirse `intencion` con estas obligaciones vivas? Se cuenta por ÍTEM, no por suscripción, y se valida el
 * conjunto que RESULTARÍA: a lo sumo un plan, ninguna función dos veces, ninguna función que el plan incluya y nada
 * desconocido. `incluye(tier, code)` dice si un plan trae una función (en producción, `elPlanConcede`).
 */
export function evaluarCompatibilidad(
  vivas: ObligacionViva[],
  intencion: Intencion,
  incluye: (tier: Tier, featureCode: string) => boolean,
): Compatibilidad {
  const items = vivas.flatMap(v => v.proyecciones.map(p => ({ sub: v.subscriptionId, p })))
  const subs = (xs: Array<{ sub: string }>) => [...new Set(xs.map(x => x.sub))]
  const no = (codigo: CodigoDeIncompatibilidad, xs: Array<{ sub: string }>): Compatibilidad => ({
    ok: false,
    codigo,
    suscripciones: subs(xs),
  })

  const desconocidos = items.filter(x => x.p.tipo === 'DESCONOCIDO')
  if (desconocidos.length) return no('OBLIGACION_DESCONOCIDA', desconocidos)

  const planes = items.flatMap(x => (x.p.tipo === 'PLAN' ? [{ sub: x.sub, tier: x.p.tier }] : []))
  const funciones = items.flatMap(x => (x.p.tipo === 'FUNCION' ? [{ sub: x.sub, code: x.p.featureCode }] : []))

  // 1. Lo específico de la intención (el mensaje más útil primero).
  let tierResultante: Tier | null = planes[0]?.tier ?? null
  if (intencion.tipo === 'PLAN') {
    if (planes.length) return no('PLAN_YA_CONTRATADO', planes)
    tierResultante = intencion.tier
  } else if (intencion.tipo === 'CAMBIO_DE_PLAN') {
    const delCambio = planes.filter(x => x.sub === intencion.subscriptionId)
    if (delCambio.length === 0) return { ok: false, codigo: 'SIN_PLAN_QUE_CAMBIAR', suscripciones: [intencion.subscriptionId] }
    // Cambiar el precio sustituye UN ítem: si la suscripción trae el plan junto con cualquier otro, no es inequívoco cuál
    // (Codex C7: se cambiaba el PRIMERO, que podía ser la función suelta, y se seguía cobrando el plan viejo).
    if (items.filter(x => x.sub === intencion.subscriptionId).length > 1) return no('CAMBIO_AMBIGUO', delCambio)
    const otros = planes.filter(x => x.sub !== intencion.subscriptionId)
    if (otros.length) return no('OTRO_PLAN_VIVO', otros)
    tierResultante = intencion.tierDestino
  } else {
    const iguales = funciones.filter(x => x.code === intencion.featureCode)
    if (iguales.length) return no('FUNCION_YA_CONTRATADA', iguales)
  }

  // 2. El conjunto que YA existe no puede estar roto: dos planes, una función cobrada dos veces (se cuentan ÍTEMS: dos
  //    ítems de la misma función en UNA suscripción también cobran doble), o una suelta que el plan vivo ya incluye.
  if (planes.length > 1) return no('OBLIGACIONES_INCOMPATIBLES', planes)
  const porCodigo = new Map<string, Array<{ sub: string }>>()
  for (const x of funciones) porCodigo.set(x.code, [...(porCodigo.get(x.code) ?? []), x])
  for (const grupo of porCodigo.values()) if (grupo.length > 1) return no('OBLIGACIONES_INCOMPATIBLES', grupo)
  const planVivo = planes[0]?.tier
  // (En un cambio de plan lo que cuenta es el conjunto RESULTANTE, que se valida abajo con el tier destino.)
  if (planVivo && intencion.tipo !== 'CAMBIO_DE_PLAN') {
    const solapadas = funciones.filter(x => incluye(planVivo, x.code))
    if (solapadas.length) return no('OBLIGACIONES_INCOMPATIBLES', solapadas)
  }

  // 3. El conjunto RESULTANTE: ninguna función suelta que el plan resultante ya incluya.
  if (intencion.tipo === 'FUNCION') {
    if (tierResultante && incluye(tierResultante, intencion.featureCode)) return no('INCLUIDA_EN_EL_PLAN', planes)
    return { ok: true }
  }
  const absorbidas = tierResultante ? funciones.filter(x => incluye(tierResultante as Tier, x.code)) : []
  if (absorbidas.length) return no('PLAN_ABSORBE_SUELTA', absorbidas)
  return { ok: true }
}

export interface FilaDePlan {
  vinculo: string | null
  active: boolean
}

export type Cobrable = 'SI' | 'NO' | 'INCIERTO'

/**
 * Qué se le hace a UNA fila de plan:
 * - `LIGAR` / `SUSTITUIR`: el vínculo pasa a ser esta suscripción; `activar` dice el acceso resultante.
 * - `APLICAR_ESTADO`: ya apunta a esta suscripción; el acceso lo decide su manejador de estado (gracia, suspensión).
 * - `RETIRAR_ACCESO`: `active = false`, el vínculo se conserva (la obligación sigue representada).
 * - `SOLTAR`: vínculo nulo y `active = false`. Va ANTES que el `LIGAR` de la otra fila (el vínculo es único).
 */
export type OperacionDeFila =
  | { op: 'LIGAR' | 'SUSTITUIR'; activar: boolean }
  | { op: 'APLICAR_ESTADO' }
  | { op: 'RETIRAR_ACCESO' }
  | { op: 'SOLTAR' }

export interface DecisionDeEntrega {
  /** Todas se aplican juntas, en una transacción. */
  filas: Partial<Record<Tier, OperacionDeFila>>
  /** Obligaciones vivas con las que choca esta suscripción: se registra el conflicto (durable). */
  conflictoCon?: string[]
  /** Faltó una respuesta de Stripe. Las operaciones de `filas` SÍ se aplican; el evento se reprocesa. */
  reintentar: boolean
}

/**
 * Qué hacer con las filas de los DOS tiers al entregar una suscripción de plan. `tier` sale del PRECIO vigente
 * (nunca de la metadata de la sesión); `puedeCobrar` trae la respuesta de Stripe para cada vínculo AJENO que
 * aparezca en las filas (sin respuesta ⇒ INCIERTO, nunca terminado).
 *
 * Reglas (Codex, 22-sep): las retiradas que ya se saben se devuelven SIEMPRE, aunque la entrega termine en
 * conflicto o en reintento; una entrante terminal sólo retira lo suyo; nunca se pisa un vínculo vivo o incierto;
 * y una suscripción pagada HABILITANTE sustituye las concesiones locales (cortesía o prueba sin vínculo).
 */
export function decidirEntregaDePlan(entrada: {
  subscriptionId: string
  tier: Tier
  estado: EstadoDeCobro
  filas: Partial<Record<Tier, FilaDePlan>>
  puedeCobrar: Record<string, Cobrable>
}): DecisionDeEntrega {
  const { subscriptionId: s, tier, estado, filas, puedeCobrar } = entrada
  const otro: Tier = tier === 'PRO' ? 'PREMIUM' : 'PRO'
  const destino = filas[tier]
  const origen = filas[otro]
  const cobrable = (id: string): Cobrable => puedeCobrar[id] ?? 'INCIERTO'
  const ops: Partial<Record<Tier, OperacionDeFila>> = {}
  const conflictoCon: string[] = []
  let reintentar = false

  // Una suscripción terminada sólo retira lo SUYO; no se representa ni se mueve sobre nada.
  if (estado === 'TERMINAL') {
    for (const t of [tier, otro]) if (filas[t]?.vinculo === s) ops[t] = { op: 'RETIRAR_ACCESO' }
    return { filas: ops, reintentar }
  }

  // 1. El otro tier, cuando lo ocupa algo AJENO a esta suscripción.
  let otroEsConcesionLocal = false
  if (origen && origen.vinculo !== s) {
    if (origen.vinculo) {
      const r = cobrable(origen.vinculo)
      if (r === 'SI') conflictoCon.push(origen.vinculo)
      else if (r === 'INCIERTO') reintentar = true
      else if (origen.active) ops[otro] = { op: 'RETIRAR_ACCESO' } // su obligación terminó: nada lo respalda
    } else if (origen.active) {
      otroEsConcesionLocal = true
    }
  }

  // 2. El destino: ¿puede representar a esta suscripción?
  let representa = false
  if (destino?.vinculo === s) {
    ops[tier] = { op: 'APLICAR_ESTADO' }
    representa = true
  } else {
    let libre = true
    let destinoTerminado = false
    if (destino?.vinculo) {
      const r = cobrable(destino.vinculo)
      if (r === 'SI') {
        conflictoCon.push(destino.vinculo)
        libre = false
      } else if (r === 'INCIERTO') {
        reintentar = true
        libre = false
      } else {
        destinoTerminado = true
      }
    }
    if (libre && conflictoCon.length === 0 && !reintentar) {
      // Una concesión local del MISMO tier la toma esta suscripción: la fila es una por tier y no puede guardar dos
      // procedencias, así que desde aquí el acceso lo decide ella (si aún no habilita, la concesión se pierde).
      ops[tier] = { op: destino?.vinculo ? 'SUSTITUIR' : 'LIGAR', activar: estado === 'HABILITANTE' }
      representa = true
    } else if (destinoTerminado && destino?.active) {
      // No se pudo representar (el otro tier bloquea), pero lo que había en el destino ya no está respaldado.
      ops[tier] = { op: 'RETIRAR_ACCESO' }
    }
  }

  // 3. Si esta suscripción estaba en el otro tier (cambió de precio): suelta si ya quedó representada en el destino;
  //    si no, conserva el vínculo (sigue representada) pero su acceso ya no está respaldado.
  if (origen?.vinculo === s) ops[otro] = representa ? { op: 'SOLTAR' } : { op: 'RETIRAR_ACCESO' }

  // 4. Una pagada que ya habilita sustituye la concesión local del otro tier.
  if (otroEsConcesionLocal && representa && estado === 'HABILITANTE') ops[otro] = { op: 'RETIRAR_ACCESO' }

  return conflictoCon.length ? { filas: ops, conflictoCon, reintentar } : { filas: ops, reintentar }
}
