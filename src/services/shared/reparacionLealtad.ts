import { normalizarTelefonoMx } from '@/utils/phone'

/**
 * Piezas de `scripts/lealtad/reparar-telefonos-y-sellos.ts` (spec 2026-10-14 §3.6) SIN base de datos: el script lee, estas
 * funciones deciden, el script escribe (o les pasa sus funciones). Así la decisión tiene pruebas y la simulación imprime
 * exactamente lo que se aplicaría.
 *
 * 🔴 Este módulo NO importa nada que cargue el cliente de Prisma (lo vigila `reparacionLealtad.test.ts`): el script lo importa
 * de forma estática, y si arrastrara `prismaClient` el cliente se construiría con el DATABASE_URL de `.env` ANTES de que
 * `--base render` lo cambie — el host confirmado sería uno y la base escrita, otra.
 */

// ── Banderas y base ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Banderas {
  base: 'render' | 'local' | null
  aplicar: boolean
  confirmHost: string | null
}

const BANDERAS_CON_VALOR = new Set(['--base', '--confirm-host'])
const BANDERAS_SOLAS = new Set(['--apply', '--dry-run'])

/**
 * 🔴 Fix ronda 1 (#3v): sólo banderas conocidas, cada una una vez, con su valor, y sin contradicciones. Un `--aplicar` mal
 * escrito no puede convertirse en silencio en una simulación (ni al revés).
 */
export function interpretarBanderas(args: readonly string[]): { ok: true; banderas: Banderas } | { ok: false; error: string } {
  const error = (e: string) => ({ ok: false as const, error: e })
  const vistas = new Set<string>()
  let base: Banderas['base'] = null
  let confirmHost: string | null = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!BANDERAS_CON_VALOR.has(a) && !BANDERAS_SOLAS.has(a)) {
      return error(`bandera desconocida «${a}» (sólo se aceptan --base, --apply, --dry-run y --confirm-host)`)
    }
    if (vistas.has(a)) return error(`bandera repetida «${a}»`)
    vistas.add(a)
    if (BANDERAS_SOLAS.has(a)) continue
    const valor = args[i + 1]
    if (valor === undefined || valor.startsWith('--')) return error(`${a} necesita un valor`)
    i++
    if (a === '--base') {
      if (valor !== 'render' && valor !== 'local') return error(`--base sólo acepta «render» o «local» (recibí «${valor}»)`)
      base = valor
    } else {
      confirmHost = valor
    }
  }
  if (vistas.has('--apply') && vistas.has('--dry-run')) return error('--dry-run y --apply se contradicen: elige uno')
  return { ok: true, banderas: { base, aplicar: vistas.has('--apply'), confirmHost } }
}

/** `URL.hostname` devuelve `[::1]` con corchetes. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * 🔴 La base por defecto (sin `--base render`) NUNCA es producción, y para ESCRIBIR sin `--base render` sólo se acepta loopback
 * (fix ronda 1 #3iv: lista de lo permitido, no de lo prohibido). Una simulación contra otra máquina (p. ej. una copia de
 * producción para ensayar) sí se permite: sólo lee.
 */
export function revisarBase(e: {
  base: Banderas['base']
  aplicar: boolean
  host: string
  hostRender: string | null
}): { ok: true } | { ok: false; motivo: string } {
  if (e.base === 'render') return { ok: true }
  if (e.host === e.hostRender || e.host.endsWith('.render.com')) {
    return { ok: false, motivo: 'DATABASE_URL apunta a producción y no pediste `--base render`: producción sólo se pide explícita.' }
  }
  if (e.aplicar && !LOOPBACK.has(e.host)) {
    return {
      ok: false,
      motivo: `para escribir sin \`--base render\` la base tiene que ser local (localhost, 127.0.0.1 o ::1); ésta es «${e.host}».`,
    }
  }
  return { ok: true }
}

// ── Avisos al cliente (H7) ─────────────────────────────────────────────────────────────────────────────────────────────

