# Autorización y segregación de funciones en compras

**Fecha:** 2026-08-06 **Motivo:** demo de validación con PITS, 11-14 de agosto de 2026 **Repos:** `avoqado-server`, `avoqado-web-dashboard`

---

## 1. El problema, en una frase

Si un evaluador de ERP pregunta _"¿toda compra pasa por autorización, o alguien puede saltársela?"_, hoy la respuesta honesta es **"puede
saltársela"**.

De las 5 órdenes de compra que hay en la base, **`approvedBy` está vacío en las 5**. El flujo de autorización nunca ha corrido, ni una vez.

## 2. Por qué, exactamente

No es que falte el flujo. **El flujo está escrito y probado, pero desconectado**, y hay tres caminos que lo rodean:

| Hueco                                                       | Dónde                                                                                           | Efecto                                                                       |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| El botón principal se salta la autorización **a propósito** | `PurchaseOrderWizard.tsx:470` — `// This skips APPROVED → SENT steps for quick workflow`        | La orden nace lista para recibir. La autorización nunca ocurre.              |
| El PUT genérico acepta `status` libre                       | `inventory.routes.ts:752` → `inventory.schema.ts:455` → `purchaseOrder.service.ts:696`          | Cualquiera con `inventory:update` salta a APROBADA sin dejar rastro de quién |
| La ruta de aprobar llama al servicio equivocado             | `inventory.routes.ts:711` → el servicio marcado `@deprecated` en `purchaseOrder.service.ts:847` | El workflow real (`purchaseOrderWorkflow.service.ts`) no tiene llamadores    |
| El botón "Rechazar" en realidad **cancela**                 | `POActions.tsx:166-169`                                                                         | `rejectedBy` / `rejectedAt` / `rejectionReason` nunca se llenan              |
| Aprobar y recibir son **el mismo permiso**                  | ambas rutas usan `inventory:update` (`:711` y `:721`)                                           | Imposible separar quién autoriza de quién recibe                             |

Y una puerta más, ésta diseñada a propósito pero cableada a fuego: `VALID_TRANSITIONS` permite **DRAFT → APPROVED** con el comentario
`// Direct approval (for small orders)`. La intuición era correcta —una compra de $200 no debe frenar a nadie— pero no es configurable.

## 3. Cómo lo resuelve la industria

Investigado y verificado, no de memoria:

- **Odoo** — ajuste _Purchase Order Approval_ + campo _Minimum Amount_. Debajo del monto se confirma directo; encima pasa a estado _To
  Approve_. **Es exactamente el "para órdenes pequeñas" que ya está en nuestro código, pero configurable.**
- **Dynamics 365** — la orden autorizada queda bloqueada; para editarla hay que _Request change_, que la regresa a borrador y la obliga a
  repasar la autorización.
- **SAP** — re-dispara la autorización sólo si el nuevo total **sube**.
- **NetSuite** — bloquea la edición, y su respuesta a la segregación de funciones es **detectiva**: una búsqueda guardada de transacciones
  donde creador == aprobador.
- **Square** — **no es el modelo a copiar aquí.** Sus órdenes de compra se gobiernan sólo con permisos; no existe paso de aprobar/rechazar.

**El hallazgo que nos diferencia:** Odoo compara **roles, no identidades**. Un gerente que captura su propia orden se la aprueba a sí mismo
y nadie se entera. NetSuite lo admite igual. SAP es el único que bloquea, y su motor de segregación vive en un producto aparte (SAP GRC).

## 4. Qué se construye

### 4.1 Interruptor con umbral, por sucursal (forma de Odoo)

Dos columnas en `VenueSettings`, junto a `enforceTableOwnership` que ya vive ahí con el mismo patrón de política por sucursal:

```prisma
requirePurchaseApproval   Boolean  @default(false)
purchaseApprovalThreshold Decimal? @db.Decimal(12, 2)  // PESOS, 1:1
```

**Nace apagado.** Los ~70 locales vivos se comportan exactamente como hoy.

