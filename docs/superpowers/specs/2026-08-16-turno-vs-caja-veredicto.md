# Turno vs. Caja — la recomendación

## 1. La respuesta en dos líneas

**Sepáralos limpio (opción B): el efectivo se cuenta UNA sola vez y se cuenta en la CAJA (el cajón/aparato), no en el Turno de la persona.**
El Turno no se elimina — se queda con lo suyo (qué vendió esa persona, sus propinas, su comisión, el enlace con SoftRestaurant) y se le
quitan el fondo inicial, el conteo final y la diferencia.

**Lo que necesito de ti al final es una sola decisión: ¿apruebas que el conteo de efectivo se mude a la Caja?** (el resto — tiers, ruta,
tiempos — te lo propongo yo).

**La analogía:** hoy tienes **dos cuadernos para la misma caja registradora**. Uno lo lleva la persona (Turno) y otro lo lleva el mostrador
(Caja). Los dos anotan cuánto había al empezar, cuánto se contó al final y cuánto faltó — y **nunca se comparan entre sí**. Square, Toast,
Fudo y Soft Restaurant llevan **un solo cuaderno, y lo lleva el mostrador**; la persona nada más firma a qué hora abrió y a qué hora cerró.

---

## 2. Qué hace el mercado

| Sistema                      | ¿A qué le cuelga el dinero?                                                    | Por qué (razón de ellos)                                                                                                                                                                                                                            | ¿Portable a México?                                                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Square** (US)              | **Al cajón/aparato**                                                           | El cajón físico cuelga del aparato. Su modelo trae `team_member_ids` **en plural**: da por hecho que N personas tocan 1 sesión de cajón. Lo laboral (Timecard) no menciona efectivo ni una vez.                                                     | ✅ Sí. Es arquitectura de datos, no convención fiscal. ⚠️ Su "solución" para separar por persona es **un cajón físico por persona** — eso sí no aplica: asume hardware barato por empleado.                                                           |
| **Toast** (US, restaurante)  | **El CONTEO al cajón. A la persona, un SALDO** (cuánto debe / cuánto le deben) | Custodia física: la pregunta que contestan es _"¿el billete quedó en la caja del negocio o en la bolsa de la persona?"_. Fondo/esperado/contado/diferencia existen **una sola vez**, en el cajón.                                                   | ✅ El patrón sí. ❌ **NO portable:** el paso obligatorio de "declarar propinas en efectivo" (es cumplimiento con el IRS). ⚠️ **Tropicalizar:** su modo "el mesero trae su propio banco" no aplica al ICP (tienda, estética, gym = un mostrador fijo). |
| **Fudo** (Argentina/LatAm)   | **A la "Caja"** (Principal, Barra, Delivery, Mostrador)                        | Contenedores de dinero distintos dentro del mismo local + doble control operador↔supervisor + arqueo a ciegas. Publican que **54.3% de 7.6M de cierres tienen diferencia**, y hay _más sobrantes que faltantes_ — o sea error de captura, no robo. | ✅ Ya es LatAm, sin tropicalizar. Su "Turno" ni siquiera es dinero: es **un filtro de reportes**.                                                                                                                                                     |
| **Soft Restaurant** (México) | **A la ESTACIÓN**                                                              | "Turno" = la sesión de caja de una estación. Corte X (parcial) y Corte Z (del día, consolida estaciones). Lo laboral vive aparte, en "Control de asistencia".                                                                                       | ✅ Ya es MX. 🔴 **Trampa de vocabulario:** en México "turno" en un POS significa **la caja de la estación**, no la jornada de una persona. Nuestro `Shift` usa la palabra al revés de como la aprendió el mercado mexicano.                           |

**Los cuatro coinciden en lo mismo, en tres países distintos: el conteo de efectivo se ancla al contenedor, y la persona queda estampada
adentro (quién abrió / quién cerró).** Ninguno tiene un arqueo cuya llave sea la persona. **El raro somos nosotros** — y encima el nuestro
raro es el gratis y prendido por default, mientras el que coincide con el mercado está apagado y muerto.

