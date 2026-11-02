// src/services/storeCredit/soloSaldoEfectivo.ts
/**
 * «Sólo saldo a favor» EFECTIVO (D-1 del full-testing del DASHBOARD, ruling del controlador): el interruptor guardado Y que el SERVIDOR
 * sepa dar saldo a favor (las dos llaves de tarjetas). Sin llaves no hay saldo que dar, así que el interruptor no restringe nada y la
 * cajera puede devolver como siempre; con llaves, igual que antes. UNA regla para el Reembolso del POS, el Cambio, la terminal y lo que
 * la app recibe en sus ajustes. Lo que se GUARDA y lo que el panel enseña sigue siendo el valor guardado.
 */
import { storeCreditAvailable } from './storeCreditTender'

export function soloSaldoEfectivo(guardado: boolean | null | undefined): boolean {
  return guardado === true && storeCreditAvailable()
}
