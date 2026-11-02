// src/services/giftCards/giftCardFallosTempranos.ts
/**
 * Q103 / Q105: el aviso de fallo de un mensaje que llega ANTES de que la entrega guarde su `deliveryMessageId`. El envío
 * espera la respuesta HTTP del proveedor y el webhook corre aparte, así que el `failed` de Meta (o el rebote de Resend) puede
 * ganarle a la escritura de `SENT`. El webhook ANOTA aquí cada aviso antes de su CAS, y la entrega, después de escribir
 * `SENT`, lo consulta: o el resultado ve el aviso, o el aviso ve la fila `SENT`. Se pierde sólo si el proceso se reinicia en
 * esos milisegundos.
 *
 * ponytail: Map en memoria de UNA instancia (sin Redis, `.claude/rules/una-sola-instancia.md`); con varias instancias, una
 * tabla (messageId, codigo, recibidoEn) con la misma caducidad. Sirve para WhatsApp (wamid) y para correo (email_id de Resend).
 */
import type { CodigoDeFalloDeEntrega } from './giftCardEntrega'

export const FALLO_TEMPRANO_VENCE_MS = 10 * 60_000

const avisos = new Map<string, { codigo: CodigoDeFalloDeEntrega; recibidoEnMs: number }>()

const vencido = (recibidoEnMs: number, ahoraMs: number) => ahoraMs - recibidoEnMs > FALLO_TEMPRANO_VENCE_MS

/** Anota el aviso (el último gana) y purga los vencidos: el mapa nunca crece más que lo que llega en 10 minutos. */
export function anotarFalloTemprano(messageId: string, codigo: CodigoDeFalloDeEntrega, ahoraMs: number = Date.now()): void {
  for (const [id, aviso] of avisos) if (vencido(aviso.recibidoEnMs, ahoraMs)) avisos.delete(id)
  avisos.set(messageId, { codigo, recibidoEnMs: ahoraMs })
}

/** El código con que se anotó ese mensaje, o `null` si no hay aviso vigente (el vencido se borra al leerlo). */
export function falloTemprano(messageId: string, ahoraMs: number = Date.now()): CodigoDeFalloDeEntrega | null {
  const aviso = avisos.get(messageId)
  if (!aviso) return null
  if (vencido(aviso.recibidoEnMs, ahoraMs)) {
    avisos.delete(messageId)
    return null
  }
  return aviso.codigo
}

export function reiniciarFallosTempranosParaPruebas(): void {
  avisos.clear()
}
