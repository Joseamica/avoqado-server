# Investigación en vivo: IVA por producto y CFDI 4.0 — SoftRestaurant y Parrot

Fecha de la investigación: 2026-09-26. Metodología: búsquedas y fetches en vivo contra los
centros de ayuda oficiales (`soporte.parrotsoftware.com.mx`, `parrotsoftware.zendesk.com`,
`softrestaurant.zohodesk.com`, `softrestaurant.com`, `academia.softrestaurant.com`) más fuentes
de terceros (partners de timbrado) etiquetadas como tales. **Limitación honesta de método:**
varias páginas objetivo devolvieron 404/403 al `WebFetch` directo (probablemente protección
anti-bot / Cloudflare de esos dominios), así que buena parte del contenido citado abajo viene
de los *snippets* que el motor de búsqueda extrajo de esas mismas páginas (WebSearch sí pudo
indexarlas), no de una lectura completa del HTML. Lo marco explícitamente en cada caso. Donde ni
eso encontró nada, digo "no encontré".

---

## SOFTRESTAURANT (National Soft)

### 1. IVA por producto — dónde se configura, qué opciones, ¿tasa 0 ≠ exento?

**No encontré** documentación pública de SoftRestaurant que muestre la pantalla exacta de
configuración de impuesto por producto/categoría (el catálogo de artículos es funcionalidad
básica del ERP y sus manuales públicos indexables no cubren ese detalle a nivel de campo). Lo
que sí se pudo confirmar indirectamente:

- El manual de "Compras desde CFDI" de SR12 confirma que el sistema maneja **porcentaje de
  impuesto por renglón** al importar una factura de compra: *"al importar los datos de la
  factura, Soft Restaurant® agrega automáticamente cantidad, costo unitario, porcentaje de
  descuento, importe, porcentaje de impuesto e importe de impuesto"* (paráfrasis del snippet
  indexado; no pude leer el PDF completo).
  Fuente: https://softrestaurant.com/recursos/manuales?download=212:sr12-manual-compras-cfdi
- Existe un manual dedicado a "Configurar dólares en el ticket" en el mismo centro de ayuda
  (`softrestaurant.zohodesk.com`), lo que confirma que ese centro de ayuda SÍ documenta ajustes
  de ticket a nivel de detalle — pero no until until encontré su equivalente para IVA por
  producto/tasa 0/exento.
  Fuente: https://softrestaurant.zohodesk.com/portal/es/kb/articles/configurar-d%C3%B3lares-en-el-ticket
- La sección de Facturación Electrónica del centro de ayuda oficial (listado completo que sí
  pude leer) NO incluye ningún artículo titulado sobre IVA/impuestos por producto; solo trae:
  "Configuración de Facturación Electrónica" (certificados/CSD), "Actualizar CSD por Vigencia",
  "Emisión de CFDI en Parcialidades", "Emisión de Complemento de Pagos", "Motivos de Cancelación
  02-03-04", "Descarga de Manifiesto" y "Activar Código QR de Facturación en el Ticket de Venta".
  Fuente (listado verificado por fetch completo):
  https://softrestaurant.zohodesk.com/portal/es/kb/nationalsoft/soft-restaurant/facturaci%C3%B3n-electronica

**Conclusión honesta:** no encontré evidencia pública de si SoftRestaurant modela el IVA por
producto, por categoría, o como default de negocio + excepción, ni si distingue tasa 0 de
exento en su UI de captura de artículos. Dado que su generador de CFDI usa el Anexo 20 del SAT
(estándar en todo el mercado), es *asumible* que internamente sí distinga tasa 0 (TipoFactor
`Tasa`, 0.000000) de exento (TipoFactor `Exento`) porque así lo exige el propio XML — pero no
tengo una fuente de SoftRestaurant que lo diga explícitamente para su UI.

### 2. Cambiar el IVA de un producto después de tener ventas

**No encontré** ninguna documentación de SoftRestaurant sobre este escenario (si afecta tickets
ya vendidos pero aún no facturados, o si toca facturas ya emitidas, ni ninguna advertencia al
respecto). Ningún manual público indexado lo menciona.

### 3. Factura individual desde ticket / portal de autofactura (QR)

**Cómo funciona el flujo (confirmado, aunque vía snippets de búsqueda, no lectura completa del
HTML):**

- *"AutoFactura es un módulo que permite a los clientes generar sus facturas de manera autónoma,
  ya sea desde un portal web personalizable o a través de un código QR incluido en el ticket."*
  Fuente: https://softrestaurant.com/yoquieroautofactura (contenido citado vía snippet del motor
  de búsqueda; el fetch directo dio 404).
