# Auditoría de permisos del POS — informe para el founder

---

## 1. Respuesta directa

**No es un caso aislado: es un patrón.** Encontré **17 endpoints** con el mismo defecto de fondo — a la gente de piso se le exige un permiso
de _administrar_ un recurso para poder _usarlo_ en su trabajo diario.

Y el caso del cajero con `tpv:read` **no es ni el peor**. Hay dos peores: con la configuración de fábrica, **un cajero no puede abrir ni
cerrar su turno en la TPV** — y sin turno abierto, la terminal deja "Cobrar", "Mesas" y "Órdenes" apagados.

---

## 2. Tabla de hallazgos, ordenada por daño real

### 🔴 Nivel 1 — El local no puede operar

| #   | Quién se queda parado | Pantalla / momento                                          | Permiso que le piden                        | Qué pasa de verdad                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------- | ----------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CASHIER y WAITER      | TPV → Turnos → **Abrir turno**                              | `shifts:create`                             | Botón apagado: "No tienes permiso para abrir turnos". Y con turnos activados (**el default**), la Home deja _Cobrar / Pago rápido / Órdenes / Mesas_ deshabilitados con "Abre el turno primero". **Nadie más puede abrirlo:** no existe ningún otro endpoint para abrir turno en toda la plataforma — ni desde el dashboard web. Un gerente tiene que **venir físicamente** a la terminal. Y la TPV **no tiene el PIN de gerente** que sí tienen Android e iOS. |
| 2   | CASHIER y WAITER      | TPV → Turnos → **Cerrar turno** (con el conteo de efectivo) | `shifts:close`                              | No pueden hacer su corte ni entregar caja. El turno queda abierto: los cobros del siguiente cajero caen sin turno asignado y se pierde el conteo físico — que es justo el dato para saber de quién es un faltante. Tampoco hay cierre remoto desde el dashboard.                                                                                                                                                                                                |
| 3   | CASHIER               | Cobro → elegir **TARJETA**                                  | `tpv:read`                                  | **El caso semilla.** Muere el cobro con tarjeta ("Error al buscar terminales (403)"). Además una consulta automática dispara el modal en la pantalla de **propina**, donde nada explica de qué se trata. Dato que lo delata: **WAITER sí tiene `tpv:read`; a CASHIER se le olvidó.**                                                                                                                                                                            |
| 4   | CASHIER               | Cobrar una mesa que abrió un mesero                         | `tables:manage-all` (vía propiedad de mesa) | Con el switch **Propiedad de mesa** encendido (PRO, opt-in), el cajero **no puede cobrar ninguna mesa ajena** — que es literalmente su trabajo. "Solo Juan Pérez puede modificar esta mesa". El PIN de gerente **no rescata** este caso (ese 403 no viaja como "autorizable"). En mostrador puro no pasa nada; sólo con servicio en mesa.                                                                                                                       |

### 🟠 Nivel 2 — Se pierde la venta o el dato del cliente

| #   | Quién                              | Pantalla                                            | Permiso              | Qué pasa                                                                                                                                                                                                                                                              |
| --- | ---------------------------------- | --------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | CASHIER y WAITER                   | Cobro → **vender un paquete/membresía**             | `creditPacks:create` | En gym, estética o spa —el ICP activo— el paquete **es** la venta principal y el mostrador no puede entregarlo. Peor: hay una **trampa armada** (ver §7).                                                                                                             |
| 6   | CASHIER (bug) / WAITER (a decidir) | Cobro → **canjear una clase** del paquete           | `creditPacks:update` | El socio llegó a su clase pagada y recepción no puede descontarla.                                                                                                                                                                                                    |
| 7   | CASHIER y WAITER                   | Cobro → al **adjuntar un cliente**                  | `creditPacks:read`   | Salta solo, sin que nadie toque nada, y la tarjeta **miente**: dice "No se pudieron cargar los créditos… toca para reintentar" (parece falla de internet). El cajero **ni se entera** de que el cliente tiene 10 clases pagadas → riesgo de cobrarle otra vez.        |
| 8   | CASHIER, WAITER y HOST             | Cobro / recibo → **"Crear cliente"**                | `customers:create`   | Llena nombre, teléfono y correo con el cliente enfrente y al guardar: dos errores encimados. La venta queda **anónima**: sin historial, sin lealtad, sin a quién facturar ni a quién mandarle el recibo. También rompe el alta rápida de clientes desde **reservas**. |
| 9   | CASHIER y WAITER                   | Cobro → **cancelar / salir** de una venta arrancada | `orders:cancel`      | El POS crea la orden _antes_ de cobrar. Si el cliente se arrepiente o falla la terminal, el cajero no puede deshacerla: **queda una orden abierta y cobrable** que ensucia el corte. En la pantalla de error se queda **atrapado** (las dos salidas fallan).          |
| 10  | CASHIER                            | Ventas → detalle → **Emitir reembolso**             | _(cruce invertido)_  | 🔁 **Aquí el server SÍ lo autoriza** (`payments:refund`) y **el cliente se lo esconde**. Gana el más estricto. Y donde el PIN está encendido, el botón sale con **candado que miente**: lo toca, el reembolso pasa y **nunca pide PIN**.                              |

