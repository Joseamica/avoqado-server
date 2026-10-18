import { randomInt } from 'node:crypto'

/** Sin O, 0, I, 1, L: el folio se dicta por teléfono y se lee en un ticket chico. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function generateOrderNumber(): string {
  let s = 'W'
  for (let i = 0; i < 4; i++) s += ALPHABET[randomInt(ALPHABET.length)]
  return s
}