- *"Es sencillo y rápido, accesible desde cualquier dispositivo móvil — los clientes solo
  necesitan escanear el código QR al final de su nota de venta"* y luego *"para solicitar su
  factura, el cliente debe ingresar al menos su RFC, nombre y apellidos o razón social, régimen
  fiscal y código postal según lo requiere el SAT"*.
  Misma fuente (softrestaurant.com/yoquieroautofactura, vía snippet).
- **¿Usa el dato fiscal del momento de la venta o el catálogo vivo?** No encontré una afirmación
  explícita. Es razonable inferir que usa el **ticket** (los conceptos/importes/impuestos ya
  quedaron congelados en la venta, porque el CFDI debe cuadrar con lo cobrado) pero no tengo cita
  textual de SoftRestaurant que lo confirme para el caso de "el producto cambió de tasa después".
- **Tasas mixtas en un mismo ticket:** no encontré mención explícita de si el portal de
  autofactura soporta un ticket con renglones a 16% y otros a 0%/exento simultáneamente. Dado que
  el CFDI 4.0 del SAT exige impuestos por concepto (no por comprobante completo), es
  técnicamente posible, pero no tengo confirmación de producto.

### 4. Factura global (público en general)

**Periodicidad:** *"Se recomienda establecer un periodo constante para la emisión de tu factura
global, ya sea semanal, mensual o diaria."* — vía snippet del motor de búsqueda sobre
softrestaurant.com/yoquieroautofactura (fetch directo 404, contenido no verificado línea por
línea).

**Qué pasa si no se completan los datos a tiempo:** *"Si el sistema no recibe la actualización de
información del cliente a tiempo, la factura se emitirá como Público en General, y si se emitió
a Público en General y necesitas corregirla con tu RFC, cuentas con los primeros 15 días del mes
siguiente para solicitar la actualización."* — misma fuente, mismo método (snippet).

**Tasas mixtas / doble facturación (individual↔global):** **no encontré** ninguna documentación
de SoftRestaurant que explique (a) cómo agrupa/desglosa tickets con tasas distintas dentro de la
global, ni (b) el mecanismo que evita que un ticket quede en la global Y facturado individual (o
viceversa). El módulo de "Motivos de Cancelación 02-03-04" existe como artículo pero solo pude
leer su primera línea introductoria — *"En Soft Restaurant®, al cancelar un Comprobante Fiscal
Digital por Internet (CFDI), es fundamental seleccionar el motivo de cancelación adecuado según
las disposiciones del Servicio de Administración Tributaria (SAT)"* — sin acceso al contenido
detallado de cada motivo (403/paywall de lectura completa).
Fuente: https://softrestaurant.zohodesk.com/portal/es/kb/articles/3-motivos-de-cancelaci%C3%B3n-02-03-04

### 5. Cancelación / sustitución / relación 04

Confirmado que **existe** un artículo oficial titulado "7. Motivos de Cancelación 02-03-04" en
el centro de ayuda de facturación electrónica — es decir, SoftRestaurant documenta el flujo de
motivos de cancelación del SAT (01 sustitución, 02 errores con relación, 03 no se llevó a cabo la
operación, 04 nominativa relacionada en una global) como parte de su producto. **No pude leer el
contenido completo** (el fetch trajo solo el párrafo introductorio) para confirmar si su UI pide
el UUID de la factura sustituta al cancelar con motivo 01/relación 04, ni si permite refacturar
automáticamente un ticket cuya factura fue cancelada.
Fuente: https://softrestaurant.zohodesk.com/portal/es/kb/articles/3-motivos-de-cancelaci%C3%B3n-02-03-04

### 6. Notas de crédito / devoluciones

**No encontré** ningún artículo de SoftRestaurant (ni en zohodesk ni en softrestaurant.com) sobre
emisión de CFDI de egreso / notas de crédito para devoluciones, ni cómo determina el IVA del
reembolso. La sección de Facturación Electrónica de su centro de ayuda (listado completo leído)
no trae ese tema — solo parcialidades, complemento de pagos, cancelación, CSD y QR.

### 7. Delivery apps (Uber Eats, Rappi, DiDi)