### 🟡 Nivel 3 — Pantalla muerta y ruido

| #   | Quién                            | Pantalla                                                | Permiso                           | Qué pasa                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------- | ------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11  | CASHIER, WAITER, KITCHEN, VIEWER | Pestaña **Calendario** (agenda de citas)                | `reservations:read`               | La pestaña se pinta para todos y **sólo sabe fallar**: se auto-consulta al entrar, en cada regreso a la app y **cada 30 segundos**. El modal reaparece indefinidamente. En un spa/estética, quien está en el mostrador suele estar dado de alta como CASHIER. **iOS ya arregló esto**; Android no. |
| 12  | Los mismos                       | **Lista de espera** (Más → Lista de espera)             | `reservations:read`               | Peor que un error: la pantalla dice **"No hay solicitudes de lista de espera"** cuando puede haber 8 personas en la puerta, e invita a un botón que también va a fallar. **Miente con cara de dato bueno.**                                                                                        |
| 13  | Los mismos                       | **Crear reserva/cita** (botón "+")                      | `reservations:read` + `:create`   | Se traga la configuración de la agenda, **inventa horarios estáticos 9:00–22:00** y el "no" definitivo llega hasta el final, con el formulario lleno.                                                                                                                                              |
| 14  | CASHIER y WAITER                 | TPV → Reportes → pestaña **Historial**                  | `tpv-reports:read`                | Nunca carga, y el mensaje **culpa a la red** ("No se pudo conectar al servidor") cuando el server contestó perfecto. Manda a revisar el WiFi por un problema de permisos.                                                                                                                          |
| 15  | CASHIER y WAITER                 | Cobro → escanear código desconocido → **"Crear nuevo"** | `menu:create`                     | La app **ofrece** la salida sin candado y la niega al guardar, con la captura ya hecha y la fila esperando. En la misma pantalla las otras dos entradas a "crear artículo" **sí** están gateadas: sólo el diálogo del escáner se quedó sin candado.                                                |
| 16  | HOST                             | Más → **Presupuestos** → Nuevo                          | `orders:create`                   | La recepcionista cotiza un servicio completo y al guardar le piden un permiso de **tomar comandas**. Tampoco puede enviar/aceptar presupuestos.                                                                                                                                                    |
| 17  | HOST                             | Plano de mesas / cuenta → **Mover** y **Abrir mesa**    | `orders:update` / `orders:create` | El anfitrión —que decide dónde se sienta la gente— no puede reubicar a un grupo ni abrir una mesa. _(Abrir mesa hoy ni siquiera se le ofrece: la pestaña Mesas no se le pinta, en Android y en iOS. Falla en silencio.)_                                                                           |

---

## 3. El patrón — sí existe, y tiene tres formas

**Hipótesis del enunciado: confirmada.** La evidencia la sostiene, y además muestra que el problema tiene tres caras distintas.

### Forma A — Permiso de _administrar_ usado para _operar_ (la más común)

