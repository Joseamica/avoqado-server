/**
 * 🔴 PUERTA DE LANZAMIENTO de la pantalla de cocina (spec docs/superpowers/specs/2026-09-27-kds-etapa-3-design.md,
 * fase 3.6).
 *
 * Mientras sea `false`, SÓLO el equipo de Avoqado (SUPERADMIN, verificado en la base) puede PRENDER una pantalla: la
 * etapa 3 se construye por fases y un cliente no puede usar una pantalla a medias (miedo del founder, 24-sep). Se
 * cambia a `true` en la fase 3.6 —QA en aparatos con la red apagada, Codex sin P1 y piloto acompañado— y en ningún
 * otro momento. Apagar siempre se puede.
 */
export const PANTALLA_ABIERTA_A_CLIENTES = false
