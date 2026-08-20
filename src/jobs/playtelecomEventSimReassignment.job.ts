/**
 * Job de reasignación automática — Asana 1217556190300772 ("Bait <> Play Telecom").
 *
 * Cuando un promotor de PlayTelecom sale de su tienda a hacer una activación, marca el
 * SIM vendido con la categoría "SIM de Evento". Esa venta se queda hoy atribuida a la
 * tienda del promotor, cuando debería restarse de ahí y contar para un venue separado
 * ("ACTIVACIÓN SLP"). Este job la mueve sola, cada 15 minutos.
 *
 * Misma receta de 4 tablas ya usada a mano en "Cubre Descanso" (73 ventas, 2026-07-07):
 * mover Order.venueId + Payment.venueId + SaleVerification.venueId + SerializedItem.sellingVenueId
 * juntos, transaccional. Payment.shiftId NUNCA se toca — el turno/caja del promotor sigue
 * cerrando en la tienda real; sólo cambia a quién le cuenta la venta para reportes.
 *
 * Spec completa: docs/superpowers/specs/2026-08-20-activacion-slp-sim-evento-design.md
 */

/**
 * Regla de reasignación: qué categoría, en qué estado de origen, se mueve a qué venue
 * destino (dentro de qué organización, resuelta por NOMBRE — nunca un id fijo, para que
 * el job no truene en un ambiente sin datos de PlayTelecom).
 */
export interface EventVenueReassignmentRule {
  orgName: string
  categoryName: string
  originState: string
  targetVenueSlug: string
}

export const PLAYTELECOM_EVENT_VENUE_REASSIGNMENT_RULES: EventVenueReassignmentRule[] = [
  { orgName: 'PlayTelecom', categoryName: 'SIM de Evento', originState: 'San Luis Potosí', targetVenueSlug: 'activacion-slp' },
  // Agregar aquí la regla de Querétaro cuando exista el venue 'activacion-qro' — una línea, sin tocar el resto del archivo.
]

/**
 * ¿Todos los items de una orden son de la MISMA categoría pedida? Si hay uno solo que no
 * lo sea (otra categoría, o sin categoría — producto no serializado), la orden es "mixta"
 * y NUNCA se reasigna automáticamente (confirmado con Isaac Mayoral, comentario Asana
 * 1217686256927402: se deja para revisión manual).
 */
export function isOrderPureCategoryMatch(categoryNames: Array<string | null>, categoryName: string): boolean {
  if (categoryNames.length === 0) return false
  const target = categoryName.trim().toLowerCase()
  return categoryNames.every(name => name != null && name.trim().toLowerCase() === target)
}
