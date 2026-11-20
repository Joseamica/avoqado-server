/**
 * Lo que recibió el modelo, como UN objeto. T-F7.3: «entender» manda dos mensajes (lo estable, con su punto de caché, y lo de cada
 * mensaje); redactar y juzgar, una sola cadena. Unir las partes en orden da la entrada de antes, llave por llave. `any`, como JSON.parse.
 */
export function aiInput(input: unknown): any {
  if (typeof input === 'string') return JSON.parse(input)
  return Object.assign({}, ...(input as { content: { text: string }[] }[]).map(m => JSON.parse(m.content[0].text)))
}
