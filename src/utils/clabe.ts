/**
 * Validación de CLABE interbancaria mexicana (Banxico): 18 dígitos, el último es
 * dígito verificador con pesos cíclicos [3,7,1] sobre los primeros 17, mod 10 por
 * producto, checksum = (10 - suma%10) % 10. Sin esto, un patrón de solo-18-dígitos
 * deja pasar CLABEs con un dígito trocado — el error típico al capturar a mano, y
 * en dinero saliente eso es un depósito al destinatario equivocado.
 * (Espejo del util homónimo del dashboard — mantener ambos en sincronía.)
 */
const CLABE_PATTERN = /^\d{18}$/

export function clabeCheckDigit(first17: string): number {
  const weights = [3, 7, 1]
  let sum = 0
  for (let i = 0; i < 17; i++) sum += (Number(first17[i]) * weights[i % 3]) % 10
  return (10 - (sum % 10)) % 10
}

export function isValidClabe(clabe: string): boolean {
  return CLABE_PATTERN.test(clabe) && clabeCheckDigit(clabe.slice(0, 17)) === Number(clabe[17])
}
