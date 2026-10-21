# Investigación en vivo: IVA por producto y facturación CFDI 4.0 en Fudo, Alegra, eleventa (y Clip, parcial)

Fecha de la investigación: 2026-09-26. Todas las fuentes fueron consultadas en esta sesión (WebSearch / WebFetch en vivo). Se marca explícitamente cuándo una afirmación viene de una cita textual verificada con `WebFetch` directo (alta confianza) contra cuándo viene sólo de un resumen sintetizado por `WebSearch` sobre snippets/caché de Google (confianza media — no se pudo verificar la cita exacta, normalmente porque el centro de ayuda del producto renderiza el cuerpo del artículo con JavaScript y las herramientas de fetch disponibles sólo devuelven el HTML de navegación).

---

## 1. Fudo (soporte.fu.do / fu.do)

🔴 **Limitación técnica descubierta en esta sesión:** el centro de ayuda de Fudo (`soporte.fu.do`, construido sobre Next.js + Intercom Help Center) **no embebe el cuerpo del artículo en el HTML inicial** — se confirmó inspeccionando el JSON `__NEXT_DATA__` de tres artículos distintos (`configurar-impuestos-a-los-productos`, `mexico-emision-de-facturas-electronicas`, `emitir-fac-autofacturacion-mx`): el payload trae sólo metadatos de la app, cookie banner y la navegación lateral completa del sitio, nunca el texto del artículo. Se probó también vía proxy `r.jina.ai` (mismo resultado) y vía la ruta `_next/data/<buildId>/...json` de Next.js (devolvió 204 sin contenido). El cuerpo se carga con una llamada cliente-servidor posterior (probablemente a la API de Intercom con headers de sesión) que ninguna herramienta disponible en esta sesión pudo reproducir. Esto coincide con una limitación **ya documentada por este mismo workspace** (`.claude/rules/product-decisions-industry-reference.md`: *"el cuerpo del artículo se dibuja con JavaScript y WebFetch/jina sólo devuelven la navegación"*, referido a Fudo).

Por eso las respuestas de Fudo abajo son más débiles que las de Alegra/eleventa — se apoyan en snippets de búsqueda (Google indexa una versión pre-renderizada), no en el texto completo verificado.

### 1. IVA per product
**Confirmado (navegación, título del artículo):** existe un artículo dedicado "Configurar impuestos a los productos" (`https://soporte.fu.do/es/articles/12703601-configurar-impuestos-a-los-productos`) listado bajo la sección "Productos" del centro de ayuda — o sea, la configuración de impuestos SÍ vive a nivel de producto individual, no sólo a nivel de negocio. **No encontré** (no se pudo leer el cuerpo) el detalle de si maneja tasa 0/8/16/exento/no objeto como opciones separadas, ni si distingue tasa 0 de exento.

### 2. Cambiar el IVA de un producto después de tener ventas
**No encontré.** Ninguna búsqueda ni fetch devolvió contenido específico de Fudo sobre este punto.

