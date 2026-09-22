/**
 * El formato del folio de merma (`idempotencyKey`): un UUID de versión 1 a 8 con la variante RFC.
 *
 * Es UNA sola regla para el servicio (`normalizeWasteKey`) y para los esquemas de `/dashboard` y
 * `/mobile`: el `.uuid()` de Zod acepta el UUID nulo y la versión 0, que el servicio rechaza, y así
 * el mismo folio malo recibía dos respuestas distintas según dónde lo atajaran. Vive en su propio
 * módulo, sin dependencias, porque los esquemas no deben arrastrar el servicio (Prisma, permisos).
 */
export const WASTE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