---

## 3. La recomendación, y por qué descarto las otras dos

### Así se ve hoy

```
HOY — el mismo dinero, en dos libros que nunca se comparan

 Cobro en la PAX ─────────► TURNO de Ana ──► fondo · conteo · diferencia ──► lo ve el dueño
                             (PERSONA)         gratis, prendido por default

 Cobro en la tablet ──┬────► TURNO de Ana ──► totales de venta
                      │
                      └────► CAJÓN mostrador ► fondo · conteo · diferencia ──► NO lo ve nadie
                             (APARATO)          gratis, sin candado             fuera de la tablet

 Cobro manual en dashboard ► TURNO de Ana        ...y existe un TERCER modelo (CashCloseout)
                                                    con una TERCERA fórmula de "efectivo esperado"
```

### Lo que propongo

```
MAÑANA — un solo libro para el dinero físico

 Cualquier cobro ──┬──► TURNO de Ana ──► qué vendió · sus propinas · su comisión · su ticket de corte
                   │     (PERSONA)        ✂ SIN fondo · SIN conteo · SIN diferencia
                   │
                   └──► CAJA del mostrador ──► fondo + entradas/salidas + conteo + diferencia
                         (APARATO/CAJÓN)         el ÚNICO lugar donde se cuenta el efectivo
                         adentro: quién la abrió, quién la cerró, y a qué hora
```

**La razón de negocio, en una frase:** tu ICP es una tienda, una estética, un gym — **un mostrador, un cajón, y varias personas rotando**.
Si el conteo se ata a la persona, cada cambio de turno obliga a contar el mismo cajón otra vez, y si al final falta dinero nadie puede decir
de quién fue, porque el dinero nunca estuvo separado. Fudo lo dice explícito: para separar por persona **hay que fabricarle una caja a cada
persona**. Square dice lo mismo con otras palabras. Ese es exactamente el trabajo que le estaríamos regalando al comerciante.

**Por qué descarto A (fusionar en un solo concepto):**

- _Fusionar hacia el cajón (matar Turno)_ = carísimo y no lo haría nunca: 32,258 órdenes y 1,023 pagos apuntan a un Turno, ahí cuelga la
  sincronización con SoftRestaurant, el sistema de comisiones, la página de turnos del dashboard, la TPV, el desktop y la herramienta del
  MCP. Y encima mataría la única función de caja que hoy se cobra.
- _Fusionar hacia el Turno (matar el cajón)_ = va contra los cuatro referentes y contra tu ICP, obliga a contar la caja en cada relevo, y
  perdería lo único genuinamente valioso del cajón: el registro de **entradas y salidas de efectivo** (alguien saca $2,000 para el proveedor
  a media tarde). Ese registro no existe en Turno, y por eso el arqueo del turno hoy **miente**: el propio código lo admite — si alguien
  saca dinero, aparece un faltante por esa cantidad.

**Por qué descarto C (dejarlo y documentar):** documentar sirve cuando hay empate. Aquí no lo hay: hay **tres fórmulas distintas de
"efectivo esperado"** sobre el mismo dinero físico y ninguna se compara con las otras, así que cuando dos discrepen no hay forma de saber
cuál miente. Y ya hay un **defecto objetivo activo** (punto 5, fase 0) que documentar no arregla.

---

## 4. El problema del tier

**Hoy está al revés y no es defendible:** contar el efectivo al cerrar turno es "PRO + opt-in", mientras el cajón —que hace exactamente lo
mismo— es **gratis y sin ningún candado**. Y `Shift.startingCash` viene gratis y prendido por default para todos.

**La analogía del corte:** **contar la caja es el cinturón de seguridad — eso no se cobra.** Lo que se cobra es **la cámara de seguridad**:
quién sacó dinero, cuándo, con qué motivo, y que el cajero no vea el número esperado antes de contar.

