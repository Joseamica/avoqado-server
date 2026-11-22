/**
 * El lector del cuerpo JSON de toda la API (`middleware.ts`), con el límite general (`BODY_JSON_LIMIT`, 1 MiB por omisión).
 *
 * 🔴 Máquina de efectivo (Codex servidor r7 #2): el cierre y la duda de la QuickPay llevan el carrito que la máquina YA cobró. Con el
 * límite general, un carrito que sí se cotizó rebotaba con 413 ANTES de guardar nada y el efectivo quedaba sólo en la PC. Esas dos rutas
 * leen hasta 4 MiB, y la cotización no cotiza un carrito de más de 512 KiB (`TOPE_DEL_CARRITO_DE_LA_MAQUINA`): lo cotizable cabe en su
 * cierre aun si la PC lo reescribiera con cada carácter escapado (×6) más el sobre. Las demás rutas siguen igual.
 */
import express, { type Express } from 'express'

import { guardarCuerpoDelCelular } from '../middlewares/autenticarSesionDeCampo.middleware'
import { BODY_JSON_LIMIT } from './env'

/** `POST …/cash-machine/sales` y `POST …/cash-machine/doubts` del POS (sin distinguir mayúsculas ni la diagonal final, como el router). */
const RUTAS_DE_LA_MAQUINA_CON_CARRITO = /^\/api\/v1\/mobile\/venues\/[^/]+\/cash-machine\/(?:sales|doubts)\/?$/i
export const LIMITE_JSON_DE_LA_MAQUINA = 4 * 1024 * 1024

export function usarCuerposJson(app: Express) {
  // El primero que lee el cuerpo lo marca y el segundo ya no lo vuelve a leer (body-parser).
  app.use(RUTAS_DE_LA_MAQUINA_CON_CARRITO, express.json({ limit: LIMITE_JSON_DE_LA_MAQUINA, verify: guardarCuerpoDelCelular }))
  // `verify`: una referencia al cuerpo crudo (sin copiarlo); sólo la lee el gancho del celular de campo para su huella.
  app.use(express.json({ limit: BODY_JSON_LIMIT, verify: guardarCuerpoDelCelular }))
}