Comportamiento del botón de crear orden — no cambia de nombre ni de lugar:

| Situación                           | Resultado                                           |
| ----------------------------------- | --------------------------------------------------- |
| Interruptor apagado                 | Idéntico a hoy                                      |
| Prendido, monto **bajo** el umbral  | Se confirma directo, y se marca **auto-autorizada** |
| Prendido, monto **sobre** el umbral | Nace `PENDING_APPROVAL`                             |

La puerta `DRAFT → APPROVED` deja de ser fija y pasa a depender de esta política.

**Reglas que no pueden quedar a interpretación:**

- **Umbral sin configurar (`null`) con el interruptor prendido = TODA orden requiere autorización.** Es el default seguro: prender el
  control y que no controle nada sería la peor de las dos lecturas posibles.
- **La comparación es `total > umbral`**, estrictamente mayor. Una orden exactamente igual al umbral se confirma directo. (Odoo usa _Minimum
  Amount_ con la misma semántica: el umbral es el último monto que **no** requiere autorización.)
- **El monto que se compara es el `total` de la orden**, con impuestos, que es lo que el negocio realmente desembolsa.
- **Una orden auto-autorizada estampa `approvedBy = createdBy`** y su `approvedAt`. No se deja en `null`. Esto tiene un propósito concreto:
  hace que el reporte de §4.5 atrape con **una sola consulta** los dos casos que le importan a un auditor —quien se aprobó a sí mismo y
  quien pasó sin que nadie la viera— en vez de necesitar dos reglas distintas.
- **Las órdenes que crea la recompra automática con `autoApprove`** (`autoReorder.service.ts:408`) estampan `approvedBy = null` y se listan
  aparte como _generadas por el sistema_. No son auto-autorizaciones de una persona y mezclarlas ensuciaría el reporte.

### 4.2 Las rutas que faltan, conectadas

- `POST …/submit-for-approval` → `purchaseOrderWorkflow.submitForApproval`
- `POST …/approve` → **re-apuntar** al workflow real, no al servicio deprecado
- `POST …/reject` → `purchaseOrderWorkflow.rejectPurchaseOrder`, **motivo obligatorio**

El botón "Rechazar" del dashboard deja de cancelar y rechaza de verdad.

Cada botón aparece **sólo desde los estados donde la transición es válida**, leyendo `getValidNextStatuses()` que ya existe. Nada de botones
que truenan al tocarlos.

### 4.3 Candado por estado + "Solicitar cambio"

Un solo guard en el servicio:

- `PENDING_APPROVAL` → nadie edita. Quien la capturó puede **Retirar** → `DRAFT`.
- `APPROVED` → nadie edita. Para tocarla, **Solicitar cambio** → `DRAFT`, y al reenviarla **se re-evalúa el umbral con el monto nuevo**.
- **Con cualquier recepción registrada → congelada.** ✅ _Ya implementado y probado el 2026-08-05_: `updatePurchaseOrder` rechaza reemplazar
  renglones si algún renglón tiene `quantityReceived > 0`.

> **Por qué esto importa más de lo que parece:** sin el último candado, alguien recibe 45 piezas de 50 y edita la orden a 45 para que
> cuadre. Todo el control sería cosmético. Es la segunda pregunta de un auditor.

Regresar a `DRAFT` en vez de guardar el monto autorizado en una columna nueva nos da **gratis la semántica de SAP**: si el monto baja del
umbral, se auto-autoriza; si sube, vuelve a pedir permiso.

### 4.4 Permisos separados

Dos permisos nuevos, copiando el molde de traslados que ya está en producción (`permissions.ts:164-168`): **`inventory:approve`** e
**`inventory:receive`**.

Quién los recibe — verificado en `DEFAULT_PERMISSIONS`:

| Rol                  | Cómo los obtiene                                   |
| -------------------- | -------------------------------------------------- |
| SUPERADMIN           | `*:*`                                              |
| OWNER, ADMIN         | `inventory:*` — los heredan solos                  |
| MANAGER              | Se agregan **explícitos** a su lista               |
| Roles personalizados | Vía **alias** `inventory:update → approve/receive` |

