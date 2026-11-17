import type { DescuentoDelPlan } from './descuentoDelPlan'

/** Lo que hace falta de la suscripción: su descuento vigente (`descuentoDelPlan`) y el fin del periodo (= próximo cobro). */
export interface SuscripcionConDescuento {
  descuento: DescuentoDelPlan | null
  currentPeriodEnd: Date | null
}

/**
 * Plan Básico (17-nov): ¿el periodo actual es el ÚLTIMO con descuento? Una sola regla para el aviso «Tu Pro sube» (job de
 * recordatorio) y para `getPlanState.basicOffer.canEndProNow` (DASHBOARD, Task 9): terminar Pro antes de esto haría perder
 * meses baratos ya prometidos (Codex r3 #1).
 *
 * `true` = sin descuento, o un descuento `repeating` que termina EN o ANTES del próximo cobro (ese cobro es el primero sin
 * descuento). `once` todavía sin usar (se aplica al próximo cobro) y `forever` → `false`. Quien avisa «Tu Pro sube» exige
 * además que haya descuento: sin él el precio no sube.
 */
export function isLastDiscountedPeriod(sub: SuscripcionConDescuento, now: Date): boolean {
  const d = sub.descuento
  if (!d) return true
  if (d.duration !== 'repeating' || !d.endsAt || !sub.currentPeriodEnd) return false
  return sub.currentPeriodEnd.getTime() > now.getTime() && d.endsAt.getTime() <= sub.currentPeriodEnd.getTime()
}
