# PITS — Inventario matriz ↔ código

> Compañero de [`PITS-PROGRAMA-COMPLETO.md`](./PITS-PROGRAMA-COMPLETO.md). **125 de 259 renglones** — los 25 de mayor consecuencia por
> módulo. Cada uno contrasta lo que contestamos en la matriz contra lo que existe hoy, con cita al código.
>
> Ésta es la materia prima del **acta de alcance** (§6.2 del programa): la columna _Brecha_ dice si el renglón se entrega hoy, en un hito, o
> requiere insumo de PITS.

## Módulo: compras

El esqueleto transaccional de compras es real y está probado (OC completa con máquina de estados, autorización/rechazo/reenvío, recepción
parcial con lotes PEPS, presentaciones de compra, PDF y correo al proveedor, cron de reabasto, 11 suites de tests y tools de MCP), pero casi
todo lo que PITS pesa como "compras" de cadena —requisiciones, cotizaciones, expediente y evaluación de proveedores, pronóstico de demanda,
código agrupador, IEPS/región/marca en el catálogo y el sugerido para mercancía de reventa— no existe; además hay tres cosas contestadas
como "cumple de forma natural" que en el código NO están (bloqueo de OC a proveedor inactivo, presentaciones de compra para productos de
tienda, y el usuario que dio de alta el producto).

### Fila 43 — Alta de producto con especificaciones completas: fotografía, nombre, marca, familia, subfamilia, presentación, descripción, costo compra, precio venta, IVA (todas las tasas), IEPS, unidad de medida, código de barras, fabricante, Región, tipo de producto. Política: usuario y fecha de alta; no se da de alta con información incompleta. Reporte: catálogo master descargable.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** Contestado 'Cumplimiento en forma natural'. Comentario: 'El catálogo cubre de forma nativa fotografía, nombre,
  descripción, categoría, costo, precio de venta, IVA, unidad de medida, código de barras, claves SAT y tipo de producto, con usuario y
  fecha de alta. Marca, fabricante, familia y subfamilia de segundo nivel, presentación, IEPS por producto y Región se entregan como campos
  adicionales de catálogo durante la implementación, junto con la validación que impide el alta incompleta. Incluido en la suscripción
  propuesta.' Sin plazo declarado.
- **Qué existe hoy:** prisma/schema.prisma:1449 model Product — SÍ existen: imageUrl, name, description, categoryId (MenuCategory con
  parentId → jerarquía de 2 niveles, schema.prisma:1350), cost, price, taxRate, unit, gtin, sku, satProductKey/satUnitKey, type, prepTime,
  createdAt. NO existen: marca, fabricante, presentación, región, ni IEPS (grep -i ieps sobre todo el schema sólo devuelve
  Expense.iepsCents:13202, o sea IEPS únicamente en CFDI recibido, nada del lado de venta ni de catálogo). Sobre 'usuario que da de alta':
  Product NO tiene createdById y src/services/dashboard/product.dashboard.service.ts:527 createProduct(venueId, productData) no recibe
  staffId — el logAction de la línea 707 escribe PRODUCT_CREATED sin staffId, así que la bitácora queda sin actor. La validación de 'no alta
  incompleta' tampoco existe: el schema Zod sólo exige nombre/sku/precio.
- **Depende de:** Decidir qué es campo de primera clase en Product (marca, fabricante, IEPS, presentación) vs. atributo genérico; Product es
  el modelo más caliente de la plataforma (POS, KDS, CFDI, inventario, MCP) y cada migración toca los ~70 puntos de venta. IEPS además
  obliga a decidir si se emite en el CFDI, lo que lo empalma con el módulo fiscal.

### Fila 44 — Alta de platillo con las mismas especificaciones que producto.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** 'Cumplimiento en forma natural'. 'Mismo alcance que el alta de producto, más los atributos de platillo que ya son
  nativos: receta, porciones, tiempo de preparación y costo por porción.' Sin plazo.
- **Qué existe hoy:** Lo del platillo SÍ está: prisma/schema.prisma:1809 model Recipe (portionYield, totalCost, prepTime, cookTime) y :1833
  model RecipeLine con costPerServing, ingredientes variables ligados a grupos de modificadores, y
  src/services/dashboard/costRecalculationTrigger.service.ts recalculando costo. Product.prepTime existe. Lo que falta es exactamente lo
  mismo que en la fila 43 (marca, fabricante, presentación, IEPS, región, validación de alta completa, actor del alta).
- **Depende de:** Se resuelve solo cuando se cierre la fila 43: es el mismo catálogo. No arrancarlo por separado.

### Fila 45 — Código agrupador al que se asocien distintos códigos de barras (SKU). Política: código de barras único y vigente; alertar duplicados. Reporte: códigos relacionados a un código corto.

- **Brecha:** 🔴 De cero · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** 'Cumplimiento en forma natural'. 'Cada producto tiene SKU y código de barras únicos con validación de duplicados. La
  agrupación de varios códigos de barras bajo un código padre se entrega como extensión del catálogo en la implementación. Incluido en la
  suscripción propuesta.' Sin plazo.
- **Qué existe hoy:** La mitad de duplicados SÍ está y a nivel base de datos: prisma/schema.prisma:1636-1637 @@unique([venueId, sku]) y
  @@unique([venueId, gtin]). La agrupación NO existe: Product.gtin es UN solo string (schema.prisma:1457), no hay modelo
  ProductBarcode/alias ni campo de código padre en ningún lado del schema. Un producto = un código de barras, punto.
- **Depende de:** Definir si el agrupador es un modelo nuevo (ProductBarcode con productId + code + esPrincipal) o un campo padre en
  Product. Toca además la búsqueda por código en el POS (Android/iOS y desktop leen gtin), o el escaneo del alias no encuentra nada.

### Fila 71 — Carga masiva por layout de códigos de barras asociados a un SKU padre.

- **Brecha:** 🔴 De cero · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** Contestado como DESARROLLO. 'Importación masiva por layout de Excel de códigos de barras asociados a un SKU padre, con
  validación previa de duplicados y de formato EAN-13, reporte de errores por renglón antes de aplicar, y confirmación en un solo paso. Se
  entrega junto con la agrupación de códigos bajo código corto. Tiempo de entrega: 1 a 2 días.'
- **Qué existe hoy:** No existe. Lo más cercano es el importador de menú: avoqado-web-dashboard/src/services/menuImport.service.ts (usa Papa
  Parse, modos básico y avanzado) y el endpoint POST /venues/:venueId/menu/import (src/routes/dashboard.routes.ts:6273) con ImportMenuSchema
  (src/schemas/dashboard/menu.schema.ts:650) — ese sí acepta gtin opcional por producto, pero es un import de menú completo (modo
  merge/replace que llega a borrar productos), NO un layout de alias de códigos, y no valida EAN-13 ni reporta errores por renglón antes de
  aplicar.
- **Depende de:** Bloqueado por la fila 45: sin el modelo de código agrupador no hay a dónde cargar los alias. El plazo de '1 a 2 días' sólo
  es realista contando que la agrupación ya esté hecha.

### Fila 46 — Asignar distintos productos de acuerdo con la tienda asignada.

- **Brecha:** 🟢 Ya está · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** 'Cumplimiento en forma natural'. 'Asignación de catálogo por sucursal: cada tienda o formato opera únicamente los
  productos que le corresponden.'
- **Qué existe hoy:** Real y por construcción: Product.venueId (schema.prisma:1451) con cascade al venue; cada sucursal tiene su propio
  catálogo y sus propios menús (model Menu / MenuCategoryAssignment, schema.prisma:1431). Existe además cloneMenu
  (src/services/dashboard/menu.dashboard.service.ts:661) para replicar dentro de un venue. Lo que NO existe es un catálogo maestro
  corporativo del que se derive cada tienda: no hay modelo OrgProduct ni replicación entre sucursales, así que dar de alta un producto en 31
  paradores hoy son 31 altas (o 31 imports).
- **Depende de:** Nada para lo contestado. Pero conviene avisarle a PITS que el 'catálogo master' que piden en el reporte de la fila 43
  implica gobierno corporativo del catálogo, que hoy no existe.

### Fila 47 — Asignar distintos precios de venta de acuerdo con la Región definida. Reporte: costo de producto por región.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** 'Cumplimiento en forma natural'. 'Precios diferenciados por sucursal son nativos. La Región como nivel intermedio (un
  precio que aplica a un conjunto de sucursales) se configura durante la implementación. Incluido en la suscripción propuesta.'
- **Qué existe hoy:** Precio por sucursal: nativo (Product.price por venueId). Región: existe el contenedor pero está muerto —
  prisma/schema.prisma:99 model Zone (organizationId, name, slug, venues[]) y Venue.zoneId:122, pero grep de zoneId en src/ sólo aparece en
  onboarding del superadmin y en organizationDashboard.service.ts (CRUD de zonas). Ningún servicio de precios, menú o producto lee Zone. La
  palabra 'region' no aparece en el schema.
- **Depende de:** Decidir el modelo de precio por región: ¿lista de precios por Zone que sobrescribe el precio del producto, o propagación
  (fijo el precio en la zona y se copia a las 31 tiendas)? La primera es correcta pero toca la lectura de precio en POS/TPV/checkout; la
  segunda es barata pero deja de ser 'un precio por región'.

### Fila 68 — Ajuste de precios a SKU específicos y tienda específica, de forma manual y masiva.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** 'Cumplimiento en forma natural'. 'El ajuste de precio por SKU y por sucursal es nativo. La carga masiva de cambios de
  precio por layout se entrega como herramienta de importación en la implementación. Incluido en la suscripción propuesta.'
- **Qué existe hoy:** Manual: sí (PUT de producto, y el tool MCP set_menu_item_price). Masivo: NO hay endpoint de actualización masiva de
  precios — grep de bulkUpdatePrice/updateManyProducts/priceBulk en src/ no devuelve nada, y en las rutas del dashboard no hay ningún /bulk
  de precio. La única vía masiva hoy es el import de menú completo (modo merge), que no es una herramienta de cambio de precios: no muestra
  previo vs. nuevo, no permite reversa y en modo replace borra el catálogo.
- **Depende de:** Nada técnico, pero es una operación de dinero visible al cliente: exige previsualización (SKU, precio actual → nuevo),
  confirmación en dos pasos y ActivityLog por renglón. Sin eso, un layout mal armado cambia precios en varias tiendas en producción.

### Fila 48 — Registrar el motivo de devolución de un producto.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** 'Cumplimiento en forma natural'. 'Registro del motivo de devolución con catálogo de motivos configurable y
  trazabilidad de quién autorizó.'
- **Qué existe hoy:** Texto libre sí, catálogo y autorizador no. En la recepción: PurchaseOrderItemStatus DAMAGED / NOT_PROCESSED
  (schema.prisma:8384) con notes libre (UpdatePurchaseOrderItemStatusSchema, src/schemas/dashboard/inventory.schema.ts:543) y
  ReceiveNoItemsSchema con un reason opcional de texto libre (:569). Al revertir se escribe un RawMaterialMovement tipo RETURN o SPOILAGE
  con reason fijo en código ('Marcado como dañado en la entrega', src/services/dashboard/purchaseOrder.service.ts:1862-1868). NO hay modelo
  de catálogo de motivos ni campo de quién autorizó la devolución (el único catálogo de motivos del sistema es
  SaleVerificationRejectionReason, schema.prisma:7371, y es de PlayTelecom).
- **Depende de:** Definir si el catálogo de motivos es por organización o por venue, y si la devolución al proveedor necesita su propio
  documento (nota de devolución con folio) o basta con el renglón de OC. PITS pide devoluciones como insumo de la evaluación de proveedores
  (fila 57), así que conviene diseñarlo junto con esa.

### Fila 50 — Flujo de autorización de promociones o descuentos de productos.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Contestado como DESARROLLO. 'Bandeja de autorización de promociones y descuentos. El comprador captura la promoción
  (tipo, vigencia, productos y tiendas donde aplica) y queda en estado pendiente; gerencia de compras autoriza o rechaza con motivo, y sólo
  entonces baja a los puntos de venta. Incluye bitácora de quién autorizó y notificación al solicitante. Se construye sobre el motor de
  descuentos ya existente. Tiempo de entrega: 1 a 2 días.'
- **Qué existe hoy:** El motor de descuentos SÍ es sólido y es base real: prisma/schema.prisma:6177 model Discount (tipo, valor, scope
  ORDER/ITEM/CATEGORY, targetItemIds, vigencia validFrom/validUntil, días y horas, topes de uso, BOGO, stacking, createdById) +
  src/services/dashboard/discountEngine.service.ts (35k) y la UI completa en avoqado-web-dashboard/src/pages/Promotions/. El flujo de
  autorización NO existe: no hay estado PENDIENTE (sólo active boolean, :6242), no hay approvedBy/rejectedBy/rejectionReason, y el campo
  requiresApproval de :6230 es otra cosa — es el flag de que una cortesía necesita gerente en el punto de venta, no una bandeja de
  autorización. Tampoco existe 'tiendas donde aplica': Discount tiene venueId, es de una sola sucursal.
- **Depende de:** El plazo de 1 a 2 días asume que sólo se agrega el estado pendiente. La parte cara es 'las tiendas donde aplica': hoy una
  promoción vive en un venue, así que una promo para 12 paradores son 12 descuentos sin ninguna liga entre ellos. Hay que decidir promoción
  de alcance organizacional antes de escribir la bandeja, o la bandeja autoriza 12 cosas sueltas.

### Fila 51 — Asignar promoción a los SKU que contengan descuentos con base en las tiendas donde aplique. Política: sólo los códigos asignados dentro del módulo llevan descuento.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** 'Cumplimiento en forma natural'. 'Asignación de promoción por SKU y por conjunto de tiendas donde aplica; sólo los
  códigos incluidos reciben el descuento.'
- **Qué existe hoy:** Por SKU: sí, Discount.scope = ITEM con targetItemIds (schema.prisma:6191) — sólo los productos listados reciben el
  descuento, tal como pide la política. Por conjunto de tiendas: NO. Discount.venueId es obligatorio (:6179) y no hay campo venueIds ni
  descuento a nivel organización; grep de venueIds/applyToVenues en discount.dashboard.service.ts no devuelve nada. Hoy 'las tiendas donde
  aplica' se resuelve creando la misma promoción N veces, sin identidad común ni forma de apagarlas todas de un jalón.
- **Depende de:** Es el mismo trabajo que la fila 50: promoción de alcance multi-sucursal. Riesgo medio porque el motor de descuentos corre
  en cada cobro de los ~70 puntos de venta vivos; tocar la resolución de descuentos aplicables es tocar dinero.

### Fila 52 — Flujo de autorización de alta de productos solicitados directo de tienda. Política: las compras derivadas de tienda sólo las autoriza gerencia de compras.

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Contestado como DESARROLLO. 'La sucursal solicita el alta de un producto desde el punto de venta o el dashboard, con
  los atributos obligatorios; la solicitud llega a una bandeja de gerencia de compras, que autoriza o rechaza con motivo. El producto sólo
  existe en catálogo tras la autorización, con lo que se cierra el hueco que PITS describió de compras que salen fuera del área de compras.
  Tiempo de entrega: 1 a 2 días.'