| Tier        | Qué incluye                                                                                                                                                                                                                                                                                     | Por qué es defendible                                                                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **FREE**    | **Contar la caja**: una caja por local, fondo inicial, conteo al cerrar, la diferencia a la vista.                                                                                                                                                                                              | Es higiene básica y **ya es gratis hoy** — cobrarlo sería quitarle algo a 20 negocios. Square y Fudo también lo dan en su plan base.                                                                               |
| **PRO**     | **El control del efectivo**: (a) varias cajas por local; (b) **entradas y salidas con motivo** y su historial; (c) **conteo a ciegas** (el cajero no ve el esperado); (d) reporte de diferencias por caja y por persona en el tiempo; (e) exigir que la caja se cierre antes del cierre de día. | Fudo cobra _varias cajas_ en su Plan Pro, y publica que **solo 14.1% hace conteo a ciegas** — o sea, es la función que separa al que de verdad controla. Nada de esto le hace falta al changarro de una sola caja. |
| **PREMIUM** | **Doble control**: el supervisor concilia lo que declaró el cajero, con motivo obligatorio de la diferencia y cierre inmutable + póliza contable automática.                                                                                                                                    | Es el flujo de Fudo para equipos con esquema de supervisión, y es lo que pide un negocio con varias sucursales.                                                                                                    |

🔴 **Regla que no rompería:** lo que hoy es gratis no se puede volver de pago. Por eso el conteo básico se queda en FREE, y
`cashReconciliationEnabled` deja de ser "¿puedes contar?" para volverse "¿puedes contar **a ciegas** y con entradas/salidas?".

---

## 5. Ruta de migración

**Nadie pierde nada y nada se borra.** Los 20 negocios con turnos prendidos siguen igual: sus 428 turnos, sus 380 conteos y su historia se
quedan donde están, visibles. Lo que cambia es **a dónde se escribe el conteo nuevo**.

| Fase                                       | Qué es                                                                                                                                                                                                                                                                                                 | Rompe algo                       | Reversible                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ------------------------------- |
| **0 — Arreglar el defecto que ya existe**  | Hoy un reembolso en efectivo **resta** del cajón, pero la venta **nunca suma**. En producción: 5 salidas contra 1 sola venta registrada. Cualquier negocio que prenda el cajón hoy verá un faltante falso. Se arregla escribiendo la venta del lado del servidor (o apagando la resta hasta entonces). | No                               | Sí                              |
| **1 — Limpiar el cajón**                   | Cerrar las 3 sesiones colgadas (una lleva 3.5 meses abierta) y ponerle **auto-cierre por día de negocio**, como Toast a las 4 a.m. Sin esto, cualquier modelo por-cajón acumula zombis.                                                                                                                | No                               | Sí                              |
| **2 — Sacar el cajón a la luz**            | Hoy el dashboard **no ve absolutamente nada** del cajón. Traer entradas/salidas y arqueo al dashboard + herramienta del MCP (hoy no existe ninguna). Aquí es donde el arqueo empieza a dejar de mentir.                                                                                                | No                               | Sí                              |
| **3 — Mudar el conteo**                    | El cierre de turno deja de pedir fondo/conteo y pasa a mostrar el arqueo de la caja. Los campos de dinero de `Shift` quedan **marcados como viejos: se siguen leyendo, se dejan de escribir**.                                                                                                         | Sí — Android, iOS, TPV y desktop | Sí (basta volver a escribirlos) |
| **4 — Limpieza** (mucho después, opcional) | Dejar de escribirlos del todo.                                                                                                                                                                                                                                                                         | —                                | Sí                              |

🔴 **Lo irreversible, y que NO haría nunca:**

- **Borrar las columnas de dinero de `Shift`**, y sobre todo `reportData` e `inventoryConsumed`: son fotos del momento que **no se pueden
  recalcular** desde los pagos. Si se borran, se pierde para siempre la posibilidad de reimprimir un corte viejo.