/** El host público de la API de PRODUCCIÓN: con él salen las ligas del correo del primer sello y los pases de Wallet. */
export const HOST_API_PRODUCCION = 'api.avoqado.io'

const hostDeUrl = (url: string | undefined): string | null => {
  if (!url) return null
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

/**
 * 🔴 H7 (auditoría de Codex del código + revisión final Important 1, 15-oct-2026): sellar en PRODUCCIÓN le manda al cliente el
 * correo de «guarda tu tarjeta» y actualiza su pase, con la `BASE_URL` del proceso. Corriendo desde la Mac, esa es el túnel de
 * ngrok: el correo llegaría con ligas a la máquina de alguien. Con `--base render --apply` la BASE_URL tiene que ser la API de
 * producción (https), o no se escribe nada. La simulación y la base local no mandan nada a clientes reales: pasan.
 */
export function revisarEntornoPublico(e: {
  base: Banderas['base']
  aplicar: boolean
  baseUrl: string | undefined
}): { ok: true } | { ok: false; motivo: string } {
  if (e.base !== 'render' || !e.aplicar) return { ok: true }
  let url: URL | null = null
  try {
    url = e.baseUrl ? new URL(e.baseUrl) : null
  } catch {
    url = null
  }
  if (url && url.protocol === 'https:' && url.hostname === HOST_API_PRODUCCION) return { ok: true }
  return {
    ok: false,
    motivo:
      `para aplicar en producción BASE_URL tiene que ser https://${HOST_API_PRODUCCION} (es «${hostDeUrl(e.baseUrl) ?? 'sin BASE_URL'}»): ` +
      `con otra, el correo del primer sello y los pases saldrían con ligas que no son de producción. ` +
      `Córrelo desde una shell de Render, o antepón BASE_URL=https://${HOST_API_PRODUCCION}.`,
  }
}

/** Lo que la simulación dice de los avisos al cliente ANTES de aplicar (sólo el host de BASE_URL, nunca la URL completa). */
export function lineaDeEntornoPublico(e: {
  baseUrl: string | undefined
  apple: boolean
  apnsProduccion: boolean
  google: boolean
}): string {
  const apple = e.apple
    ? `disponible (${e.apnsProduccion ? 'APNs de producción' : 'APNs de PRUEBAS: los iPhone de clientes reales no se actualizan'})`
    : 'NO disponible'
  return (
    `Avisos al cliente: BASE_URL → ${hostDeUrl(e.baseUrl) ?? '(sin BASE_URL)'} · Apple Wallet: ${apple} · ` +
    `Google Wallet: ${e.google ? 'disponible' : 'NO disponible'}`
  )
}

// ── (a) Teléfonos ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Lo que guardó el OTP viejo: «+» + 10 dígitos, sin lada. */
export const TELEFONO_SIN_LADA = /^\+\d{10}$/

export interface FilaTelefono {
  id: string
  venueId: string | null
  phone: string
}
export interface CambioDeTelefono {
  id: string
  venueId: string | null
  de: string
  a: string
}
export interface ChoqueDeTelefono extends CambioDeTelefono {
  ocupadoPor: string
}

/** `porNegocio`: Customer (único por venue). Sin él: Consumer (global). */
export function planearTelefonos(
  filas: readonly FilaTelefono[],
  ocupados: readonly FilaTelefono[],
  porNegocio: boolean,
): { cambios: CambioDeTelefono[]; choques: ChoqueDeTelefono[] } {
  const llave = (venueId: string | null, phone: string) => (porNegocio ? `${venueId ?? ''}|${phone}` : phone)
  const duenos = new Map<string, string>()
  for (const o of ocupados) duenos.set(llave(o.venueId, o.phone), o.id)
  const cambios: CambioDeTelefono[] = []
  const choques: ChoqueDeTelefono[] = []
  for (const f of filas) {
    if (!TELEFONO_SIN_LADA.test(f.phone)) continue
    const a = normalizarTelefonoMx(f.phone)
    const k = llave(f.venueId, a)
    const ocupadoPor = duenos.get(k)
    if (ocupadoPor && ocupadoPor !== f.id) {
      choques.push({ id: f.id, venueId: f.venueId, de: f.phone, a, ocupadoPor })
      continue
    }
    cambios.push({ id: f.id, venueId: f.venueId, de: f.phone, a })
    duenos.set(k, f.id)
  }
  return { cambios, choques }
}

// ── (b) El par autorizado ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * 🔴 El ÚNICO par que la spec autoriza a fusionar (§3.6, Testarudo, medido el 14-oct): se queda el `+52…`, se desactiva el
 * que quedó sin lada. Auditoría A #5: no hay fusión genérica.
 */
export const PAR_AUTORIZADO = {
  venueId: 'cmiowv1yu000aqa27mhhxrdqe',
  conservar: 'cmv192e9k0968os29qhgyn86h',
  retirar: 'cmttavm9802bjpk2b6asriztj',
} as const

/**
 * 🔴 Fix ronda 1 (#1): el resto de la historia que puede colgar de un Customer. La LLAVE es el nombre exacto de la relación en
 * `model Customer` (el script la cuenta con `_count`); el valor es cómo se dice en el motivo. Se exige al VIEJO (el que se
 * desactiva): el conservado conserva lo suyo. Cualquiera > 0 ⇒ no se fusiona y decide una persona.
 *
 * Quedan fuera A PROPÓSITO (y por qué): `walletPasses` (se MUEVEN al conservado), `consumer` (el OTP encuentra primero por
 * `(venueId, phone)` y el teléfono queda en el conservado; el Consumer es global y no se toca), `customerGroup` (una etiqueta
 * de segmento, no historia), `referralTier` (se deriva de `referralCount` y de `referralTierUnlocks`, que sí cuentan),
 * `approvalDecidedBy`/`approvalStatus` (metadatos de la aprobación de la cuenta, no historia del cliente) y `venue` (se revisa
 * aparte: los dos del negocio autorizado). `orders`, `orderAssociations`, `reservations`, `creditPackPurchases`,
 * `creditTransactions` y los sellos (`StampEvent`) ya cuentan para los DOS (`ventas`, `reservas`, `paquetes`, `sellos`).
 */
export const OTRA_HISTORIA = {
  loyaltyTransactions: 'movimientos de puntos',
  stampRewards: 'premios de sellos',
  stampCards: 'tarjetas de sellos',
  externalIdentities: 'identidades externas (TotalPass, Wellhub…)',
  taxProfiles: 'perfiles fiscales',
  referralsAsReferrer: 'referidos que hizo',
  referralsAsReferred: 'referidos donde lo invitaron',
  referralGrants: 'premios de referido',
  referralTierUnlocks: 'niveles de referido desbloqueados',
  referredCustomers: 'clientes que refirió',
  couponRedemptions: 'cupones canjeados',
  customerDiscounts: 'descuentos asignados',
  waitlistEntries: 'lugares en lista de espera',
  consentEvents: 'eventos de consentimiento',
  campaignDeliveries: 'envíos de campañas',
  customerOrderMetrics: 'visitas registradas',
  approvalOutbox: 'avisos de aprobación pendientes',
  kioskOutreachOutbox: 'avisos del kiosco',
  captureTokens: 'ligas de captura de datos',
} as const
export type OtraHistoria = keyof typeof OTRA_HISTORIA

export interface ResumenCliente {
  id: string
  venueId: string
  active: boolean
  phone: string | null
  email: string | null
  /** `YYYY-MM-DD` o null. */
  birthDate: string | null
  loyaltyPoints: number
  referralCount: number
  referredByCustomerId: string | null
  notes: string | null
  tags: readonly string[]
  /** StampEvent de sus tarjetas. Se exige a los DOS. */
  sellos: number
  /** `OrderCustomer` + `Order.customerId`. Se exige a los DOS. */
  ventas: number
  /** Se exige a los DOS. */
  reservas: number
  /** `CreditPackPurchase` + `CreditTransaction`. Se exige a los DOS. */
  paquetes: number
  /** Fix ronda 1: se exige al VIEJO. */
  otros: Readonly<Record<OtraHistoria, number>>
}

export type DecisionDeFusion = { decision: 'FUSIONAR' } | { decision: 'SOLO_REPORTAR'; motivo: string }

/**
 * ¿Se fusiona? SÓLO el par autorizado, y sólo si nada cambió: los dos activos, del negocio autorizado, el viejo con la forma
 * sin lada del teléfono del nuevo, los DOS sin sellos, ventas, reservas, paquetes ni créditos, y el VIEJO sin ninguna otra
 * historia (`OTRA_HISTORIA`), sin puntos, sin referidos, sin quién lo refirió, sin notas ni etiquetas, y con correo y cumpleaños
 * vacíos o iguales a los del conservado. Un cliente «sin ventas ni sellos» puede tener reservas, paquetes, consentimientos o su
 * correo, y desactivarlo le quita el acceso por OTP: con cualquier historia decide una persona.
 */
export function decidirFusionAutorizada(viejo: ResumenCliente, nuevo: ResumenCliente): DecisionDeFusion {
  const reportar = (motivo: string): DecisionDeFusion => ({ decision: 'SOLO_REPORTAR', motivo })
  if (viejo.id !== PAR_AUTORIZADO.retirar || nuevo.id !== PAR_AUTORIZADO.conservar) {
    return reportar('no es el par autorizado por la spec: un choque de teléfono sólo se reporta')
  }
  if (viejo.venueId !== PAR_AUTORIZADO.venueId || nuevo.venueId !== PAR_AUTORIZADO.venueId) {
    return reportar('el par ya no está en el negocio autorizado')
  }
  if (!viejo.active || !nuevo.active) return reportar('uno de los dos ya está desactivado')
  if (!viejo.phone || !TELEFONO_SIN_LADA.test(viejo.phone) || normalizarTelefonoMx(viejo.phone) !== nuevo.phone) {
    return reportar('los teléfonos ya no son el mismo número en sus dos formas')
  }
  for (const c of [viejo, nuevo]) {
    const historia = [
      ['sellos', c.sellos],
      ['ventas', c.ventas],
      ['reservas', c.reservas],
      ['paquetes o movimientos de crédito', c.paquetes],
    ].filter(([, n]) => Number(n) > 0)
    if (historia.length) return reportar(`${c.id} tiene ${historia.map(([que, n]) => `${n} ${que}`).join(', ')}`)
  }
  const otra = (Object.keys(OTRA_HISTORIA) as OtraHistoria[]).filter(k => (viejo.otros[k] ?? 0) > 0)
  if (otra.length) return reportar(`${viejo.id} tiene ${otra.map(k => `${viejo.otros[k]} ${OTRA_HISTORIA[k]}`).join(', ')}`)
  const datos: string[] = []
  if (viejo.email && viejo.email !== nuevo.email) datos.push('un correo que el conservado no tiene')
  if (viejo.loyaltyPoints !== 0) datos.push(`${viejo.loyaltyPoints} puntos`)
  if (viejo.referralCount !== 0) datos.push(`${viejo.referralCount} en su contador de referidos`)
  if (viejo.referredByCustomerId) datos.push('quién lo refirió')
  if (viejo.birthDate && viejo.birthDate !== nuevo.birthDate) datos.push('un cumpleaños que el conservado no tiene')
  if (viejo.notes?.trim()) datos.push('notas')
  if (viejo.tags.length) datos.push('etiquetas')
  if (datos.length) return reportar(`${viejo.id} tiene ${datos.join(', ')}`)
  return { decision: 'FUSIONAR' }
}

// ── Bitácora ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Un renglón de `ActivityLog` con los MISMOS campos que escribe `logAction` para un actor de sistema. */
export interface FilaDeBitacora {
  staffId: null
  venueId: string | null
  organizationId: null
  action: string
  entity: string
  entityId: string
  data: Record<string, unknown>
  ipAddress: null
  userAgent: null
}

export function filaDeBitacora(
  action: string,
  entity: string,
  entityId: string,
  venueId: string | null,
  data: Record<string, unknown>,
): FilaDeBitacora {
  return { staffId: null, venueId, organizationId: null, action, entity, entityId, data, ipAddress: null, userAgent: null }
}

// ── Aplicar (a)+(b) dentro de UNA transacción ──────────────────────────────────────────────────────────────────────────

/** Tope de pases del viejo que se mueven; si hay más, no se fusiona (nunca se mueve una parte). */
export const TOPE_PASES = 50

/** Lo que `aplicarTelefonosYPar` necesita de la transacción. El script lo arma con su `tx`; las pruebas, en memoria. */
export interface PuertoDeTransaccion {
  /** `SELECT … FOR UPDATE` de las dos filas del par (en orden de id). */
  bloquearPar(): Promise<void>
  /** CAS: cambia el teléfono sólo si sigue siendo `de`. Devuelve cuántas filas tocó. */
  cambiarTelefonoDeCliente(c: CambioDeTelefono): Promise<number>
  /** Otro Consumer (id distinto) que YA tenga `c.a`, o null. */
  consumerConTelefono(c: CambioDeTelefono): Promise<string | null>
  cambiarTelefonoDeConsumer(c: CambioDeTelefono): Promise<number>
  /** Vuelve a contar TODO del par, con las filas ya bloqueadas. */
  decidirPar(): Promise<DecisionDeFusion>
  /** Hasta `limite` ids de pases del viejo. */
  pasesDelViejo(limite: number): Promise<string[]>
  moverPases(ids: readonly string[]): Promise<number>
  /** CAS: desactiva al viejo sólo si sigue activo y con `telefonoViejo`. */
  desactivarViejo(telefonoViejo: string): Promise<number>
  escribirBitacora(filas: readonly FilaDeBitacora[]): Promise<void>
}

export interface PlanDeAplicacion {
  script: string
  cambiosDeClientes: readonly CambioDeTelefono[]
  cambiosDeConsumidores: readonly CambioDeTelefono[]
  /** El choque del par si el PLAN decidió fusionarlo; null si no. Se revalida aquí dentro. */
  parPorFusionar: ChoqueDeTelefono | null
}

export interface ResultadoDeAplicacion {
  clientes: CambioDeTelefono[]
  consumidores: CambioDeTelefono[]
  /** Otro Consumer ya tenía el +52 al aplicar (apareció después del plan): no se cambió. */
  consumidoresOmitidos: ChoqueDeTelefono[]
  fusion: { aplicada: true; pases: string[] } | { aplicada: false; motivo: string | null }
  /** Renglones de bitácora escritos en la MISMA transacción. */
  bitacora: number
}

/**
 * 🔴 El cuerpo de la transacción de (a)+(b). El llamador la corre DENTRO de `prisma.$transaction`: si algo lanza, se deshace
 * todo, bitácora incluida.
 *
 *   1. Si hay par por fusionar, lo PRIMERO es el candado `FOR UPDATE` de sus dos filas (#3iii). Un `FOR UPDATE` choca con el
 *      `FOR KEY SHARE` que toma cualquier INSERT de una fila hija (una reserva, un paquete, un consentimiento…): mientras dure la
 *      transacción no puede aparecer historia nueva de esos dos clientes, y lo que se cuente después es la verdad.
 *   2. Teléfonos de clientes con CAS (si uno cambió por debajo, se aborta todo).
 *   3. Teléfonos de consumidores: antes de cada uno, ¿otro Consumer ya tiene ese +52? (#3ii: no hay índice único que lo frene).
 *      Si sí, ése no se cambia y se reporta.
 *   4. El par: se revalida con las filas bloqueadas; más de `TOPE_PASES` pases ⇒ no se fusiona (#3vi); mover pases o desactivar
 *      que toquen otro número de filas ⇒ se aborta todo.
 *   5. LO ÚLTIMO: la bitácora de lo que SÍ cambió, en la misma transacción (#2a): cambio y bitácora se confirman juntos o no se
 *      confirma ninguno. Un corte después del commit ya no puede dejar un cambio sin su renglón.
 */
export async function aplicarTelefonosYPar(tx: PuertoDeTransaccion, plan: PlanDeAplicacion): Promise<ResultadoDeAplicacion> {
  const par = plan.parPorFusionar
  if (par) await tx.bloquearPar()

  const clientes: CambioDeTelefono[] = []
  for (const c of plan.cambiosDeClientes) {
    if ((await tx.cambiarTelefonoDeCliente(c)) !== 1) throw new Error(`Cliente ${c.id} cambió por debajo: se aborta TODO.`)
    clientes.push(c)
  }

  const consumidores: CambioDeTelefono[] = []
  const consumidoresOmitidos: ChoqueDeTelefono[] = []
  for (const c of plan.cambiosDeConsumidores) {
    const ocupadoPor = await tx.consumerConTelefono(c)
    if (ocupadoPor) {
      consumidoresOmitidos.push({ ...c, ocupadoPor })
      continue
    }
    if ((await tx.cambiarTelefonoDeConsumer(c)) !== 1) throw new Error(`Consumer ${c.id} cambió por debajo: se aborta TODO.`)
    consumidores.push(c)
  }

  let fusion: ResultadoDeAplicacion['fusion'] = { aplicada: false, motivo: null }
  if (par) {
    const otraVez = await tx.decidirPar()
    if (otraVez.decision !== 'FUSIONAR') {
      fusion = { aplicada: false, motivo: otraVez.motivo }
    } else {
      const pases = await tx.pasesDelViejo(TOPE_PASES + 1)
      if (pases.length > TOPE_PASES) {
        fusion = { aplicada: false, motivo: `el viejo tiene más de ${TOPE_PASES} pases de la cartera: revisar a mano` }
      } else {
        const movidos = pases.length ? await tx.moverPases(pases) : 0
        if (movidos !== pases.length) {
          throw new Error(`Se leyeron ${pases.length} pases y se movieron ${movidos}: se aborta TODO.`)
        }
        if ((await tx.desactivarViejo(par.de)) !== 1) {
          throw new Error(`Cliente duplicado ${PAR_AUTORIZADO.retirar} cambió por debajo: se aborta TODO.`)
        }
        fusion = { aplicada: true, pases }
      }
    }
  }

  const filas: FilaDeBitacora[] = [
    ...clientes.map(c =>
      filaDeBitacora('CUSTOMER_PHONE_NORMALIZED', 'Customer', c.id, c.venueId, { de: c.de, a: c.a, script: plan.script }),
    ),
    ...consumidores.map(c =>
      filaDeBitacora('CONSUMER_PHONE_NORMALIZED', 'Consumer', c.id, null, { de: c.de, a: c.a, script: plan.script }),
    ),
    ...(fusion.aplicada && par
      ? [
          filaDeBitacora('CUSTOMER_MERGED_DUPLICATE', 'Customer', PAR_AUTORIZADO.retirar, PAR_AUTORIZADO.venueId, {
            conservado: PAR_AUTORIZADO.conservar,
            telefonoViejo: par.de,
            pasesMovidos: fusion.pases,
            script: plan.script,
          }),
        ]
      : []),
  ]
  if (filas.length) await tx.escribirBitacora(filas)
  return { clientes, consumidores, consumidoresOmitidos, fusion, bitacora: filas.length }
}

// ── (c) Sellos ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * 🔴 Sin «YA_SELLADA» a propósito (auditoría A #6): un EARN existente no prueba que la reparación terminó (pudo cortarse antes
 * de los puntos). `elegible` = `revalidarVenta(...)`: la MISMA regla del sello tardío (`esElegibleParaLealtad` con
 * `{ ignorarPlazo: true }`) más que el cliente siga primario — spec §3.6, sin las 24 h.
 */
