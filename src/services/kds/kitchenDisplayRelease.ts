/**
 * 🔴 PUERTA DE LANZAMIENTO de la pantalla de cocina (spec docs/superpowers/specs/2026-09-27-kds-etapa-3-design.md,
 * fase 3.6).
 *
 * Mientras sea `false`, SÓLO el equipo de Avoqado (SUPERADMIN, verificado en la base) puede PRENDER una pantalla: la
 * etapa 3 se construye por fases y un cliente no puede usar una pantalla a medias (miedo del founder, 24-sep). Se
 * cambia a `true` en la fase 3.6 —QA en aparatos con la red apagada, Codex sin P1 y piloto acompañado— y en ningún
 * otro momento. Apagar siempre se puede.
 * 1-nov-2026: el founder la abrió («sí quiero que el cliente pueda»). Quedaban sin hacer, a sabiendas: la QA en iPad de los
 * arreglos de iOS de la 3.6 y el piloto acompañado.
 */
// Abierta por el founder el 1-nov-2026 («sí quiero que el cliente pueda»): cada estación elige impresora, pantalla o ambas.
export const PANTALLA_ABIERTA_A_CLIENTES = true