🔴 **El alias no es opcional.** Ambas rutas usan `inventory:update` HOY. Sin el alias, el día del deploy los ~70 locales pierden el botón de
recibir.

Cada permiso nuevo lleva su entrada en `PERMISSION_DEPENDENCIES` con `inventory:read` y `products:read`. Sin eso el rol no carga ni la lista
de órdenes.

**Tier: CORE / gratis.** Decisión del founder. Cobrar por separar quién autoriza de quién recibe se lee mal en una evaluación de ERP. El
bloqueo duro de cuatro ojos, si se construye, irá en PREMIUM.

### 4.5 Las tres huellas + reporte de auto-autorizadas

**Los siete campos ya existen** en `PurchaseOrder` — `createdBy`, `approvedBy`, `approvedAt`, `rejectedBy`, `rejectedAt`, `rejectionReason`,
`receivedBy`. Esto es pintar y validar, **cero migración**.

- En el detalle de la orden: **quién pidió / quién autorizó / quién recibió**, con fecha.
- Un reporte filtrable de órdenes donde `createdBy == approvedBy`, marcadas como **auto-autorizadas**. Por la regla de §4.1 esa sola
  condición cubre los dos casos que importan: la persona que se aprobó su propia orden, y la que pasó bajo el umbral sin que nadie la
  revisara. Las generadas por la recompra automática (`approvedBy = null`) quedan fuera de ese reporte y se listan por separado.

Eso es el control detectivo que NetSuite entrega como búsqueda mensual, en vivo y en pantalla — y es donde superamos a Odoo, que sólo
compara roles.

> 🔴 **Trampa verificada:** usar **`createdBy`**, NO `createdById`. En producción `createdById` está en **0 de 5** órdenes y `createdBy` en
> 4 de 5. Pintar el campo equivocado muestra "sin autor" en toda la demo.

### 4.6 Rechazada como estado propio

`REJECTED` ya existe en el enum. La orden rechazada **se queda rechazada** —editable sólo por quien la capturó, con botón **Reenviar** que
la manda a `PENDING_APPROVAL`.

Moverla a `DRAFT` la borraría del reporte de rechazos, que es justo lo que un evaluador quiere ver. Es el patrón de NetSuite y D365.

### 4.7 Segregación demostrada con roles personalizados

Sin roles nuevos en el sistema: `VenueRolePermission` ya permite roles a la medida por sucursal. En el venue de demo se crean
**"Comprador"** y **"Almacenista"** desde el editor que ya existe en el dashboard. Cero esquema, y además demuestra que es configurable y no
cableado.

## 5. Qué NO se construye

| Fuera                                     | Por qué                                                                                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Venta con existencia en cero              | El candado que ve el cajero vive en la app Kotlin (`ProductMappers.kt:150`), no en el servidor. Exige compilar e instalar en la PAX, y arrastra iOS y Android por la regla de paridad. |
| MRP / orden de producción                 | Un valor nuevo en `InventoryMethod` entra a un `switch` cuyo `default` **lanza dentro del cobro** y tumba órdenes completadas. Es el mayor riesgo para los ~70 locales.                |
| Motor genérico de autorizaciones          | Semana o más. Lo que se demuestra es su primer caso real: compras.                                                                                                                     |
| Conteo por denominación                   | Obliga a tocar el cálculo de varianza en un camino de dinero vivo. Ninguno de los cuatro pesos de PITS lo pide.                                                                        |
| Bloqueo duro de cuatro ojos               | Decisión del founder: va después, y en PREMIUM.                                                                                                                                        |
| **Conciliación a tres vías**              | Verificado: `Expense` **no tiene** `purchaseOrderId`. Son migración + endpoint + pantalla. Se declara, no se promete.                                                                  |
| Folio de factura del proveedor al recibir | Cortado por tiempo (1 h).                                                                                                                                                              |
| Comparación orden-vs-recibido en pantalla | Cortado por tiempo (1.5 h).                                                                                                                                                            |
| **Cualquier cambio en `/mobile`**         | iOS y Android se tocan en paralelo desde otras sesiones.                                                                                                                               |

