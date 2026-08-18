/**
 * `POST /mobile/venues/:venueId/estimates/:estimateId/convert` — la decisión de
 * dónde termina "cotizar".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL SÍNTOMA
 *
 * La auditoría de permisos de piso le dio al HOST (recepción) `estimates:create`:
 * ya CREA el presupuesto, lo LISTA y le cambia el estado (enviar / aceptar /
 * rechazar / cancelar). Pero CONVERTIR pedía `orders:create`, que el HOST no tiene
 * — así que quedaba a media función: el cliente dice "sí, lo quiero" y la
 * recepcionista no puede cerrar. iOS ya pinta el botón (`EstimateDetailView.swift`,
 * "Convertir a venta"), o sea que hoy tronaba con 403 en la cara del cliente.
 *
 * Es EXACTAMENTE el patrón que esta auditoría existe para matar: un rol que puede
 * EMPEZAR un flujo y no TERMINARLO.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA DECISIÓN: convertir pasa a `estimates:create`
 *
 * 1. 🔑 **La autoridad ya se gastó antes.** El HOST ya escribe los renglones y los
 *    PRECIOS del presupuesto (`POST /estimates` pide `estimates:create` y el body
 *    trae `items[].unitPrice`), y ya lo ACEPTA (`PUT /status`, mismo permiso).
 *    `convertToOrder` no deja escribir nada nuevo: COPIA verbatim los renglones ya
 *    aceptados. Poner el candado en la copia, y no en la autoría, es ponerlo en el
 *    paso equivocado — el caballo ya salió del establo.
 *
 * 2. **Square contesta lo mismo, y más fuerte que "mismo permiso".** El permiso de
 *    Square para presupuestos es el de facturas ("view, edit, create, and delete
 *    invoices and estimates"), no uno de "crear una venta". Y con Invoices Plus el
 *    presupuesto se **auto-convierte solo** cuando el cliente lo acepta, sin humano
 *    en medio: _"Automatically convert estimate to invoice when customer accepts"_.
 *    Si convertir fuera una frontera de autoridad, no se podría automatizar.
 *    (Tropicalización: esto es convención de PRODUCTO, no fiscal de EE.UU. — nada
 *    en México hace que "convertir mi cotización aceptada" sea más autoridad que
 *    "escribir la cotización". Portable tal cual.)
 *
 * 3. 🔴 **`orders:create` abre DE MÁS, medido con el resolvedor real.** No es sólo
 *    "crear una orden": es también el gate de `POST /orders/:orderId/items`, o sea
 *    AGREGAR RENGLONES A CUALQUIER CUENTA ABIERTA del local, y arrastra
 *    `inventory:read` por dependencia. Darle `orders:create` al HOST para que
 *    termine SU cotización le entregaría de pasada la edición de líneas de todos
 *    los cheques abiertos. Por eso la respuesta NO es "denle orders:create".
 *    Es el criterio que midió Android: el permiso "más parecido" puede abrir —o
 *    cerrar— de más; se elige por SIGNIFICADO, no por la tabla que produzca.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ES SEGURO
 *
 * - **Nadie pierde nada:** `orders:create` YA implica `estimates:create` (puente que
 *   dejó la auditoría), así que WAITER, CASHIER, MANAGER, ADMIN y OWNER conservan
 *   convertir. El cambio es un ensanchamiento estricto.
 * - **El HOST no gana superficie nueva:** ya podía LEER y ACEPTAR cualquier
 *   presupuesto del venue. Lo único que gana es cerrar el ciclo.
 * - **La orden que nace es inerte:** `status PENDING`, `paymentStatus PENDING`,
 *   `kitchenStatus PENDING`. El HOST NO puede cobrarla (`payments:*`), NO puede
 *   agregarle renglones (`orders:create`), NO puede descontarla, comp-earla ni
 *   anularla. Es el registro de "el cliente aceptó", que es justo lo que es la
 *   factura de Square.
 */

import { StaffRole } from '@prisma/client'
import mobileRouter from '@/routes/mobile.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { hasPermission, resolvePermissions } from '@/lib/permissions'