export type DecisionDeSello = 'NO_EXISTE' | 'AMBIGUA' | 'SIN_CLIENTE' | 'PROGRAMA_APAGADO' | 'NO_ELEGIBLE' | 'COMPLETAR'

export function decidirReparacionDeSello(e: {
  coincidencias: number
  clienteId: string | null
  programaActivo: boolean
  elegible: boolean
}): DecisionDeSello {
  if (e.coincidencias === 0) return 'NO_EXISTE'
  if (e.coincidencias > 1) return 'AMBIGUA'
  if (!e.clienteId) return 'SIN_CLIENTE'
  if (!e.programaActivo) return 'PROGRAMA_APAGADO'
  if (!e.elegible) return 'NO_ELEGIBLE'
  return 'COMPLETAR'
}

export type RevalidacionDeVenta = { elegible: true } | { elegible: false; motivo: string }

/**
 * 🔴 B2 (auditoría de Codex, ronda B): la elegibilidad COMPLETA de la reparación, salvo el plazo de 24 h. La usa el plan y,
 * OTRA VEZ, cada venta justo antes de otorgarse al aplicar: entre la simulación (o la lectura del inicio de `--apply`) y el
 * turno de cada venta pudo entrar un reembolso, una cancelación o un cambio de cliente.
 *
 * El script calcula con la foto de la venta (`fotoDeLaVenta`) `elegible = esElegibleParaLealtad(foto, ahora,
 * { ignorarPlazo: true })` (saldada, no cancelada, sin reembolso contado exacto, sin sello ni puntos de OTRO cliente) y
 * `decision = decideSaleStamp(...)`. Aquí se agrega lo que esa regla deja pasar: que ESTE cliente siga siendo el primario. Sin
 * primario, `decideSaleStamp` dice ELIGIBLE (la liga lo volvería primario), pero la lealtad del cobro no tendría a quién
 * sellar: se reporta en vez de correrla a ciegas.
 */