Confirmado que SoftRestaurant **integra pedidos** de Uber Eats/Rappi/DiDi Food al POS ("Soft
Restaurant® Delivery Manager centraliza pedidos de Didi, Rappi y Uber Eats integrado con el
punto de venta, sincroniza datos en tiempo real..."), con un artículo específico de
configuración de catálogo hacia Uber Eats ("4. Opciones de productos, importar y eliminar –
Uber Eats", que no pude leer completo por 404 en el fetch directo).
Fuente (snippet): https://softrestaurant.zohodesk.com/portal/es/kb/articles/opciones-de-productos-importar-y-eliminar
Fuente (integración general, vía búsqueda): https://softrestaurant.com/integraciones

**¿Factura el pedido de delivery al cliente final?** No encontré documentación específica de
SoftRestaurant sobre esto. Contexto de mercado (no específico del producto): Uber Eats aclara a
sus propios usuarios que *"el recibo que recibes en tu correo no es en realidad la factura del
restaurante — para recibir tu factura debes coordinarlo directamente con el restaurante"* — es
decir, la factura fiscal del consumo, si existe, la emite el restaurante (vía su propio sistema,
que sería SoftRestaurant), no Uber Eats. Fuente (Uber, no SoftRestaurant):
https://help.uber.com/en/ubereats/restaurants/article/c%C3%B3mo-obtengo-la-factura-de-mi-pedido

### 8. "La factura debe cuadrar con lo cobrado" / bloqueo por datos inconsistentes

**No encontré** ninguna mención explícita de SoftRestaurant sobre bloquear la facturación cuando
los datos no cuadran (a diferencia de lo que sí pude confirmar para Parrot, ver abajo).

---

## PARROT (Parrot Software)

Nota: Parrot tiene **dos** centros de ayuda vivos que aparecen indexados: el nuevo
`soporte.parrotsoftware.com.mx` (más reciente, pobre en resultados de búsqueda todavía) y el
legado `parrotsoftware.zendesk.com/hc/es` (más antiguo pero con más contenido indexado y con
las respuestas más completas encontradas en esta investigación). Ambos se citan abajo.

### 1. IVA por producto — dónde se configura, qué opciones, ¿tasa 0 ≠ exento?

**No pude confirmar la pantalla exacta.** El artículo más prometedor —"Creación de artículos,
categorías y grupos modificadores"— devolvió 403 en el fetch directo (protección de Zendesk) y
las búsquedas dirigidas a su contenido no revelaron el nombre del campo de impuesto ni las
opciones (16/8/0/exento) documentadas explícitamente.
Fuente (URL confirmada pero no legible): https://parrotsoftware.zendesk.com/hc/es/articles/27617210487827-Creaci%C3%B3n-de-art%C3%ADculos-categor%C3%ADas-y-grupos-modificadores

Contexto encontrado (de terceros, blog propio de Parrot, no su centro de ayuda): Parrot
menciona en su propio blog una "Guía para la facturación en restaurantes en México" que discute
CFDI 4.0 en general, pero no localicé el detalle de UI para IVA por producto.

**Conclusión honesta:** no encontré confirmación de si es por producto, por categoría, o default
del negocio + excepción, ni si la UI distingue tasa 0 de exento como opciones separadas.

### 2. Cambiar el IVA de un producto después de tener ventas

**No encontré** documentación de Parrot sobre este escenario específico. Ninguna búsqueda dirigida
devolvió contenido de sus centros de ayuda sobre el efecto retroactivo de cambiar impuestos de un
producto.

### 3. Factura individual desde ticket / portal de autofactura (QR) — Auto-Facturación

Este es el punto donde Parrot documenta **más y mejor** que SoftRestaurant, con comportamiento
explícito y verificable (aunque siempre vía snippets del buscador sobre la página real de
Zendesk, que en fetch directo da 403):

- Flujo de habilitación (3 configuraciones): *"Datos de emisión (información fiscal para emitir
  CFDIs), Portal de autofacturación (el sitio donde facturarán sus órdenes), y Recibos con link y
  código QR de facturación."*
  Fuente: https://soporte.parrotsoftware.com.mx/es_MX/colecciones/habilita-la-facturacion-para-tus-clientes
- Límite de días para autofacturar: *"por default, el número de días para facturar es 40 y se
  precargará al seleccionar esa opción"*, y **es un candado que solo aplica al cliente final**:
  *"El límite de días para facturar que hayas configurado solo limitará a tus clientes de
  facturar un recibo, pero tú podrás incluirlo en una factura global en el momento que desees
  siempre que no haya sido incluido previamente en otra factura global."*
  Fuente: https://parrotsoftware.zendesk.com/hc/es/articles/1500007861882-Auto-Facturaci%C3%B3n
- **Anti-doble-facturación, ambas direcciones, confirmado explícitamente:**
  - Individual → bloquea global: *"Si un recibo ya fue incluido en otra factura, no podrás
    incluirlo en una factura global"* — es decir, un ticket ya autofacturado por el cliente
    (individual) queda excluido de la global.
  - Autofacturado → queda inactivo para todo: *"Cuando un ticket se autofactura, ya no está
    disponible para facturarse ni se considera para la factura global, es decir queda
    inactivo."*
  - Intento de duplicar: *"si se intenta duplicar la facturación, aparecerá un mensaje de error
    en tu portal de auto-facturación."*
  - Reversión: para volver a facturar un ticket ya autofacturado hace falta **"liberar"** el
    ticket, lo cual **cancela la factura generada** para que solo exista un comprobante cuando se
    vuelva a facturar (según el snippet: *"para reactivarlo hay que 'liberar' el ticket, lo cual
    cancela la factura generada para que solo exista un comprobante cuando se vuelva a
    facturar"*).
  Fuente de las cuatro citas: https://parrotsoftware.zendesk.com/hc/es/articles/1500010533762-Facturaci%C3%B3n-Global
  y https://parrotsoftware.zendesk.com/hc/es/articles/1500007861882-Auto-Facturaci%C3%B3n (contenido
  extraído vía snippets del buscador; fetch directo de ambas URLs dio 403).
- **¿Usa el dato del ticket o el catálogo vivo?** No encontré una afirmación explícita, pero el
  propio mecanismo de "liberar para volver a facturar" (que cancela la factura anterior en vez de
  simplemente re-generarla con datos nuevos) sugiere que el sistema trata el CFDI ya emitido como
  el snapshot autoritativo — no re-lee el catálogo al reintentar. Es inferencia, no cita directa.
- **Tasas mixtas en un ticket:** no encontré mención explícita.

### 4. Factura global (público en general)

- **Periodicidad:** *"Puedes elegir un día, semana o mes para generar una factura global por
  dicho periodo."* Y el proceso (confirmado también en `soporte.parrotsoftware.com.mx`, esta vez
  con fetch exitoso): *"1) Navegar a la sección de Facturación, 2) Clic en 'Generar factura
  global', 3) Aplicar filtros de fecha, 4) Filtrar por razón social, método de pago, canal de
  venta y marca según se necesite, 5) Seleccionar recibos (todos seleccionados por default),
  6) Completar campos requeridos incluyendo periodicidad, mes/año y fecha de emisión, 7)
  Confirmar."*
  Fuentes: https://parrotsoftware.zendesk.com/hc/es/articles/1500010533762-Facturaci%C3%B3n-Global
  y https://soporte.parrotsoftware.com.mx/es_MX/facturacion/generar-factura-global (este último sí
  se pudo leer con fetch directo, confirmando "Periodicidad: diaria, semanal, quincenal o
  mensual" como opciones del formulario).