- **Borrar sesiones de cajón**: sus movimientos se van en cascada.
- Todo lo demás (apagar pantallas, marcar viejo, cambiar dónde se escribe) se deshace.

---

## 6. Riesgo y costo

**Qué se rompe:**

- **Android e iOS**: hoy son los únicos que tienen módulo de caja (12 archivos Kotlin + el paquete de Swift). Se rediseña la pantalla, en
  **las dos a la vez** por la regla de paridad.
- **La TPV (PAX)**: 🔴 **este es el trabajo grande y el que no haría todavía.** La PAX no tiene módulo de cajón: si el arqueo se muda a la
  caja, la terminal se queda sin dónde contar. Hasta que eso esté resuelto, la TPV sigue cerrando turno como hoy.
- **El desktop** (`CajaScreen`) lee turnos.
- **El MCP**: `list_shifts` expone `cashDeclared`, y **no existe ni una sola herramienta para el cajón** — eso ya está incompleto hoy,
  independientemente de esta decisión.

**Cuánto trabajo:** fase 0 ≈ medio día · fase 1 ≈ 1–2 días · fase 2 ≈ 1 semana (server + dashboard + 2 apps) · fase 3 ≈ 2–3 semanas si entra
la TPV.

**Lo que NO haría todavía:**

1. **No tocar la TPV** hasta que la caja esté probada en hardware en Android/iOS.
2. **No borrar nada.**
3. **No construir el modo "la persona trae el dinero encima"** (el _cash in hand_ de Toast). No puedo nombrarte dos clientes reales que
   quieran cosas opuestas, así que sería construir por toggle. El diseño de datos sí debe dejarle el hueco — el caso más probable es
   PlayTelecom, donde el promotor sí carga efectivo.
4. **No meterme todavía con `CashCloseout`**, el tercer modelo. Existe, tiene su propia fórmula de efectivo esperado, y es otra
   conversación.

---

## 7. Lo que no pude verificar

- 🔴 **Lo laboral en México.** No investigué si la Ley Federal del Trabajo limita descontarle a un trabajador el faltante de caja. Si eso
  pesa en la decisión, hay que buscarlo aparte — **no lo des por cierto en ninguna dirección.** Square no habla de eso porque es gringo.
- **Nada de esto se probó en hardware.** Todo sale de leer el schema, el código y la base de producción en modo lectura.
- **De los 20 negocios con turnos prendidos, no sé cuáles pidieron el conteo de efectivo** y cuáles simplemente lo traen porque viene
  encendido por default. Sí está medido que 380 de 428 turnos traen conteo declarado, pero eso no dice si lo quieren.
- **No hay documentación pública de API ni de Fudo ni de Soft Restaurant.** Parte de Soft Restaurant se leyó desde el índice del buscador,
  no de la página original. Dos páginas de Toast devolvieron error 403 y su contenido se confirmó por otras dos fuentes de Toast.
- **El tier es una propuesta mía, no una decisión.** La regla dice que la decides tú.

---

## En corto

**Qué pasa:** tenemos dos cuadernos anotando el mismo dinero — uno de la persona y otro del mostrador — y nunca se comparan; los cuatro POS
que miramos (uno de ellos mexicano) llevan uno solo y lo lleva el mostrador.

**Qué significa para ti:** hay que quitarle el conteo de efectivo al Turno y dejárselo a la Caja. No se borra nada, nadie pierde su
historia, y el gate de PRO deja de ser "¿puedes contar?" (eso es gratis) para volverse "¿puedes controlar quién saca dinero y contar a
ciegas?".

**Qué necesito de ti:** una sola decisión — **¿apruebas mudar el conteo de efectivo a la Caja?** Si dices que sí, arranco por la fase 0, que
es un defecto real que hoy le inventa faltantes a cualquiera que prenda el cajón, y que conviene arreglar aunque digas que no a todo lo
demás.
