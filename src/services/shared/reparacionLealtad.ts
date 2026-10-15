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

/**
 * 🔴 El ÚNICO par que la spec autoriza a fusionar (§3.6, Testarudo, medido el 14-oct): se queda el `+52…`, se desactiva el
 * que quedó sin lada. Auditoría A #5: no hay fusión genérica.
 */
export const PAR_AUTORIZADO = {
  venueId: 'cmiowv1yu000aqa27mhhxrdqe',
  conservar: 'cmv192e9k0968os29qhgyn86h',
  retirar: 'cmttavm9802bjpk2b6asriztj',
} as const

export interface ResumenCliente {
  id: string
  venueId: string
  active: boolean
  phone: string | null
  sellos: number
  /** `OrderCustomer` + `Order.customerId`. */
  ventas: number
  reservas: number
  /** `CreditPackPurchase` + `CreditTransaction`. */
  paquetes: number
}

export type DecisionDeFusion = { decision: 'FUSIONAR' } | { decision: 'SOLO_REPORTAR'; motivo: string }

/**
 * ¿Se fusiona? SÓLO el par autorizado, y sólo si nada cambió: los dos activos, del negocio autorizado, el viejo con la forma
 * sin lada del teléfono del nuevo, y los DOS sin sellos, ventas, reservas, paquetes ni créditos. Un cliente «sin ventas ni
 * sellos» puede tener reservas o paquetes, y desactivarlo le quita el acceso por OTP: con cualquier historia decide una persona.
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
  return { decision: 'FUSIONAR' }
}

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
  /** Algo cambió (sello, puntos o visita). Sin cambio = ya estaba completa: el script no escribe bitácora (no es un hecho). */
  cambio: boolean
}

const mismoEstado = (a: EstadoDeLealtad, b: EstadoDeLealtad): boolean =>
  a.conSello === b.conSello && a.conPuntos === b.conPuntos && a.conVisita === b.conVisita

/**
 * (c) Corre la lealtad de cada venta y anota el resultado EN CUANTO termina cada una. Reanudable por construcción: no decide
 * nada con «ya tiene sello»; `completar` es `otorgarLealtadRespetandoReembolsos` (B2: idempotente, no otorga a una venta
 * devuelta y revierte el sello si el reembolso entra mientras otorga), así que correrlo otra vez después de una corrida cortada
 * completa lo que falte sin duplicar nada.
 *
 * 🔴 B2: cada venta se REVALIDA en su turno (`revalidar`), justo antes de otorgar. Si ya no es elegible, no se toca.
 */
export async function completarLealtadDeVentas(
  ventas: readonly VentaPorReparar[],
  deps: {
    /** El script: `fotoDeLaVenta` + `esElegibleParaLealtad(…, { ignorarPlazo: true })` + `revalidarVenta`. */
    revalidar: (v: VentaPorReparar) => Promise<RevalidacionDeVenta>
    /** El script: `otorgarLealtadRespetandoReembolsos`. */
    completar: (v: VentaPorReparar) => Promise<{ complete: boolean; reembolsada: boolean }>
    estado: (v: VentaPorReparar) => Promise<EstadoDeLealtad>
    /** El script: `logAction` (sólo si hubo cambio) + consola. */
    registrar?: (v: VentaPorReparar, r: ResultadoDeReparacion) => Promise<void>
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
      }
    }
    await deps.registrar?.(v, r)
    resultados.push(r)
  }
  return resultados
}
