/**
 * The codes of «Clientes» (plan C1, C1b): what it uses, its plan level and condition, its state, why a signup stalled and what
 * it leaves Avoqado. A LEAF
 * (no imports): the request schema, the SQL and the screens read the same lists without loading any service.
 */
export const USA = ['AMBOS', 'TERMINAL', 'POS', 'NO_IDENTIFICADO', 'NINGUNO'] as const
export type Usa = (typeof USA)[number]
/** What a person may write by hand (✋); «Leerlo solo» clears it. */
export const USA_ESCRITO = ['AMBOS', 'TERMINAL', 'POS'] as const
export type UsaEscrito = (typeof USA_ESCRITO)[number]
/** ENTERPRISE has no code in the database (`basePlan.service.ts`), so it is never a level here. */
export const NIVELES = ['FREE', 'PRO', 'PREMIUM'] as const
export type Nivel = (typeof NIVELES)[number]
export const CONDICIONES = ['PAGADO', 'CAMPANA', 'PRUEBA_CON_TARJETA', 'PRUEBA_SIN_TARJETA', 'CORTESIA', 'DE_ANTES', 'GRATIS'] as const
export type Condicion = (typeof CONDICIONES)[number]
export const ESTADOS = ['ALTA_SIN_TARJETA', 'COBRA', 'SIN_COBROS', 'NUNCA'] as const
export type Estado = (typeof ESTADOS)[number]
export const MOTIVOS_DEL_ALTA = ['PRECIO', 'NO_QUISO_TARJETA', 'SOLO_VEIA', 'OTRO_SISTEMA', 'PROBLEMA_TECNICO', 'DESPUES', 'OTRO'] as const
export type MotivoDelAlta = (typeof MOTIVOS_DEL_ALTA)[number]
/** What a client leaves Avoqado (C1b): a paid plan, card money processed by Avoqado in 30 days, both or neither. They add up. */
export const INGRESOS = ['MENSUALIDAD', 'TRANSACCIONES', 'AMBOS', 'NINGUNO'] as const
export type Ingreso = (typeof INGRESOS)[number]
/** The seller's opportunity under «Ingreso»: card charged on another terminal, or nothing but cash in 30 days. */
export const PISTAS_DE_INGRESO = ['TARJETA_OTRA_TERMINAL', 'SOLO_EFECTIVO'] as const
export type PistaDeIngreso = (typeof PISTAS_DE_INGRESO)[number]