| Para hacer esto (operar)              | Se le pide esto (administrar)                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| Ver con qué terminal cobro            | `tpv:read` = inventario y salud de terminales del dashboard                    |
| Abrir/cerrar **mi** turno             | `shifts:create/close` = crear y corregir turnos **de otros** desde back-office |
| Entregar y canjear un paquete vendido | `creditPacks:create/update` = administrar el **catálogo** de paquetes          |
| Ver **mis** cortes de días pasados    | `tpv-reports:read` = histórico de ventas del **venue entero**                  |
| Cobrar una mesa ajena                 | `tables:manage-all` = "modificar mesas de otro mesero"                         |

> **La prueba de que ya alguien lo vio:** el catálogo de permisos **ya tiene la versión granular para el POS y nadie la cableó** —
> `tpv-shifts:create` y `tpv-shifts:close` existen escritos en `permissions.ts:1602` con **cero rutas** que los usen y **cero roles** que
> los tengan. Lo mismo `tpv-products:write`, que dice literal _"crear productos al vuelo (Scan and Go)"_ y **no sirve**, porque no resuelve
> al permiso que la ruta exige. Los permisos correctos están declarados; falta enchufarlos.

### Forma B — Permiso del **recurso equivocado**: acciones de MESA gateadas con permisos de ORDEN

Abrir mesa, liberar mesa, mover cuenta y asignar mesero piden `orders:create` / `orders:update`. Consecuencia medible: **`tables:update` es
un permiso muerto** — se le dio a HOST y a WAITER, y **ninguna ruta HTTP del POS lo lee** (sólo lo usa el MCP). Le prometemos al anfitrión
"gestión de sala" y no hay una sola puerta que ese permiso abra.

### Forma C — El cliente y el server no dicen lo mismo, y siempre gana el más estricto

Dos direcciones, las dos malas:

- **El server dice sí y el cliente esconde** → reembolsos (#10) y la pestaña Ventas para meseros.
- **El cliente ofrece y el server dice no** → Calendario, Lista de espera, Presupuestos, "Crear nuevo" del escáner, botón "Mover".

Esto viola la regla de la casa: _apagado se VE y se EXPLICA_. Hoy o desaparece sin decir nada, o se ofrece y explota al final.

---

## 4. Fix propuesto, endpoint por endpoint

### Cambio de una línea (o dos) — bajo riesgo

| Endpoint                               | Hoy exige                      | Debería exigir                                                         | Por qué                                                                                                                                                                         | Tamaño                                                                 |
| -------------------------------------- | ------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /mobile/…/terminals/online`       | `tpv:read`                     | `payments:create`                                                      | Ver qué terminal está prendida es parte de cobrar. Sus hermanas (`terminal-payment`, `status`, `print-receipt`) ya piden `payments:*` — este es el único desalineado del flujo. | **1 línea** en `mobile.routes.ts:1520`                                 |
| `POST /mobile/…/customers`             | `customers:create`             | igual, pero **dárselo** a CASHIER, WAITER y HOST                       | Ya tienen `customers:read` y `payments:create`. Editar y borrar el directorio se queda arriba.                                                                                  | **3 líneas** en `permissions.ts`                                       |
| `GET …/credit-balance` + `POST …/sell` | `creditPacks:read` / `:create` | igual, pero **dárselos** a CASHIER (y decidir WAITER)                  | Vender un paquete es cobrar, no administrar catálogo. `creditPacks:delete` se queda en MANAGER+.                                                                                | **2–4 líneas**                                                         |
| `POST /tpv/…/shifts/open` y `/close`   | `shifts:create` / `:close`     | `tpv-shifts:create` / `tpv-shifts:close`, **dados a CASHIER y WAITER** | Los permisos **ya existen** en el catálogo para esto exactamente. Deja `shifts:create/close` como lo que es: administrar turnos ajenos.                                         | **2 líneas** en rutas + **4** en permisos + espejo del texto en la TPV |

### Necesita permiso nuevo (o rediseño chico) — no lo aflojes de golpe

| Caso                                                    | Qué NO hacer                                                                                                      | Qué sí                                                                                                                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cancelar la venta que el propio POS acaba de crear (#9) | ❌ Dar `orders:cancel` a CASHIER/WAITER — eso permite anular cheques ajenos ya en servicio                        | Permiso acotado tipo **`orders:cancel-unpaid`** (orden sin ningún pago, creada por el mismo dispositivo). O que el POS **no cree la orden hasta confirmar el cobro**.           |
| Cobrar mesa ajena con propiedad de mesa (#4)            | ❌ Dar `tables:manage-all` al cajero — le regala editar, descontar, cancelar, mover y fusionar **cualquier** mesa | **Eximir la ruta de cobro** del candado de propiedad, o permiso **`tables:pay-any`**. Toast y Square tienen dueño de mesa, pero dejan que la **caja liquide** cualquier cheque. |
| Mover / abrir / liberar mesa por el HOST (#17)          | ❌ Dar `orders:update` al HOST — abre de golpe **17 rutas** (descuentos, cortesías, cargos, separar, detalles)    | Permiso propio de sala, **`tables:move-check`** (Toast lo tiene separado: "Change Table" #1.16). Y decidir si "sentar" abre cuenta o sólo marca ocupada.                        |
| Canjear una clase (#6)                                  | ❌ `creditPacks:update` — también permite **editar el paquete** (precio, número de sesiones)                      | Permiso **`creditPacks:redeem`**, espejo exacto de `coupons:redeem`, que ambos roles **ya tienen**.                                                                             |
| Presupuestos del HOST (#16)                             | —                                                                                                                 | Aceptar también `reservations:create`, o permiso propio **`estimates:create`**. Un presupuesto no mueve dinero ni abre comanda.                                                 |

### Sólo cliente — no tocar el servidor

| Caso                                                  | Fix                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reembolso escondido (#10)                             | `canIssueRefund` debe resolverse con **`hasVenuePermission("payments:refund")`** (que lee la lista real que manda el server), no con una lista de roles a mano. ⚠️ **Separar antes** `canResolveQuarantine`, que hoy reusa esa misma propiedad. |
| Calendario / Lista de espera / Crear reserva (#11-13) | Gatear con la capacidad que **ya está calculada y sin usar** (`ReservationsCapability`). **iOS ya lo hace**; es portar el gate a Android.                                                                                                       |
| "Crear nuevo" del escáner (#15)                       | Gatear el diálogo con `hasVenuePermission("menu:create")` — no con la lista de roles, que dejaría fuera a venues con permisos personalizados. En Android **y en iOS**, donde la pantalla completa está sin gate.                                |
| Historial TPV (#14)                                   | Distinguir 403 de fallo de red y decirlo. Hoy culpa al WiFi.                                                                                                                                                                                    |
| Separar cuenta (#, PLAUSIBLE)                         | La pantalla ya pinta "Mesa de X — solo lectura" y **aun así ofrece el botón**. Meterle el mismo guard que ya tienen agregar, enviar y cobrar.                                                                                                   |

---

## 5. Lo segundo: el modal que salta por peticiones que nadie pidió

### El criterio, en una frase

> **El modal global sólo puede salir de una petición que nació de un toque del usuario en esa pantalla y cuyo fracaso impide justo lo que
> pidió.** Todo lo demás falla en silencio y lo cuenta la pantalla, con sus palabras.

### Las herramientas ya existen y están sin usar

| Header                  | Qué hace                                        | Quién lo usa hoy                                                           |
| ----------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `X-Avoqado-Background`  | El 403 no genera modal **ni teclado de PIN**    | 🔴 **Cero llamadores en toda la app.** Está construido y nunca se enchufó. |
| `X-Avoqado-Local-Error` | El error lo pinta la pantalla, sin modal encima | Sólo el repositorio del override de gerente                                |

_(En iOS el equivalente existe y también está desaprovechado: `suppressForbiddenNotification: true` en `APIClient`.)_

### Tres cubetas, y dónde va cada llamador

**Cubeta 1 — Nadie la pidió → `X-Avoqado-Background`, silencio total:**

| Poner el header aquí                                                                                                       | Por qué                                                             |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `PaymentFlowViewModel.probeTerminalAvailability()` (la sonda automática) — **no** en `fetchTerminals`, que sí es la acción | Es la que sacó el modal en la pantalla de propina del caso original |
| `CalendarViewModel.fetch()` → calendario **y** sesiones de clase, sobre todo el tick de 30 s                               | Hoy: modal cada medio minuto                                        |
| `ArticlesRepository.fetchCustomerCredits` (la tarjeta de membresías del carrito)                                           | Corre sola al adjuntar cliente                                      |
| `PendingGrantQueue` (reintentos al arrancar la app)                                                                        | Hoy puede abrir el **teclado de PIN de gerente** en el arranque     |
| `WaitlistViewModel.load()` cuando viene de una recarga automática                                                          |                                                                     |
| `CreateReservationViewModel` init (settings + disponibilidad)                                                              |                                                                     |
| Cualquier carga de arranque de pantalla que no sea la acción pedida                                                        |                                                                     |

**Cubeta 2 — Es la acción, pero la pantalla ya tiene su propio error → `X-Avoqado-Local-Error`, sin modal duplicado:**
`CustomersRepository.createCustomer` · `ProductsRepository.createProduct` · `EstimatesRepository.create` ·
`TableServiceRepository.splitOrder`. En los cuatro el usuario recibe **hoy dos errores encimados**.

**Cubeta 3 — Acción crítica sin error propio →** sin header, modal global. Está bien.

### Dos arreglos que van con esto

1. 🔴 **Una petición de fondo NUNCA debe abrir el teclado de PIN de gerente.** Hoy puede hacerlo, y además **retiene la red esperando a que
   llegue una persona**. El header tiene que cortocircuitar las dos cosas — el modal y el PIN.
2. **El modal escupe el código crudo** («tpv:read», «orders:create»). Ya existe el diccionario de etiquetas amables (`PermissionLabels`),
   pero **sólo lo usa el teclado de PIN**. Usarlo también en el modal: "Pídele a un administrador que te active _cobrar con terminal_" en
   vez de un código que nadie entiende.

---

## 6. Riesgo de cada fix — qué se abre de más

| Fix                                      | Riesgo                                                                                                                                                                                                                                          | Veredicto                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `terminals/online` → `payments:create`   | Quien cobra ve la lista de terminales prendidas (nombre y serie). Nada más.                                                                                                                                                                     | ✅ **Bajo.** Mejor que la alternativa (dar `tpv:read` al cajero, que le abriría administración de terminales en el dashboard). |
| `customers:create` a CASHIER/WAITER/HOST | Duplicados y basura en el directorio. Editar/borrar/saldar se quedan arriba.                                                                                                                                                                    | ✅ **Bajo.**                                                                                                                   |
| `creditPacks:read` + `create` a CASHIER  | Puede vender paquetes. Con `redeem` propio (no `update`), **no** puede tocar precios ni sesiones del catálogo.                                                                                                                                  | 🟡 **Medio.** Si le das `creditPacks:update` en vez de un `redeem` acotado, **sí le estás regalando editar el catálogo**.      |
| Turnos a CASHIER/WAITER                  | ⚠️ **El riesgo de verdad:** que un cajero pueda cerrar el turno **de otro** y llevarse su conteo. **No pude verificar si el servicio valida al dueño del turno al cerrar** (sí verifiqué que al _abrir_ el guard es por local, no por persona). | 🟠 **Verificar antes de mover nada.** Si no valida dueño, el permiso nuevo debe ser "mi turno", no "cualquier turno".          |
| `orders:cancel` a operativos             | ❌ Permite anular cheques **ajenos y en servicio**.                                                                                                                                                                                             | 🔴 **No hacerlo así.** Sólo la versión acotada.                                                                                |
| `tables:manage-all` a CASHIER            | ❌ Le regala editar, descontar, cortesiar, cancelar, mover y fusionar cualquier mesa.                                                                                                                                                           | 🔴 **No.** Eximir la ruta de cobro o permiso acotado.                                                                          |
| `orders:update` a HOST                   | ❌ Abre 17 rutas de edición de comanda.                                                                                                                                                                                                         | 🔴 **No.** Permiso de sala propio.                                                                                             |
| `reservations:read` a CASHIER            | Ve la agenda y los datos de los clientes citados. **En clínicas eso puede ser información de salud.**                                                                                                                                           | 🟡 **Decisión tuya.** El fix del cliente (no ofrecer la pestaña muerta) aplica igual, se decida como se decida.                |
| `tpv-reports:read` a CASHIER             | ❌ Abre el histórico de ventas del **venue entero**, no "mis cortes".                                                                                                                                                                           | 🔴 **No.** Arreglar el cliente; si quieres dárselo, con un permiso acotado.                                                    |
| `menu:create` a CASHIER                  | Square también lo separa del rol de caja.                                                                                                                                                                                                       | 🔴 **No.** Fix de cliente (no ofrecer el botón).                                                                               |
| Reembolsos (sólo cliente)                | ⚠️ Esa misma propiedad se reusa como candado de la **pantalla de cuarentena**. Arreglarla en el lugar le abre la cuarentena al cajero de rebote.                                                                                                | 🟡 **Separar las dos propiedades en el mismo cambio.**                                                                         |

---

## 7. De paso: cinco cosas que **no** son de permisos y cuestan dinero hoy

1. **Se cobra un paquete sin cliente seleccionado → el cliente paga y no recibe créditos, sin rastro en ningún lado.** No hay error, no hay
   cola, no hay nada. Esto pasa **hoy**, sin tocar un solo permiso.
2. **Salir del cobro mientras se elige terminal deja una orden fantasma** y ni siquiera intenta cancelarla — **para cualquier rol, gerente
   incluido**.
3. **La cola de entrega de paquetes reintenta un 403 para siempre**, en cada arranque de la app, sin tope.
4. **El caché de reportes históricos es por local, no por persona:** si un gerente abrió el Historial en esa terminal, el cajero que entre
   después **ve las ventas históricas** que supuestamente no puede ver. O sea que el bloqueo ni siquiera es consistente: en terminal nueva
   miente sobre la red, en terminal usada filtra los datos.
5. **La lista de espera afirma "No hay solicitudes"** cuando en realidad fue un rechazo de permisos. Un dato falso presentado como verdad.

---

## Lo que **no** pude verificar (honestidad)

- **Nada de esto se reprodujo en hardware.** Todo es lectura de código más ejecución del resolvedor real de permisos. El único caso medido
  en un aparato es el original (`tpv:read`), que tú viste.
- **No auditamos todas las rutas.** Se cubrió el flujo de cobro, mesas, turnos, reservas, membresías y reportes. Quedaron fuera —o sin
  verificación adversarial— inventario, KDS, comisiones, tickets de área y lealtad. **Es muy probable que haya más.**
- **No verifiqué si cerrar turno valida que el turno sea tuyo.** Es lo primero que hay que mirar antes de mover ese permiso.
- **Comparación con el mercado:** sólo dos puntos verificados en vivo (Toast separa "Change Table" como permiso propio; Square separa "crear
  artículos" del rol de caja). El resto de las recomendaciones es criterio interno, no investigación de mercado.
- **Paridad iOS:** revisada caso por caso en la mayoría, pero no de forma exhaustiva. En reservas **iOS ya está mejor que Android**; en
  membresías, escáner y reembolsos está **igual de mal**.
- **El PIN de gerente nace apagado** por local y **no existe en la TPV**. No lo probé encendido, así que todos los "callejones sin salida"
  están descritos con el default de fábrica.
- **Dos hallazgos quedaron como _plausibles_** (abrir mesa por el anfitrión, separar cuenta por el cajero) porque dependen de una decisión
  de producto tuya, no de un defecto claro.
- **No consultamos la base de producción:** puede que algún local ya tenga permisos personalizados que enmascaren esto en la vida real.

---

## En corto

**Qué pasó:** el caso del cajero no era un descuido suelto — hay 17 lugares donde a la gente de piso se le pide un permiso de _jefe_ para
hacer su trabajo de _piso_. Los dos peores no son el que viste: **un cajero no puede abrir ni cerrar turno en la TPV, y sin turno la
terminal no cobra** — y sólo se arregla con un gerente parado ahí.

**Qué significa para ti:** cinco de estos se arreglan cambiando una línea (empezando por el tuyo). Otros cinco necesitan un permiso nuevo y
acotado, porque el atajo fácil —darle el permiso de jefe al cajero— le regalaría anular cheques, editar precios o tocar mesas ajenas. Y el
modal que brinca solo se apaga con un header que **ya está construido y nunca se conectó**.

**Qué necesito de ti:** una sola decisión para arrancar — **¿el cajero debe poder abrir y cerrar su propio turno, sí o no?** Si es sí, eso y
el fix de terminales son las dos primeras líneas que cambio.