function permissionOf(router: any, method: string, path: string): string | undefined {
  for (const layer of router.stack ?? []) {
    if (!layer.route || layer.route.path !== path) continue
    const routeLayers: any[] = layer.route.stack ?? []
    if (!routeLayers.some(rl => rl.method === method)) continue
    const permissionLayer = routeLayers.find(rl => typeof (rl.handle as any)?.requiredPermission === 'string')
    return (permissionLayer?.handle as any)?.requiredPermission
  }
  return undefined
}

function hasAuth(router: any, method: string, path: string): boolean {
  for (const layer of router.stack ?? []) {
    if (!layer.route || layer.route.path !== path) continue
    const routeLayers: any[] = layer.route.stack ?? []
    if (!routeLayers.some(rl => rl.method === method)) continue
    return routeLayers.map(rl => rl.handle).includes(authenticateTokenMiddleware)
  }
  return false
}

const CONVERT = '/venues/:venueId/estimates/:estimateId/convert'
const CREATE = '/venues/:venueId/estimates'
const STATUS = '/venues/:venueId/estimates/:estimateId/status'

describe('POST /mobile/.../estimates/:estimateId/convert — cerrar el ciclo de cotizar', () => {
  it('sigue autenticada', () => {
    expect(hasAuth(mobileRouter, 'post', CONVERT)).toBe(true)
  })

  it('🔴 exige estimates:create, no orders:create', () => {
    expect(permissionOf(mobileRouter, 'post', CONVERT)).toBe('estimates:create')
  })

  it('🔑 el HOST por fin TERMINA lo que empezó: crear, aceptar y convertir con el mismo permiso', () => {
    const gates = [
      permissionOf(mobileRouter, 'post', CREATE),
      permissionOf(mobileRouter, 'put', STATUS),
      permissionOf(mobileRouter, 'post', CONVERT),
    ]
    expect(new Set(gates).size).toBe(1)
    for (const gate of gates) {
      expect(hasPermission(StaffRole.HOST, null, gate!)).toBe(true)
    }
  })
})

describe('Nadie pierde convertir (el cambio es un ensanchamiento estricto)', () => {
  it('orders:create implica estimates:create — el puente que ya existía', () => {
    expect(Array.from(resolvePermissions(['orders:create']))).toContain('estimates:create')
  })

  it.each([StaffRole.WAITER, StaffRole.CASHIER, StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER])('%s conserva convertir', role => {
    expect(hasPermission(role, null, permissionOf(mobileRouter, 'post', CONVERT)!)).toBe(true)
  })
})

describe('🔴 Convertir NO regala el resto del POS — la contención de la decisión', () => {
  it('el HOST sigue SIN poder crear órdenes ni agregar renglones a una cuenta abierta', () => {
    // `orders:create` es el gate de POST /orders Y de POST /orders/:orderId/items.
    // Es justo lo que NO se le entrega al HOST por dejarlo cerrar su cotización.
    expect(hasPermission(StaffRole.HOST, null, 'orders:create')).toBe(false)
  })

  it('el HOST sigue SIN poder cobrar, descontar, comp-ear ni anular la orden que nació', () => {
    for (const perm of ['payments:create', 'discounts:apply', 'orders:comp', 'orders:void', 'orders:update']) {
      expect(hasPermission(StaffRole.HOST, null, perm)).toBe(false)
    }
  })

  it('🔴 convertir NO va al revés: cotizar no expande a crear órdenes', () => {
    const desdeCotizar = Array.from(resolvePermissions(['estimates:create']))
    expect(desdeCotizar).not.toContain('orders:create')
    expect(desdeCotizar).not.toContain('orders:update')
    expect(desdeCotizar).not.toContain('payments:create')
  })

  it('KITCHEN y VIEWER siguen fuera de cotizaciones por completo', () => {
    for (const role of [StaffRole.KITCHEN, StaffRole.VIEWER]) {
      expect(hasPermission(role, null, 'estimates:create')).toBe(false)
    }
  })
})
