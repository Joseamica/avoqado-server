// src/services/giftCards/giftCardTerms.ts
/**
 * Los términos de la tarjeta y el aviso de privacidad que enseña la página del regalo (1b S6, diseño § 6).
 *  - Términos: el dictamen legal (`docs/investigaciones/reports/Gift cards reglas fiscales y legales.md` § 4), versión de
 *    MOSTRADOR: la cláusula de cancelar una compra en línea entra con la 1c. La versión es la congelada en la tarjeta
 *    (`GiftCard.termsVersion`).
 *  - Aviso de privacidad simplificado (dictamen § 6, LFPDPPP arts. 16 fr. II y 17): el negocio es el responsable y Avoqado el
 *    encargado; los datos sirven sólo para entregar la tarjeta y avisar del saldo.
 * Sin Prisma: sólo arma texto con los datos que recibe.
 */
import { formatInTimeZone } from 'date-fns-tz'
import { es } from 'date-fns/locale'

export interface DatosDelNegocio {
  nombre: string
  direccion: string | null
  telefono: string | null
}

/** Un dato vacío o de puros espacios cuenta como ausente. */
function dato(valor: string | null | undefined): string | null {
  const limpio = valor?.trim()
  return limpio ? limpio : null
}

/** Cierra la frase con punto sin duplicarlo cuando el dato ya trae uno (`Tacos S.A.`, `Col. Centro.`). */
function frase(texto: string): string {
  const limpio = texto.trim()
  return /[.!?]$/.test(limpio) ? limpio : `${limpio}.`
}

export function terminosDeLaTarjeta(
  n: DatosDelNegocio,
  t: { termsVersion: string; venceEl: Date | null; timezone: string; url: string },
): { version: string; texto: string } {
  const nombre = n.nombre.trim()
  const vigencia = t.venceEl
    ? `Vence el ${formatInTimeZone(t.venceEl, t.timezone, "d 'de' MMMM 'de' yyyy", { locale: es })}.`
    : 'Sin fecha de vencimiento.'
  // La última frase lleva sólo los datos que existan: sin domicilio ni teléfono, el texto termina en la liga.
  const contacto = [dato(n.direccion), dato(n.telefono)].filter((d): d is string => d !== null).map(frase)
  const texto = [
    frase(`Tarjeta de regalo de ${nombre}`),
    frase(`Válida en ${nombre}`),
    vigencia,
    'No se cambia por efectivo ni se reembolsa, salvo lo que marca la ley.',
    'El saldo que no uses se queda en la tarjeta para otra compra.',
    'Quien tenga el código puede usarla: cuídalo como efectivo.',
    'Si la pierdes y no se ha usado, la bloqueamos y te damos una nueva con tu folio de compra.',
    `Consulta tu saldo en ${t.url}.`,
    ...contacto,
  ].join(' ')
  return { version: t.termsVersion, texto }
}

export function avisoDePrivacidad(n: DatosDelNegocio): string {
  const nombre = n.nombre.trim()
  const telefono = dato(n.telefono)
  return [
    `${nombre} es responsable de tus datos y Avoqado los trata por su encargo.`,
    'Usamos tu nombre y tu teléfono o correo sólo para entregarte esta tarjeta y avisarte de su saldo.',
    'Para mandarte promociones te pediríamos tu permiso aparte.',
    frase(`Si tienes dudas sobre tus datos, comunícate con ${nombre}${telefono ? ` al ${telefono}` : ''}`),
  ].join(' ')
}
