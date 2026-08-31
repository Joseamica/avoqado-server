import express from 'express'

import { getConfigCheck } from '../../controllers/superadmin/systemConfig.superadmin.controller'

const router = express.Router({ mergeParams: true })

/**
 * @openapi
 * /api/v1/superadmin/system/config-check:
 *   get:
 *     tags: [Superadmin]
 *     summary: Estado de la configuración crítica de ESTE servidor
 *     description: |
 *       Contesta lo mismo que el guardia de arranque, pero a demanda. Sirve para saber si una
 *       variable que se guardó en el panel de Render de verdad está en vigor — guardarla no
 *       basta: sólo entra cuando el proceso reinicia.
 *
 *       NUNCA devuelve el valor de una variable, sólo si está en el estado esperado.
 *     responses:
 *       200:
 *         description: La revisión, con `todoBien` y el detalle por variable
 *       401: { description: Sin token }
 *       403: { description: No es SUPERADMIN }
 */
router.get('/config-check', getConfigCheck)

export default router