- **Ventana de emisión:** *"solo cuentas con 72 hrs para emitir tu factura global"* (una vez
  seleccionado el periodo/tickets). Misma fuente.
- **Filtros disponibles en "Facturas globales":** *"búsqueda de facturas con múltiples filtros:
  por fecha, código de facturación, razón social y tipo de factura"* — con descarga masiva y
  exportación a Excel.
  Fuente: https://soporte.parrotsoftware.com.mx/es_MX/facturacion/facturas-globales (fetch
  directo exitoso).
- **Tasas mixtas dentro de la global:** **no encontré** mención explícita de cómo Parrot agrupa
  o desglosa renglones con tasas distintas dentro de una factura global — solo que selecciona
  "recibos/tickets" y arma la factura, sin detalle de agrupación por tasa.
- **Doble facturación (ambas direcciones):** ver punto 3 arriba — Parrot es el único de los dos
  productos donde encontré confirmación textual explícita en las dos direcciones (individual
  bloquea global; ticket ya en una global bloquea otra global; autofacturado queda "inactivo"
  para ambos caminos).

### 5. Cancelación / sustitución / relación 04

- Desde "Facturas emitidas": *"Editarla o cancelarla (si aplica)"* mediante el menú de tres
  puntos junto a cada factura, con filtros por origen (*"Usa el filtro de Origen para separar
  entre facturas generadas por Autofacturación o Factura general"*) y estado (*"vigentes,
  canceladas o pendientes"*).
  Fuente: https://soporte.parrotsoftware.com.mx/es_MX/facturacion/facturas-emitidas (fetch
  directo exitoso).