export function revalidarVenta(e: {
  existe: boolean
  clienteId: string
  primarioActual: string | null
  elegible: boolean
  decision: string | null
}): RevalidacionDeVenta {
  if (!e.existe) return { elegible: false, motivo: 'la venta ya no existe' }
  if (e.primarioActual !== e.clienteId) {
    return {
      elegible: false,
      motivo: `el cliente ${e.clienteId} ya no es el primario de la venta (ahora: ${e.primarioActual ?? 'ninguno'})`,
    }
  }
  if (!e.elegible) return { elegible: false, motivo: `ya no es elegible (${e.decision ?? 'sin decisión'})` }
  return { elegible: true }
}

export interface VentaPorReparar {
  orderNumber: string
  orderId: string
  clienteId: string
  /** Venta y cargos sin propina (la base del cobro y del reconciliador). */
  base: number
}

/** Lo que la lealtad de UNA venta ya dejó para su cliente. Se lee antes y después de otorgar para saber si algo cambió. */
export interface EstadoDeLealtad {
  /** Sello VÁLIDO: hay EARN de esta venta y no hay REVERSAL. */
  conSello: boolean
  /** LoyaltyTransaction EARN de esta venta para este cliente. */
  conPuntos: boolean
  /** CustomerOrderMetric de esta venta para este cliente (la visita). */
  conVisita: boolean
}

