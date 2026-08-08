# PITS · H0 — Registro histórico de pendientes

> ✅ **Los nueve puntos de H0 están implementados.** Este archivo conserva el diagnóstico que
> guio la ejecución, pero ya no es una lista vigente de trabajo.
>
> **Actualización H0.6 — 2026-08-08:** la captura ciega, el opt-in PRO, el contrato aditivo, el
> cierre atómico y la prueba HTTP/PostgreSQL ya están hechos. Falta rollout y piloto físico, no la
> funcionalidad. Ver `docs/PITS-HANDOFF-SESION-2026-08-07.md` §0.

> Continuación de `docs/PITS-HANDOFF.md`. Cada punto trae: dónde está el código, qué hace
> hoy, qué debe hacer, **la trampa** (esto es lo que un implementador nuevo hace mal), y
> cómo se verifica. Investigado en código el **2026-08-07**.
>
> H0.3 (exportaciones) tiene su propio plan en `docs/PITS-H0.3-EXPORTACIONES-PLAN.md`.

---

## H0.7 — Candado de ajuste de inventario · el más barato, hazlo primero

**Dónde:** `src/routes/dashboard/inventory.routes.ts:256` (insumos) y `:1269` (productos).

**Hoy:** las dos rutas de `adjust-stock` se gatean con `checkPermission('inventory:update')`.
Es decir: **quien puede editar la ficha de un insumo también puede mover su existencia.**
Son dos cosas distintas — una es catálogo, la otra es dinero en el almacén.

**Debe:** gatearse con `inventory:adjust`, que **ya existe** en `src/lib/permissions.ts`
(está en `INDIVIDUAL_PERMISSIONS_BY_RESOURCE`, y MANAGER lo tiene explícito; ADMIN y OWNER
por el comodín `inventory:*`; SUPERADMIN por `*:*`). Verificado: no es un permiso fantasma.

**La trampa — el grandfathering.** El riesgo NO está en los roles por default (nadie por
debajo de MANAGER tiene `inventory:update` hoy, así que nadie pierde acceso). Está en las
**filas de `VenueRolePermission`**: un venue pudo haberle dado `inventory:update` a un rol
bajo con el editor de roles personalizados, y ese usuario perdería el ajuste sin aviso.
Antes de cambiar, consulta producción en **sólo lectura**:

```sql
SELECT "venueId", role, permissions
FROM "VenueRolePermission"
WHERE 'inventory:update' = ANY(permissions) AND NOT ('inventory:adjust' = ANY(permissions));
```

Si devuelve filas, agrega `inventory:adjust` a esas filas en la misma migración de datos.
Si devuelve vacío, el cambio es limpio.

**Verificación:** `npm run audit:permissions` debe salir en 0. Y espejar el nombre exacto en
`avoqado-web-dashboard` (`<PermissionGate permission="inventory:adjust">`) — el dashboard ya
usa ese nombre en el menú de la lista de insumos, así que probablemente ya está alineado;
confírmalo. Un nombre desalineado falla **en silencio**.

---

## H0.4 — Pólizas XML y exportación de estados financieros

**Dónde:** `src/routes/dashboard/accounting.routes.ts`. El servicio de contabilidad
electrónica ya genera catálogo, balanza **y pólizas** en XML del Anexo 24.

**Hoy:** el endpoint de pólizas existe y **no tiene botón** en el dashboard. Y el estado de
resultados y el balance general se calculan y cuadran, pero no se pueden exportar a XLS ni
a PDF.

**Debe:** botón de descarga de pólizas en la pantalla de contabilidad electrónica, y
exportación de los dos estados financieros.

**La trampa — los centavos.** El libro mayor guarda **enteros en centavos**
(`JournalEntry.totalDebitCents`, `JournalLine.debitCents`). Toda salida hacia el usuario
—pantalla, XLS, PDF, MCP— **debe dividir entre 100**. Un archivo con los montos 100× lo va
a cargar un contador a su sistema y el error se descubre semanas después. Usa el helper
`pesosFromCents` que propone el plan de exportaciones.

**Segunda trampa:** el resto de la plataforma trabaja en **pesos 1:1** como `Decimal`. El
ledger es la excepción, no la regla. No "uniformices" a centavos.

---

## H0.6 — Diferencia de caja al cerrar turno

**Estado actual:** cerrado en implementación y prueba local.

- Fórmula Decimal: `contado − (fondo inicial + pagos COMPLETED en efectivo)`.
- `0.00` se conserva como balance real; ausencia de conteo conserva `null`.
- Capacidad PRO + opt-in por venue, default `false`; el flujo antiguo no cambia.
- `avoqado-tpv` captura efectivo físico total con conteo ciego, ofrece skip confirmado y mantiene
  el resultado hasta acuse.