- **No encontré** mención explícita de si Parrot soporta relación tipo 04 (sustitución) al
  cancelar, ni si pide el UUID del sustituto. El mecanismo de "liberar ticket" descrito en el
  punto 3 (cancela la factura autofacturada para permitir una nueva) es el comportamiento más
  cercano documentado a una sustitución, pero no está descrito con el vocabulario fiscal
  "relación 04" en ninguna fuente que pude leer.

### 6. Notas de crédito / devoluciones

**No encontré** ningún artículo de Parrot (en ninguno de sus dos centros de ayuda) sobre emisión
de CFDI de egreso / notas de crédito para reembolsos, ni cómo determinan el IVA del reembolso
(si toma el de la factura original o es proporcional). Ninguna búsqueda dirigida devolvió
contenido de Parrot sobre este tema — solo resultados genéricos de terceros no relacionados con
el producto.

### 7. Delivery apps (Uber Eats, Rappi, DiDi)

Parrot documenta la integración de pedidos de forma más rica que SoftRestaurant en su propio
sitio comercial (no su centro de ayuda técnico):

- *"El software permite conectar con Uber Eats, Rappi, DiDi Food, OpenTable y más desde el día
  uno."* Y: *"Los pedidos llegan automáticamente al POS y a la pantalla de cocina sin captura
  manual ni tablets extra."*
  Fuente: https://parrotsoftware.com.mx/blog/como-integrar-uber-eats-rappi-didi-restaurante