export interface ResultadoDeReparacion {
  orderNumber: string
  /** `null`: se corrió la lealtad. Texto: por qué NO se tocó al aplicar (revalidación, B2). */
  omitida: string | null
  completa: boolean
  conSello: boolean
  /** La venta se reembolsó mientras se otorgaba: el envoltorio no otorgó o revirtió el sello. */
  reembolsada: boolean
  /** Algo cambió en ESTA corrida (sello, puntos o visita). Informativo: no decide la bitácora. */
  cambio: boolean
  /** ESCRITA: esta corrida escribió el renglón · YA_EXISTIA: una corrida anterior ya lo había escrito · NO_APLICA: omitida. */
  auditoria: 'ESCRITA' | 'YA_EXISTIA' | 'NO_APLICA'
}

const mismoEstado = (a: EstadoDeLealtad, b: EstadoDeLealtad): boolean =>
  a.conSello === b.conSello && a.conPuntos === b.conPuntos && a.conVisita === b.conVisita

/**
 * (c) Corre la lealtad de cada venta y deja su renglón de bitácora EN CUANTO termina cada una. Reanudable por construcción: no
 * decide nada con «ya tiene sello»; `completar` es `otorgarLealtadRespetandoReembolsos` (B2: idempotente, no otorga a una venta
 * devuelta y revierte el sello si el reembolso entra mientras otorga), así que correrlo otra vez después de una corrida cortada
 * completa lo que falte sin duplicar nada.
 *
 * 🔴 B2: cada venta se REVALIDA en su turno (`revalidar`), justo antes de otorgar. Si ya no es elegible, no se toca.
 * 🔴 Fix ronda 1 (#2c): la bitácora se decide por la EXISTENCIA del renglón `STAMP_REPAIRED_FOR_LATE_CUSTOMER` de esa venta
 * (`yaAuditada`), no por el antes/después: si una corrida se cayó entre otorgar y escribir el renglón, la siguiente ya no ve
 * cambio, pero sí ve que falta el renglón y lo escribe; y nunca lo escribe dos veces. `auditar` LANZA si no puede escribir (la
 * re-corrida lo recupera).
 */
