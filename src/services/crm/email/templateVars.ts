/**
 * Variables de las plantillas de correo del CRM: `{{nombre}}`, `{{negocio}}` y `{{vendedor}}`, lista CERRADA.
 *
 * 🔴 Aquí se pone TEXTO en los bloques; el escape lo hace después `renderizarBloques`. Por eso un nombre como
 * `<b>Ana</b>` sale como `&lt;b&gt;Ana&lt;/b&gt;`. Y la `url` de un bloque no se toca NUNCA: sustituir ahí dejaría que un
 * dato de la base arme el destino de un enlace.
 */
import type { BloqueCampana } from '../../marketing/campaignBlocks'

export const VARIABLES = ['nombre', 'negocio', 'vendedor'] as const
export type Variable = (typeof VARIABLES)[number]
export type Vars = Partial<Record<Variable, string | null>>

/** `{{ nombre }}`: el nombre va sin llaves y sin espacios alrededor. Un `{{` sin su `}}` es texto, no variable. */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g

/** Igual que `PLACEHOLDER`, pero captura los espacios/tabuladores de justo antes. */
const CON_ESPACIO_PREVIO = /([ \t]*)\{\{([^{}]*)\}\}/g

/** Las que no están en la lista cerrada, en orden y sin repetir (para decir «Variable desconocida: {{x}}» al guardar). */
export function variablesDesconocidas(texto: string): string[] {
  const conocidas: readonly string[] = VARIABLES
  const desconocidas = new Set<string>()
  for (const [, nombre] of texto.matchAll(PLACEHOLDER)) {
    const limpio = nombre.trim()
    if (!conocidas.includes(limpio)) desconocidas.add(limpio)
  }
  return [...desconocidas]
}

/** Un valor de la base, en una sola línea: un salto de línea no debe partir el asunto ni abrir otra cabecera. */
const limpio = (valor: string | null | undefined) => (valor ?? '').replace(/\s+/g, ' ').trim()

/** Los valores con sus respaldos: `nombre` cae en `negocio` (y en vacío), `negocio` en «tu negocio», `vendedor` en «el equipo de Avoqado». */
function valores(vars: Vars): Record<Variable, string> {
  const negocio = limpio(vars.negocio)
  return {
    nombre: limpio(vars.nombre) || negocio,
    negocio: negocio || 'tu negocio',
    vendedor: limpio(vars.vendedor) || 'el equipo de Avoqado',
  }
}

export function aplicarVariables(bloques: BloqueCampana[], asunto: string, vars: Vars): { bloques: BloqueCampana[]; asunto: string } {
  const dato = valores(vars)
  // Una sola pasada: lo que se pone no se vuelve a revisar, así que un valor con `{{vendedor}}` adentro queda como texto.
  const sustituir = (texto: string) =>
    texto.replace(CON_ESPACIO_PREVIO, (completo, espacio: string, nombre: string) => {
      const llave = nombre.trim()
      if (!(VARIABLES as readonly string[]).includes(llave)) return completo
      const valor = dato[llave as Variable]
      // una variable vacía se lleva su espacio para que no quede "Hola ,"
      return valor ? espacio + valor : ''
    })

  return {
    asunto: sustituir(asunto),
    bloques: bloques.map((b): BloqueCampana => {
      switch (b.type) {
        case 'heading':
        case 'paragraph':
          return { ...b, text: sustituir(b.text) }
        case 'image':
          return { ...b, alt: sustituir(b.alt) }
        case 'button':
          return { ...b, label: sustituir(b.label) }
        case 'divider':
          return b
      }
    }),
  }
}

/** Las variables que no existen en el asunto y en lo que se sustituye de los bloques (text, label y alt; la url no). */
export function variablesDesconocidasEn(asunto: string, bloques: BloqueCampana[]): string[] {
  const textos = [asunto]
  for (const b of bloques) {
    if (b.type === 'heading' || b.type === 'paragraph') textos.push(b.text)
    else if (b.type === 'image') textos.push(b.alt)
    else if (b.type === 'button') textos.push(b.label)
  }
  return [...new Set(textos.flatMap(variablesDesconocidas))]
}
