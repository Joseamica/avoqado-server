/** Rappi sólo confirma la cancelación fuera del POS; el texto también sirve al cancelar por las rutas genéricas. */
export const CANCELAR_ACEPTADO_RAPPI = {
  soporte:
    'Rappi no deja cancelar por sistema un pedido ya aceptado. Pídele la cancelación al soporte de Rappi; aquí se cancela solo cuando Rappi la confirme.',
  appDeAliados: 'Cancélalo en la app de Rappi para aliados; aquí se cancela solo cuando Rappi lo confirme.',
} as const

export function instruccionesParaCancelarRappi(raw: unknown): string {
  const metodo = String((raw as { order_detail?: { delivery_method?: unknown } } | null)?.order_detail?.delivery_method ?? '')
    .trim()
    .toLowerCase()
  return metodo === 'marketplace' || metodo === 'pickup' ? CANCELAR_ACEPTADO_RAPPI.appDeAliados : CANCELAR_ACEPTADO_RAPPI.soporte
}