export async function completarLealtadDeVentas(
  ventas: readonly VentaPorReparar[],
  deps: {
    /** El script: `fotoDeLaVenta` + `esElegibleParaLealtad(…, { ignorarPlazo: true })` + `revalidarVenta`. */
    revalidar: (v: VentaPorReparar) => Promise<RevalidacionDeVenta>
    /** El script: `otorgarLealtadRespetandoReembolsos`. */
    completar: (v: VentaPorReparar) => Promise<{ complete: boolean; reembolsada: boolean }>
    estado: (v: VentaPorReparar) => Promise<EstadoDeLealtad>
    /** ¿Ya existe el renglón de bitácora de esta venta? */
    yaAuditada: (v: VentaPorReparar) => Promise<boolean>
    /** Escribe el renglón; si falla, LANZA. */
    auditar: (v: VentaPorReparar, r: ResultadoDeReparacion) => Promise<void>
    /** Consola. */
    informar?: (v: VentaPorReparar, r: ResultadoDeReparacion) => void | Promise<void>
  },
): Promise<ResultadoDeReparacion[]> {
  const resultados: ResultadoDeReparacion[] = []
  for (const v of ventas) {
    const revalidada = await deps.revalidar(v)
    let r: ResultadoDeReparacion
    if (!revalidada.elegible) {
      const ahora = await deps.estado(v)
      r = {
        orderNumber: v.orderNumber,
        omitida: revalidada.motivo,
        completa: false,
        conSello: ahora.conSello,
        reembolsada: false,
        cambio: false,
        auditoria: 'NO_APLICA',
      }
    } else {
      const antes = await deps.estado(v)
      const { complete, reembolsada } = await deps.completar(v)
      const despues = await deps.estado(v)
      r = {
        orderNumber: v.orderNumber,
        omitida: null,
        completa: complete,
        conSello: despues.conSello,
        reembolsada,
        cambio: !mismoEstado(antes, despues),
        auditoria: 'ESCRITA',
      }
      if (await deps.yaAuditada(v)) {
        r = { ...r, auditoria: 'YA_EXISTIA' }
      } else {
        await deps.auditar(v, r)
      }
    }
    await deps.informar?.(v, r)
    resultados.push(r)
  }
  return resultados
}