- **Qué existe hoy:** No existe nada. No hay modelo de solicitud de alta de producto en el schema (ningún model *Request/*Solicitud para
  catálogo). El patrón de bandeja de aprobación sí existe y es copiable casi al pie de la letra:
  src/services/dashboard/sale-verification.dashboard.service.ts (aprobación de back-office con motivo de rechazo catalogado y su versión
  org-level) y el propio flujo de OC (submitForApproval / approve / reject con motivo). Hoy cualquiera con permiso menu:create da de alta el
  producto directo, sin paso intermedio.
- **Depende de:** Depende de la fila 43: la bandeja tiene que validar 'atributos obligatorios' y esos atributos todavía no existen en el
  modelo. También hay que decidir si la solicitud se levanta desde el POS (obliga a tocar avoqado-android y avoqado-ios, que van juntos) o
  sólo desde el dashboard — con dashboard solamente el plazo de 1-2 días es defendible; con POS no.

### Fila 53 — Alta de proveedores con categorización (1,2), ID, razón social, RFC, nombre comercial, gestión, gestión matriz, tipo de producto, cambios/devoluciones, días de crédito, envío, sucursal, pago centralizado, contactos (ventas, cuentas por cobrar), observaciones, estatus activo/inactivo, tipo de servicio. Política: a proveedor inactivo no se le puede colocar una OC. Incluye Fila 54 (tipo de servicio: mantenimiento/suministros/producto/insumos/servicio), Fila 178 (términos de pago) y Fila 161 (cuenta bancaria para pagarle).

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Todas contestadas 'Cumplimiento en forma natural'. Fila 53: 'El padrón cubre de forma nativa ID, razón social, RFC,
  nombre comercial, contacto, correo, teléfono, dirección, sucursal, tiempo de entrega, pedido mínimo, calificación y estatus
  activo/inactivo, con bloqueo de OC a proveedor inactivo. Categorización (1,2), días de crédito, pago centralizado, contacto de cuentas por
  cobrar, gestión matriz y tipo de servicio se agregan como campos de catálogo en la implementación.' Filas 54/178/161: campos de catálogo
  'durante la implementación', incluidos en la suscripción.
- **Qué existe hoy:** prisma/schema.prisma:1869 model Supplier — SÍ: name, contactName, email, phone, website,
  address/city/state/country/zipCode, taxId (RFC), rating, reliabilityScore, leadTimeDays, minimumOrder, active, notes, soft delete. NO:
  categorización, razón social separada de nombre comercial, días de crédito, términos de pago, pago centralizado, contacto de cuentas por
  cobrar, gestión matriz, tipo de servicio, cuenta bancaria. 🔴 Y el bloqueo prometido como NATIVO no está:
  src/services/dashboard/purchaseOrder.service.ts:598 createPurchaseOrder busca el proveedor con findFirst({id, venueId}) y sólo valida que
  exista y que se cumpla el pedido mínimo — nunca lee supplier.active ni deletedAt. Hoy sí se le puede colocar una OC a un proveedor
  inactivo o borrado. Además la UI está muy por detrás del backend:
  avoqado-web-dashboard/src/pages/Inventory/Suppliers/components/SupplierDialog.tsx sólo captura nombre, contacto, notas, teléfono, correo y
  código postal — ni siquiera expone el RFC ni el estatus, aunque el Zod del servidor (src/schemas/dashboard/inventory.schema.ts:283) sí los
  acepta.
- **Depende de:** Nada bloquea. El bloqueo de proveedor inactivo son horas y hay que hacerlo ya porque se contestó como cumplido (ojo: al
  activarlo hay que decidir qué pasa con OC abiertas de proveedores que hoy están inactivos en los venues vivos). Los campos nuevos son
  migración + Zod + formulario; el cuello real es la UI de proveedores, que hoy expone seis campos de los veintitantos que PITS pide.

### Fila 55 — Adjuntar checklist de proveedor (lista de documentos requeridos y documentos digitalizados). Política: no se da de alta ningún proveedor sin la entrega y validación de la documentación requerida.

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** Contestado como DESARROLLO. 'Catálogo configurable de documentos requeridos por tipo de proveedor (acta constitutiva,
  RFC, opinión de cumplimiento, comprobante de domicilio, póliza de seguro, etc.), con carga de archivos, control de vigencia por documento,
  alerta de vencimiento y bloqueo del alta hasta que la documentación esté completa y validada. Se construye sobre el almacenamiento en nube
  ya operativo. Tiempo de entrega: 3 a 5 días.'
- **Qué existe hoy:** No existe ningún modelo de documentos de proveedor (grep 'model .\*Document' en el schema no devuelve nada; los únicos
  documentos son los del KYC del venue: Venue.taxDocumentUrl/idDocumentUrl/actaDocumentUrl/rfcDocumentUrl, schema.prisma:223-228, y el paso
  7 del onboarding :1306). El almacenamiento en nube sí es real y es la base que se citó: src/services/storage.service.ts con
  buildStoragePath() y el patrón prod|dev/venues/{slug}/kyc/. Falta todo lo demás: catálogo configurable, vigencias, alertas de vencimiento
  y el bloqueo del alta.
- **Depende de:** Definir el catálogo de documentos por tipo de proveedor con PITS (la lista real que exige su área de compras) y quién
  valida. La alerta de vencimiento necesita un job nuevo — hay que colgarlo del patrón de src/jobs/ respetando la regla de retry por P1001.

### Fila 56 — Expediente digital de proveedor: toda la documentación adjunta, histórico de servicios y evaluaciones.

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** Contestado como DESARROLLO. 'Expediente digital único por proveedor que concentra la documentación cargada, el
  histórico de órdenes de compra, recepciones, faltantes, sobrantes, devoluciones y notas de crédito, y el resultado de cada evaluación
  periódica. Consultable desde la ficha del proveedor y exportable. Tiempo de entrega: 3 a 5 días.'
- **Qué existe hoy:** Parcial y disperso, sin expediente. Lo que ya se puede leer: getSupplier
  (src/services/dashboard/supplier.service.ts:73) trae las últimas 20 OC y su historial de precios; getSuppliers trae las últimas 5. El
  histórico de faltantes/sobrantes/devoluciones es derivable de PurchaseOrderItem (quantityOrdered vs quantityReceived, receiveStatus
  DAMAGED/NOT_PROCESSED) y de RawMaterialMovement tipo RETURN. Lo que NO existe: documentación (fila 55), evaluaciones (fila 57), notas de
  crédito (no hay modelo), y una vista de expediente único exportable.
- **Depende de:** Es el envoltorio de las filas 55 y 57: no puede empezar antes que ellas o queda un expediente vacío. Las notas de crédito
  de proveedor no existen en ningún lado del sistema y hay que decidir si se modelan aquí o del lado fiscal (Expense/CFDI de egreso).

### Fila 57 — Evaluación de proveedores desde el alta y cada determinado tiempo, con devoluciones, incidencias, facturaciones, mermas, penalizaciones, OTIF y fill rate. Reporte de Evaluación de Proveedor.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Contestado como DESARROLLO. 'Modelo de evaluación con los indicadores que PITS solicita — OTIF, fill rate,
  devoluciones, incidencias, facturación, mermas y penalizaciones — calculados automáticamente a partir de datos que la plataforma YA
  captura hoy en cada recepción (cantidad recibida contra la ordenada, fechas comprometida y real, faltantes, sobrantes, rechazos y
  devoluciones). Se agrega la parte cualitativa por captura manual, la periodicidad configurable de la evaluación y el Reporte de Evaluación
  de Proveedor. Tiempo de entrega: 3 a 5 días.'
- **Qué existe hoy:** La afirmación sobre los datos es CIERTA y verificable: PurchaseOrder.expectedDeliveryDate vs receivedDate,
  PurchaseOrderItem.quantityOrdered vs quantityReceived y receiveStatus (RECEIVED/DAMAGED/NOT_PROCESSED) están todos capturados
  (schema.prisma:1956 y :2013). Lo calculado hoy es sólo UN indicador: src/services/dashboard/supplier.service.ts:445 getSupplierPerformance
  devuelve onTimeDeliveryRate (recibida antes de la fecha comprometida), totales gastados, valor promedio y conteos por estatus, más un
  qualityScore que es simplemente reliabilityScore capturado a mano. NO calcula fill rate (aunque quantityReceived/quantityOrdered está
  ahí), ni OTIF combinado, ni devoluciones, incidencias, mermas o penalizaciones. No hay modelo de evaluación, ni periodicidad, ni reporte.
- **Depende de:** Definir con PITS las fórmulas exactas (¿OTIF a nivel orden o renglón? ¿la penalización se captura o se calcula?) y de
  dónde salen las mermas atribuibles al proveedor — hoy SPOILAGE no distingue si la merma fue del proveedor o del local. Sin esa distinción
  el indicador de mermas sale inventado.

### Fila 58 — Generar órdenes de compra con reglas de autorización. Política: los niveles de autorización estarán determinados por la estructura organizacional vigente. Reportes: compras en el periodo, gastos.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** 'Cumplimiento en forma natural'. 'Órdenes de compra con autorización y rechazo con motivo son nativas (autorizado por,
  fecha, motivo de rechazo). Los niveles escalonados según la estructura organizacional se configuran en la implementación. Incluido en la
  suscripción propuesta.'
- **Qué existe hoy:** La autorización básica es real y está bien hecha: src/services/dashboard/purchaseOrderWorkflow.service.ts con máquina
  de estados explícita (VALID_TRANSITIONS, :29), submitForApproval / approvePurchaseOrder / rejectPurchaseOrder con motivo obligatorio,
  campos approvedBy/approvedAt/rejectedBy/rejectedAt/rejectionReason (schema.prisma:1995-2000), ActivityLog en cada paso, y el ciclo de
  corregir-y-reenviar REJECTED → PENDING_APPROVAL (commit reciente 3c1f3407). Reporte de compras del periodo: getPurchaseOrderStats
  (purchaseOrder.service.ts:1256). Lo escalonado NO existe: no hay umbrales por monto ni niveles; todas las rutas de OC —crear, autorizar,
  rechazar, recibir, cancelar— usan el mismo permiso inventory:update (src/routes/dashboard/inventory.routes.ts:725, 752, 766), o sea que
  quien puede editar una orden puede autorizarla, y no hay tope por monto. Además getPurchaseOrderStats es por venue: no hay consolidado de
  compras de las 31 sucursales (grep de purchaseOrder en src/services/organization-dashboard/ no devuelve nada).
- **Depende de:** PITS tiene que entregar su matriz real de niveles (montos por puesto). Técnicamente hay que separar el permiso de
  autorizar del de editar (purchase-orders:approve nuevo en PERMISSION_CATALOG, con su paso por audit:permissions) y agregar umbrales.
  Riesgo medio: el mismo servicio lo consumen las apps POS por /api/v1/mobile/venues/:venueId/purchase-orders/:poId/status
  (src/routes/mobile.routes.ts:2211) y el cron de reabasto — endurecer la autorización sin coordinarlo deja a alguien sin poder autorizar en
  producción.

### Fila 59 — Track de compra con cambio de estatus: Solicitada, Confirmada, Entregada, Programada, Cerrada. Reporte de OC en proceso.

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** 'Cumplimiento en forma natural'. 'Seguimiento del estatus de la orden de compra a lo largo de su ciclo, con reporte de
  órdenes en proceso.'
- **Qué existe hoy:** Existe un ciclo más fino que el que pide PITS, pero con otros nombres: PurchaseOrderStatus (schema.prisma:8366) =
  DRAFT, PENDING_APPROVAL, REJECTED, APPROVED, SENT, CONFIRMED, SHIPPED, PARTIAL, RECEIVED, CANCELLED, con transiciones validadas y bitácora
  (getWorkflowHistory, purchaseOrderWorkflow.service.ts:413). El reporte de OC en proceso se resuelve con el filtro por estatus de la lista
  (avoqado-web-dashboard/src/pages/Inventory/PurchaseOrders/PurchaseOrdersPage.tsx). Faltan dos de los cinco estatus de PITS: 'Programada'
  (entrega agendada — hoy sólo existe expectedDeliveryDate como fecha, no como estado) y 'Cerrada' distinta de 'Entregada' (RECEIVED es
  terminal y no hay cierre administrativo posterior, que es justo lo que pide la fila 60 con la factura).
- **Depende de:** Decidir si se mapean los nombres de PITS sobre los estados actuales (barato, y probablemente lo correcto) o se agregan
  SCHEDULED y CLOSED al enum. Agregar valores al enum toca la máquina de estados, las apps POS que muestran el estatus (Android/iOS leen
  /mobile) y el dashboard: es lo que lo pone en riesgo medio, no la lógica.

### Fila 60 — Cerrar la OC una vez que se le da entrada a la mercancía. Política: toda OC que cuente con factura debe cerrarse automáticamente.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** 'Cumplimiento en forma natural'. 'El cierre de OC al dar entrada a la mercancía es nativo. El cierre automático al
  asociar la factura se configura junto con la recepción de CFDI de proveedor. Incluido en la suscripción propuesta.'
- **Qué existe hoy:** La primera mitad es cierta y está bien resuelta: receivePurchaseOrder, receiveAllItems y updatePurchaseOrderItemStatus
  recalculan el estatus a partir de los renglones (updatePurchaseOrderStatusBasedOnItems,
  src/services/dashboard/purchaseOrder.service.ts:1171 y :2133), moviendo la orden a PARTIAL o RECEIVED, con lotes PEPS para insumos y
  movimientos de inventario para mercancía de reventa, y hay tests de recepción concurrente. La segunda mitad NO existe: el CFDI de
  proveedor sí se recibe (prisma/schema.prisma:13172 model Expense, con uuid, xmlUrl, parser src/services/fiscal/cfdiReceived.parser.ts y el
  tool import_expense_xml), pero Expense NO tiene purchaseOrderId — sólo un supplierId opcional (:13232) declarado explícitamente como
  'cross-link opcional, no es la fuente de verdad fiscal'. No hay ninguna liga factura↔OC, así que el cierre automático con factura no
  puede ocurrir, y tampoco existe la conciliación de tres vías (OC / recepción / factura) que un corporativo de este tamaño da por hecha.
- **Depende de:** Cruza dos módulos: compras y fiscal. Hay que decidir el matching (¿por RFC del proveedor + total? ¿captura manual del
  folio en la OC? ¿tolerancia de diferencia?) y qué pasa cuando una factura cubre varias OC o al revés. También depende de la fila 59 si
  'Cerrada' va a ser un estado propio.

### Fila 61 — Solicitud de requisición de compras por usuarios, con especificaciones, gestión de cotizaciones con proveedor, emisión de la OC correspondiente, y compras urgentes con motivo y autorización extraordinaria del responsable de área y del gerente.

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Contestado como DESARROLLO. 'Requisición de compra levantada por cualquier usuario autorizado con especificaciones y
  justificación; captura de cotizaciones de uno o varios proveedores asociadas a la requisición; marca de compra urgente con motivo
  obligatorio y autorización extraordinaria del responsable de área y del gerente; y emisión de la orden de compra directamente desde la
  requisición aprobada, heredando proveedor, partidas y precios. Cierra el ciclo requisición → cotización → autorización → OC. Tiempo de
  entrega: 3 a 5 días.'
- **Qué existe hoy:** No existe nada del ciclo: no hay modelo de requisición ni de cotización en el schema (grep de model .*Requisition /
  .*Quote no devuelve nada). Lo único vecino es SupplierPricing (schema.prisma:1922), que es una lista de precios vigente por insumo y
  proveedor con descuento por volumen y vigencia — sirve para comparar precios, pero no es una cotización asociada a una solicitud. La OC sí
  se emite bien (createPurchaseOrder + PDF + correo al proveedor), o sea que el último eslabón de la cadena ya está; falta toda la cadena
  anterior.
- **Depende de:** Es el módulo más grande de esta lista y el plazo de 3 a 5 días no es defendible: son dos modelos nuevos con su ciclo de
  vida, dos flujos de autorización (el normal y el extraordinario de urgencia, que necesita dos firmantes) y la conversión requisición→OC.
  Depende además de la fila 58: la autorización extraordinaria de dos niveles no se puede construir sobre un esquema que hoy no tiene
  niveles.

### Filas 62, 202 y 208 — Propuesta de compra automática basada en inventario disponible, demanda esperada (pronóstico), OC en tránsito y parámetros de abastecimiento por producto. Política: ajustes manuales antes de generar la OC; redondear según múltiplos de compra o presentación del proveedor; filtrar por proveedor, categoría, almacén o sucursal. Reportes: días de cobertura, productos próximos a agotarse, compras sugeridas por proveedor. Incluye 'recomendación automática: qué, cuánto y cuándo comprar considerando lead time y estacionalidad' y 'reabasto automático sin intervención manual'.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** Las tres 'Cumplimiento en forma natural'. 'La sugerencia automática de compra por punto de reorden y existencia
  disponible es nativa, con ajuste manual antes de emitir la OC y filtros por proveedor, categoría y sucursal. La incorporación del
  pronóstico de demanda y las OC en tránsito al cálculo se entrega con el módulo de IA de abastecimiento. La generación automática de
  órdenes de compra por punto de reorden es nativa.'
- **Qué existe hoy:** El motor existe y es serio: src/services/dashboard/autoReorder.service.ts — getReorderSuggestions (:173) con punto de
  reorden, urgencia CRITICAL/HIGH/MEDIUM/LOW, días hasta desabasto, cantidad sugerida por consumo promedio de 90 días + 25% de stock de
  seguridad (:126), proveedor recomendado por precio/lead time/confiabilidad (getSupplierRecommendations, supplier.service.ts:314),
  createPurchaseOrdersFromSuggestions agrupando por proveedor (:360) y runAutoReorderForVenue (:486) como cron con tope diario en pesos,
  urgencia mínima, y la lógica de no reinsistir 14 días sobre una orden rechazada. Tres huecos duros contra lo prometido: (1) 🔴 SÓLO
  INSUMOS — getReorderSuggestions consulta prisma.rawMaterial (:183); la mercancía de reventa (model Product/Inventory, con su minimumStock
  en schema.prisma:1657) NO entra al sugerido, o sea que las 18 tiendas de conveniencia de PITS no tienen propuesta de compra automática;
  (2) NO hay redondeo a múltiplos ni a presentación del proveedor — la cantidad es un Math.ceil del número crudo (:161) e ignora
  RawMaterialPresentation.factorToBase y SupplierPricing.minimumQuantity; (3) los filtros son sólo por categoría (:176), no por proveedor,
  almacén ni sucursal, y las OC en tránsito no se restan de la cantidad (el cron sólo salta el insumo si ya tiene una orden abierta, no
  ajusta el sugerido). Días de cobertura sí sale (daysUntilStockout).
- **Depende de:** Lo de mercancía de reventa se puede empezar ya (la OC ya acepta renglones de Product desde la migración 20260806024353 con
  su CHECK insumo-xor-producto; falta el lado del sugerido). El pronóstico y la estacionalidad dependen del módulo de las filas 63-67.
  Riesgo medio: este cron emite órdenes reales y manda correos a proveedores en los venues vivos — cualquier cambio en la fórmula de
  cantidad hay que probarlo contra el tope diario en pesos antes de soltarlo.

### Filas 63 a 67 — Pronóstico de venta por tienda/familia/producto; selección del modelo estadístico; al menos 3 modelos; detección de estacionalidades; integración de la estacionalidad al cálculo del pronóstico.

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Las cinco contestadas como DESARROLLO, 'Tiempo de entrega: 1 a 2 semanas' cada una, entregadas como un solo módulo. Se
  prometió explícitamente: media móvil, suavizamiento exponencial (Holt-Winters) y regresión con estacionalidad, con comparativo de
  precisión por producto y elección automática del de menor error; detección de estacionalidad semanal, mensual y de temporada; y que el
  pronóstico alimente el sugerido de compra y el punto de reorden. Se apoyó con: 'Base ya disponible: histórico completo de venta por
  producto, sucursal, día y hora desde el primer día de operación'.
- **Qué existe hoy:** El insumo SÍ está: histórico completo de ventas por producto/sucursal/día/hora (OrderItem + Order, y los servicios de
  analítica que ya lo explotan). El motor NO existe: grep -i 'forecast|pronostico|seasonal|estacional|holt|winters' sobre todo src/ devuelve
  exactamente dos cosas, y ninguna es esto — autoReorder.service.ts (un promedio simple de consumo de 90 días con 25% de seguridad, que el
  comentario del código llama 'exponential moving average' pero no lo es) y overview.analytics.service.ts:53, que es un forecast de métricas
  SaaS internas con datos MOCK generados con Math.random. Cero modelos estadísticos, cero estacionalidad, cero comparativo de error.
- **Depende de:** Nada bloquea el arranque: el histórico está. Lo que hay que cerrar antes es el nivel de agregación
  (tienda/familia/producto exige que 'familia' exista de verdad — fila 43) y cómo se mide el error para elegir modelo. El plazo de 1-2
  semanas cubre los tres modelos y el backtesting; NO cubre además cablearlo al sugerido de compra y al punto de reorden, que es trabajo
  aparte sobre autoReorder.

### Fila 70 — Alertas automáticas y configurables para incumplimientos de políticas, vencimientos, niveles de inventario, compras, producción, ventas y procesos operativos.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** 'Cumplimiento en forma natural'. 'Alertas configurables por inventario, caducidad y operación disponibles. La
  cobertura completa de alertas por incumplimiento de política en todos los procesos se define durante la implementación. Incluido en la
  suscripción propuesta.'
- **Qué existe hoy:** Hay un sistema de alertas real pero acotado: prisma/schema.prisma model LowStockAlert (rawMaterialId obligatorio) con
  AlertType = LOW_STOCK, OUT_OF_STOCK, EXPIRING_SOON, OVER_STOCK (:8445) y ciclo ACTIVE/ACKNOWLEDGED/RESOLVED/DISMISSED;
  src/services/dashboard/alert.service.ts con reconocer, resolver, auto-resolver, descartar, historial y estadísticas, más rutas y digest
  por correo. Dos límites: las alertas son SÓLO de insumos (no de mercancía de reventa — para productos sólo existe la consulta puntual del
  tool MCP low_stock, sin alerta persistente), y no hay motor de reglas configurables: los cuatro tipos están cableados en el enum. Alertas
  por incumplimiento de política en compras, producción o ventas: no existen.
- **Depende de:** PITS tiene que enumerar qué políticas quiere vigiladas — 'incumplimientos de políticas en todos los procesos' es un motor
  de reglas, no una lista de alertas. Conviene acotarlo por escrito antes de estimarlo en firme; tal como está redactado es abierto.

### Filas 72 y 249 — La OC maneja unidades de medida (pieza, kg, lt, ml, grs, oz); múltiples unidades de compra y venta para el mismo SKU con conversión forzosa y validada (compro caja de 12, vendo por pieza). Reporte de conversiones y discrepancias.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** Ambas 'Cumplimiento en forma natural'. 'Las órdenes de compra manejan unidades de medida con presentaciones de compra
  configurables por insumo.' Y: 'Múltiples unidades de compra y venta para el mismo producto con conversión obligatoria y validada, mediante
  presentaciones configurables por insumo.'
- **Qué existe hoy:** Para INSUMOS es cierto y está bien construido: prisma/schema.prisma:1790 model RawMaterialPresentation (name libre,
  factorToBase, isPurchase, isDefaultOut), model UnitConversion (:2220) con conversiones del sistema, y el renglón de OC congela la
  presentación como SNAPSHOT (PurchaseOrderItem.presentationName/presentationFactor, :2013) para que una corrección posterior del factor no
  revalúe órdenes viejas — con tests dedicados (purchaseOrderPresentation.test.ts, purchaseOrderPresentationSnapshot.test.ts). 🔴 Para
  MERCANCÍA DE REVENTA no: resolvePresentationSnapshots (purchaseOrder.service.ts:553) filtra explícitamente por rawMaterialId y su propio
  comentario dice que 'las presentaciones de compra son exclusivas de insumos (el esquema Zod rechaza una presentación en un renglón de
  producto)'. Product no tiene presentaciones. O sea: el ejemplo textual de PITS —compro caja de 12 piezas de refresco, vendo por pieza— hoy
  NO se puede en una tienda de conveniencia, sólo en la cocina. El reporte de conversiones y discrepancias tampoco existe.
- **Depende de:** Es portar el patrón de presentaciones de RawMaterial a Product. El diseño ya está probado, así que es sobre todo
  migración + recepción + UI. Riesgo medio porque toca el camino de recepción de mercancía de reventa, que es reciente
  (InventoryMovement.purchaseOrderItemId, migración de agosto) y ya corrigió un doble conteo de existencias: hay que respetar que el delta
  se derive de los movimientos, no de quantityReceived.

### Filas 203 a 206 (IA Compras y Abastecimiento) — Selección automática de proveedor por precio, calidad, OTIF, tiempos de entrega y cumplimiento; negociación asistida con rangos sugeridos; detección de anomalías en compras (órdenes atípicas, duplicadas o fuera de política) antes de autorizar; pronóstico de precios de materia prima.

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Las cuatro contestadas como DESARROLLO. Selección de proveedor: 'ligado al módulo de evaluación de proveedores, 1 a 2
  semanas'. Negociación asistida: 'desarrollo sobre el motor de IA de la plataforma, 1 a 2 semanas'. Detección de anomalías: 'La plataforma
  ya audita cada operación con usuario y fecha, que es el insumo del modelo. 3 a 5 días'. Pronóstico de precios: '1 a 2 semanas'.
- **Qué existe hoy:** Selección de proveedor: hay un scoring determinista, no IA, y le falta la mitad de los criterios prometidos —
  getSupplierRecommendations (src/services/dashboard/supplier.service.ts:314) pondera precio (0.5), lead time (0.2) y reliabilityScore
  (0.3), pero reliabilityScore es un número capturado a mano, no calidad ni OTIF calculados. Negociación asistida y pronóstico de precios de
  materia prima: no existen (SupplierPricing guarda historial de precios por proveedor e insumo, que es el insumo natural, pero nadie lo
  analiza). Detección de anomalías: no existe; lo que sí es cierto es la base citada — ActivityLog registra las mutaciones de OC
  (PURCHASE_ORDER_CREATED/SUBMITTED/APPROVED/REJECTED/RECEIVED en purchaseOrderWorkflow y purchaseOrder.service). El motor de IA de la
  plataforma también es real (src/mcp/ con más de 200 tools, entre ellas list_suppliers, list_purchase_orders, purchase_order_detail y
  reorder_suggestions).
- **Depende de:** La selección automática de proveedor está bloqueada por la fila 57: sin OTIF ni fill rate calculados, ponderarlos es
  imposible. La detección de anomalías necesita antes que exista 'la política' contra la cual comparar (filas 58 y 61). El pronóstico de
  precios de materia prima necesita historial de precios de compra con suficiente profundidad, que en un cliente nuevo no existe el día uno
  — hay que decirlo.

### Fila 248 — Alta de producto con atributos específicos por tipo de negocio (restaurante/cafetería: recetas, porciones, tiempos de preparación; tienda: código de barras EAN-13). Política: validar que los atributos obligatorios por tipo de negocio estén completos. Reporte: catálogo maestro con filtro por tipo de negocio.

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** 'Cumplimiento en forma natural'. 'Para restaurante y cafetería, recetas, porciones y tiempos de preparación son
  nativos; para tienda, código de barras EAN-13 y claves SAT son nativos. La validación de atributos obligatorios por tipo de negocio se
  configura durante la implementación. Incluido en la suscripción propuesta.'
- **Qué existe hoy:** Lo declarado nativo sí lo es: Recipe/portionYield/prepTime (schema.prisma:1809 y Product.prepTime), gtin y
  satProductKey/satUnitKey en Product, y Venue.type (VenueType) más operationalRole (schema.prisma:128-130) para distinguir formatos. Existe
  incluso una validación por tipo, validateProductByType en src/services/dashboard/product.dashboard.service.ts:529, pero valida por
  ProductType (CLASS, EVENT, DIGITAL, DONATION…), no por tipo de negocio del venue, y no exige EAN-13 en tienda ni receta en cafetería. El
  formato del código de barras no se valida en ningún lado (gtin es z.string().max(14)). El catálogo maestro con filtro por tipo de negocio
  no existe como reporte.
- **Depende de:** Definir la matriz de obligatoriedad por formato (tienda / restaurante / cafetería). Riesgo medio no por el trabajo sino
  por el efecto: volver obligatorio un atributo rompe altas que hoy funcionan en los venues vivos, así que tiene que ser configuración por
  venue y no una regla global.

## Módulo: contabilidad

Mucho mas completo de lo que el founder cree: hay libro diario de partida doble real, catalogo SAT, Anexo 24 (catalogo/balanza/polizas XML),
DIOT, ISR, IVA en flujo, activos fijos con tasas LISR, nomina con timbrado, CxP con antiguedad, cierre de periodo y CFDI 4.0 (individual,
global, autofactura, cancelacion) — todo con UI en el dashboard; los huecos reales y caros son cuatro: integracion de descarga con el SAT
(se contesto como cumplimiento natural y no existe), IEPS en la venta (critico para 18 tiendas de conveniencia), el modulo presupuestal
completo (10 renglones, cero codigo) y viaticos/dispersion de pagos.

### Filas 137 y 144: subcentros de costo asociados a un centro primario, con estado de resultados y balanza por centro; y estado de resultados consolidado por tipo de negocio, compania y centro de costos

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** NATURAL ambas. 'Centros de costo con jerarquia padre y subcentro se configuran en el catalogo contable, con estado de
  resultados y balanza de comprobacion por centro' y 'estado de resultados consolidado por tipo de negocio, compania y centro de costo'.
  Incluido en la suscripcion.
- **Qué existe hoy:** El asiento SI estampa el centro de costo: JournalEntry.venueId (prisma/schema.prisma:13080) lo escribe
  autoPosting.service.ts (lineas 288/296) y journalEntry.service.ts:247. PERO ningun reporte contable lo filtra ni lo agrupa:
  accountingReports.service.ts:89 (getAccountingReports) y trialBalance.service.ts:71 agrupan solo por (organizationId, rfc). Por COMPANIA
  si esta resuelto (una org puede tener varios RFC via FiscalEmisor y cada contribuyente lleva su propio catalogo y sus propios estados).
  Por TIPO DE NEGOCIO el dato existe (Venue.type distingue tienda/restaurante/cafeteria) pero no se usa en contabilidad. La jerarquia
  padre/hijo que existe es la del catalogo de cuentas (LedgerAccount.parentId), NO de centros de costo; el unico agrupador de sucursales es
  Venue.zoneId (modelo Zone) y no esta cableado a nada contable.
- **Depende de:** Decidir con el contador de PITS si el centro de costo es el venue, la Zone o una dimension nueva; y como se reparten
  activos y pasivos si quieren balance general por centro (el estado de resultados por centro es directo, el balance no).

### Fila 138: identificar los ingresos generados por cada centro de costo/localidad

- **Brecha:** 🟢 Ya está · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL. 'Hoy en produccion cada sucursal y formato reporta su ingreso por separado y consolidado.'
- **Qué existe hoy:** Cierto y verificado: getIncomeStatement en src/services/dashboard/accounting.dashboard.service.ts:92 es por venue con
  rango de fechas en zona local del negocio, desglosa IVA por tasa real y separa el subconjunto fiscal del gerencial; el consolidado esta en
  el tool MCP revenue_by_venue. UI en avoqado-web-dashboard/src/pages/Reports/IncomeStatement.tsx y BusinessSummary.tsx.
- **Depende de:** Nada. Solo dar de alta los venues de PITS.

### Filas 139 y 149: generar y timbrar CFDI 4.0 a clientes, y alertar para evitar duplicados en el timbrado

- **Brecha:** 🟢 Ya está · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL ambas. 'Timbrado de CFDI 4.0 disponible en el modulo fiscal' y 'control de duplicados en el timbrado mediante
  validacion por UUID'. Incluido en la suscripcion.
- **Qué existe hoy:** Existe completo: src/services/fiscal/cfdi.service.ts (issueCfdiForOrder:169, cancelCfdi:519 con los 4 motivos SAT,
  getCfdiStatus:596), factura global mensual (cfdiGlobal.service.ts + jobs/cfdiGlobal.job.ts), autofactura del cliente
  (controllers/public/cfdi.public.controller.ts) y adaptador Facturapi (providers/facturapi.provider.ts). Anti-duplicado a nivel base de
  datos: Cfdi.uuid @unique y Cfdi.idempotencyKey @unique (schema.prisma:12799), mas reserva de fila en estado STAMPING antes de llamar al
  PAC y el job cfdiReconcile.job.ts que pregunta al PAC antes de permitir cualquier reintento. UI en avoqado-web-dashboard/src/pages/Cfdi/.
- **Depende de:** Alta del CSD de cada RFC de PITS en el proveedor fiscal (ya existe fiscalOnboarding.service.ts y la pantalla
  UploadCsdModal).

### Filas 140 y 153: registrar complemento de pago (REP) asociado a una factura, y complemento de pago a proveedores sobre facturas PPD

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** NATURAL ambas. 'Registro del complemento de pago (REP) asociado a la factura, dentro del modulo fiscal. Incluido en la
  suscripcion.'
- **Qué existe hoy:** HALLAZGO IMPORTANTE: el REP SI esta construido, pero en el lugar equivocado para PITS. facturapi.provider.ts:226 tiene
  createPaymentComplement (CFDI tipo P con NumParcialidad, ImpSaldoAnt e ImpSaldoInsoluto) y su unico consumidor es
  src/services/superadmin/platform-billing/platformCfdi.service.ts:312 — o sea Avoqado facturandole a SUS propios clientes, no un venue a
  los suyos. En el camino de venue solo se emite tipo INGRESO: el enum CfdiType incluye PAGO y EGRESO pero cfdiPayloadBuilder.ts no los
  construye. Del lado recibido, cfdiReceived.parser.ts si reconoce el tipo PAGO pero expensePosting.service.ts:244 lo excluye y no lo liga a
  la factura PPD del proveedor.
- **Depende de:** Que el REP de platform-billing quede commiteado y con su migracion aplicada (hoy ese trabajo esta en develop sin cerrar);
  despues es portar el mismo servicio al scope de venue y agregar el registro del REP recibido del proveedor.

### Filas 141 y 170: depreciar activos parametrizable por tipologia de forma contable y fiscal, y vincular activos a un activo padre

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL ambas. 'Depreciacion de activos contable y fiscal, parametrizable por tipologia del activo, en el modulo de
  activos fijos' y 'vinculacion de activos a un activo padre con depreciacion contable y fiscal'. Incluido en la suscripcion.
- **Qué existe hoy:** Depreciacion: existe y es seria. src/services/fiscal/assetTypeCatalog.ts trae las tasas maximas de la LISR art. 34-35
  por tipo de activo (editables por el contador) con el tope de MOI para automoviles (175,000, art. 36-II);
  fixedAssetDepreciation.service.ts calcula linea recta por meses completos de uso y postea la poliza (JournalEntrySource.DEPRECIATION);
  modelos FixedAsset y FixedAssetDepreciation en schema.prisma:13311, idempotentes por (activo, periodo). UI en Reports/FixedAssets.tsx.
  Limitacion documentada en el propio codigo: base nominal, la actualizacion por INPC se captura a mano (FixedAsset.inpcFactor). ACTIVO
  PADRE: no existe — FixedAsset no tiene parentId ni autorelacion.
- **Depende de:** Nada externo. Agregar parentId autorelacion a FixedAsset, el rollup de depreciacion acumulada del padre y la columna en la
  pantalla. Regenerar docs/SCHEMA_MAP.md en el mismo commit.

### Filas 142 y 143: estado de resultados y balance general predeterminados, configurables y exportables en XLS y PDF

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL ambas. 'Predeterminado, configurable y exportable a XLS y PDF, en el modulo contable. Incluido en la
  suscripcion.'
- **Qué existe hoy:** Los dos estados existen y cuadran: accountingReports.service.ts:89 devuelve IncomeStatement y BalanceSheet con la
  prueba de la ecuacion contable (campo balanced) y resuelve correctamente el resultado de ejercicios anteriores. UI en
  Reports/AccountingReports.tsx. BONUS no prometido en la matriz: desde esa misma pantalla se descargan los XML de contabilidad electronica
  del SAT (Anexo 24, esquema 1.3) — catalogo y balanza via contabilidadElectronica.service.ts (getCatalogoXml:54, getBalanzaXml:100), y
  ademas existe getPolizasXml:147 ya expuesto en la API (accounting.routes.ts:592) aunque sin boton en la UI. LO QUE FALTA: el export a XLS
  y PDF de estos estados NO esta — no hay ninguna referencia a export/xlsx/pdf en Reports/AccountingReports.tsx, TrialBalance.tsx ni
  Journal.tsx, pese a que ya existen los helpers avoqado-web-dashboard/src/utils/export.ts y src/services/dashboard/export.helpers.ts
  (PDFKit) usados en otros reportes.
- **Depende de:** Nada. Es cablear el helper de export que ya existe y agregar el boton de polizas XML que ya tiene endpoint.

### Fila 145: estado de flujo de efectivo predeterminado, configurable y exportable en XLS y PDF

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL. 'Estado de flujo de efectivo predeterminado, configurable y exportable a XLS y PDF, en el modulo contable.
  Incluido en la suscripcion.'
- **Qué existe hoy:** NO EXISTE. La busqueda de 'flujo de efectivo'/cashflow en todo src solo devuelve ivaFlujo.service.ts (que es el IVA
  causado sobre flujo, LIVA art. 1-B — cosa distinta) y getBankAndCashSummary (accounting.dashboard.service.ts:466), que es un resumen de
  bancos y caja del periodo, no un estado de flujo con actividades de operacion, inversion y financiamiento.
- **Depende de:** Clasificar las cuentas del catalogo por actividad (operacion / inversion / financiamiento) — decision del contador de
  PITS. El metodo indirecto se deriva del balance comparativo mas el resultado, que ya existen y cuadran.

### Fila 146: normatividad fiscal actualizada para el calculo de impuestos, con IVA en todas sus tasas e IEPS, y prueba de que cada producto grava el impuesto adecuado

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** ALTO
- **Qué prometimos:** MODULO COMPLEMENTARIO con plazo. 'Catalogo fiscal con IVA en todas sus tasas e IEPS, y claves de producto y unidad del
  SAT por producto, con validacion del impuesto que grava cada articulo... Configuracion durante la implementacion: 3 a 5 dias.'
- **Qué existe hoy:** IVA: cumplido. Product.taxRate (schema.prisma:1470), satProductKey, satUnitKey y objetoImp por producto y con default
  por categoria; el estado de resultados desglosa el IVA por tasa real (taxByRate 16/8/0/exento) usando el mismo split que la poliza, para
  que reporte y libro diario cuadren al centavo. IEPS: NO EXISTE del lado de la VENTA. La busqueda de 'ieps' en prisma/schema.prisma solo
  devuelve Expense.iepsCents (linea 13202), que es el CFDI RECIBIDO del proveedor. No hay campo de IEPS en Product ni en ninguna entidad de
  venta, y cfdiPayloadBuilder.ts:44 solo emite impuestos tipo IVA. Las cuentas contables de IEPS si estan sembradas
  (chartOfAccounts.catalog.ts:704, 722, 738) pero nada las alimenta desde la venta. OJO: se contesto como 'configuracion durante la
  implementacion, 3 a 5 dias' y no es configuracion — es desarrollo, y toca el calculo de impuestos de la venta.
- **Depende de:** Definir con PITS que productos causan IEPS y a que tasa o cuota (refresco, cerveza, tabaco). Es el requerimiento fiscal
  mas relevante para las 18 tiendas de conveniencia y hoy no esta cubierto por ningun lado del sistema.

### Fila 147: conciliar facturas a partir de integracion con el SAT

- **Brecha:** 🔴 De cero · **Esfuerzo:** MES_O_MAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL. 'Conciliacion de facturas contra el SAT mediante descarga y validacion automatica de CFDI recibidos, con
  proceso de conciliacion diario ya operando. Incluido en la suscripcion.'
- **Qué existe hoy:** NO EXISTE integracion con el SAT. Verificado: no hay descarga masiva, ni e.firma, ni CIEC, ni proveedor tercero — la
  busqueda de sat.gob/efirma/descarga masiva solo devuelve namespaces XML del Anexo 24 y textos de ayuda. El 'proceso de conciliacion diario
  ya operando' que se cito es src/jobs/cfdiReconcile.job.ts, que hace algo completamente distinto: reconcilia contra Facturapi NUESTRAS
  propias facturas atoradas en estado STAMPING para no timbrar dos veces (ver el encabezado de cfdiReconcile.service.ts). Los CFDI recibidos
  entran unicamente por captura manual o subiendo el XML (expense.service.ts importExpenseFromXml:466).
- **Depende de:** Decision de plataforma: contratar un tercero de descarga masiva (SATws, Syncfy, Facturapi Recepcion) o pedir a PITS la
  e.firma/CIEC de cada RFC y construir el cliente del web service del SAT. Es el hueco mas grande del modulo y se contesto como cumplimiento
  natural sin plazo.

### Fila 148: conciliar facturas a partir de la carga de un concentrado de facturas XML (excel)

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL. 'Conciliacion de facturas a partir de la carga de un concentrado de XML, en el modulo fiscal. Incluido en la
  suscripcion.'
- **Qué existe hoy:** Parcial. Existe la importacion de UN XML por llamada: expense.service.ts importExpenseFromXml:466, con parser completo
  (cfdiReceived.parser.ts: traslados por tasa, IEPS, retenciones de ISR e IVA, UUID) y deduplicacion dura por [organizationId, rfc, uuid] y
  por dedupeKey. NO existe carga masiva: expense.controller.ts:74 recibe un solo XML como texto — no hay ZIP, ni multiarchivo, ni layout de
  Excel.
- **Depende de:** Nada. Envolver el import que ya existe en un endpoint de carga multiple con reporte por renglon (aceptado / duplicado /
  error).

### Fila 150: carga de layout para registro de nominas y cualquier tipo de poliza, y autorizar el gasto

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** DESARROLLO con plazo. 'Carga por layout de Excel... con validacion de cuadre (cargos igual a abonos), verificacion de
  que las cuentas existan en el catalogo, previsualizacion de errores por renglon antes de aplicar, y flujo de autorizacion del gasto antes
  de afectar la contabilidad. Se construye sobre el motor de polizas y el catalogo de cuentas ya operativos. Tiempo de entrega: 3 a 5 dias.'
- **Qué existe hoy:** La base que se cito es real y solida: journalEntry.service.ts postJournalEntry:155 valida el cuadre (suma debe igual a
  suma haber como invariante duro), verifica que la cuenta exista y sea afectable, respeta el candado de periodo (AccountingPeriodLock,
  accountingPeriodLock.service.ts) y es idempotente por idempotencyKey; createManualEntry:330 ya permite polizas manuales y hay UI en
  Reports/Journal.tsx. Lo que NO existe: parser de Excel, previsualizacion por renglon y flujo de autorizacion — no hay nada de
  layout/import masivo en src/services/fiscal.
- **Depende de:** Que PITS entregue el layout real que usan hoy, con las columnas exactas; sin eso se construye a ciegas. Los 3 a 5 dias
  alcanzan para la carga y la previsualizacion, no para el motor de autorizacion multinivel.

### Fila 151: calculo de nominas

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL. 'Calculo de nomina disponible en el modulo de nomina, con timbrado de recibos. Incluido en la suscripcion.'
- **Qué existe hoy:** Existe mas de lo que el founder recuerda: nomina.service.ts computePayrollLine:79 aplica la tarifa real del art. 96
  (ART96_MONTHLY en isr.service.ts:47), el subsidio al empleo incluyendo el subsidio entregado cuando excede al ISR, e IMSS obrero;
  runPayroll:467 genera la corrida y su poliza; nominaCfdi.service.ts stampPayrollReceipts:123 timbra el CFDI 4.0 tipo N con complemento
  Nomina 1.2. Modelos PayrollRun y PayrollLine (schema.prisma:13423). UI en Reports/Nomina.tsx. LIMITACIONES escritas en el propio codigo:
  otras deducciones siempre en 0 (prestamos, pension alimenticia, fondo de ahorro) con una nota de que activarlas descuadra la poliza si no
  se hacen tres cambios juntos; percepcion exenta en 0; sin horas extra, aguinaldo, PTU, finiquito ni incapacidades; sin IMSS patronal ni
  SUA (el ISN si esta, como tasa en FiscalEmisor.isnRate).
- **Depende de:** Saber si PITS va a correr aqui la nomina real de sus 141 usuarios o solo quiere el timbrado. Si es nomina de produccion
  faltan las percepciones y deducciones variables completas — no es un ajuste menor y toca dinero de empleados.

### Fila 152 (con 127 y 181): dispersion de pagos, orden de pago que agrupa varias facturas del mismo proveedor y carga mediante layout a portales bancarios

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** DESARROLLO. 'Generacion del archivo de dispersion en el formato del banco a partir de las ordenes de pago autorizadas,
  con control de folio, bitacora y conciliacion posterior contra el estado de cuenta. De nuestro lado: 3 a 5 dias. La fecha final depende de
  los tiempos del tercero que PITS defina.'
- **Qué existe hoy:** No existe para proveedores. Lo unico llamado dispersion es src/services/dashboard/cash-out/cash-out.report.service.ts
  generateDispersionReport:33, que es el corte de comisiones de promotores de PlayTelecom — otro dominio por completo. No hay modelo de
  orden de pago, ni agrupacion de facturas por proveedor, ni generador de layout bancario. Expense.paymentStatus/paidCents si permite marcar
  pagado (mark_expense_paid) pero factura por factura.
- **Depende de:** El banco que PITS defina y su especificacion de layout — el plazo de 3 a 5 dias 'de nuestro lado' es realista SOLO si nos
  entregan el formato. Depende ademas de construir primero la orden de pago (fila 127), que es el objeto que se dispersa.

### Fila 154: registrar notas de credito del proveedor con base en la factura ya capturada en el sistema

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL. 'Registro de notas de credito del proveedor con base en la factura ya capturada, en el modulo fiscal.
  Incluido en la suscripcion.'
- **Qué existe hoy:** Se REGISTRA pero no AFECTA nada. El parser reconoce el tipo E y lo guarda como Expense.comprobanteTipo = EGRESO
  (cfdiReceived.parser.ts:20, enum ReceivedComprobanteTipo). Pero expensePosting.service.ts:244 excluye explicitamente los EGRESO de la
  generacion de polizas, accountsPayable.service.ts:87 solo suma comprobanteTipo INGRESO (la nota de credito NO baja el saldo del proveedor)
  y diot.service.ts:116 igual (no resta el IVA). Tampoco hay liga a la factura original: no existe campo de UUID relacionado.
- **Depende de:** Nada externo. Agregar la relacion a la factura original, netear en CxP, en la DIOT y en el IVA acreditable, y generar el
  asiento inverso.

### Fila 155: reporte de ganancias y perdidas (P&L) con corte configurable y rentabilidad por producto (PMIX)

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL. 'Reporte de rentabilidad y resultados (P&L) con corte configurable por periodo, sucursal, formato y producto,
  exportable. Incluye rentabilidad por producto y mezcla de venta (PMIX).'
- **Qué existe hoy:** Base real: src/services/dashboard/cost-management.service.ts calcula profitMargin y metricas de utilidad; hay reportes
  SalesByItem y SalesByCategory en el dashboard con export; y el costo de ventas si se computa con costo real FIFO en cogs.service.ts
  (movimientos USAGE de recetas mas SALE de producto, excluyendo mermas). Falta el corte 'por formato' y armar un P&L unico exportable que
  junte ingreso, COGS y gasto por producto y sucursal — hoy son pantallas separadas.
- **Depende de:** Que el catalogo tenga costo cargado por producto y receta; sin costo, la rentabilidad sale en cero.

### Fila 156: analisis de facturas emitidas y recibidas con filtros amplios (UUID, RFC emisor y receptor, proveedor, sucursal, centro de costo, importe, estatus SAT, metodo y forma de pago, moneda, impuestos), deteccion de canceladas y duplicadas, y diferencias entre XML, orden de compra y recepcion de mercancia

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** MODULO COMPLEMENTARIO con plazo. 'Analisis... con los filtros solicitados... e identificacion de canceladas y
  duplicadas, en el modulo fiscal. El cruce automatico entre XML, orden de compra y recepcion se entrega durante la implementacion.
  Configuracion durante la implementacion: 3 a 5 dias.'
- **Qué existe hoy:** Los filtros que hay son muy pocos: expense.service.ts ListExpensesFilters:396 solo acepta period, paymentStatus,
  proveedorRfc e includeCancelled — no UUID, no importe, no centro de costo, no metodo ni forma de pago, no impuesto, no moneda. Del lado
  emitido, cfdi.service.ts listCfdisForVenue:71 filtra por venue y estatus. Los duplicados si se detectan (unique por uuid y por dedupeKey).
  El CRUCE TRIPLE XML-OC-RECEPCION no existe: Expense.supplierId es un cross-link opcional que el propio esquema marca como 'no es la fuente
  de verdad fiscal', y PurchaseOrder no tiene ninguna relacion con Expense ni con Cfdi. Ese cruce es lo caro del renglon y se contesto como
  configuracion de implementacion.
- **Depende de:** Coordinacion con el modulo de compras: hay que definir el enlace orden de compra -> recepcion -> CFDI antes de poder
  cruzar nada. Los filtros por si solos son dias; el cruce es el trabajo real.

### Filas 157 y 158: reporte de ingresos y reporte de gastos con clasificacion por categoria y centro de costo

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL ambas. Ingresos: 'por sucursal, formato, periodo y metodo de pago, exportable'. Gastos: 'con clasificacion por
  categoria y centro de costo, en el modulo contable. Incluido en la suscripcion.'
- **Qué existe hoy:** Ingresos: cumplido (SalesSummary, PaymentMethods, IncomeStatement por venue, todos exportables). Gastos: el dato esta
  — Expense tiene categoria (enum ExpenseCategoria, schema.prisma:13372), venueId y ledgerAccountId — y hay pantalla Reports/Expenses.tsx,
  pero listExpenses NO filtra ni agrupa por categoria ni por venue/centro de costo. O sea: hoy se LISTAN los gastos, no se REPORTAN
  clasificados como pide el renglon.
- **Depende de:** Nada. Agregar filtros y agrupacion al servicio y a la pantalla que ya existen.

### Modulo presupuestal completo — filas 159, 160, 165, 166, 167, 168, 174, 176, 177 y 185: presupuestos de ingresos y egresos, por concepto de gasto e insumo, por centro de costo real contra presupuestado, ajuste del planeado, presupuesto de gasto y costo del flujo de ventas, control configurable de compra abierta contra restrictiva, presupuesto de viaticos, presupuesto de nuevos proyectos, alertas de sobregasto y reglas de autorizacion

- **Brecha:** 🔴 De cero · **Esfuerzo:** MES_O_MAS · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** DESARROLLO en los 10 renglones. La mayoria a '1 a 2 semanas' cada uno; las reglas de autorizacion de proyectos a '3 a
  5 dias'. Se describio como 'el modulo presupuestal, que responde al primer punto del macroproceso de PITS', y en la fila 159 se agrego el
  argumento del SCADA de CONAGUA puesto al corriente en 15 dias.
- **Qué existe hoy:** NO EXISTE NADA. La busqueda de 'budget' en prisma/schema.prisma solo devuelve ChatbotTokenBudget (presupuesto de
  tokens del chatbot, sin relacion alguna). No hay modelo de presupuesto, ni partida, ni comparativo real contra presupuestado, ni alerta
  por umbral, ni bloqueo de orden de compra al agotarse la partida. Lo unico reutilizable es la contraparte real (polizas, gastos, centros
  de costo) y el motor de notificaciones existente.
- **Depende de:** Es el bloque mas grande del modulo y ademas 'el primer punto del macroproceso de PITS'. Necesita spec propio (que
  dimension se presupuesta: cuenta, centro de costo, proyecto, insumo) y el candado restrictivo toca el flujo de ordenes de compra, o sea
  coordinacion con el modulo de compras. Sumar 10 renglones a '1 a 2 semanas' cada uno subestima el conjunto.

### Fila 164: mostrar de forma automatica los comprobantes de pago de nomina en el portal de empleados

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** DESARROLLO con plazo. 'Portal del empleado con acceso a sus recibos de nomina timbrados, descarga de XML y PDF, e
  historico por periodo. Se construye sobre el modulo de nomina existente, que ya administra empleados con RFC, CURP, NSS, salario diario
  integrado y registro patronal. Tiempo de entrega: 1 a 2 dias.'
- **Qué existe hoy:** La base citada es exacta: PayrollLine guarda el recibo por empleado con su estado de timbrado (PayrollCfdiStatus) y
  stampPayrollReceipts genera XML y PDF. Pero el PORTAL no existe: no hay ruta ni autenticacion de empleado para consultar sus propios
  recibos; hoy la nomina se ve desde el dashboard con permiso accounting (Reports/Nomina.tsx). Lo que falta es justamente el acceso del
  empleado a SOLO lo suyo.
- **Depende de:** Decidir como entra el empleado (reusar el login de Staff con un rol restringido, o un enlace magico por correo). Los 1 a 2
  dias prometidos alcanzan para la pantalla, no para el modelo de acceso — y aqui un error expone el salario de un empleado a otro.

### Fila 171: clasificar el gasto de acuerdo a un atributo (activo directo o indirecto, insumos) y gastos que se cargan por activo fijo

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL. 'Clasificacion del gasto por atributo (activo directo, indirecto, insumos) y carga por activo fijo, en el
  modulo contable. Incluido en la suscripcion.'
- **Qué existe hoy:** Casi completo. Expense.categoria es un enum ExpenseCategoria (schema.prisma:13372) con clasificacion predefinida, mas
  expenseAccountCode y ledgerAccountId para el destino contable, y venueId como centro de costo. La carga por activo fijo SI existe:
  FixedAsset.sourceExpenseId liga el gasto de compra con el activo. Falta que el atributo directo/indirecto/insumo sea configurable por PITS
  (hoy es un enum cerrado en codigo) y que los reportes agrupen por el.
- **Depende de:** Confirmar si PITS acepta las categorias actuales o necesita atributos propios; si necesita propios, es una tabla de
  atributos con su migracion.

### Fila 173: control y administracion de fondos de capital por inversiones y de las cuentas bancarias en general

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** DESARROLLO con plazo. 'Registro y control de fondos de capital destinados a inversion, con seguimiento por cuenta
  bancaria, movimientos y rendimiento, integrado al catalogo de cuentas y a la conciliacion bancaria ya existentes. Tiempo de entrega: 3 a 5
  dias.'
- **Qué existe hoy:** La parte bancaria si tiene base real: modelo FinancialAccount (schema.prisma:11750) y todo el conector
  src/services/financial-connections/ (financialConnection.service.ts, externalBank.client.ts), mas el catalogo de cuentas y la conciliacion
  que se citaron. La parte de INVERSIONES no existe: no hay entidad de fondo, ni instrumento, ni calculo de rendimiento.
- **Depende de:** Que PITS diga que instrumentos maneja (pagare, mesa de dinero, fondo de inversion) porque el rendimiento se calcula
  distinto en cada uno. Nota operativa: la variable EXTERNAL_BANK_API_BASE del conector bancario sigue pendiente de actualizar en Render
  tras el cambio de dominio del proveedor.

### Fila 175: flujo completo desde la solicitud hasta la comprobacion del gasto de viaticos (reembolsos)

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** DESARROLLO con plazo. 'Ciclo completo de viaticos — solicitud con justificacion y monto, autorizacion por nivel
  jerarquico, entrega del anticipo, comprobacion con carga de CFDI y tickets, calculo del saldo a favor o en contra, y reembolso o
  descuento. Se apoya en la carga de CFDI de gastos que ya opera. Tiempo de entrega: 3 a 5 dias.'
- **Qué existe hoy:** NO EXISTE. La busqueda de viatic / per diem / reembolso en src no devuelve nada de este dominio (solo reembolsos de
  pagos a clientes, que es otra cosa). Lo unico cierto de la respuesta es que la carga de CFDI de gastos si opera (expense.service.ts) y
  serviria para la etapa de comprobacion.
- **Depende de:** Necesita un motor de autorizacion por nivel jerarquico que tampoco existe todavia — es el mismo que piden la fila 184
  (autorizacion segun clasificacion de producto) y el modulo presupuestal. Conviene construir ese motor UNA vez y colgar de el viaticos,
  presupuesto y autorizacion de compra.

### Filas 131, 132 y 229: conciliacion bancaria a partir de carga de estado de cuenta, por referencia, monto y fecha, con emparejamiento inteligente, y reporte de conciliacion de gastos y flujos de efectivo

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** NATURAL la carga de estado de cuenta y el emparejamiento por referencia, monto y fecha ('existe en el modulo
  contable'); MODULO la conciliacion automatica via conexion bancaria, '3 a 5 dias de nuestro lado, la fecha final depende del banco'.
- **Qué existe hoy:** Existe y esta bien hecho, pero solo de un lado. src/services/dashboard/bankReconciliation.service.ts:
  parseBankCsv:104, matchLines:219 (puro y determinista, con tolerancia de monto, ventana de 2 dias y deteccion de duplicados) y
  processBankStatement:278; modelos BankStatement y BankStatementLine (schema.prisma:12896); UI en Reports/BankReconciliation.tsx; gate
  Feature PRO BANK_RECONCILIATION (dashboard.routes.ts:4159). LIMITE IMPORTANTE: matchLines descarta toda linea que no sea CREDIT — solo
  concilia DEPOSITOS contra pagos que Avoqado proceso. Los CARGOS (pagos a proveedores, comisiones, transferencias) quedan todos sin
  conciliar, y la conciliacion no genera poliza ni toca el libro mayor. El 'reporte de conciliacion de gastos y flujos de efectivo' que pide
  la fila 132 no existe.
- **Depende de:** Para conciliar cargos hace falta primero tener el egreso registrado como orden de pago (filas 127 y 152). El matcher ya es
  la pieza estable y testeable; extenderlo a DEBIT y ligarlo al ledger es el trabajo.

### Filas 125, 135 y 136: generar cuenta por pagar con fecha programada de pago segun dias de credito (calculada desde fecha de factura, recepcion o validacion), estado de cuenta por proveedor y localidad, y generacion automatica de la cuenta por pagar a partir de la orden de compra

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** NATURAL las filas 125 y 135 ('el registro de cuentas por pagar y su vencimiento existe en el modulo contable; el
  calculo automatico de la fecha programada de pago a partir de los dias de credito del proveedor se configura junto con el catalogo
  ampliado de proveedores'); MODULO la 136, '3 a 5 dias de configuracion durante la implementacion'.
- **Qué existe hoy:** CxP existe como antiguedad de saldos: accountsPayable.service.ts getAccountsPayableAging:69 agrupa por proveedor en
  cubetas 0-30 / 31-60 / 61-90 / 90+, con tool MCP accounts_payable y UI Reports/AccountsPayable.tsx. PERO las cubetas se calculan desde la
  FECHA DE EMISION, no desde un vencimiento real: Expense no tiene campo de fecha de vencimiento ni de dias de credito, y el modelo Supplier
  (schema.prisma:1869) no tiene dias de credito ni cuenta bancaria — solo leadTimeDays, que es tiempo de ENTREGA, no de credito. Eso deja
  tambien sin base la fila 161 (cuenta bancaria del proveedor para el pago). Y no hay generacion automatica desde la orden de compra:
  PurchaseOrder no tiene relacion alguna con Expense.
- **Depende de:** Ampliar el catalogo de proveedores (dias de credito, cuenta bancaria, CLABE) y definir el enlace orden de compra ->
  recepcion -> CFDI, que es la misma dependencia de la fila 156. Sin el vencimiento real, la antiguedad que se muestra hoy no es la que PITS
  usaria para decidir a quien pagar.

### Filas 228, 230, 232 y 233 (IA contable): captura automatizada de facturas con OCR e IA, deteccion de fraude financiero en cuentas por pagar, clasificacion automatica de gastos (auto-coding) y pronostico de flujo de efectivo

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** DESARROLLO los cuatro. OCR '3 a 5 dias' aclarando que el CFDI XML ya se procesa; fraude en AP '3 a 5 dias';
  auto-coding '3 a 5 dias' apoyandose en que 'el catalogo contable y los centros de costo ya existen'; pronostico de flujo '1 a 2 semanas'.
- **Qué existe hoy:** Ninguno de los cuatro existe. Lo cierto de las respuestas: el CFDI XML si se parsea completo (cfdiReceived.parser.ts)
  — pero eso es lectura de XML, no OCR; y el catalogo con AccountMapping (accountMapping.service.ts, enum AccountMovementType con 32 tipos
  de movimiento y defaults por giro en accountMapping.catalog.ts) si es base solida para el auto-coding. Para el fraude en AP falta primero
  el objeto que se protege (la orden de pago, fila 152). Para el pronostico de flujo falta el estado de flujo de efectivo (fila 145).
- **Depende de:** El auto-coding se puede empezar ya (hay catalogo, mapeos e historial de gastos). Los otros tres dependen de piezas que aun
  no existen: OCR necesita definir proveedor de vision, fraude en AP necesita ordenes de pago, y el pronostico necesita el estado de flujo
  de efectivo.

## Módulo: inventarios

El motor de insumos (RawMaterial → StockBatch PEPS con caducidad → RawMaterialMovement) y el de traslados entre sucursales están construidos
y son sólidos — mucho más de lo que la matriz da a entender; el hueco real y grande es que TODO lo de lotes, caducidad, PEPS, cuarentena y
traslados vive ÚNICAMENTE del lado de insumos (RawMaterial) y NO existe para la mercancía de reventa (Product/Inventory), que es justo el
inventario de las 18 tiendas de conveniencia que PITS pondera primero.

### R74 — Descontar automáticamente del inventario disponible el producto clasificado como merma, con tipo de movimiento diferenciado (daño, caducidad, desperdicio).

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Cumplimiento natural. 'El producto clasificado como merma se descuenta automáticamente del inventario disponible para
  venta, con tipo de movimiento diferenciado (daño, caducidad, desperdicio).' Sin plazo.
- **Qué existe hoy:** Existe de verdad en insumos: enum RawMaterialMovementType.SPOILAGE (prisma/schema.prisma:8403) y
  adjustRawMaterialStock en src/services/dashboard/rawMaterial.service.ts descuentan saldo y dejan movimiento. En mercancía de reventa
  existe MovementType.LOSS (schema:7091) y se usa hoy SOLO en un caso: mercancía marcada DAMAGED al recibir
  (src/services/dashboard/purchaseOrder.service.ts:1571-1580). El 'tipo diferenciado (daño/caducidad/desperdicio)' NO es un campo tipado: es
  texto libre en `reason`.
- **Depende de:** Decidir si el motivo de merma se tipifica (enum/catálogo) o se queda como texto libre; hoy el catálogo de motivos existe
  SOLO en el dashboard (src/lib/inventory-constants.ts WASTE_REASONS) y el backend no lo conoce.

### R90 — Registro de la causa de merma por daño o caducidad, con motivo, evidencia y autorización. Reporte de merma.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Cumplimiento natural. 'Registro de merma con motivo (daño, caducidad, desperdicio), usuario responsable y
  autorización, con reporte de merma por sucursal y producto.' Sin plazo.
- **Qué existe hoy:** Motivo + responsable: sí (RawMaterialMovement.reason/createdBy + ActivityLog). Autorización: NO existe, ninguna merma
  requiere aprobación. Evidencia (foto): NO existe. Reporte de merma: NO existe — no hay endpoint ni pantalla; solo se puede filtrar el
  kardex por tipo desde el MCP get_inventory_movements (src/mcp/tools/inventory.ts:338). 🔴 Además, la pantalla que capturaba la merma con
  catálogo de motivos está construida pero MUERTA: avoqado-web-dashboard/src/pages/Inventory/components/WasteLogDialog.tsx no está montado
  en ninguna ruta (grep sin ningún consumidor). Hoy la merma se captura como un ajuste genérico con AdjustStockDialog.tsx.
- **Depende de:** Cablear WasteLogDialog (ya escrito) es horas. El reporte de merma y la autorización dependen del motor genérico de
  aprobaciones (mismo que R98).

### R73 — Reservar el producto en estatus merma en un almacén de cuarentena que no se refleje en existencias. Reporte de inventario mermado.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** DESARROLLO. 'La plataforma ya registra la merma y la descuenta del disponible; el almacén de cuarentena separado que
  no se refleja en existencias es desarrollo. Tiempo de entrega: 1 a 2 días.'
- **Qué existe hoy:** Existe MÁS de lo prometido en el motor y MENOS en la superficie: quarantineBatch() en
  src/services/dashboard/fifoBatch.service.ts:685 pone el lote en QUARANTINED, lo saca de FIFO y descuenta su remanente del disponible con
  movimiento SPOILAGE — exactamente la semántica pedida. 🔴 Pero NO tiene ruta, ni controlador, ni tool de MCP: nadie puede invocarla (grep
  'quarantineBatch' solo devuelve el servicio y sus tests). Además solo aplica a lotes de INSUMO; la mercancía de reventa no tiene lotes. Y
  no existe ningún concepto de 'almacén' o ubicación: no hay modelo Warehouse/Location en prisma/schema.prisma, el venue es la única
  dimensión de ubicación.
- **Depende de:** Para insumos: solo exponer la función (horas-días). Para tiendas: depende de que exista lote/caducidad en mercancía de
  reventa (R80/R250). El 'reporte de inventario mermado' depende del reporte de merma (R90).

### R80 + R250 — Lote y fecha de caducidad obligatorios por producto, con PEPS, para insumos Y para la mercancía de reventa de las 18 tiendas. Bloqueo de venta de producto caducado. Reporte de antigüedad de inventario y productos por vencer.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** DESARROLLO en ambos renglones. 'Para insumos... es nativo y opera hoy, con consumo PEPS por lote y un proceso diario
  que vence lotes y genera el movimiento de merma automáticamente. Para la MERCANCÍA DE REVENTA de las 18 tiendas extendemos el mismo
  control... con captura obligatoria configurable por producto en la recepción. Tiempo de entrega: 2 a 3 días.' R250 agrega: 'lote
  obligatorio por producto perecedero, reporte de antigüedad de inventario y de productos por vencer, y bloqueo de venta de producto
  caducado. Tiempo de entrega: 2 a 3 días.'
- **Qué existe hoy:** Lo prometido de insumos es REAL y verificable: StockBatch (schema:2272) con
  initialQuantity/remainingQuantity/costPerUnit/expirationDate, FIFO ordenado por receivedDate (fifoBatch.service.ts:155
  getActiveBatchesFIFO, :380 deductStockFIFO), y el cron diario src/jobs/batch-expiration.job.ts (02:17 CDMX) que llama markExpiredBatches y
  genera el SPOILAGE. En mercancía de reventa NO existe nada: StockBatch cuelga de rawMaterialId (obligatorio), Inventory (schema:1646) es
  un saldo simple sin lote, y el propio comentario del código lo dice ('sin generar lote'). 🔴 Dos matices que la respuesta no distingue:
  (a) la caducidad NUNCA se captura, se DERIVA de RawMaterial.shelfLifeDays (purchaseOrder.service.ts:1032-1035 y
  rawMaterial.service.ts:194) — no hay ningún campo de fecha de caducidad ni de número de lote en ningún schema Zod (grep en
  src/schemas/dashboard/ no devuelve expirationDate ni batchNumber); (b) el número de lote se autogenera ('BATCH-20231013-001'), no se
  teclea el del proveedor. Y no hay NINGUNA ruta HTTP que liste lotes: los lotes no son visibles desde el dashboard. Reporte de antigüedad:
  no existe. Bloqueo de venta de caducado: indirecto (el lote vencido sale del stock por el cron), no hay validación explícita.
- **Depende de:** Decisión de diseño: ¿ProductBatch paralelo o generalizar StockBatch a un target polimórfico? Es la misma bifurcación que
  ya se resolvió en PurchaseOrderItem (rawMaterialId XOR productId, migración 20260806024353) y conviene copiar esa forma. Riesgo MEDIO
  porque tocar la deducción de stock en la venta afecta a los ~70 puntos que ya operan; el camino de insumos debe quedar byte-idéntico.

### R81 — Alertas de productos próximos a caducar según parámetros configurables (15 y 30 días).

- **Brecha:** 🔴 De cero · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** Cumplimiento natural, con la salvedad de que 'las alertas... se configuran como reporte y notificación durante la
  implementación. Incluido en la suscripción propuesta.' Sin plazo.
- **Qué existe hoy:** El dato base sí está (StockBatch.expirationDate con índice). El AlertType EXPIRING_SOON existe en el enum
  (schema:8448) pero NADIE lo genera: grep 'EXPIRING_SOON' en todo src no devuelve un solo sitio que lo cree. El único job de alertas es
  src/jobs/nightly-low-stock.job.ts, que solo mira reorderPoint de RawMaterial. No hay reporte ni notificación de próximos a vencer.
- **Depende de:** Nada para insumos (el job nocturno ya es el molde). Para tiendas depende de R80/R250.

### R85 — Consulta de existencias por producto y punto de venta en tiempo real, con historial de movimientos.

- **Brecha:** 🟢 Ya está · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** Cumplimiento natural. 'Consulta de existencias en tiempo real por producto y punto de venta, con historial completo de
  movimientos.' Sin plazo.
- **Qué existe hoy:** Sí, verificado: getStockOverview (src/services/mobile/inventory.mobile.service.ts:32) con búsqueda por nombre/sku/gtin
  y disponible = currentStock - reservedStock; pantallas ProductStock.tsx y RawMaterials.tsx en el dashboard; tools MCP low_stock y
  stock_value. La consulta es por venue. ⚠️ Un matiz frente al comentario de la matriz ('por sucursal y almacén'): no existe el concepto de
  almacén.
- **Depende de:** Nada.

### R93 — Registrar y consultar el historial completo de entradas, salidas, transferencias, ajustes y mermas por producto (kardex), consultable y exportable.

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** Cumplimiento natural. 'Historial completo de entradas, salidas, traspasos, ajustes y mermas por producto, consultable
  y exportable.' Sin plazo.
- **Qué existe hoy:** El kardex es real y de los mejores pedazos del módulo: InventoryMovement + RawMaterialMovement con
  previousStock/newStock/reason/createdBy, unificados en getGlobalMovements (src/services/dashboard/productInventory.service.ts:185),
  pantalla avoqado-web-dashboard/src/pages/Inventory/InventoryHistory.tsx, y el tool MCP get_inventory_movements que además resuelve el
  nombre del staff y suma los ajustes manuales (anti-fraude). 🔴 'Exportable' NO se cumple: InventoryHistory.tsx no tiene botón de exportar
  y src/services/dashboard/export.helpers.ts solo lo consumen los controladores de ventas, pagos y órdenes — inventario no.
- **Depende de:** Nada — export.helpers ya existe, es cablearlo.

### R94 — Cálculo del valor económico del inventario por tienda, familia y línea de negocio, valuado por el método contable de la compañía (PEPS).

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Cumplimiento natural. 'Valorización económica del inventario por tienda, familia y línea de negocio, con costeo PEPS
  por lote.' Sin plazo.
- **Qué existe hoy:** Hay DOS medias valorizaciones y ninguna es PEPS por lote: (a) GET /reports/valuation → getInventoryValuation
  (src/services/dashboard/report.service.ts:427) valúa SOLO RawMaterial y usa currentStock × costPerUnit y × avgCostPerUnit — el costo
  ACTUAL y el promedio, NO la suma de los lotes vivos a su costo congelado; sí desglosa por categoría (≈familia). (b) El tool MCP
  stock_value (src/mcp/tools/inventory.ts:220) valúa SOLO Product/Inventory a product.cost. Ninguna suma los dos, ninguna consolida por
  organización, y 'línea de negocio' no existe como dimensión. Existe getVenueCostingMethod (fifoBatch.service.ts:827) que declara
  FIFO/WEIGHTED_AVERAGE/STANDARD_COST, pero el reporte de valorización no lo consulta.
- **Depende de:** Que exista lote en mercancía de reventa (R80) para que la valuación PEPS cubra las 18 tiendas; y definir qué es 'línea de
  negocio' (¿tipo de venue: tienda/restaurante/cafetería?).

### R95 — Capturar inventarios físicos y compararlos contra el inventario en sistema (conteos cíclicos). Reporte de diferencias.

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Cumplimiento natural. 'Captura de inventario físico y comparación contra el inventario en sistema, con reporte de
  diferencias.' Sin plazo.
- **Qué existe hoy:** Construido y bien: StockCount/StockCountItem (schema:2209/2230) con tipo CYCLE|FULL;
  createStockCount/updateStockCount/confirmStockCount (src/services/mobile/inventory.mobile.service.ts:234-527) cuentan productos E insumos,
  aplican la diferencia y dejan movimiento COUNT. Tiene dos defensas ganadas a golpes que conviene no romper: solo se aplican las líneas con
  countedAt (una línea no tocada no pone el stock en cero) y el delta de insumos se calcula contra el stock ACTUAL, no contra `expected`.
  Pantallas StockCounts/ en el dashboard (solo lectura: las rutas dashboard son GET, src/routes/dashboard/inventory.routes.ts:1372/1381) y
  tool MCP stock_counts. 🔴 La captura solo existe desde la app móvil, no desde el dashboard.
- **Depende de:** Nada para el motor. Si contraloría va a capturar desde el navegador, faltan las rutas POST/PUT del dashboard.

### R87 — Programa de conteos cíclicos por familia o ubicación. Reportes de exactitud de inventario (%) y cumplimiento a conteos (%).

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** Cumplimiento natural con salvedad: 'Conteos cíclicos con captura y comparación contra sistema son nativos. La
  programación automática por familia o ubicación se configura durante la implementación.' Sin plazo.
- **Qué existe hoy:** La captura sí (R95). La PROGRAMACIÓN no existe en absoluto: no hay modelo de calendario de conteos, no hay job
  (revisada la lista completa de src/jobs/), no hay selección por familia (createStockCount recibe una lista explícita de ids o 'todo') y
  'ubicación' no existe como concepto. Exactitud de inventario % y cumplimiento a conteos %: no se calculan en ningún lado.
- **Depende de:** Definir qué es 'familia' (MenuCategory para producto vs RawMaterialCategory para insumo — son catálogos distintos) y si
  'ubicación' obliga a introducir almacenes.

### R86 — Mover mercancía entre sucursales, con autorización y trazabilidad completa.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** Cumplimiento natural. 'Traspasos de mercancía entre sucursales con autorización, despacho, recepción y resolución de
  diferencias, con trazabilidad completa de cada etapa.' Sin plazo.
- **Qué existe hoy:** Es la pieza mejor construida del módulo — y solo sirve para INSUMOS. InterVenueTransfer (schema:2323) con máquina de
  estados REQUESTED→APPROVED→IN_TRANSIT→PARTIALLY_RECEIVED→COMPLETED/COMPLETED_WITH_VARIANCE, permisos separados por etapa
  (inventory-transfers:request/approve/dispatch/receive), asignación FIFO congelada al despachar con SELECT ... FOR UPDATE
  (src/services/dashboard/interVenueTransfer.service.ts:461), la caducidad del lote viaja al destino, recepciones idempotentes por
  idempotencyKey, y resolución de variaciones con motivo tipificado (NOT_DISPATCHED/DAMAGED/LOST_IN_TRANSIT/QUANTITY_ERROR/OTHER). Pantallas
  InterVenueTransfers/ en el dashboard y 7 tools de MCP. 🔴 InterVenueTransferItem solo referencia
  sourceRawMaterialId/destinationRawMaterialId (schema:2375): un refresco de tienda NO se puede traspasar. El modelo legacy
  InventoryTransfer (schema:11532) guarda los renglones en un `itemsJson` de texto y NO mueve existencias.
- **Depende de:** Extender el motor a Product/Inventory. Es más simple que insumos (sin FIFO), pero toca un servicio que ya mueve dinero e
  inventario en producción; y si se quiere lote en el traspaso de tienda, depende de R80. Gate actual: feature INVENTORY_TRACKING (PREMIUM)
  en ambos venues.

### R76 — Registrar la recepción de mercancía proveniente de traspasos entre tiendas, actualizando el inventario al autorizar la recepción. Reporte de entradas y salidas de traspasos.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Cumplimiento natural. 'Recepción de traspasos entre tiendas con actualización de inventario al autorizar la recepción,
  y reporte de entradas y salidas por traspaso.' Sin plazo.
- **Qué existe hoy:** Sí para insumos: receiveInterVenueTransfer crea InterVenueTransferReceipt + líneas y genera movimientos
  TRANSFER_IN/TRANSFER_OUT (enum schema:8409-8410) que quedan en el kardex. El 'reporte de entradas y salidas' no es un reporte formal: se
  obtiene filtrando el kardex por tipo. Para mercancía de reventa no aplica (ver R86).
- **Depende de:** R86 (extensión a producto). El reporte en sí son días sobre el kardex que ya existe.

### R88 — Ajustes positivos y negativos por diferencias operativas, con autorización de la estructura jerárquica; solo contraloría puede ajustar.

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** Cumplimiento natural con salvedad: 'Ajustes positivos y negativos con motivo, usuario y trazabilidad son nativos, y la
  restricción a contraloría se aplica por permiso. El flujo de autorización jerárquica en línea se configura en la implementación.' Sin
  plazo.
- **Qué existe hoy:** Ajustes ±: sí (adjustInventoryStock en productInventory.service.ts:32 y adjustRawMaterialStock), con motivo, actor y
  ActivityLog. Restricción por permiso: PARCIALMENTE — existe el permiso dedicado 'inventory:adjust' en src/lib/permissions.ts:162, pero la
  ruta del dashboard usa checkPermission('inventory:update') (src/routes/dashboard/inventory.routes.ts:128), o sea que cualquiera que pueda
  editar un insumo puede ajustar existencias. Solo la ruta móvil (src/routes/mobile.routes.ts:1827) usa 'inventory:adjust'. 'Se configura
  por permiso' es cierto solo si antes se cambia el gate de la ruta web. Autorización jerárquica: no existe.
- **Depende de:** Cambiar el gate a 'inventory:adjust' requiere grandfathering (los roles que hoy tienen inventory:update y ajustan
  perderían el acceso). Es el punto 5 de la bitácora docs/DEMO-PITS-2026-08-BITACORA.md, aún pendiente.

### R98 — Flujo de autorización para realizar los ajustes de inventario (solicitud, bandeja de contraloría, aplicación solo tras autorización).

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** DESARROLLO. 'Alcance: solicitud de ajuste, bandeja de contraloría y aplicación sólo tras la autorización. Tiempo de
  entrega: 1 a 2 días.'
- **Qué existe hoy:** No existe. No hay ningún modelo de solicitud/aprobación genérico en prisma/schema.prisma (grep
  'Approval'/'ApprovalRequest' sin resultados fuera de sale-verification y purchase orders). El ajuste se aplica al instante. Lo más cercano
  en la plataforma son dos aprobaciones de un solo propósito que sirven de molde: PurchaseOrder.approvedBy/rejectedBy y el flujo de
  sale-verification.
- **Depende de:** Es el 'motor genérico de flujos de autorización' del punto 6 de la bitácora, que PITS pide en 7 puntos distintos. Hacerlo
  genérico una vez cuesta más que 1-2 días pero paga los otros 6.

### R89 — Cálculo de días de cobertura por producto. Reporte de niveles de inventario por tienda.

- **Brecha:** 🔴 De cero · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** Cumplimiento natural. 'El cálculo de días de cobertura se entrega como indicador configurable a partir del consumo
  histórico y la existencia por sucursal. Incluido en la suscripción propuesta.' Sin plazo.
- **Qué existe hoy:** No existe. grep de 'coverageDays', 'diasDeCobertura', 'daysOfCoverage' en todo src: cero resultados. Lo que sí existe
  y es el insumo del cálculo: el consumo histórico está en RawMaterialMovement/InventoryMovement, y getReorderSuggestions
  (autoReorder.service.ts:173) ya calcula urgencia y cantidad sugerida — pero contra el punto de reorden, no contra días de consumo.
- **Depende de:** Nada. Es una consulta sobre datos que ya están.

### R91 — Configurar reportes e indicadores: nivel de servicio, exactitud de inventario y merma.

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** Cumplimiento natural. 'Reportes e indicadores configurables (nivel de servicio, exactitud de inventario y merma) a
  partir de la información del sistema. Incluido en la suscripción propuesta.' Sin plazo.
- **Qué existe hoy:** Ninguno de los tres indicadores existe: grep de 'exactitud', 'accuracy', 'fillRate', 'OTIF', 'serviceLevel' en src no
  devuelve nada del dominio. Lo que sí hay son otros reportes de inventario ya construidos: PMIX, rentabilidad, uso de ingredientes,
  variación de costo y valorización (src/routes/dashboard/inventory.routes.ts:997-1043). Del lado de proveedores hay onTimeDeliveryRate
  (supplier.service.ts:497), no fill rate.
- **Depende de:** Exactitud de inventario sale de StockCount (ya existe); merma sale del kardex (ya existe); nivel de servicio necesita
  definirse con PITS (¿fill rate de OC, o disponibilidad en anaquel?).

### R96 — Alertas por quiebres, sobrestock, caducidades y diferencias de inventario.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Cumplimiento natural con salvedad: 'Las alertas por quiebre de stock son nativas y corren automáticamente todas las
  noches, con umbral mínimo configurable por categoría. Sobrestock, caducidad próxima y diferencias de inventario se configuran como alertas
  adicionales durante la implementación.'
- **Qué existe hoy:** Quiebre: cierto y verificado — src/jobs/nightly-low-stock.job.ts (22:33 CDMX) manda un correo consolidado por venue +
  notificación in-app. ⚠️ Dos precisiones: solo cubre RawMaterial (no Product/Inventory) y el umbral es POR INSUMO
  (RawMaterial.reorderPoint), NO 'configurable por categoría' como dice la respuesta. Sobrestock: AlertType.OVER_STOCK existe en el enum
  pero nadie lo genera, y además Inventory.maximumStock (schema:1656) no se puede fijar desde ningún endpoint — solo
  RawMaterial.maximumStock se captura (src/schemas/dashboard/inventory.schema.ts:36). Caducidad próxima: no (ver R81). Diferencias de
  inventario: no.
- **Depende de:** Sobrestock depende de poder capturar máximos en mercancía de reventa (hoy imposible); caducidad depende de R80/R81.

### R99 + R212 — Clasificación ABC de productos por volumen de venta y rotación, con reclasificación dinámica por rotación y margen real.

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** DESARROLLO en ambos. R99: 'incluido en el módulo de IA de inventarios con reclasificación dinámica. Tiempo de entrega:
  1 a 2 semanas.' R212: 'Optimización ABC dinámica por rotación y margen real: desarrollo... 1 a 2 semanas.'
- **Qué existe hoy:** No existe nada: no hay campo abcClass ni modelo de clasificación en el schema (grep sin resultados). Los insumos del
  cálculo sí están completos: ventas por producto, movimientos con costo, y el reporte de rentabilidad (getProfitabilityReport) ya calcula
  margen.
- **Depende de:** Nada técnico. Definir la ventana de análisis y si la clase se persiste (campo) o se calcula al vuelo.

### R17 — Ventas de producto con inventario 0 (venta en negativo), con alerta que no sea limitante de venta.

- **Brecha:** 🔴 De cero · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** DESARROLLO. 'Hoy el sistema valida la existencia antes de cobrar y detiene la venta... Para PITS entregamos el modo
  venta permitida con existencia en cero, configurable por sucursal y por producto: la venta se completa, se registra el faltante y se
  dispara la alerta al responsable... Tiempo de entrega: 1 a 2 días.'
- **Qué existe hoy:** La confesión de la matriz es exacta: validateOrderInventoryAvailability (src/services/tpv/payment.tpv.service.ts:162)
  corre ANTES de capturar el pago y bloquea con 'Insufficient stock for product' tanto en método QUANTITY como en RECIPE (por porciones
  máximas). Además adjustInventoryStock (productInventory.service.ts:58) rechaza cualquier movimiento que deje el saldo negativo. El
  interruptor prometido NO existe: grep de 'allowNegative', 'allowOversell', 'ventaSinExistencia' en src y prisma: cero resultados.
- **Depende de:** Nada técnico, pero toca la ruta del cobro de los ~70 puntos vivos: el flag debe ser opt-in por venue y por producto, con
  el default en el comportamiento actual, o se rompe el control de inventario de quien hoy depende de él. Es el punto 4 de la bitácora.

### R18 — Alertas y proceso de ajuste de inventario por ventas en negativo.

- **Brecha:** 🔴 De cero · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** DESARROLLO. 'Alerta configurable al gerente de tienda y a contraloría cuando una venta se realiza con existencia en
  cero o negativa, y tarea de ajuste de inventario con autorización, ligada al modo del renglón anterior. Tiempo de entrega: 1 a 2 días.'
- **Qué existe hoy:** No existe (no puede existir: hoy esa venta no ocurre). La infraestructura de notificación sí está lista y probada: el
  patrón de correo + notificación in-app por rol de nightly-low-stock.job.ts es reutilizable tal cual.
- **Depende de:** R17 (el modo de venta con existencia en cero) y, para la parte de 'con autorización', R98 (motor de aprobaciones).

### R77 + R79 — Validar cantidades recibidas físicamente contra la OC, con alerta de faltantes y sobrantes; registrar faltantes, sobrantes y rechazos, toda diferencia documentada y autorizada. Reportes de faltantes, sobrantes y rechazos.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** Cumplimiento natural en los dos renglones. 'Validación de las cantidades recibidas contra la OC, con registro y alerta
  de faltantes y sobrantes' y 'Registro documentado de faltantes, sobrantes y rechazos durante la recepción, con resolución de variaciones
  autorizada y auditada.' Sin plazo.
- **Qué existe hoy:** FALTANTES y RECHAZOS: sí. PurchaseOrderItem lleva quantityOrdered vs quantityReceived y receiveStatus
  PENDING/RECEIVED/DAMAGED/NOT_PROCESSED (schema:8384), con ActivityLog en cada cambio (purchaseOrder.service.ts:1532). 🔴 SOBRANTES: NO se
  pueden registrar — recibir más de lo ordenado se RECHAZA con 400 en los tres caminos (purchaseOrder.service.ts:1506 y :1035, y
  src/services/mobile/purchase-order.mobile.service.ts:415). Es lo contrario de 'registro de sobrantes'. Alerta: no hay ninguna notificación
  por diferencia de recepción. Reportes de faltantes/sobrantes/rechazos: no existen como reporte. Ojo: donde SÍ existe resolución de
  variaciones autorizada y auditada es en los TRASLADOS entre sucursales (InterVenueTransferVarianceResolution), no en la recepción de
  proveedor — la respuesta de la matriz mezcla las dos cosas.
- **Depende de:** Permitir sobrantes cambia una guarda que hoy protege contra doble conteo — hay que hacerlo con tolerancia configurable y
  motivo obligatorio, no quitando la validación.

### R78 — Recepción parcial de una orden de compra manteniendo producto pendiente. Reportes de órdenes pendientes por recibir y fill rate.

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Cumplimiento natural. 'Recepción parcial con producto pendiente y seguimiento de órdenes por recibir.' Sin plazo.
- **Qué existe hoy:** Recepción parcial: sí, y bien resuelta. updatePurchaseOrderItemStatus/applyItemReceiveStatusInTx
  (purchaseOrder.service.ts:1405/1614) reciben por renglón, con estado PARTIAL en la orden y recálculo del estado padre. El delta se deriva
  del ESTADO REAL (lotes vivos en insumos; InventoryMovement.purchaseOrderItemId en mercancía, migración 20260806024353) precisamente porque
  derivarlo de quantityReceived producía doble conteo — está documentado en docs/DEMO-PITS-2026-08-BITACORA.md §3b. 'Órdenes pendientes por
  recibir' se puede listar por estado; fill rate NO se calcula.
- **Depende de:** Nada — el fill rate sale de quantityReceived/quantityOrdered que ya está.

### R82 — Adjuntar fotografías de productos dañados o incidencias en la recepción. Reporte de proveedores con mercancía dañada.

- **Brecha:** 🔴 De cero · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** DESARROLLO. 'Adjuntar fotografías de producto dañado o incidencias en la recepción: desarrollo, sobre el
  almacenamiento en nube existente. Tiempo de entrega: 1 a 2 días.'
- **Qué existe hoy:** No existe: PurchaseOrderItem no tiene ningún campo de adjuntos (solo `notes`), ni hay modelo de evidencia ligado a la
  recepción. Lo prometido como base sí es cierto: el almacenamiento en nube opera (buildStoragePath en src/services/storage.service.ts) y ya
  se usa para KYC y otros documentos.
- **Depende de:** Nada. Mismo patrón que la evidencia de devolución (R49), conviene hacerlos juntos con un modelo de adjuntos genérico.

### R83 + R84 + R97 — Escaneo de código de barras con handheld o lector para ejecutar el recibo, con actualización automática del inventario al confirmar la recepción.

- **Brecha:** 🟢 Ya está · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** Cumplimiento natural en los tres. 'Escaneo con lector de código de barras o handheld para ejecutar el recibo' y
  'Actualización automática del inventario al confirmar la recepción'. Sin plazo.
- **Qué existe hoy:** Sí. Product.gtin y RawMaterial.gtin existen (schema:1456 y :1725, este último con unique por venue); la app móvil
  recibe por escaneo mandando DELTAS y el backend los convierte al acumulado absoluto
  (src/services/mobile/purchase-order.mobile.service.ts:407-430); la respuesta expone sku, gtin e itemKind (PRODUCT|RAW_MATERIAL) para que
  el cliente case el escaneo con el renglón. El inventario se actualiza dentro de la misma transacción que el renglón.
- **Depende de:** Nada en el servidor. Falta validar en hardware con el lector que PITS use.

### R209/R210/R213/R214 — IA de inventarios multi-sucursal: redistribución sugerida entre sucursales (3-5 días), predicción de quiebres de stock (1-2 semanas), conteo cíclico inteligente priorizado por valor/rotación/riesgo (3-5 días) y detección de mermas anómalas (1-2 semanas).

- **Brecha:** 🔴 De cero · **Esfuerzo:** MES_O_MAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** DESARROLLO en los cuatro, con los plazos citados. Se afirmó además que 'la plataforma ya opera traspasos entre
  sucursales... el alcance es el motor de sugerencia' y 'desarrollo sobre el módulo de conteos ya existente' y 'la plataforma ya registra
  cada merma con motivo y responsable, que es el insumo del modelo'.
- **Qué existe hoy:** Ninguno de los cuatro modelos existe. Las tres afirmaciones de base son ciertas pero con un asterisco importante: los
  traspasos y los conteos existen (R86, R95) pero los traspasos NO cubren mercancía de reventa, y el 'motivo y responsable' de la merma es
  texto libre sin catálogo tipificado en el backend, lo que degrada la calidad del insumo para detectar anomalías. Sí existe
  getConsolidatedRawMaterialInventory (interVenueTransfer.service.ts:842), que da la vista multi-sucursal sobre la que se apoyaría la
  redistribución — y también es solo de insumos.
- **Depende de:** Volumen de historia suficiente por SKU/sucursal; que los traspasos cubran mercancía de reventa (R86) para que la
  redistribución sea accionable en las 18 tiendas; y tipificar el motivo de merma (R74/R90) para que el detector de anomalías tenga con qué
  clasificar.

## Módulo: pos

De los ~30 compromisos de POS, unos 15 ya estan construidos y verificados en codigo (offline-first, cobro integrado, arqueo, cancelaciones,
bitacora de operaciones, motor de descuentos con 2x1, cupones, reportes) — mas de lo que el founder probablemente recuerda; pero hay 5
huecos serios que se contestaron como NATURAL sin serlo (combos, monedero electronico, promociones que se disparen solas, RFC desde caja,
login/logout en bitacora) y los 7 renglones marcados como DESARROLLO con plazo de 1-2 dias son en realidad de semanas porque tocan la ruta
de dinero de ~70 puntos de venta vivos.

### Fila 10 y 36: ID unico por punto de venta; toda venta estampada con terminal, turno y cajero. Reportes de venta por turno, cajero, producto, familia y metodo de pago.

- **Brecha:** 🟢 Ya está · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL. 'Cada punto de venta se registra como terminal con ID unico... Toda venta queda estampada con terminal, turno
  y cajero.' + 'Reportes de venta por turno, cajero, producto, categoria/familia, metodo de pago, sucursal y formato.'
- **Qué existe hoy:** Existe. `model Terminal` (prisma/schema.prisma:3767) con serialNumber unico; `model Order` (:2795) trae terminalId
  (:2806), shiftId y createdBy; `model Payment` (:3269) trae terminalId (:3288), shiftId y processedById. Reportes:
  src/services/dashboard/sales-summary.dashboard.service.ts (getSalesSummary con byPaymentMethod y byPaymentMethodDetailed),
  sales-by-item.dashboard.service.ts, src/services/tpv/shift.tpv.service.ts (getShiftsSummary), y las pantallas src/pages/Reports/\* del
  dashboard.
- **Depende de:** Nada. Solo validar en la demo que los filtros por turno y cajero se vean con nombre de PITS.

### Fila 11: registro de ventas por escaneo de codigo de barras o busqueda de producto.

- **Brecha:** 🟢 Ya está · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL. 'Registro de venta por escaneo de codigo de barras (campo GTIN por producto) o busqueda por nombre, SKU o
  categoria.'
- **Qué existe hoy:** Existe y esta en las tres apps. `Product.gtin` (prisma/schema.prisma:1456) y `Product.sku`. Android:
  avoqado-android/.../tables/presentation/TableOrderScreen.kt:678 matchea
  `product.sku == barcode || product.barcode == barcode || product.gtin == barcode` contra el catalogo YA cacheado (por eso tambien funciona
  sin red). iOS: avoqado-ios/Tables/TableOrderView.swift:534 BarcodeScannerView + productsRepo.findByBarcode.
- **Depende de:** Nada. Solo cargar los GTIN reales de PITS en el catalogo (trabajo de implementacion, no de codigo).

### Filas 12 y 252: recargas de tiempo aire y servicios de valor agregado (pago de servicios, impuestos, tenencias), con registro de fallos y reporte de recaudacion por tipo de servicio.

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** DESARROLLO. 'De nuestro lado: 3 a 5 dias. La fecha final depende de los tiempos del tercero (agregador o banco) que
  PITS defina.'
- **Qué existe hoy:** NO EXISTE NADA. Grep de 'recarga|airtime|topup|tiempo aire|pago de servicios' en todo src/ y prisma/schema.prisma solo
  devuelve la lista de sinonimos del chatbot en src/config/chatbot/industries/telecom.config.ts:124 — texto, no funcionalidad. No hay
  modelo, ni servicio, ni adaptador de agregador, ni registro de fallos, ni reporte de recaudacion por tipo de servicio.
- **Depende de:** Que PITS defina el agregador y entregue credenciales/sandbox y contrato de API. Hay que construir: modelo de
  servicio+transaccion, adaptador, maquina de reintentos/fallos (una recarga fallida cobrada es dinero real), y el reporte. Los '3 a 5 dias'
  asumen una API trivial; sin ver el contrato del tercero ese numero no es defendible.

### Fila 13: validar monto recibido, calcular el cambio y notificar diferencia por cobro insuficiente o excedente.

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** NATURAL. 'Captura del efectivo recibido, calculo automatico del cambio y aviso de diferencia por cobro insuficiente o
  excedente.'
- **Qué existe hoy:** Existe en el cliente, en las dos apps. Android: avoqado-android/.../payment/data/CashPaymentRepository.kt:22
  `val changeCents = cashReceivedCents - totalCents`, pintado en CashPaymentScreen.kt:109 y PaymentMethodSelectionScreen.kt:474. iOS:
  avoqado-ios/Payment/PaymentFlowViewModel.kt(.swift):324 proceedToCashFlow valida `tenderedAmount < totalDue`. MATIZ: el efectivo recibido
  y el cambio NO se persisten — `model Payment` no tiene campo de tendered/change y el grep de 'cashTendered|tendered' en el server solo
  aparece en un comentario de mobile.routes.ts:666. Se calcula y se avisa, pero no queda auditable.
- **Depende de:** Nada para cumplir lo prometido. Si PITS pide el dato en el arqueo (diferencias de cajero), hay que agregar 2 campos a
  Payment y mandarlos desde los 3 clientes.

### Fila 14 y 31: calculo automatico de descuentos, impuestos y total. Descuentos por porcentaje o importe fijo, con tope maximo y permiso por rol.

- **Brecha:** 🟢 Ya está · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL. 'Calculo automatico de descuentos, impuestos y total, con motor de descuentos por producto, categoria,
  cliente y vigencia' + 'con tope maximo configurable y permiso por rol para aplicarlos'.
- **Qué existe hoy:** Existe. `model Discount` (prisma/schema.prisma:6177) con type PERCENTAGE/FIXED_AMOUNT/COMP, scope
  ORDER/ITEM/CATEGORY/MODIFIER/CUSTOMER_GROUP/QUANTITY, maxDiscountAmount, minPurchaseAmount, applyBeforeTax, modifyTaxBasis, isStackable.
  Motor: src/services/dashboard/discountEngine.service.ts. Ruta TPV con permiso: src/routes/tpv.routes.ts:4460
  `checkPermission('discounts:apply')`. Impuestos por producto: `Product.taxRate` (:1472).
- **Depende de:** Nada.

### Fila 15: aceptar multiples formas de pago en una misma transaccion (efectivo, tarjeta, vales, Cashi).

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** MODULO COMPLEMENTARIO. 'Pago mixto nativo en una misma transaccion... La interfaz especifica con Cashi se entrega como
  conector adicional. Disponible hoy: se activa y configura en 1 a 3 dias.'
- **Qué existe hoy:** El pago mixto SI existe: `Payment` es 1-N contra `Order` con `splitType` (enum SplitType
  FULLPAYMENT/PERPRODUCT/EQUALPARTS/CUSTOMAMOUNT, prisma/schema.prisma:7541) y la validacion de inventario del pago se salta explicitamente
  en pagos parciales (src/services/tpv/payment.tpv.service.ts:397 'PRE-FLIGHT SKIPPED: Partial payment'). UI en
  avoqado-android/.../payment/presentation/SplitPaymentSheet.kt. Cashi: NO EXISTE nada — cero referencias en el codigo.
- **Depende de:** El pago mixto no depende de nada. El conector Cashi depende 100% de que Cashi entregue API/credenciales; no hay ni un
  adaptador iniciado, asi que '1 a 3 dias' solo aplica a la configuracion del pago mixto, no a Cashi.

### Fila 16 y 19: descuento automatico del inventario de lo vendido (incluye consumo de materia prima por receta) y consulta de existencias en tiempo real.

- **Brecha:** 🟢 Ya está · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL en ambos. 'Descuento automatico de inventario al completar el pago, incluyendo el consumo de materia prima por
  receta' + 'Consulta de existencias en tiempo real por producto, sucursal y almacen, desde el POS y desde el dashboard.'
- **Qué existe hoy:** Existe y es robusto. src/services/tpv/payment.tpv.service.ts:665 en adelante deduce stock al completar el pago, con
  FIFO (src/services/dashboard/fifoBatch.service.ts) y compensacion/restock si una deduccion falla a medias (:851-872). Recetas:
  `model Recipe`/`RecipeLine` (RecipeLine.rawMaterialId). Modelos: `Inventory` (:1646), `InventoryMovement` (:1673), `StockBatch` (:2272),
  `RawMaterialMovement`.
- **Depende de:** Nada.

### Filas 17 y 18: permitir venta con existencia 0 o negativa (alerta que NO sea limitante de venta), con alerta al responsable y proceso de ajuste de inventario con autorizacion.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** ALTO
- **Qué prometimos:** DESARROLLO en ambas. 'Es un cambio acotado sobre la validacion previa al cobro. Tiempo de entrega: 1 a 2 dias' + la
  alerta y la tarea de ajuste, 'otro 1 a 2 dias'.
- **Qué existe hoy:** La descripcion de la matriz es CORRECTA: hoy se bloquea. src/services/tpv/payment.tpv.service.ts:374-390 hace el
  PRE-FLIGHT y lanza BadRequestError 'Cannot complete order - insufficient inventory'. Y aguas abajo tambien truena:
  fifoBatch.service.ts:327 y 415, productInventoryIntegration.service.ts:185, rawMaterial.service.ts:563 todos lanzan 'Insufficient stock'.
  NO existe ningun flag `allowNegative`/`allowOversell` en el schema ni en el codigo (grep vacio). Lo que SI existe como base:
  `LowStockAlert` (:2177) y `StockAlertConfig` (:9715). HALLAZGO IMPORTANTE: la ruta de efectivo del POS movil
  (src/services/mobile/order.mobile.service.ts:1997-2021) ya NO pre-valida — deduce despues del pago y de forma no bloqueante, o sea que el
  POS Android/iOS ya sobrevende hoy sin querer. El bloqueo real vive en la ruta /tpv.
- **Depende de:** Decision de producto: donde vive el switch (Venue y Producto) y quien recibe la alerta. Es un cambio en la ruta de dinero
  que corre en ~70 puntos de venta, y hay que tocar 4 puntos que lanzan 'Insufficient stock' mas el comportamiento de FIFO con stock
  negativo (hoy ni siquiera esta definido que hace un lote negativo). Los '1 a 2 dias' subestiman: son 2 dias de codigo y el resto de
  pruebas para no romper la deduccion de nadie.

### Filas 20 y 21: ticket impreso y/o electronico con CFDI opcional, y terminal bancaria integrada al mismo flujo de venta.

- **Brecha:** 🟢 Ya está · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL en ambos. 'Ticket impreso (impresoras de red o Bluetooth) y ticket electronico por correo o enlace; CFDI
  opcional desde el mismo ticket' + 'la aplicacion corre en la propia terminal PAX y el cobro con tarjeta es parte del mismo flujo de venta,
  sin doble captura'.
- **Qué existe hoy:** Existe. `model DigitalReceipt` (:3442) + src/services/tpv/digitalReceipt.tpv.service.ts. Autofactura del cliente desde
  el ticket: src/routes/public.routes.ts:103 `POST /receipt/:accessKey/cfdi` con rate limit, apoyado en `FiscalEmisor` (:12724) y
  `model Cfdi` (receptorRfc/receptorNombre/receptorRegimen/receptorCp). Impresion: src/services/printing/printRouting.engine.ts +
  `PrintStation` (:11899) + `Printer`/`PrintJob`. Cobro en la propia PAX: repo avoqado-tpv (SDK Blumon) y
  src/services/tpv/blumon-tpv.service.ts / angelpay-webhook.service.ts.
- **Depende de:** Para CFDI: que PITS entregue CSD y regimen por razon social (configuracion, no desarrollo).

### Filas 22, 29 y 37: precios y catalogo se administran central y bajan automaticamente a cada POS; promociones vigentes se sincronizan; las ventas suben en tiempo real y actualizan inventario y contabilidad sin batch nocturno.

- **Brecha:** 🟢 Ya está · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL en las tres. 'sincronizacion en tiempo real' y 'Las ventas se sincronizan en tiempo real por websocket... sin
  proceso batch nocturno.'
- **Qué existe hoy:** Existe. Socket.IO: src/communication/sockets/types/index.ts:138 `MENU_UPDATED = 'menu_updated'`, emitido en
  broadcasting.service.ts:736-741 y disparado desde src/services/dashboard/product.dashboard.service.ts:684, 875, 942, 1198 en cada cambio
  de producto/precio. Las ventas entran por la API en el momento del cobro (no hay job nocturno de ventas) y la contabilidad se postea con
  src/services/fiscal/autoPosting.service.ts.
- **Depende de:** Nada.

### Fila 23: registrar clientes para facturacion o programas de lealtad.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** NATURAL. 'Alta de cliente desde caja con RFC y datos fiscales para facturacion, y alta simultanea en el programa de
  lealtad.'
- **Qué existe hoy:** MEDIA VERDAD. El alta de cliente desde caja SI existe: src/services/tpv/customer.tpv.service.ts:268
  `quickCreateCustomer` + busqueda por telefono/email, y la lealtad se engancha por `Customer` -> `LoyaltyTransaction`. Pero el RFC NO:
  `model Customer` no tiene campo rfc/taxId (revisado campo por campo). Existe `model CustomerTaxProfile` (:12869, con rfc, razonSocial,
  regimenFiscal, codigoPostal, ligado a Customer) — pero es un MODELO MUERTO: grep de 'CustomerTaxProfile|customerTaxProfile' en todo src/
  devuelve CERO usos. Hoy el RFC solo lo captura el CLIENTE FINAL en la pagina del ticket (autofactura), nunca el cajero.
- **Depende de:** Nada externo, pero son 4 capas: endpoints CRUD de CustomerTaxProfile, engancharlo al flujo de CFDI (hoy solo recibe el RFC
  por autofactura), y UI de captura en TPV + Android + iOS. Android e iOS se cambian juntos por regla del workspace.

### Filas 24, 116 y 117: arqueo de caja con efectivo esperado vs contado y deteccion de diferencias; cierre de caja por turno con apertura, movimientos, retiros y depositos; corte desglosado por metodo de pago y por transaccion con conciliacion contra el procesador.

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** NATURAL en las tres.
- **Qué existe hoy:** Existe, por dos caminos. Arqueo con diferencia calculada: `CashDrawerSession` (:11475) con startingAmount /
  actualAmount / overShort y `CashDrawerEvent` (:11499, tipos OPEN/PAY_IN/PAY_OUT/CASH_SALE/CLOSE); el over/short se calcula en
  src/services/mobile/cash-drawer.mobile.service.ts:235. Turno: `model Shift` (:2609) con startingCash,
  cashDeclared/cardDeclared/vouchersDeclared/otherDeclared y los totales calculados automaticamente
  (totalCashPayments/totalCardPayments/...); el cierre arma un reportData completo en src/services/tpv/shift.tpv.service.ts:1316-1360.
  Conciliacion contra procesador: `VenueTransaction`, `ProviderEventLog`, `MoneyAnomaly`. MATIZ: `Shift.cashDifference` NO se escribe al
  cerrar turno desde TPV (shift.tpv.service.ts:1400-1425 guarda declarado y calculado pero deja el campo nulo); solo el path de dashboard lo
  llena (shift.dashboard.service.ts:791). El dato es derivable, pero el campo esta vacio.
- **Depende de:** Nada. Llenar `cashDifference` al cerrar turno son minutos; vale la pena antes de la demo porque un reporte de diferencias
  con la columna vacia se ve peor de lo que esta.

### Filas 25 y 26: cancelacion de linea o de la venta completa antes del cobro con motivo y bitacora; y cancelacion/devolucion posterior al cobro conforme a niveles de autorizacion, auditada con usuario, motivo y fecha.

- **Brecha:** 🟢 Ya está · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL en ambas. 'Cancelacion de linea o de la venta completa antes del cobro, con motivo y registro en bitacora' +
  'Devolucion y cancelacion posterior al cobro sujetas a permiso especifico por rol; toda operacion queda auditada.'
- **Qué existe hoy:** Existe, con doble auditoria. Antes del cobro: src/services/tpv/order.tpv.service.ts:2488 `voidItems` (exige reason)
  escribe `OrderAction` actionType VOID (:2652) Y hace logAction 'ITEM_VOIDED' (:2668) — dual-write correcto; y `cancelOrder` en
  src/services/mobile/order.mobile.service.ts:2279. Despues del cobro: src/services/tpv/refund.tpv.service.ts crea un Payment type=REFUND,
  restockea inventario (restockOrderItems), y hace logAction 'REFUND_CREATED' (:402); la ruta esta gateada con
  `checkPermission('payments:refund')` (src/routes/tpv.routes.ts:3421) y el permiso solo lo traen roles altos en src/lib/permissions.ts:117.
- **Depende de:** Nada.

### Filas 27 y 41: flujo de solicitud y autorizacion por un SEGUNDO usuario para devoluciones (bandeja de aprobacion con umbral configurable y notificacion al autorizante), y matriz de limites POR MONTO por rol y operacion (descuento, cancelacion, devolucion) con aprobacion en linea.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** ALTO
- **Qué prometimos:** DESARROLLO en ambas, con 'Tiempo de entrega: 1 a 2 dias' cada una.
- **Qué existe hoy:** Hay media pieza. Existe el concepto de autorizante: `OrderDiscount.authorizedById` (prisma/schema.prisma:6599) y el
  motor exige un autorizante cuando el descuento lo pide (src/services/dashboard/discountEngine.service.ts:702
  `if (discount.requiresApproval && !authorizedById)`), y el TPV ya lo manda (src/schemas/tpv.schema.ts:590-628, obliga authorizedById si
  type=COMP). O sea: el patron 'que el gerente meta su PIN' YA funciona para cortesias. Lo que NO existe: (a) ningun UMBRAL POR MONTO en
  ninguna parte — el unico tope es `Discount.maxDiscountAmount`, que es un tope del descuento, no un limite por rol; (b) ninguna bandeja de
  aprobacion ni notificacion al autorizante (grep de 'model *Approval|*AuthorizationRequest' no devuelve nada aplicable); (c) devoluciones y
  cancelaciones no tienen segundo usuario en absoluto, solo permiso de rol. HALLAZGO REUTILIZABLE: `SaleVerification` (:3475) YA es
  exactamente una bandeja de aprobacion de back-office con estado PENDING/COMPLETED/FAILED, reviewedById, reviewedAt, reviewNotes y motivos
  de rechazo tipificados — es el molde para construir esto sin inventar la arquitectura.
- **Depende de:** Que PITS defina la matriz real (que rol autoriza que operacion arriba de que monto). El riesgo alto no es tecnico sino
  operativo: un umbral mal configurado deja a un cajero sin poder cancelar a media hora pico en un parador de carretera. Toca server + 3
  apps cliente (pantalla de PIN del autorizante) + bandeja en el dashboard. Los '1 a 2 dias' cubren el modelo de datos, no el flujo
  completo.

### Filas 28 y 35: trazabilidad del acceso de cada usuario (inicio de sesion, actividad, cierre de sesion) y bitacora completa de operaciones por usuario, exportable y filtrable.

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL en ambas. 'Bitacora de acceso y actividad por usuario: inicio y cierre de sesion, y registro auditable de cada
  operacion sensible (cancelacion, cortesia, descuento, devolucion, cambio de precio).'
- **Qué existe hoy:** La bitacora de OPERACIONES si existe y es fuerte: `model ActivityLog` (:5725) con action, entity, entityId, staffId,
  venueId, data, ipAddress, userAgent e indices por staff/venue/fecha; se escribe en cancelaciones (ITEM_VOIDED), devoluciones
  (REFUND_CREATED), descuentos (ORDER_DISCOUNT_APPLIED, order.mobile.service.ts:2320), cambios de producto (PRODUCT_UPDATED,
  product.dashboard.service.ts:889) y decenas mas. Pero el INICIO Y CIERRE DE SESION NO SE REGISTRAN:
  src/services/tpv/auth.tpv.service.ts:20 `staffSignIn` y :318 `staffLogout` NO llaman logAction — el unico login auditado es el de
  emergencia (`MASTER_LOGIN_SUCCESS`/`MASTER_LOGIN_FAILED`, :448 y :523, mas auth.service.ts:120). Grep de LOGIN en todo src/ devuelve solo
  esas dos. El login del dashboard tampoco se audita.
- **Depende de:** Nada. Es agregar logAction en staffSignIn / staffLogout / login de dashboard + un filtro por accion en la pantalla de
  bitacora. Barato y cierra un renglon que hoy se contesto como NATURAL sin serlo — es de lo primero que un auditor de PITS va a pedir ver.

### Filas 30 y 32: promociones por vigencia (fechas, dias de la semana y horario), alcance por sucursal, producto, categoria y grupo de clientes; y promociones tipo compra N / lleva M (2x1, 3x2 y variantes).

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** NATURAL en ambas.
- **Qué existe hoy:** El MOTOR existe completo y el 2x1 esta realmente implementado: `Discount` (:6177) trae validFrom/validUntil,
  daysOfWeek[], timeFrom/timeUntil, targetItemIds/targetCategoryIds, customerGroupId,
  buyQuantity/getQuantity/getDiscountPercent/buyItemIds/getItemIds y scope QUANTITY; `calculateBOGO` en
  src/services/dashboard/discountEngine.service.ts:466; y la UI de alta ya existe
  (avoqado-web-dashboard/src/pages/Promotions/components/wizard-steps/WizardStep2Scope.tsx:258-314 configura buy/get). El alcance por
  sucursal es natural porque Discount cuelga de venueId. PERO NO SE DISPARA SOLO Y NO LLEGA AL POS MOVIL: (a) `applyAutomaticDiscounts`
  existe (discountEngine.service.ts:877, expuesto en src/routes/tpv.routes.ts:4826) pero NINGUN cliente lo llama — grep de 'discounts/auto'
  en avoqado-android, avoqado-ios y avoqado-tpv: cero resultados; (b) peor, la ruta que si usan Android/iOS rechaza el 2x1 explicitamente:
  src/services/mobile/order.mobile.service.ts `applyOrderDiscount` corta con 'Solo descuentos de orden aplican a la cuenta completa' si
  `discount.scope !== 'ORDER'`. O sea: hoy el 2x1 se configura, se calcula en el motor, y en el POS movil no se puede aplicar; en el TPV el
  cajero tendria que elegirlo a mano de una lista.
- **Depende de:** Nada externo. Hay que: llamar al motor automatico cada vez que cambia el carrito, levantar la restriccion de scope en
  /mobile, y decidir la UX de 'esta promocion se aplico sola' (si el cajero no la ve, cuadra mal el ticket). Riesgo MEDIO porque a partir de
  ese cambio los descuentos empiezan a moverse solos en cuentas de venues vivos que hoy no los tienen.

### Filas 33 y 34: promociones de combo (cafe + galletas por $X) y combos incrementales (producto X + importe adicional = X+Y).

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** NATURAL en ambas. 'Combos por conjunto de productos a precio especial... configurables por sucursal y vigencia' +
  'Combos incrementales mediante reglas de compra condicionada.'
- **Qué existe hoy:** NO EXISTE. No hay modelo de combo ni de bundle: `enum ProductType` (:7055) va
  REGULAR/FOOD_AND_BEV/APPOINTMENTS_SERVICE/CLASS/EVENT/DIGITAL/DONATION — ningun COMBO; grep de 'combo|bundle' en src/services no devuelve
  nada del dominio. El motor de descuentos NO tiene el caso 'conjunto de productos a precio fijo': tiene BOGO (mismo producto o lista get) y
  descuentos por monto/porcentaje, no precio de paquete. El workaround obvio (crear un producto 'Combo cafe+galleta') NO sirve para PITS:
  las recetas apuntan a `RecipeLine.rawMaterialId` (materia prima), no a otros productos, asi que la galleta — que en tienda de conveniencia
  es un producto con inventario por cantidad — NO se descontaria del inventario.
- **Depende de:** Decision de producto sobre el modelo (combo como producto compuesto vs como regla de precio). Es lo mas subestimado del
  modulo: toca modelo, motor de precios, deduccion de inventario de N productos por una linea, impresion del ticket y la UI de los 3 POS.
  Este renglon se contesto como NATURAL y no lo es — 18 tiendas de conveniencia y 5 cafeterias es exactamente donde se usa.

### Filas 38, 39 y 40: programa de puntos configurable con reglas diferenciadas por grupo de clientes; monedero electronico con saldo prepagado canjeable en cualquier formato del grupo; cupones con codigo unico, vigencia y topes de uso.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** NATURAL en las tres. El monedero: 'disponible mediante el modulo de paquetes de credito: saldo prepagado por cliente,
  canjeable en cualquier formato del grupo. Incluido en la suscripcion.'
- **Qué existe hoy:** Puntos y cupones SI. `LoyaltyConfig` (:5935) con pointsPerDollar, pointsPerVisit, redemptionRate, minPointsRedeem,
  pointsExpireDays; `LoyaltyTransaction` (:5958) con EARN/REDEEM/EXPIRE/ADJUST ligado a OrderDiscount para que quitar el descuento devuelva
  los puntos. Cupones completos: `CouponCode` (:6474, codigo unico, maxUses, maxUsesPerCustomer, validFrom/Until) + `CouponRedemption`
  (:6505) + UI en src/pages/Promotions/Coupons.tsx. Faltan dos cosas: (a) LoyaltyConfig es `@unique venueId` — NO hay reglas de puntos por
  grupo de clientes (lo diferenciable por grupo son los descuentos, via `Discount.customerGroupId`); (b) el MONEDERO NO ES UN MONEDERO:
  `CreditPack`/`CreditPackItem`/`CreditItemBalance` (:11181-11265) guardan `remainingQuantity` de CREDITOS POR PRODUCTO (10 clases de yoga),
  no un saldo en pesos; `Customer` no tiene ningun campo de balance; y todo cuelga de venueId, no de la organizacion, asi que 'canjeable en
  cualquier formato del grupo' es falso hoy.
- **Depende de:** Decision de producto: el monedero es dinero prepagado (pasivo contable, se refleja en contabilidad y en el corte) y ademas
  cross-venue, lo cual choca con que hoy `Customer` es por venue. Construirlo bien es modelo de saldo + metodo de pago nuevo en los 3 POS +
  asiento contable + reporte de saldos. Puntos y cupones no dependen de nada, ya estan.

### Fila 42: venta con falla temporal de comunicacion, sincronizando al restablecer la conexion (modo offline).

- **Brecha:** 🟢 Ya está · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL, y es la respuesta mas larga y mas comprometida de la matriz: 'Arquitectura offline-first verificada en
  hardware... abrir cuenta, agregar productos, aplicar descuentos y cargos, cortesias, mover, cancelar, separar y fusionar cuentas, cobrar
  en efectivo e imprimir comandas a cocina... con control de idempotencia que impide duplicar cobros.'
- **Qué existe hoy:** Existe y es real, verificable linea por linea. `SyncIntentType` en src/services/mobile/sync.mobile.service.ts:40
  declara los 14 intents (OPEN_TABLE, ADD_ITEMS, PAY_CASH, APPLY_DISCOUNT, APPLY_SERVICE_CHARGE, COMP_ORDER, UPDATE_DETAILS, CANCEL_ORDER,
  MOVE_ORDER, ASSIGN_ORDER, CLEAR_TABLE, SPLIT_ORDER, SPLIT_BY_SEAT, MERGE_ORDERS). El reducer reusa los MISMOS servicios que la ruta
  online. Idempotencia de dinero: applyPayCash (:651) pasa `idempotencyKey: intent.id` y `Payment` tiene indice unico compuesto por
  [venueId, idempotencyKey] (:3400+). Tres estados de ack ACKED/REJECTED/RETRY con RETRYABLE_ERROR_CODES (:88) para que un error transitorio
  nunca se pierda. Hub LAN entre cajas y impresion offline documentados en .claude/rules/offline-first-y-hub-lan.md. El matiz de tarjeta que
  pusimos en la respuesta es honesto y correcto.
- **Depende de:** Nada. Unico pendiente honesto documentado: el KDS offline no existe, y eso ya se acoto en la respuesta. Advertencia para
  la demo: la impresion offline exige que el POS se haya conectado a internet UNA vez para bajar la config de impresoras.

### Fila 49: cargar evidencia fotografica de la devolucion del producto.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** DESARROLLO. 'Adjuntar imagenes desde la app del POS al registro de devolucion, sobre el almacenamiento en nube ya
  existente. Tiempo de entrega: 1 a 2 dias.'
- **Qué existe hoy:** No existe en devoluciones — el refund (src/services/tpv/refund.tpv.service.ts) no tiene ningun campo de fotos. PERO el
  patron completo YA ESTA CONSTRUIDO Y EN PRODUCCION en otro flujo: `SaleVerification` (:3475) tiene `photos String[]` con rutas de Firebase
  Storage ('venues/{venueId}/verificaciones/{paymentId}/\*.jpg'), captura desde el TPV via POST /tpv/venues/:venueId/verificaciones
  (src/routes/tpv.routes.ts:5173), subida con `uploadFileToStorage` + `buildStoragePath` (src/services/storage.service.ts:134), y hasta
  revision de back-office con motivos de rechazo. Copiar ese patron al refund es realista.
- **Depende de:** Nada externo. Server es poco trabajo (campo photos en el refund + endpoint de subida reusando storage.service). Lo que
  estira el plazo es la UI de camara en los clientes: TPV (PAX) y, por la regla del workspace, Android e iOS en el MISMO cambio. Los '1 a 2
  dias' aplican al backend, no al recorrido completo.

### Fila 69: visualizar/filtrar los SKU con cambio de precio para los usuarios de tienda.

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** DESARROLLO. 'Pantalla y reporte de cambios de precio vigentes por sucursal. Tiempo de entrega: 1 a 2 dias.'
- **Qué existe hoy:** NO EXISTE, y falta el insumo. No hay ningun modelo de historial de precios (grep de
  'PriceHistory|ProductPriceHistory|priceChangedAt' en el schema: cero). Peor: la auditoria actual NO guarda el precio anterior —
  src/services/dashboard/product.dashboard.service.ts:889 escribe
  `logAction({ action: 'PRODUCT_UPDATED', data: { changes: Object.keys(productData) } })`, o sea solo los NOMBRES de los campos que
  cambiaron, sin valor viejo ni nuevo. Reconstruir 'que SKU cambiaron de precio esta semana' con lo que hay hoy es imposible.
- **Depende de:** Nada externo, pero hay que empezar por capturar el dato (modelo de historial de precio o enriquecer el ActivityLog con
  antes/despues) y solo despues hacer la pantalla. Advertencia: hasta que eso corra en produccion, la vista arranca vacia — no hay historia
  retroactiva que mostrar.

### Fila 87: programa de conteos ciclicos por familia o ubicacion, con reportes de exactitud de inventario (%) y cumplimiento a conteos (%).

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** NATURAL. 'Conteos ciclicos con captura y comparacion contra sistema son nativos. La programacion automatica por
  familia o ubicacion se configura durante la implementacion.'
- **Qué existe hoy:** El conteo si existe: `StockCount` (:2209) con `StockCountType` CYCLE/FULL y `StockCountItem` (:2230) con expected vs
  counted y `countedAt` (una linea no tocada nunca pone el stock en cero — bien resuelto). Cubre productos por cantidad y materias primas.
  Lo que no existe: PROGRAMACION automatica (no hay calendario ni recurrencia por familia/ubicacion) ni los dos indicadores prometidos en la
  columna Reportes — exactitud de inventario % y cumplimiento a conteos % no estan calculados en ningun lado.
- **Depende de:** Nada. Los dos KPI salen directo de StockCountItem (expected vs counted) y de conteos programados vs ejecutados. Ojo: la
  respuesta dice que la programacion 'se configura durante la implementacion', lo cual suena a parametrizacion y en realidad es codigo —
  vale corregir la expectativa antes de firmar.

### Fila 251: gestion de pedidos y produccion en cocina/barra (KDS), ruteando por tipo de producto a impresoras o pantallas segun estacion, en tiempo real y bidireccional; mas reporte de tiempos de preparacion y productividad por estacion.

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** NATURAL, con el reporte prometido a 2 DIAS: 'El reporte de tiempos de preparacion y productividad por estacion se
  entrega como parte del proyecto, con marca de tiempo por evento de la comanda.'
- **Qué existe hoy:** La mitad de impresion es solida y verificada en hardware: `PrintStation` (:11899) + ruteo en cascada producto ->
  categoria -> default (src/services/printing/printRouting.engine.ts, printStation.dashboard.service.ts:367), `PrintJob`, y comandas
  imprimiendo sin internet. La mitad de PANTALLA es debil: `KdsOrder` (:11798) NO tiene estacion — ningun campo printStationId ni
  fulfillmentAreaId — asi que el ruteo por estacion hacia PANTALLA no existe; ademas la orden de KDS no se crea sola desde la venta, la
  tiene que crear el cliente llamando POST /mobile/venues/:venueId/kds/orders (mobile.routes.ts:2485). Para el REPORTE: los timestamps base
  existen (KdsOrder.createdAt/startedAt/completedAt, y `OrderItem.sentToKitchenAt`), pero `OrderItem.preparedAt` (:3079) NUNCA SE ESCRIBE —
  grep de 'preparedAt' en src/: cero. Y no hay ningun reporte de tiempos ni endpoint que lo calcule.
- **Depende de:** Decision: si PITS quiere pantallas (8 restaurantes + 5 cafeterias) hay que agregar estacion a KdsOrder y crearla
  automaticamente desde la venta; hoy solo se sostiene con impresoras. El reporte de 2 dias es realista SOLO si se acepta medirlo con los
  timestamps de KdsOrder; si se quiere por estacion, primero hay que construir la estacion.

### Filas 215 y 219 (IA POS): motor de recomendacion upsell/cross-sell en tiempo real en pantalla de cajero/cliente; y asistente conversacional interno que resuelve dudas operativas del cajero/gerente.

- **Brecha:** 🟢 Ya está · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** NATURAL/MODULO en ambas. 'Disponible hoy en produccion. La plataforma expone mas de 200 herramientas a un asistente de
  IA con permisos por usuario, auditoria de cada operacion y confirmacion en dos pasos para acciones sensibles.'
- **Qué existe hoy:** Ambas son ciertas y verificables. Upsell: `UpsellRule` (:6323) con UpsellOrigin OWNER/BASKET_DATA/AI/PROMOTION,
  `UpsellImpression` (:6393) y `UpsellAcceptance` (:6433) atada a la linea real de la orden; motor en src/services/upsell/, job nocturno
  src/jobs/nightly-upsell-rules.job.ts, generacion por IA gateada a PREMIUM (`UPSELL_AI`, upsellAi.service.ts:212), UI de cajero ya en iOS
  (avoqado-ios/POS/Views/UpsellCashierStrip.swift) y administracion en src/pages/Promotions/Upsell.tsx. Asistente: el conteo real de tools
  registradas en src/mcp/tools/ es 225, o sea 'mas de 200' es exacto, con requirePermission + venueFilter + auditMcpWrite + confirmacion en
  dos pasos por regla del repo.
- **Depende de:** Nada. Vale la pena demostrarlo en vivo: es el renglon donde la respuesta suena a promesa y en realidad es de lo mas
  construido del modulo.

### Filas 216, 217 y 218 (IA POS): precios dinamicos y promociones personalizadas por demanda o inventario perecedero; deteccion de fraude en caja por patrones de cancelaciones, devoluciones y descuentos; y pronostico de afluencia por hora/sucursal para programar turnos.

- **Brecha:** 🔴 De cero · **Esfuerzo:** MES_O_MAS · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** DESARROLLO en las tres: precios dinamicos '3 a 5 dias', fraude en caja '3 a 5 dias', forecast de personal '1 a 2
  semanas'.
- **Qué existe hoy:** Ninguna de las tres existe. Precios dinamicos: grep de 'dynamicPric|surge' en src/ y schema: cero. Fraude en caja: no
  hay modelo ni servicio de scoring; lo unico parecido es `MoneyAnomaly` (vigilancia de discrepancias de cobro en
  src/services/payments/reservation-deposit-webhook.service.ts:26), que es otra cosa. Forecast de personal: 'forecast' solo aparece en
  src/services/dashboard/autoReorder.service.ts:130 (media movil exponencial para reabasto de insumos), no para afluencia. LO QUE SI ES
  CIERTO ES EL INSUMO, y esa parte de la respuesta esta bien fundada: el motor de descuentos ya segmenta por
  cliente/vigencia/producto/sucursal; cada cancelacion, cortesia, descuento y devolucion YA queda auditada con usuario y motivo en
  ActivityLog + OrderAction (que es literalmente el dataset del modelo de fraude); y el historico de venta por hora existe (tool peak_hours)
  junto con el modulo de horarios de personal.
- **Depende de:** Decision de alcance por cada una. Precios dinamicos es el de mayor riesgo: mueve el precio de venta solo, en 70 puntos de
  venta, y ademas necesita fecha de caducidad por lote (`StockBatch` existe, hay que ver si PITS la captura). Fraude y forecast son de bajo
  riesgo (solo leen) y son los mas defendibles porque el dato ya esta ahi. Los plazos de 3-5 dias describen un primer corte con reglas, no
  un modelo; conviene aclararlo antes de firmar.

## Módulo: transversal

La columna vertebral (multi-tenant, 243 permisos, ActivityLog con 467 puntos de escritura, almacenamiento, exportación, MCP con OAuth y
auditoría) está sólida y en varios renglones supera lo prometido; lo que falta es casi todo lo "configurable por el cliente" (presupuestos
de cero, multimoneda de cero, webhook saliente con modelo muerto, reglas de negocio, vistas/KPI persistidos) y las interfaces con terceros,
que además dependen de que PITS defina proveedor.

### Fila 3 — El sistema admite configuraciones multiempresa en el mismo site

- **Brecha:** 🟢 Ya está · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** 'Arquitectura multi-tenant nativa: Organización → Sucursal → Formato. Consolidación a nivel organización con
  aislamiento estricto de datos por sucursal y un solo acceso. Hoy en producción con un cliente de 47 sucursales.' Marcado cumplimiento
  natural.
- **Qué existe hoy:** EXISTE Y ES REAL. prisma/schema.prisma:18 model Organization → Venue (organizationId) → todo filtrado por venueId.
  Multi-org por staff: model StaffOrganization (schema.prisma:1075) con OrgRole + isPrimary. Módulos heredables org→venue:
  OrganizationModule/VenueModule (moduleService.isModuleEnabled con fallback org-level, src/services/modules/module.service.ts:11).
  Dashboard consolidado org-level: src/routes/dashboard/organizationDashboard.routes.ts + src/services/organization-dashboard/. Regla de
  aislamiento por venueId documentada y aplicada (.claude/rules/critical-warnings.md).
- **Depende de:** Nada. Sólo el alta de la organización PITS y sus 31 puntos de venta.

### Fila 7 — El sistema puede manejar más de dos tipos de moneda (compra y venta)

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** ALTO
- **Qué prometimos:** DESARROLLO. 'Catálogo de monedas, tipo de cambio diario con carga automática, captura de documentos de compra y venta
  en moneda extranjera, revaluación y expresión dual en reportes y estados financieros. Tiempo de entrega: 1 a 2 semanas.'
- **Qué existe hoy:** NO EXISTE NADA. `currency String @default("MXN")` aparece suelto en ~8 modelos (schema.prisma:133, 4159, 4724, 11189,
  11365, 11762, 12094, 13766) y nunca se lee para convertir. Cero resultados para exchangeRate/tipoCambio/fx en todo el schema. Todo el
  dinero es Decimal(10,2) en pesos 1:1 (regla explícita en .claude/rules/critical-warnings.md) y cada agregación de ventas, corte,
  contabilidad y MCP asume una sola moneda.
- **Depende de:** Decisión de si la conversión se congela al momento del documento o se revalúa; fuente del tipo de cambio (DOF/Banxico); y
  que el módulo contable (catálogo de cuentas, pólizas) acepte importe en moneda origen + moneda base. Tocar las columnas de dinero es lo
  más peligroso del inventario completo: hay ~70 puntos de venta cobrando contra esas mismas tablas.

### Filas 4 y 197 — Personalización de reportería / configurar cálculos de KPI y cuadros de mando

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Cumplimiento natural en ambas. 'Reportes predefinidos, configurables y exportables (XLS/PDF/CSV) nativos. La
  reportería 100% a la medida se cubre con el módulo de analítica y el asistente de lenguaje natural incluidos.' y 'Configuración de
  cálculos de KPI y cuadros de mando... exportables a Excel.'
- **Qué existe hoy:** MITAD Y MITAD. Lo que sí: reportes predefinidos (src/routes/dashboard/reports.routes.ts, sales-summary), exportación
  real csv/xlsx/pdf (src/services/dashboard/export.helpers.ts), y el asistente en lenguaje natural SÍ está en producción — MCP con 47
  archivos de tools y ~225 registros de herramienta (src/mcp/tools/), más el text-to-SQL
  (src/services/dashboard/text-to-sql-assistant.service.ts). Lo que NO: no existe ningún modelo de definición de KPI, reporte guardado ni
  layout de tablero — cero resultados para KpiDefinition/ReportConfig/DashboardLayout/SavedView en schema.prisma. Lo único persistido en esa
  línea son metas: model OrganizationGoal (schema.prisma:9756), y sólo salesTarget/volumeTarget.
- **Depende de:** Definir si 'configurable' significa un constructor de KPI en pantalla (modelo nuevo + evaluador de fórmula) o si basta con
  el asistente + exportación. Si es lo segundo, ya está; si es lo primero, es un módulo.

### Fila 5 — El sistema permite personalización de vistas

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Cumplimiento natural. 'Vistas, columnas y terminología configurables por tipo de negocio (tienda / restaurante /
  cafetería), por rol y por sucursal.'
- **Qué existe hoy:** PARCIAL. Por tipo de negocio SÍ hay base: enum BusinessType con 30+ tipos (schema.prisma:6865, incluye
  CONVENIENCE_STORE, RESTAURANT, CAFE) y la config de industria documentada en docs/industry-config/. Nombres de rol personalizables:
  avoqado-web-dashboard/src/pages/Settings/components/RoleDisplayNames.tsx. Marca blanca por organización: módulo WHITE_LABEL_DASHBOARD con
  theme/logo/navegación configurables (scripts/setup-modules.ts:348). PERO la visibilidad de columnas vive en localStorage del navegador
  (src/components/data-table.tsx) — no se guarda por rol ni por sucursal, y no existe modelo de vista guardada en el schema.
- **Depende de:** Que PITS diga qué vistas exactas quiere fijar por rol; si sólo es terminología y marca, ya está.

### Fila 9 — Alojamiento en nube o servidor propio, con respaldos y alta disponibilidad

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** Cumplimiento natural. 'Nube (SaaS) por defecto, con respaldos, alta disponibilidad y sin costo de servidor ni de motor
  de base de datos... Si aun así se requiere despliegue dedicado en infraestructura propia, está disponible como opción de implementación.'
- **Qué existe hoy:** NUBE SÍ, RESPALDO SIN POLÍTICA. Producción en Render con Postgres gestionado (render.yaml define los servicios web; la
  base NO está en el IaC, se administra en el panel). El propio plan interno lo dice sin adornos: 'CORRECCION: 0 archivos down.sql en todo
  prisma/migrations => pg_dump es la unica red' (docs/DEMO-PITS-PLAN-5-FRENTES.md:4 y :86). Archivos de venues en Firebase/GCS
  (src/config/firebase.ts:40), sin respaldo separado. No hay documento de política de respaldo, RPO/RTO, ni restauración ensayada. El
  'servidor propio' nunca se ha desplegado.
- **Depende de:** Nada técnico: es escribir la política (frecuencia, retención, RPO/RTO), ensayar UN restore y agregar migraciones de bajada
  para los cambios que toquen dinero. Si PITS pide de verdad el despliegue en su infraestructura, eso sí es un proyecto aparte y hoy no
  existe receta.

### Filas 165, 166, 167, 176, 177, 185 — Módulo presupuestal completo: presupuesto por centro de costo real vs presupuestado, ajuste del planeado, presupuesto de gasto y costo del flujo de ventas, control de nuevos proyectos, alertas de sobregasto y reglas de autorización

- **Brecha:** 🔴 De cero · **Esfuerzo:** MES_O_MAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** DESARROLLO en los seis renglones, 'dentro del módulo presupuestal'. Plazos comprometidos: 1 a 2 semanas (165, 166,
  167, 176, 177) y 3 a 5 días (185). Con reportes: planeado vs real, presupuestos modificados, movimientos y control de presupuesto,
  presupuesto de ventas.
- **Qué existe hoy:** NO EXISTE EL MÓDULO. El único modelo con 'Budget' en todo el schema es ChatbotTokenBudget (schema.prisma:7851) y es el
  presupuesto de tokens de IA — nada que ver. Tampoco existe entidad de centro de costo: el término aparece sólo como comentario en el
  módulo fiscal, donde venueId se usa como centro de costo informativo (schema.prisma:13085, 13174, 13315;
  src/services/fiscal/journalEntry.service.ts:36). Sí existe la base contra la cual comparar: catálogo de cuentas, pólizas y gastos
  (src/services/fiscal/expense.service.ts, journalEntry.service.ts).
- **Depende de:** Definir la jerarquía de centro de costo (¿parador? ¿formato dentro del parador? ¿cuenta contable?) y el periodo
  presupuestal. Se apoya en el catálogo de cuentas ya operativo, así que puede arrancar sin esperar a nada más. Sumados, los seis renglones
  prometidos suman mucho más de las '1 a 2 semanas' que se contestó en cada uno por separado.

### Fila 172 — Flujos y administración de créditos bancarios, con comparativo contra presupuesto

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** DESARROLLO. 'Administración de créditos bancarios con comparativo contra presupuesto. Tiempo de entrega: 3 a 5 días.'
- **Qué existe hoy:** NO EXISTE. Los únicos modelos bancarios son BankStatement (schema.prisma:12898), BankStatementLine (:12919) y
  PromoterBankAccount (:13576) — estado de cuenta y conciliación, no créditos. No hay modelo de crédito, amortización ni saldo insoluto.
- **Depende de:** El módulo presupuestal (fila 165): sin presupuesto no hay 'comparativo contra presupuesto', que es literalmente el reporte
  prometido. Los 3-5 días sólo aplican al registro del crédito, no al comparativo.

### Filas 186 y 187 — Módulo de administración de usuarios (altas, bajas, cambios) y permisos por módulo, función y nivel de autorización

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** Cumplimiento natural en ambas. 'Módulo de administración de usuarios... invitaciones, roles por sucursal y reporte de
  perfiles y autorizaciones' y 'Permisos granulares por módulo y acción (más de 200 permisos definidos), asignables por rol y
  personalizables por sucursal.'
- **Qué existe hoy:** CUMPLE Y LA CIFRA ES CONSERVADORA. src/lib/permissions.ts contiene 243 permisos únicos resource:action
  (DEFAULT_PERMISSIONS, PERMISSION_DEPENDENCIES, INDIVIDUAL_PERMISSIONS_BY_RESOURCE). Personalización por sucursal: model
  VenueRolePermission (schema.prisma:1132, con modifiedBy auditado) y PermissionSet (:1157). Dos niveles de rol: StaffRole (9 niveles) +
  OrgRole (4). Invitaciones: src/services/invitation.service.ts. UI: avoqado-web-dashboard/src/pages/Settings/RolePermissions.tsx y
  src/pages/Team. Hay auditor automatizado de deriva entre repos: npm run audit:permissions (.claude/rules/permissions-policy.md). LO QUE
  FALTA es sólo el entregable de papel: el 'Reporte de perfiles y autorizaciones por usuario' exportable no existe como reporte (la única
  matriz visual vive en src/pages/playtelecom/Users/components/PermissionMatrix.tsx, atada a ese cliente).
- **Depende de:** Nada. Es generalizar la matriz de permisos existente a una pantalla estándar y colgarle exportación.

### Fila 188 — Sincronizar automáticamente ventas, inventarios y precios entre el ERP y el punto de venta

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Cumplimiento natural. 'Sincronización automática y en tiempo real de ventas, inventarios y precios entre el sistema
  central y cada punto de venta.'
- **Qué existe hoy:** CIERTO PARA VENTAS, NO PARA PRECIOS NI INVENTARIO EN VIVO. Socket.IO empuja en tiempo real
  ORDER*CREATED/UPDATED/STATUS_CHANGED, PAYMENT*\_, SHIFT\_\_, TABLE*STATUS_CHANGE, TPV*\* (src/communication/sockets/types/index.ts:46),
  con 101 usos de broadcast en el código. El inventario se descuenta del lado del servidor (FIFO al pagar) y es una sola base de datos, así
  que no hay desfase de dato. PERO el enum de eventos NO tiene ningún evento de cambio de precio ni de inventario: un cambio de precio hecho
  en el dashboard llega al POS cuando el POS refresca su catálogo, no por empuje. Además existe el reproductor de intents offline
  (SyncIntentType, src/services/mobile/sync.mobile.service.ts), que es lo que realmente sostiene la promesa en paradores con enlace
  intermitente.
- **Depende de:** Agregar dos eventos de socket (precio/menú actualizado y stock actualizado) y que Android/iOS los escuchen — eso obliga a
  tocar los dos repos POS en el mismo cambio y a esperar el ciclo de APK, que son días de calle, no de código.

### Fila 189 — Acceso sin restricciones para configurar parámetros, relaciones de tablas, carga masiva, flujos y nuevos desarrollos

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** Cumplimiento natural. 'Acceso completo de configuración por interfaz... más acceso a la API documentada. La entrega de
  código fuente y el acceso a base de datos se definen contractualmente: en el proyecto SCADA para CONAGUA el código se entregó al cliente.'
- **Qué existe hoy:** CONFIGURACIÓN SÍ, 'DOCUMENTADA' ES GENEROSO. La configuración por interfaz existe ampliamente (catálogos, módulos,
  permisos, precios, terminales). La API está montada con swagger-jsdoc + swagger-ui (src/config/swagger.ts, escanea src/routes/\*\*), pero
  sólo hay 7 anotaciones @swagger en TODO src/routes: la especificación que se sirve está prácticamente vacía. La entrega de código y el
  acceso a base de datos son decisión contractual del founder, no del código.
- **Depende de:** Decidir qué superficie se documenta (probablemente el subconjunto que PITS va a integrar, no las ~700 rutas). Anotar rutas
  es trabajo mecánico pero real.

### Fila 190 — Apartado configurable para visualización de indicadores de control

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Cumplimiento natural. 'Apartado configurable para la visualización de indicadores de control, por sucursal, formato y
  organización.'
- **Qué existe hoy:** HAY TABLEROS, NO SON CONFIGURABLES. Existen Home, Reports, Analytics y el Command Center a nivel organización
  (avoqado-web-dashboard/src/pages/Home.tsx, /Reports, /Analytics; backend src/services/command-center/), con corte por sucursal y por
  organización. Lo que no existe es la persistencia de la configuración: cero modelos de layout/widget en el schema. Cada usuario ve el
  mismo tablero.
- **Depende de:** Definir si 'configurable' es elegir qué tarjetas se ven (modelo de layout por usuario/rol, días) o construir widgets a la
  medida (semanas). Se decide con PITS.

### Fila 191 — Carga masiva desde Excel para tablas estáticas (catálogos)

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Cumplimiento natural. 'Carga masiva desde Excel para catálogos disponible mediante las herramientas de importación.
  Los layouts específicos de PITS se construyen durante la implementación.'
- **Qué existe hoy:** EXISTE PARA MENÚ/PRODUCTOS Y SUCURSALES, NO PARA LOS DEMÁS CATÁLOGOS. Importación de menú por CSV con parseo,
  validación y previsualización: avoqado-web-dashboard/src/services/menuImport.service.ts + src/components/menu/MenuImportDialog.tsx
  (papaparse), modo básico y avanzado (costo, stock, modificadores). Alta masiva de venues:
  src/services/superadmin/bulkVenueCreation.service.ts + FullTemplateImportDialog.tsx. Carga masiva de configuración de liquidaciones y de
  categorías de item. NO hay importador de proveedores, clientes, materias primas ni catálogo de cuentas.
- **Depende de:** Que PITS entregue sus layouts reales. El patrón de importación ya está probado; replicarlo por catálogo es 1-2 días cada
  uno.

### Fila 192 — Carga masiva desde Excel para tablas productivas (órdenes de compra, órdenes de servicio, programación de pagos)

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** DESARROLLO. 'Tiempo de entrega: 1 a 2 días.'
- **Qué existe hoy:** NO EXISTE NINGUNO. La importación existente es sólo de catálogos (menú, venues). No hay endpoint ni pantalla que cree
  órdenes de compra, órdenes de servicio ni programación de pagos desde archivo.
- **Depende de:** Los layouts de PITS. Importante: aquí un renglón mal parseado CREA documentos que mueven inventario y dinero, así que
  necesita previsualización, validación por renglón y todo-o-nada. Los '1 a 2 días' prometidos alcanzan para UN layout simple, no para los
  tres con validación seria.

### Filas 193, 28 y 35 — Actividad histórica por usuario, trazabilidad de acceso (inicio/cierre de sesión) y bitácora de operaciones exportable

- **Brecha:** 🟡 Falta poco · **Esfuerzo:** DIAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Cumplimiento natural en las tres. 'Historial de actividad por usuario... con reporte auditable y exportable',
  'Bitácora de acceso y actividad por usuario: inicio y cierre de sesión, y registro auditable de cada operación sensible', 'Bitácora
  completa de operaciones por usuario, exportable y filtrable por sucursal, fecha y tipo de operación.'
- **Qué existe hoy:** MUCHO MÁS FUERTE DE LO QUE PARECE, CON DOS HUECOS CONCRETOS. model ActivityLog (schema.prisma:5725) guarda action,
  entity, entityId, staffId, venueId, data, ipAddress y userAgent. El escritor logAction (src/services/dashboard/activity-log.service.ts:41)
  se invoca en 467 lugares distintos repartidos en 155 archivos — la cobertura de mutaciones es amplia y es regla obligatoria del repo.
  Consulta con filtros y paginación a nivel sucursal (src/routes/dashboard/activityLog.routes.ts, gated PRO VENUE_AUDIT_LOG + permiso
  activity:read) y a nivel organización (organizationDashboard.routes.ts:1532). Pantallas: VenueActivityLog.tsx y
  OrganizationActivityLog.tsx. HUECO 1: el inicio y cierre de sesión de un usuario normal NO se registra — sólo se escriben
  MASTER_LOGIN_SUCCESS/FAILED (src/services/dashboard/auth.service.ts:118, src/services/tpv/auth.tpv.service.ts:523) y ACCOUNT_LOCKED
  (auth.service.ts:262); lo más cercano a una sesión de cajero es el turno (model Shift, schema.prisma:2609). HUECO 2: ninguna de las dos
  pantallas de bitácora tiene botón de exportar.
- **Depende de:** Nada. Son dos cosas puntuales: escribir LOGIN/LOGOUT en el camino de autenticación (con cuidado de no inundar la tabla) y
  colgar el exportador que ya existe (export.helpers.ts) a la consulta de bitácora.

### Filas 194 y 195 — Alertas y correos por cambio de estatus en los procesos, a usuarios del sistema y a correos externos que no son usuarios

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Cumplimiento natural en ambas. 'Motor de notificaciones por correo disponible. Las alertas por cambio de estatus en
  cada proceso se configuran durante la implementación' y 'Envío de alertas a correos externos que no son usuarios del sistema, con el mismo
  motor de notificaciones.'
- **Qué existe hoy:** EL MOTOR EXISTE; 'SE CONFIGURA' HOY SIGNIFICA TOCAR CÓDIGO. Hay motor completo: model Notification
  (schema.prisma:6696) con canales IN_APP/EMAIL/PUSH, NotificationPreference (:6743) con horario silencioso, NotificationTemplate (:6770)
  con variables, y envío real por correo (src/services/email.service.ts, resend.service.ts) más jobs que ya notifican
  (nightly-low-stock.job.ts, nightly-sales-summary.job.ts). PERO NotificationType es un enum CERRADO de ~30 valores en el schema (:7581):
  agregar 'se aprobó la orden de compra' o 'cambió el estatus del gasto' obliga a migración y despliegue, no es configuración. Y para
  correos externos sólo hay envíos directos con destinatario fijo por variable de entorno (notification.service.ts:307,
  ONBOARDING_NOTIFICATIONS_EMAIL); no existe pantalla para que PITS agregue destinatarios externos por evento.
- **Depende de:** Decidir si se abre el catálogo de eventos a datos (tabla de suscripciones evento→destinatarios, incluidos externos) o si
  se hardcodean los N eventos que PITS pida. Lo primero es lo que se contestó.

### Fila 196 — Exportar en XLS, CSV, TXT las bases de información desde los reportes y listados

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Cumplimiento natural. 'Exportación de la información a XLS y CSV desde TODOS los reportes y listados del sistema.'
- **Qué existe hoy:** EXISTE EL MOTOR, ESTÁ CONECTADO A TRES LISTADOS. src/services/dashboard/export.helpers.ts hace csv/xlsx/pdf con
  selección de columnas (tope 10,000 filas; 1,000 en PDF). Está enganchado en: órdenes (order.dashboard.controller.ts:206), pagos
  (payment.dashboard.controller.ts:380) y resumen de ventas (sales-summary.dashboard.controller.ts:296 y :354). Hay exports hechos a mano en
  control de stock, categorías de item y el generador Excel de Blumon. NO tienen exportación: bitácora, inventario general, compras,
  contabilidad, personal. Además el detalle por transacción está detrás de PREMIUM (TRANSACTION_EXPORT,
  sales-summary.dashboard.controller.ts:227).
- **Depende de:** Nada técnico: es enganchar el helper listado por listado (~medio día cada uno). La decisión pendiente es el tope de 10,000
  filas — para un histórico de 18 paradores se queda corto y hay que decidir si se hace exportación asíncrona.

### Fila 198 — Configurar lógicas y reglas de negocio ligadas a autorizaciones, ejecuciones, cancelaciones o modificaciones de registros

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** MES_O_MAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Cumplimiento natural. 'Los permisos y las validaciones por operación son nativos. El motor configurable de reglas de
  negocio... se define durante la implementación.'
- **Qué existe hoy:** LOS CANDADOS SÍ, EL MOTOR NO. Existen permisos granulares por acción (243), middlewares de validación por operación
  (checkPermission, checkTableOwnership, interVenueTransferCancelPermission, checkFeatureAccess) y flujos de aprobación CONCRETOS ya
  construidos: traspasos entre sucursales (autorizar/despachar/recibir/resolver diferencia), verificación documental de ventas
  (src/services/dashboard/sale-verification.dashboard.service.ts) y órdenes de compra con autorización/rechazo con motivo. Lo que NO existe
  es un motor donde el cliente defina una regla nueva sin programar: no hay ningún modelo de regla en el schema.
- **Depende de:** Que PITS liste las reglas reales que quiere. Si son 5-10 reglas concretas, se implementan una por una en días; un motor
  genérico configurable es un proyecto y se contestó de forma ambigua a propósito ('se define durante la implementación').

### Filas 199 y 257 — Extracción para BI y API RESTful completa y documentada con OAuth 2.0 y registro de todos los consumos

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Cumplimiento natural en ambas. 'Extracción de información para BI mediante API REST documentada... conectable con
  Power BI, Looker o similar' y 'API REST documentada con autenticación OAuth 2.0 y registro de cada consumo. Hoy la consumen nueve
  aplicaciones cliente distintas.' Con reporte de consumo de API y trazabilidad de integraciones.
- **Qué existe hoy:** LOS NUEVE CLIENTES SON CIERTOS; OAUTH Y EL REGISTRO DE CONSUMO SON PARCIALES. La API /api/v1 sí la consumen POS
  Android, POS iOS, TPV, dashboard, checkout, widget, consumer app, puente POS heredado y superadmin. OAuth 2.0 real existe SÓLO en el canal
  MCP: src/mcp/oauth/ completo (provider, PKCE, tokens) con model McpOAuthClient (schema.prisma:12589) y McpRefreshToken (:12623). El
  dashboard y los POS usan JWT propio; la API de socios usa llave estática hasheada — model PartnerAPIKey (schema.prisma:4668), que sólo
  guarda lastUsedAt y lastUsedIp, no cada llamada. Registro de consumo por llamada: existe para el canal IA (model McpToolCall, escrito por
  src/mcp/instrument.ts con herramienta, actor, org, venue, resultado y duración) pero NO para la API REST: no hay modelo de log de
  peticiones; requestLogger.ts sólo escribe al log de texto. Documentación: 7 anotaciones @swagger en todo src/routes.
- **Depende de:** Definir si PITS va a integrar por OAuth (hay que extender el proveedor del MCP a la API general o montar
  client_credentials) o si le basta llave de socio como BAIT. El 'reporte de consumo de API' necesita una tabla nueva y un endpoint; hoy no
  hay de dónde sacarlo.

### Filas 200 y 201 — Almacenamiento de documentos e imágenes (activos, evidencias, facturas XML/PDF) sobre servicio de nube externo

- **Brecha:** 🟢 Ya está · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** Cumplimiento natural en ambas. 'Almacenamiento en nube para documentos e imágenes... sin límite operativo' y 'El
  almacenamiento de archivos ya opera sobre un servicio de nube gestionado, con carga, consulta, visualización y descarga ligadas a cada
  registro.'
- **Qué existe hoy:** EXISTE. src/services/storage.service.ts con buildStoragePath() que separa prod/dev y organiza por venue.slug, sobre
  Firebase Storage / Google Cloud Storage (src/config/firebase.ts:40). Ya se usa en producción para KYC, evidencias de custodia serializada
  y facturas del buzón fiscal. Nota fina: es GCS, no AWS como pregunta el renglón — la respuesta dijo 'servicio de nube gestionado', que es
  exacto y no hay que corregirla.
- **Depende de:** Nada. Sólo definir las carpetas de PITS por proceso durante la implementación.

### Fila 258 — Webhook para notificar eventos en tiempo real a sistemas externos, con entrega fiable, reintentos y registro de fallos

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Cumplimiento natural. 'La notificación de eventos en tiempo real está disponible por websocket (venta realizada,
  cambio de inventario, alta de cliente). El webhook HTTP saliente con reintentos y bitácora de fallos se entrega como conector durante la
  implementación.'
- **Qué existe hoy:** NO EXISTE, Y HAY UN MODELO MUERTO QUE LO APARENTA. model WebhookSubscription (schema.prisma:4920) tiene url, secreto
  cifrado y active — pero NO se referencia desde ninguna línea de src/: la única mención en todo el repo es
  scripts/generate-schema-map.ts:473. No hay entrega, ni reintentos, ni bitácora de fallos. Todo lo que llamamos 'webhook' hoy es ENTRANTE
  (Stripe, Blumon, MercadoPago, WhatsApp: src/routes/webhook.routes.ts, model ProviderEventLog con idempotencia y reintento). Ojo con la
  parte del websocket: el enum de eventos (src/communication/sockets/types/index.ts:46) tiene venta y pago, pero NO tiene cambio de
  inventario ni alta de cliente — dos de los tres ejemplos que citamos en la respuesta no existen como evento.
- **Depende de:** Nada externo. Es cola de entrega + backoff + firma HMAC + tabla de intentos, sobre un modelo que ya está en el schema. Hay
  que agregar además los dos eventos faltantes (inventario y cliente) para que la respuesta sea verdad.

### Fila 259 (Políticas de Control) — Política formal de Segregación de Funciones, aplicable y auditable, con reporte de roles y conflictos de interés

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** Cumplimiento natural. 'El sistema ya separa por permiso quién autoriza, quién recibe y quién ajusta, y audita cada
  operación con usuario y fecha. La matriz formal de funciones incompatibles y su reporte de conflictos de interés se configura durante la
  implementación.'
- **Qué existe hoy:** LA MITAD QUE DIJIMOS ES CIERTA, LA OTRA MITAD NO EXISTE. La separación por permiso sí: los permisos de autorizar,
  recibir y ajustar son acciones distintas en src/lib/permissions.ts y se pueden dar a roles distintos por sucursal (VenueRolePermission).
  La auditoría con usuario y fecha sí: ActivityLog con 467 puntos de escritura. Lo que NO existe: no hay matriz de pares incompatibles, no
  hay validación que impida asignarle a un mismo usuario dos permisos en conflicto, y no hay reporte de conflictos de interés. Hoy nada te
  detiene si le das 'autorizar compra' y 'recibir mercancía' a la misma persona.
- **Depende de:** Que PITS (o su contraloría) entregue la matriz de funciones incompatibles. Sin esa matriz no hay nada que programar. Con
  ella: tabla de pares + validador al guardar el rol + reporte, sobre la infraestructura de permisos existente.

### Fila 255 — Administración de regalías y comisiones de franquicias, cálculo automático por franquiciatario según ventas, estado de cuenta y proyección

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANA · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** MÓDULO COMPLEMENTARIO. 'Se cubre con el módulo de comisiones, que ya calcula montos por venta con esquemas escalonados
  o fijos, genera el estado de cuenta y controla la dispersión. Configuración durante la implementación: 3 a 5 días.'
- **Qué existe hoy:** EL MOTOR EXISTE PERO CALCULA POR PERSONA, NO POR CONTRATO DE FRANQUICIA. src/services/dashboard/commission/ tiene
  esquemas escalonados y fijos, metas, cálculo, payouts y clawbacks (memoria: en producción en Mindform con dos configuraciones vivas), y
  OrganizationGoal (schema.prisma:9756) para metas org. Pero la atribución es por colaborador (servedById), no por franquiciatario ni por
  venta bruta de la sucursal, y no hay entidad 'contrato de franquicia' ni estado de cuenta de franquiciatario. Adaptarlo no es sólo
  configuración.
- **Depende de:** Saber si PITS realmente tiene franquicias (los 18 paradores parecen propios) y, si las tiene, la base de cálculo de la
  regalía. Los '3 a 5 días de configuración' que contestamos asumen que basta con parametrizar el motor de comisiones; hoy hay que
  extenderlo para atribuir a la sucursal en lugar de a la persona.

### Fila 256 — Comparación de KPIs entre sucursales propias y franquicias, con acceso diferenciado (cada franquiciatario sólo a su información)

- **Brecha:** 🟢 Ya está · **Esfuerzo:** HORAS · **Riesgo a venues vivos:** NINGUNO
- **Qué prometimos:** Cumplimiento natural. 'Cada franquiciatario ve únicamente su información y PITS ve el consolidado. Es la misma
  arquitectura multi-sucursal que hoy opera con 47 puntos en un cliente.'
- **Qué existe hoy:** CIERTO. El aislamiento por venueId es regla dura de todo el repo; el acceso se resuelve por StaffVenue (sucursales
  asignadas) y StaffOrganization (schema.prisma:1075) para el consolidado, con guardas de organización (checkOrgAccess, requireOrgOwner en
  src/routes/dashboard/organizationConfig.routes.ts). El comparativo entre sucursales ya existe: Command Center y análisis de tiendas a
  nivel organización (src/services/command-center/, src/routes/dashboard/storesAnalysis.routes.ts) — construido y en uso para un cliente de
  39+ sucursales.
- **Depende de:** Nada. Sólo asignar correctamente qué sucursales ve cada usuario al dar de alta.

### Filas 130, 131, 181 y 152 — Gestión de cuentas bancarias por integración con plataformas bancarias, conciliación automática por referencia/monto/fecha, carga por layout a portales bancarios y dispersión de pagos

- **Brecha:** 🟠 Base, falta la mitad · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** MEDIO
- **Qué prometimos:** 130 y 131 como módulo complementario ('conector bancario de la plataforma... De nuestro lado: 3 a 5 días; la fecha
  final depende del banco'), 181 y 152 como DESARROLLO ('3 a 5 días'). En 152: 'archivo de dispersión en el formato del banco a partir de
  las órdenes de pago autorizadas, con control de folio, bitácora y conciliación posterior'.
- **Qué existe hoy:** LA CONCILIACIÓN POR ARCHIVO SÍ EXISTE (y es lo que contestamos en la fila 132, correctamente).
  src/services/dashboard/bankReconciliation.service.ts: parseBankCsv, loadDepositCandidates, matchLines por referencia/monto/fecha,
  confirmMatches, con models BankStatement (schema.prisma:12898) y BankStatementLine (:12919), gated por BANK_RECONCILIATION. La CONEXIÓN
  bancaria en vivo está a medias: existe el andamio src/services/financial-connections/ (externalBank.client.ts, registry.ts, crypto.ts,
  financialConnection.service.ts) pero el registro de proveedores está vacío en la práctica y hay un incidente conocido de que el proveedor
  migró de dominio. La DISPERSIÓN y el LAYOUT bancario NO existen: lo más parecido es el reporte de dispersión de Cash Out a Finanzas
  (src/services/dashboard/cash-out/, con CLABE y folio), que es un Excel interno, no un archivo en formato de banco.
- **Depende de:** Que PITS diga QUÉ BANCO. Cada banco tiene su propio layout de dispersión y su propio esquema de conexión; los '3 a 5 días
  de nuestro lado' son honestos por banco, pero no arrancan hasta tener la especificación y las credenciales. Riesgo MEDIO porque generar
  archivos de dispersión es mover dinero real: necesita doble confirmación, control de folio y bitácora antes de tocarlo.

### Filas 134, 12 y 252 — Cuentas por cobrar desde transacciones recibidas por interfaz de estaciones de servicio; recargas de tiempo aire y servicios; servicios de valor agregado (pago de impuestos, tenencias)

- **Brecha:** 🔴 De cero · **Esfuerzo:** SEMANAS · **Riesgo a venues vivos:** BAJO
- **Qué prometimos:** DESARROLLO en las tres. 134: 'ligado a la interfaz que se defina con el sistema de la gasolinera. De nuestro lado: 3 a
  5 días.' 12 y 252: 'integración con el proveedor que PITS defina, con registro de fallos y reporte de recaudación por tipo de servicio. De
  nuestro lado: 3 a 5 días. La fecha final depende de los tiempos del tercero.'
- **Qué existe hoy:** NADA DE LAS TRES INTERFACES, Y FALTA LA BASE DE UNA. No existe integración con ningún sistema de estación de servicio
  ni con ningún agregador de recargas/servicios (cero coincidencias en src/). Más importante: no existen cuentas por cobrar a clientes B2B —
  el único modelo de facturación es Invoice (schema.prisma:3672) y es la factura de suscripción que Avoqado le cobra al venue, no un estado
  de cuenta de flotilla. La respuesta de la fila 133 ya lo admite ('la plataforma no maneja hoy cuentas por cobrar a clientes B2B'). La
  venta de un servicio como producto en mostrador sí funciona hoy.
- **Depende de:** Bloqueado por terceros: PITS tiene que definir el sistema de la gasolinera y el agregador de recargas, y conseguir
  documentación y ambiente de pruebas. Además hay una dependencia interna que no está en la respuesta: primero hay que construir cuentas por
  cobrar B2B (cliente-flotilla, límite de crédito, estado de cuenta), y hasta entonces los '3 a 5 días de nuestro lado' aplican sólo al
  conector.