- **Facturación en 60 segundos vía QR** se menciona como feature general del producto (*"el
  sistema permite la facturación automática en 60 segundos mediante un código QR en el
  recibo"*), pero no until until until pude confirmar si esto aplica específicamente a un pedido
  que llegó vía Uber Eats/Rappi/DiDi (con su propio ticket) o solo a ventas de mostrador/mesa.
- **¿Factura el pedido de delivery al cliente final?** No encontré documentación específica de
  Parrot sobre esto. Mismo contexto de mercado general aplicable (Uber Eats emite su propio
  recibo, no una factura fiscal — la factura, si existe, la coordina el restaurante).

### 8. "La factura debe cuadrar con lo cobrado" / bloqueo por datos inconsistentes

**Encontrado, aunque indirecto:** el mecanismo de "liberar ticket" (que **cancela** la factura
generada antes de permitir facturar de nuevo, en vez de dejar coexistir dos comprobantes del
mismo ticket) es, en esencia, una salvaguarda para que nunca haya más de un CFDI vigente por
ticket — la forma en que Parrot evita que la factura "no cuadre" con la venta real es impidiendo
la duplicidad en la fuente, no revalidando montos en tiempo de emisión. No encontré una regla
explícita del tipo "si el importe del ticket cambió, la factura se bloquea" — la protección
documentada es contra **duplicar**, no contra **inconsistencia de monto**.

---

## Patrón común / diferencias entre SoftRestaurant y Parrot

1. **Ambos ofrecen el mismo patrón de mercado para autofactura**: QR en el ticket → portal web →
   el cliente captura sus datos fiscales (RFC, régimen, CP) → recibe XML/PDF. Ninguno de los dos
   muestra en su documentación pública si el ticket ya facturado permite reintentos con datos
   distintos del catálogo — el único de los dos que documenta explícitamente el candado
   anti-duplicado es **Parrot** (con su mecánica de "liberar ticket" = cancelar antes de
   re-emitir).
2. **Ambos usan periodicidad configurable para la factura global** (diaria/semanal/mensual —
   Parrot añade explícitamente "quincenal"), y ambos usan el RFC genérico de público en general
   por default cuando no hay datos fiscales.
3. **Diferencia notable:** Parrot es explícito en que el candado de "días para autofacturar" (ej.
   40 días) **solo limita al cliente**, nunca al negocio, que puede meter el ticket a la global
   "en el momento que desees" mientras no haya entrado ya a OTRA global. SoftRestaurant menciona
   una ventana de corrección de 15 días del mes siguiente para "público en general → con RFC",
   que es un concepto distinto (corregir la factura global emitida, no re-facturar un ticket
   suelto).
4. **Ninguno de los dos documenta públicamente**, de forma clara y accesible sin sesión
   autenticada: (a) la pantalla de configuración de IVA por producto/categoría con sus opciones
   exactas (16/8/0/exento/no objeto), (b) el efecto de cambiar el IVA de un producto sobre ventas
   ya hechas, (c) notas de crédito / CFDI de egreso para devoluciones y cómo determinan el IVA del
   reembolso, ni (d) cómo facturan (o no) específicamente los pedidos que llegan por Uber
   Eats/Rappi/DiDi. Esto probablemente vive detrás del login del producto o en manuales PDF
   completos no indexados/accesibles vía fetch anónimo — no es evidencia de que la funcionalidad
   no exista, solo de que no está documentada públicamente de forma legible por este método.
5. **Relación 04 / sustitución de CFDI:** ninguno de los dos productos tiene, en las fuentes que
   pude leer, una confirmación explícita y textual de soportar la relación 04. SoftRestaurant
   SÍ tiene un artículo dedicado a "Motivos de Cancelación 02-03-04" (nombre que sugiere que sí
   cubre el flujo estándar del SAT), pero no pude leer su contenido completo para confirmar el
   detalle de UI.

## Preguntas que NO pude contestar (para ninguno de los dos productos)

- Pantalla/campo exacto donde se configura el IVA de un producto (per-producto vs per-categoría
  vs default-de-negocio-con-excepción) y si la UI distingue "tasa 0" de "exento" como opciones
  separadas o como una sola.
- Efecto de cambiar el IVA de un producto sobre ventas ya realizadas pero no facturadas
  (autofactura días después, o en la próxima global).
- Efecto sobre ventas ya facturadas.
- Soporte real de tasas mixtas dentro de un mismo ticket al facturar (individual o global).
- Notas de crédito / CFDI de egreso: si se emiten, cómo determinan el IVA del reembolso (de la
  factura original vs. proporcional), y qué restricciones existen.
- Si relación 04 (sustitución) está soportada explícitamente por el producto (más allá de existir
  como concepto general del SAT).
- Si los pedidos de Uber Eats/Rappi/DiDi se facturan al cliente final desde el propio POS, y si
  esos pedidos (que suelen venir con comisión de la plataforma) se tratan distinto fiscalmente.
- Cualquier mecanismo explícito de "bloquear la facturación si los datos no cuadran con lo
  cobrado" más allá del candado anti-duplicado de Parrot.

## Fuentes consultadas (lista completa)

- https://soporte.parrotsoftware.com.mx/facturacion
- https://soporte.parrotsoftware.com.mx/es_MX/facturacion/generar-factura-global
- https://soporte.parrotsoftware.com.mx/es_MX/facturacion/facturas-globales
- https://soporte.parrotsoftware.com.mx/es_MX/facturacion/facturas-emitidas
- https://soporte.parrotsoftware.com.mx/es_MX/colecciones/habilita-la-facturacion-para-tus-clientes
- https://soporte.parrotsoftware.com.mx/es_MX/inventarios
- https://parrotsoftware.zendesk.com/hc/es/articles/1500010591642-Configuraci%C3%B3n-de-Facturaci%C3%B3n
- https://parrotsoftware.zendesk.com/hc/es/articles/1500010533762-Facturaci%C3%B3n-Global
- https://parrotsoftware.zendesk.com/hc/es/articles/1500007861882-Auto-Facturaci%C3%B3n
- https://parrotsoftware.zendesk.com/hc/es/sections/360004218033-Facturaci%C3%B3n
- https://parrotsoftware.zendesk.com/hc/es/articles/27617210487827-Creaci%C3%B3n-de-art%C3%ADculos-categor%C3%ADas-y-grupos-modificadores
- https://parrotsoftware.com.mx/blog/como-integrar-uber-eats-rappi-didi-restaurante
- https://softrestaurant.com/yoquieroautofactura
- https://softrestaurant.com/cfdi
- https://softrestaurant.com/integraciones
- https://softrestaurant.com/manuales
- https://academia.softrestaurant.com/courses/soft-restaurant-addons-auto-factura/
- https://softrestaurant.zohodesk.com/portal/es/kb/nationalsoft/soft-restaurant/facturaci%C3%B3n-electronica
- https://softrestaurant.zohodesk.com/portal/es/kb/articles/manual-de-implementaci%C3%B3n-analytics-autofactura-soft-restaurant-12
- https://softrestaurant.zohodesk.com/portal/es/kb/articles/3-motivos-de-cancelaci%C3%B3n-02-03-04
- https://softrestaurant.zohodesk.com/portal/es/kb/articles/opciones-de-productos-importar-y-eliminar
- https://help.uber.com/en/ubereats/restaurants/article/c%C3%B3mo-obtengo-la-factura-de-mi-pedido (contexto de mercado, no del producto)
