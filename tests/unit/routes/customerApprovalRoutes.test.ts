import fs from 'fs'
import path from 'path'

/**
 * Fase 1 — guardia a nivel de FUENTE sobre las dos rutas de aprobación.
 *
 * Dos cosas que no fallan en ningún test de unidad y sí en producción:
 *
 * 1. **El orden.** `/customers/awaiting-approval` tiene que registrarse ANTES de
 *    `/customers/:customerId`. Si no, Express casa "awaiting-approval" como un id de
 *    cliente y el schema lo rechaza con un 400 que no explica nada. Es exactamente por eso
 *    que `/customers/stats` ya estaba antes.
 * 2. **El permiso.** Ambas rutas exigen `customers:approve`. Si alguien lo cambia a
 *    `customers:read` "para que la gerente vea la bandeja", le está regalando también el
 *    botón de aprobar — que el founder decidió que es de dueño.
 */
const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../../src/routes/dashboard.routes.ts'), 'utf8')

describe('rutas de aprobación de clientes', () => {
  it('🔴 `awaiting-approval` se registra ANTES de `/customers/:customerId`', () => {
    const awaiting = SOURCE.indexOf("'/venues/:venueId/customers/awaiting-approval'")
    const byId = SOURCE.indexOf("'/venues/:venueId/customers/:customerId'")

    expect(awaiting).toBeGreaterThan(-1)
    expect(byId).toBeGreaterThan(-1)
    expect(awaiting).toBeLessThan(byId)
  })

  it('🔴 la bandeja exige el plan de reservaciones Y `customers:approve`, no `customers:read`', () => {
    expect(SOURCE).toMatch(
      /'\/venues\/:venueId\/customers\/awaiting-approval',\s*authenticateTokenMiddleware,(\s|\/\/.*|\n)*checkFeatureAccess\('RESERVATIONS'\),\s*checkPermission\('customers:approve'\),/,
    )
  })

  it('🔴 la decisión es PATCH, exige plan + `customers:approve` y valida el cuerpo', () => {
    expect(SOURCE).toMatch(
      /router\.patch\(\s*'\/venues\/:venueId\/customers\/:customerId\/approval',\s*authenticateTokenMiddleware,(\s|\/\/.*|\n)*checkFeatureAccess\('RESERVATIONS'\),\s*checkPermission\('customers:approve'\),\s*validateRequest\(CustomerApprovalDecisionSchema\),/,
    )
  })
})