- Desktop top-level `cashDeclared`, APKs antiguos y kiosk conservan sus contratos legacy.
- CAS `OPEN -> CLOSING -> CLOSED`, auditoría transaccional y recovery acotado evitan doble cierre.
- Customer MCP, socket y dashboard serializan `cashDeclared`/`cashDifference` sin perder cero.

La verificación real contra un clon PostgreSQL cubrió un turno balanceado con resultado `0.00`,
cero físico, skip, inválido, overflow, gate FREE/PRO, downgrade, concurrencia, `CLOSING` obsoleto y
aislamiento por tenant. El detalle y los comandos están en
`docs/PITS-HANDOFF-SESION-2026-08-07.md` §0.

**Límites honestos:** entradas/retiros de caja todavía no están ligados a Shift, y un pago en vuelo
puede quedar fuera de la foto `COMPLETED` que lee el cierre ganador. Resolver cualquiera de los dos
implica cambiar el ledger/flujo de cobro existente y quedó fuera de H0.6. También falta el piloto
físico porque no hubo dispositivo ADB.

---

## H0.9 — "Recibir ninguno" debe devolver la mercancía al almacén

> 🔴 **El único punto de H0 con riesgo a producción.** Toca la deducción de inventario de
> ~70 puntos de venta que están cobrando hoy. Va **al final**, con el resto de H0 ya verde.
> Estimado: 4-5 días.

**Dónde:** `src/services/dashboard/purchaseOrder.service.ts:2012` → `receiveNoItems`.

**Hoy:** pone todos los renglones en `NOT_PROCESSED` con `quantityReceived: 0`, cancela la
orden… **y no toca la existencia.** Si ya habías recibido mercancía y le das "recibir
ninguno", el inventario se queda inflado con producto que el sistema declara que nunca
llegó. El almacén y el sistema dejan de coincidir sin que nadie se entere.

**La trampa, y es la que define el diseño:**

**No puedes revertir lo que dice la orden. Tienes que revertir lo que de verdad entró.**
Está documentado en este mismo archivo, líneas ~1455, porque ya causó un doble conteo:
`quantityReceived` es un **metadato mutable** que esta misma función pone en 0. Si el delta
se calcula contra esa columna, la secuencia "recibir 5 → recibir ninguno → recibir todo"
deja **10 de existencia habiendo llegado 5** — un solo usuario, tres clics, sin concurrencia.

El estado real de cada camino:

| Tipo de renglón | De dónde sale lo que entró de verdad |
|---|---|
| **Mercancía de reventa** (`productId`) | Los `InventoryMovement` con ese `purchaseOrderItemId`, sumando **`newStock − previousStock`** (nunca `quantity`: la convención de signo no es uniforme entre servicios). |
| **Insumo** (`rawMaterialId`) | Los `StockBatch` con ese `purchaseOrderItemId`. |

**El problema difícil: qué pasa si ya se consumió.** Si entraron 100 piezas y se vendieron
40, revertir 100 deja la existencia en −40 y rompe la invariante
`currentStock === Σ remainingQuantity de lotes ACTIVE`.

**Cómo lo resuelve la industria (y qué recomiendo):** Odoo **no deja cancelar** una
recepción cuya mercancía ya se movió — te obliga a hacer una **devolución**, que es otro
documento con su propio movimiento. Es lo correcto: cancelar es "esto nunca pasó", devolver
es "pasó y lo regresamos". Confundirlos destruye la trazabilidad.

Propuesta: **`receiveNoItems` se niega** si algo de lo recibido ya se consumió, con un
mensaje que diga cuánto se consumió y que la salida es una devolución. Si está intacto,
revierte y cancela.

**Obligatorio en este punto, por el riesgo:**
- Migración de bajada (`down.sql`). **No existe ni una sola en `prisma/migrations`** — hoy
  `pg_dump` es la única reversa.
- Bandera por venue si cambia comportamiento observable, con el default en el comportamiento
  actual.
- Ensayar un restore ANTES de tocar esto. Nadie sabe hoy cuánto tarda ni si funciona.

**Verificación:** una prueba que reciba parcial, cancele, y verifique que la existencia
vuelve **exactamente** al punto de partida — el mismo patrón de la prueba de simetría de
`fifoBatch.quarantine.test.ts`. Más una que confirme que con consumo de por medio **se
rechaza** en vez de corromper.

---

## Orden histórico usado para ejecutar H0

1. **H0.7** — completado.
2. **H0.4** — completado.
3. **H0.6** — completado en implementación/prueba local; rollout pendiente.
4. **H0.3** — completado según el handoff general.
5. **H0.9** — completado con regresión; la prueba destructiva contra base normal sigue separada.