## 6. Riesgos y cómo se mitigan

| Riesgo                                               | Mitigación                                                                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| El deploy quita el botón de recibir a los 70 locales | Alias `inventory:update → approve/receive` + `npm run audit:permissions` debe salir 0                                             |
| El guard de estados rompe la recompra automática     | `autoReorder.service.ts:408` crea órdenes en `DRAFT` (o `APPROVED` con `autoApprove`). El guard debe contemplarlo explícitamente. |
| Cambiar el enum de estados                           | **No se toca.** Tiene 10 valores en producción; se mapea a etiquetas en español sólo en la UI.                                    |
| Pintar el campo de autor equivocado                  | Usar `createdBy`. Verificado contra datos reales.                                                                                 |
| Activar el interruptor y romper a alguien            | Nace apagado. Sólo se prende en el venue de demo.                                                                                 |

## 7. Cómo se prueba

1. Unitarias: evaluación del umbral (arriba, abajo, exactamente igual, sin umbral configurado), transiciones válidas e inválidas, y el guard
   por estado.
2. La prueba existente que introspecciona `requiredPermission` de cada ruta.
3. `npm run audit:permissions` — debe salir 0.
4. `npm run pre-deploy`.
5. `/full-testing` con el ciclo completo contra la base real: comprador crea → gerente autoriza → almacenista recibe, verificando que **cada
   uno NO ve el botón del otro**, que las tres huellas quedan estampadas, y que una orden autorizada no se puede editar sin pasar por
   "Solicitar cambio".
6. Regresión: con el interruptor apagado, el flujo de compras debe comportarse **byte-idéntico** a hoy.

## 8. Lo que se declara en la demo

**Tres vías:**

> "Hoy conciliamos a dos vías de forma verificable: la orden contra la recepción, renglón por renglón y con parciales. La tercera vía, el
> CFDI del proveedor, ya la ingerimos en el módulo fiscal. Lo que estamos cerrando es el amarre entre las dos cosas. Ese cruce lo comprometo
> para \_\_\_\_."

> ⚠️ **La fecha la decide el founder en la reunión**, no este documento. Va en blanco a propósito: comprometer un plazo por escrito sin que
> él lo haya dicho es exactamente el tipo de promesa que después se rompe.

**Multinivel:**

> "Hoy es un nivel de autorización más umbral por sucursal, que es lo que trae Odoo de fábrica. Donde vamos más lejos es que nosotros
> comparamos identidades: le mostramos quién pidió, quién autorizó y quién recibió, y le alertamos las que se autorizaron solas."

**Tiendas chicas:**

> "En un parador de tres personas no bloqueamos, y es a propósito. Bloquear donde no hay gente es fingir un control: la operación se sale
> del sistema. Arriba del umbral que usted defina, esa orden no la autoriza la tienda — sube al regional. Abajo del umbral se marca como
> auto-autorizada y cae en un reporte que dirección firma. Donde sí hay gente, ahí sí bloqueamos."

**Hueco conocido a declarar sin que lo pregunten:**

> Desde la app móvil todavía se puede autorizar con otro permiso; la separación aplica hoy en el dashboard. Se cierra en la primera
> iteración post-firma.

## 9. Decisiones cerradas (no re-litigar)

1. Permisos de segregación: **CORE / gratis**.
2. Interruptor **con umbral**, por sucursal, apagado por default.
3. Un solo botón de crear; el sistema decide según la política.
4. Motivo de rechazo **obligatorio**.
5. Rechazada **se queda rechazada**, con reenvío.
6. Nombres `inventory:approve` / `inventory:receive` (no `purchase-orders:*`).
7. El enum de estados **no se toca**.
8. Tres vías: se declara, no se construye.