### 3. Factura individual desde un ticket / portal de autofacturación
**Evidencia de snippet (confianza media, no verificado con cita exacta):** según el resumen de búsqueda sobre `https://soporte.fu.do/docs/emitir-fac-autofacturacion-mx`, el cliente ingresa el código impreso en su ticket, llena sus datos fiscales y pulsa "Emitir factura"; **"once a ticket has been invoiced, there is no re-invoicing option"** — es decir, un ticket ya facturado no se puede volver a facturar por el portal. No se pudo verificar si usa los datos guardados al momento de la venta o el catálogo vigente, ni si tolera tasas mixtas en un mismo ticket.
Fuente: [soporte.fu.do/docs/emitir-fac-autofacturacion-mx](https://soporte.fu.do/docs/emitir-fac-autofacturacion-mx) (vía snippet de búsqueda, cuerpo no accesible directamente).

### 4. Factura global
**No encontré contenido propio de Fudo.** Las búsquedas sobre "Fudo factura global México" devolvieron sólo contenido genérico de terceros y, por error de superposición de resultados, contenido de Alegra (ver abajo) — se descarta explícitamente esa mezcla. Un snippet de búsqueda sí afirma en general que *"Fudo supports the issuance of electronic invoices respecting CFDI version 4.0 regulations in Mexico... to issue electronic invoices through Fudo it is necessary to acquire an additional 'CFDI' module, which has an additional cost"*, y que puede seleccionarse "Público general" al facturar — pero sin detalle de periodicidad, generación manual/automática, ni manejo de tasas mixtas.

### 5. Cancelación / sustitución (relación 04)
**No encontré** contenido específico de Fudo. (Existe el artículo "México - Facturación Electrónica: Errores" en el índice del centro de ayuda, pero su cuerpo no fue accesible.)

### 6. Notas de crédito / devoluciones
**No encontré** contenido específico de Fudo para México. (Sí existe, y es simétrico, un artículo de Argentina — "Argentina: emisión de notas de crédito electrónicas" — lo que sugiere que el módulo de notas de crédito de Fudo es primero-Argentina y no está necesariamente replicado para México; esto es inferencia, no una cita.)

### 7. Apps de delivery (Uber Eats, Rappi, DiDi)
**Evidencia de snippet (confianza media):** *"Fudo receives orders from Rappi, Uber Eats, iFood and other regional delivery platforms"* y *"sales from Rappi, Uber Eats, iFood, DiDi Food or any delivery platform that goes through Fudo also accumulate points if the customer is registered"* — o sea, Fudo integra el PEDIDO de estas apps al POS (y a su programa de lealtad), pero **no encontré** ninguna mención de cómo se factura fiscalmente esa venta (dato relevante de mercado, no específico de Fudo: ver sección de patrón común — la app de delivery normalmente sólo timbra su propia comisión y el restaurante sigue siendo responsable de facturar el alimento al consumidor).

### 8. Bloqueo de facturación por datos inconsistentes
**No encontré** contenido específico de Fudo.

---

## 2. Alegra POS / Alegra Facturación México (ayuda.alegra.com)

Fue el producto mejor documentado en esta sesión — su centro de ayuda sirve HTML con el cuerpo del artículo accesible por `WebFetch` (a diferencia de Fudo), lo que permitió citas textuales verificadas.

### 1. IVA per product
**Confirmado, per-item, con opción tasa 0 explícita** (verificado por `WebFetch` en un fetch anterior a esta sesión de investigación puntual — repetido y confirmado con búsquedas nuevas hoy): *"Para poder emitir correctamente facturas con IVA 0%, es obligatorio configurar previamente un ítem con IVA 0%... esta configuración se realiza desde el módulo de Ítems, donde puedes crear o editar un producto y asignarle IVA 0%."* Distingue explícitamente exento de tasa 0 en su documentación general (Colombia, pero mismo motor de impuestos): *"un bien exento está gravado con tarifa 0% y permite al productor recuperar el IVA pagado en sus insumos... mientras que un bien excluido simplemente está fuera del campo de aplicación del impuesto."*
Fuente: [ayuda.alegra.com/int/crea-impuestos-a-la-medida-de-tu-negocio](https://ayuda.alegra.com/int/crea-impuestos-a-la-medida-de-tu-negocio) + snippet de búsqueda sobre esa misma colección (el fetch directo de la versión `/int/` genérica no mostró el detalle de México — la separación tasa-0/exento con ObjetoImp específico de México ya estaba confirmada por una investigación anterior del propio equipo, referenciada en `product-decisions-industry-reference.md`, y no se repitió el fetch exacto hoy por límite de tiempo).
🔴 **No verificado hoy con cita exacta de México:** si es "producto → categoría → default del negocio" en cascada, o sólo producto+catálogo plano. **No encontré** ese detalle jerárquico explícito.

### 2. Cambiar el IVA de un producto después de tener ventas
**Confirmado (cita exacta, aunque aplicada literalmente a "cantidad inicial" y "costo unitario" en la plantilla de carga masiva, no nombra "IVA" en ese renglón exacto):**
> *"Importante: debes estar seguro de cambiar estos datos, al ser valores iniciales podrían afectarse los resultados de las consultas asociadas a los productos vendidos anteriormente."*
Fuente: [ayuda.alegra.com/es/actualiza-masivamente-tus-productos-en-alegra-contabilidad-méxico](https://ayuda.alegra.com/es/actualiza-masivamente-tus-productos-en-alegra-contabilidad-m%C3%A9xico)
Interpretación honesta: Alegra advierte que cambiar valores "iniciales" de un producto (que en ese artículo son cantidad/costo, pero el patrón de diseño — un dato que se congela al vender — es el mismo que se espera para IVA) **puede afectar los REPORTES/consultas sobre lo ya vendido**, pero el texto no dice si una factura YA TIMBRADA cambia de monto — un CFDI timbrado es inmutable por definición del SAT, así que es razonable inferir (no confirmado textualmente) que el efecto es sólo sobre reportes internos y sobre las próximas facturas, nunca sobre el XML ya sellado. **No encontré** una declaración explícita de Alegra sobre si una autofactura PENDIENTE (ticket vendido pero aún no facturado) usa la tasa vigente al momento de facturar o la vigente al momento de la venta.

### 3. Factura individual desde un ticket ("Convertir ticket en factura")
**Confirmado con cita exacta, y responde directamente la pregunta 3 y parte de la 4:**
> *"la información del ticket (productos, cantidades, precios, etc.) no puede modificarse al convertirlo."*
— es decir, usa los datos **congelados en el ticket al momento de la venta**, no el catálogo vigente.

Condiciones para poder convertir un ticket en factura electrónica (parafraseadas del cuerpo, en español en el original): debe estar **pagado**, **no haber sido convertido previamente** a factura, **no estar cancelado**, y —el dato clave para la pregunta 4— **"No estar incluido en una factura global."**
Fuente: [ayuda.alegra.com/int/convierte-tickets-de-venta-en-facturas-electronicas-mex](https://ayuda.alegra.com/int/convierte-tickets-de-venta-en-facturas-electronicas-mex)

**No encontré** si tolera tasas mixtas (16%/0%/exento) dentro del mismo ticket al convertirlo — el artículo no lo menciona ni a favor ni en contra.

### 4. Factura global
**Confirmado, generación MANUAL, periodicidad configurable, y con la regla anti-doble-conteo en AMBAS direcciones:**
> *"Ve a Ingresos > Facturas Globales > Nueva factura global. Completa el formulario y selecciona los Tickets que deseas facturar."*
> *"La factura global puede emitirse de forma: Diaria, Semanal o mensual (según el régimen fiscal aplicable)."* Y: *"La periodicidad debe cumplir con las disposiciones vigentes de la autoridad fiscal."*
> *"No uses factura global para ventas a clientes con datos fiscales completos."*
> *"La factura global no reemplaza a una factura CFDI común cuando un cliente sí proporciona datos fiscales completos."*
Fuente: [ayuda.alegra.com/mex/timbrar-facturas-globales](https://ayuda.alegra.com/mex/timbrar-facturas-globales)

Combinado con el hallazgo de la pregunta 3 (**"No estar incluido en una factura global"** bloquea la conversión individual de un ticket), Alegra cierra el círculo completo: un ticket **YA facturado individualmente** no puede volver a facturarse (dirección 1, confirmado: "no haber sido convertido previamente"), y un ticket **YA incluido en una factura global** tampoco puede facturarse individual después (dirección 2, confirmado explícitamente). **No encontré**, sin embargo, cómo maneja tasas mixtas (16%/0%/exento) DENTRO de una misma factura global que agrupa varios tickets de productos con distinta tasa — el artículo no lo trata.

### 5. Cancelación / sustitución (relación 04)
**Confirmado con citas exactas:**
> *"Debe ser sustituida por un nuevo CFDI, el cual debe estar vinculado a la factura a cancelar"* (motivo 01, con relación).
> *"La cancelación debe hacerse a más tardar el 31 de enero del año siguiente al de emisión."*
> *"En Alegra, al indicar en el campo Sustitución CFDI previos la factura a cancelar, se activará automáticamente el motivo 01 - Comprobante emitido con errores con relación después de 5 minutos."*
Fuente: [ayuda.alegra.com/mex/sustituir-y-cancelar-facturas-con-errores-con-relacion](https://ayuda.alegra.com/mex/sustituir-y-cancelar-facturas-con-errores-con-relacion)

Esto responde la pregunta 5 (¿se puede re-facturar el ticket de una factura cancelada?): **sí** — el flujo estándar de Alegra para corregir una factura ES precisamente cancelarla y emitir una nueva ligada con relación 04 sobre el MISMO ticket/venta original. Alegra automatiza el motivo de cancelación cuando detecta que ya se indicó una sustitución.

Sobre las notas de crédito mismas (no la factura original), Alegra también soporta sustituirlas/cancelarlas con la MISMA mecánica (motivo 04, deadline distinto — 30 días naturales en vez de 31-ene):
> *"Este motivo se utiliza cuando la nota de crédito presenta errores en producto, valor, descuento u otro dato."*
> *"La sustitución debe realizarse dentro de los 30 días naturales siguientes a la emisión."*
> *"Una nota de crédito no cancela el CFDI de ingreso al que está vinculada"* — la factura original sigue vigente y hay que cancelarla aparte si se quiere anular del todo.
Fuente: [ayuda.alegra.com/mex/como-sustituir-y-cancelar-las-notas-credito](https://ayuda.alegra.com/mex/como-sustituir-y-cancelar-las-notas-credito)

### 6. Notas de crédito / devoluciones
**Confirmado (vía snippet de búsqueda sobre varias páginas de ayuda.alegra.com, sin cita textual exacta verificada por fetch propio hoy):** *"las notas de crédito que se utilicen para hacer la devolución de mercancía, descuentos o bonificaciones en el precio o para disminuir el ingreso por la totalidad de un CFDI que ya se haya timbrado, deberán hacerse por medio de un CFDI de egreso"* — Alegra sigue la regla estándar del SAT (CFDI 4.0: nota de crédito = CFDI tipo Egreso relacionado con tipo 01 al CFDI de ingreso original).

**Sobre cómo se determina el IVA del reembolso — verificado con fetch directo, resultado NEGATIVO/parcial:** el formulario de nota de crédito en Alegra pide **"escribe el valor total de la nota de crédito"** — es decir, el monto (y por extensión su desglose de impuestos) parece **capturarse/calcularse en el formulario de la nota**, no derivarse automáticamente y de forma bloqueada del renglón original. **No encontré** una declaración explícita de si el sistema limita el monto de la nota a no exceder el saldo de la factura original, ni si el IVA se prorratea automáticamente por renglón o se recalcula sobre el total ingresado.
Fuente: [ayuda.alegra.com/mex/notas-de-credito](https://ayuda.alegra.com/mex/notas-de-credito)

### 7. Apps de delivery (Uber Eats, Rappi, DiDi)
**No encontré** ningún artículo de Alegra sobre facturar pedidos de Uber Eats/Rappi/DiDi específicamente. Contexto de mercado (no específico de Alegra, aplica a los cuatro productos por igual): Uber Eats y DiDi Food sólo timbran su propia comisión de intermediación al restaurante; **la comida la sigue facturando el restaurante directamente al consumidor final**, y Rappi ni siquiera emite su propio CFDI de la venta — según sus Términos y Condiciones el usuario debe pedir la factura de la comida directamente al negocio. Esto implica que, para efectos de un POS como Avoqado/Alegra, una venta de delivery ES una venta normal del catálogo (con su IVA por producto normal) y NO requiere un tratamiento fiscal especial más allá de la facturación estándar — la única pieza "especial" es la comisión que la plataforma le cobra al negocio, que es un gasto/CFDI recibido, no un ingreso.

### 8. Bloqueo de facturación por datos inconsistentes
**Confirmado (snippet, medio-alta confianza — coincide con patrón esperado de un timbrador CFDI 4.0):** *"Si un ítem aparece en gris, eso quiere decir que Alegra no lo encontró en tu catálogo. Debes seleccionarlo o crearlo manualmente antes de timbrar."* — es decir, Alegra bloquea/exige resolver manualmente un producto sin clave SAT asociada ANTES de poder timbrar la factura, en vez de timbrar con datos incompletos o inventados.

---

## 3. eleventa (eleventa.com/aprender/*)

El centro de ayuda de eleventa también sirvió contenido legible por `WebFetch` (a diferencia de Fudo), aunque varios artículos resultaron más operativos/superficiales que los de Alegra.

### 1. IVA per product
**Confirmado, configuración por producto, con casillas de selección (implica que un producto puede tener MÁS de un impuesto marcado, o ninguno):**
> *"Abre el producto que deseas crear o modificar"* → *"Entra en la pestaña Impuestos"* → *"Marca las casillas correspondientes según el tipo de impuesto que aplique."*
> *"Verifica que la pestaña muestre entre paréntesis el número de impuestos asignados"* (para confirmar la configuración antes de facturar).
Fuente: [eleventa.com/aprender/configurando-productos-para-facturar](https://eleventa.com/aprender/configurando-productos-para-facturar)

Los impuestos en sí (16%, 8%, 0%, exento) se configuran primero, aparte, en "Configuración → Personalización → Impuestos", y luego se ASIGNAN por producto — es decir, el modelo es: catálogo de impuestos a nivel negocio + asignación por producto (no hay evidencia de un "default del negocio" implícito que aplique automáticamente salvo excepción; cada producto necesita su casilla marcada explícitamente).

Sobre tasa 0 vs exento — encontrado en snippet de búsqueda sobre resultados de eleventa.com (medio-alta confianza, coincide con la doctrina fiscal estándar que cualquier producto mexicano de facturación debe implementar): *"Tanto el IVA exento como el IVA al 0% implican que no se aplica el Impuesto al Valor Agregado en las ventas. Sin embargo, en el caso del IVA al 0%, el contribuyente puede acreditar el IVA pagado en la adquisición de esos bienes o servicios."* — o sea, eleventa SÍ distingue las dos como conceptos separados en su documentación (no los trata como sinónimos).

### 2. Cambiar el IVA de un producto después de tener ventas
**No encontré** contenido específico. El único hallazgo relacionado con precios/impuestos y cambios fue la actualización "Precios con Impuestos y Cobros Mixtos" (2026), que sólo documenta la funcionalidad de **capturar precios ya incluyendo impuesto** (*"Ahora podrás ingresar tus precios con impuestos incluidos al crear o modificar cualquier producto"* y ver "los precios netos desde el apartado de búsqueda y los diversos reportes") — no aborda el efecto retroactivo de cambiar la tasa de un producto sobre ventas o autofacturas pendientes.
Fuente: [eleventa.com/blog/facturacion-electronica-mejorada-precios-con-impuestos-y-cobros-mixtos](https://eleventa.com/blog/facturacion-electronica-mejorada-precios-con-impuestos-y-cobros-mixtos)

### 3. Factura individual desde un ticket / catálogo vigente vs. datos del ticket
**No encontré** una declaración explícita sobre si eleventa usa los datos del ticket al momento de la venta o el catálogo vigente al facturar. Es un hueco real en la documentación pública consultada hoy.

### 4. Factura global
**Confirmado, generación manual con selección de tickets, y periodicidad amplia (más opciones que Alegra):**
> *"Facturas globales generated by eleventa can be issued weekly or monthly, and when generating a global invoice, you can select which tickets to include or adjust the total amount of the global invoice according to your administrative needs."* (snippet de búsqueda sobre eleventa.com, no verificado con fetch directo del artículo específico por límite de tiempo).
La periodicidad del régimen mexicano en general admite diario/semanal/quincenal/mensual/bimestral (dato genérico del SAT, no específico de eleventa, útil como contexto). **No encontré** cómo eleventa maneja tasas mixtas dentro de la factura global.

### 5. Cancelación / sustitución (relación 04) y re-facturación
**Confirmado con cita exacta — y es el hallazgo más útil de eleventa para las preguntas 4 y 5 juntas:** eleventa tiene CUATRO motivos de cancelación en su UI, y uno de ellos es exactamente el escenario de "sacar un ticket de la factura global para facturarlo individual":
> *"Se necesita cancelar la factura global para facturar una venta individual"* — permite pasar de factura global a factura nominativa (motivo de cancelación dedicado a este caso).
> *"eleventa enviará la solicitud de cancelación al cliente, quien deberá aprobarla."*
> *"al emitir la nueva factura se generará el costo de un timbre adicional"* — confirma explícitamente que **SÍ se puede volver a facturar** el ticket/venta después de cancelar (con el costo de un timbre nuevo).
Los otros tres motivos: *"La factura tenía errores y fue reemplazada"*, *"La factura tenía errores, pero no fue reemplazada"*, *"No se llevó a cabo la operación o venta."*
Fuente: [eleventa.com/aprender/cancelacion-de-facturas](https://eleventa.com/aprender/cancelacion-de-facturas)

🔑 Esto es un dato valioso para Avoqado: eleventa es el ÚNICO de los tres productos investigados hoy que documenta explícitamente, con un motivo de cancelación DEDICADO, el caso "ya está en una factura global y ahora el cliente pide su factura individual" — resolviéndolo con cancelación + re-emisión, no con una operación de "extracción" silenciosa del ticket de la global.

### 6. Notas de crédito / devoluciones
**Parcial / débil:** la página operativa de devoluciones de eleventa sólo documenta el flujo de POS (*"Devolver artículo seleccionado"*, con la recomendación *"En pagos con tarjeta, transferencia o cheque, te recomendamos hacer la devolución en efectivo desde caja"*) y **no menciona la generación de un CFDI de egreso o nota de crédito** en esa misma página — sugiere que, si existe, vive en un módulo/artículo de facturación separado que no localicé hoy.
Fuente: [eleventa.com/aprender/ventas-devoluciones-y-cancelaciones](https://eleventa.com/aprender/ventas-devoluciones-y-cancelaciones)
**No encontré** cómo se determina el IVA del reembolso en eleventa.

### 7. Apps de delivery
**No encontré** nada específico de eleventa. Aplica el mismo contexto de mercado general descrito en la sección de Alegra (la plataforma sólo timbra su comisión; el negocio sigue facturando la venta al consumidor con el motor normal de IVA por producto).

### 8. Bloqueo de facturación por datos inconsistentes
**No encontré** una declaración explícita, aunque el requisito de asignar la clave de producto SAT antes de facturar (mencionado de forma genérica: *"cumple con los requisitos del CFDI 4.0 asignando correctamente las claves del catálogo oficial del SAT"*) sugiere el mismo patrón que Alegra (bloqueo/aviso si falta el dato), sin confirmarlo textualmente.

---

## 4. Clip (clip.mx) — investigación parcial, fuera del foco principal por límite de tiempo

Con el tiempo restante sólo se hizo una búsqueda superficial. Hallazgos, todos de baja confianza (snippets genéricos, ninguna cita verificada contra el propio sitio de ayuda de Clip):

- Existe un producto "Clip Digital" con "catálogo de clientes, productos y empleados, con licencias SAT y actualizaciones del sistema incluidas" y respaldo de información "por 5 años", facturación desde el celular. Fuente (snippet): clip.mx / clipdigital.mx.
- **No encontré** nada específico de Clip sobre IVA por producto, tasa 0 vs exento, factura global, notas de crédito, sustitución, ni apps de delivery. Esto es una laguna de esta investigación (falta de tiempo), no evidencia de que Clip no lo tenga.

---

## Patrón común / diferencias

1. **El IVA sí se configura por producto en los tres productos verificables (Alegra, eleventa; Fudo probablemente también pero sin poder confirmarlo con cita).** Ninguno documenta explícitamente un modelo "default del negocio + excepción por producto" — el patrón visible es más bien "catálogo de impuestos a nivel negocio (16/8/0/exento como conceptos ya creados) + asignación explícita por producto", coincidiendo con lo que ya había encontrado este mismo workspace para Alegra/CONTPAQi/Parrot el 24-sep (ObjetoImp inferido de la elección, no pedido al usuario).
2. **Tasa 0 y exento se tratan como conceptos DISTINTOS en Alegra y eleventa** (ambos documentan explícitamente la diferencia de acreditamiento), consistente con el hallazgo previo del workspace.
3. **La factura individual desde un ticket usa los datos CONGELADOS en el ticket al momento de la venta, nunca el catálogo vigente** — esto quedó confirmado con cita textual exacta para Alegra (*"la información del ticket... no puede modificarse al convertirlo"*) y es coherente con que un CFDI, una vez timbrado, es inmutable por regla del SAT. Es razonable asumir el mismo comportamiento en Fudo y eleventa aunque no se pudo verificar textualmente en ninguno de los dos.
4. **La factura global es de generación MANUAL (nunca automática) y con periodicidad configurable (diaria/semanal/mensual, a veces quincenal/bimestral)** en Alegra y eleventa — el usuario selecciona explícitamente qué tickets agrupar, no hay una tarea de fondo que decida sola.
5. **La regla anti-doble-facturación (ticket no puede estar en una factura global Y en una individual a la vez) está resuelta de forma distinta pero convergente:**
   - **Alegra**: lo previene hacia adelante — un ticket ya incluido en una factura global queda explícitamente bloqueado para conversión individual (*"No estar incluido en una factura global"* es una condición dura).
   - **eleventa**: lo resuelve hacia atrás — si un ticket YA está en una factura global y el cliente pide su factura individual después, eleventa tiene un motivo de cancelación DEDICADO para sacarlo de la global (cancelar + re-facturar individual, con costo de timbre extra).
   Ningún producto documenta qué pasa si dos personas intentan facturar el mismo ticket simultáneamente por las dos vías (condición de carrera) — no se investigó ni se encontró.
6. **La corrección de una factura con error usa el mismo patrón CFDI 4.0 estándar en los tres (hasta donde se pudo verificar): cancelar + reemitir con relación 04 (sustitución), nunca "editar" la factura viva.** Alegra automatiza la detección del motivo 01 cuando se indica la sustitución.
7. **Las devoluciones/reembolsos usan CFDI de egreso (nota de crédito) relacionado tipo 01, siguiendo la norma del SAT** — confirmado explícitamente para Alegra vía snippet; para eleventa sólo se encontró el flujo operativo de POS sin el puente documental hacia el CFDI de egreso.
8. **Ninguno de los tres productos investigados documenta públicamente un tratamiento fiscal especial para pedidos de Uber Eats/Rappi/DiDi.** Esto probablemente refleja la realidad del mercado mexicano: la plataforma de delivery sólo timbra su PROPIA comisión al negocio (un CFDI recibido/gasto), mientras que la venta de comida al consumidor la sigue facturando el negocio con su motor normal de POS — o sea, **no hay ninguna "integración fiscal" especial que construir para pedidos de delivery más allá de tratarlos como una venta normal del catálogo con su IVA por producto normal.** Esto es evidencia de mercado (no específica de un producto) reunida de fuentes fiscales/contables generales, no de la documentación de los POS mismos.
9. **El bloqueo por datos inconsistentes existe al menos en Alegra** (ítem sin clave SAT aparece en gris y se debe resolver antes de timbrar) — comportamiento esperado y probablemente compartido por los demás, aunque sólo se pudo confirmar textualmente para Alegra.
10. **Diferencia notable de calidad documental:** Alegra y eleventa sirven el cuerpo del artículo de forma accesible (HTML normal); **Fudo renderiza el cuerpo por JavaScript del lado del cliente**, lo que hace su documentación pública mucho más difícil de auditar desde fuera (ninguna herramienta de fetch disponible hoy pudo leer el texto real de sus artículos, sólo títulos y navegación). Esto es un dato operativo sobre "qué tan auditable es la competencia", no sobre el producto en sí.

## Preguntas sin responder (honestas)

- **Fudo**: prácticamente todas las preguntas 1-8 quedaron sin cita textual verificada, por el bloqueo de JavaScript del centro de ayuda. Sólo se pudo confirmar, de forma indirecta: que existe configuración de impuestos por producto (título del artículo), que exige un módulo CFDI de pago, que el portal de autofacturación no permite re-facturar un ticket ya facturado (snippet), y que integra pedidos de Rappi/Uber Eats/DiDi Food al POS y a lealtad (snippet) sin detalle fiscal.
- **Alegra**: no se encontró (a) la jerarquía exacta producto/categoría/default del negocio para asignar IVA, (b) si tolera tasas mixtas dentro de un mismo ticket o de una misma factura global, (c) si el monto/IVA de una nota de crédito se limita automáticamente a no exceder la factura original o se prorratea por renglón, (d) tratamiento específico de pedidos de delivery.
- **eleventa**: no se encontró (a) si usa datos del ticket o del catálogo vigente al facturar individualmente, (b) manejo de tasas mixtas en factura global, (c) el puente documental entre "Devolver artículo" y la emisión de un CFDI de egreso/nota de crédito, (d) cómo se determina el IVA del reembolso, (e) tratamiento de pedidos de delivery.
- **Clip**: investigación casi completa pendiente — no se alcanzó a revisar ninguna de las 8 preguntas con evidencia específica del producto por límite de tiempo.
- **Ninguno de los cuatro**: comportamiento ante condición de carrera (dos personas facturando el mismo ticket por dos vías a la vez); si el sistema BLOQUEA activamente (código de error) editar el IVA de un producto con ventas pendientes de autofactura, o sólo lo permite con una advertencia pasiva.
