// src/services/dashboard/staffPay/textos.ts — Pago al personal (fase 3, Bloque C): las frases que comparten las rutas, el MCP y
// los servicios. Archivo aparte y sin dependencias a propósito: muchas pruebas simulan `acceso.ts` entero, y una frase que
// viviera ahí les llegaría `undefined`.

/**
 * Cómo se consigue el plan (spec fase 3 §10, decisión D3), en UN solo lugar. El precio suelto es dato de superadmin: ningún
 * texto lo escribe fijo (global-constraints, resolución 11).
 */
export const COMO_SE_CONSIGUE_EL_PLAN = 'viene en el plan Pro o se contrata suelto por sucursal'
