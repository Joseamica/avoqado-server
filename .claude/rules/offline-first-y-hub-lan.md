# Offline-first + Hub LAN — lo que hay que saber antes de tocar esto

Aplica a **avoqado-android, avoqado-ios y avoqado-server a la vez**. Los tres
comparten un contrato; romper uno rompe los otros en silencio.

---

## 1. El modelo mental en 60 segundos

Sin internet, cada POS escribe cada mutación como un **intent append-only** en su
outbox local y la reproduce al reconectar (FIFO por dispositivo). El server tiene
un **reducer** que aplica esos intents usando **los mismos servicios que la ruta
online** — sincronizar no es una puerta trasera: el feature gating y la propiedad
de mesa se evalúan igual.

Encima de eso, el **hub LAN** (PREMIUM) hace que los POS se coordinen entre sí
por el WiFi del local para PREVENIR conflictos en vez de detectarlos al
reconectar.

```
POS sin red → outbox (intents) → replay al reconectar → reducer del server
                    ↑
            hub LAN (opcional): leases de mesa entre POS, sin internet
```

---

## 2. Reglas que NO se negocian

### 2.1 El contrato de intents se espeja por nombre EXACTO

`SyncIntentType` en `avoqado-server/src/services/mobile/sync.mobile.service.ts`
es la fuente de verdad. Los 14 tipos actuales:

```
OPEN_TABLE · ADD_ITEMS · PAY_CASH · APPLY_DISCOUNT · APPLY_SERVICE_CHARGE
COMP_ORDER · UPDATE_DETAILS · CANCEL_ORDER · MOVE_ORDER · ASSIGN_ORDER
CLEAR_TABLE · SPLIT_ORDER · SPLIT_BY_SEAT · MERGE_ORDERS
```

Agregar uno = tocar server + Android + iOS + el MCP `pos_sync_status`, en el
MISMO cambio. Un tipo que el server no conoce se rechaza con
`UNKNOWN_INTENT_TYPE` (no se pierde, cae en cuarentena).

### 2.2 Tres estados de ack, y el del medio es el que la gente olvida

- `ACKED` — aplicado, terminal.
- `REJECTED` — rechazo de NEGOCIO permanente → **cuarentena visible**.
- `RETRY` — condición TRANSITORIA (hoy sólo `VERSION_CONFLICT`): el cliente lo
  deja PENDING y **corta el batch** para preservar el FIFO. NO se persiste.

Si conviertes un error transitorio en `REJECTED`, el intent se pierde para
siempre. Ese fue un P1 real.

### 2.3 "Offline es estado normal, no error"

Un fallo de RED se convierte en intent (`orQueueOffline` / `queueOfflineOrRethrow`).
Un rechazo de NEGOCIO (403/409/4xx) se propaga tal cual al usuario. Confundirlos
es el bug clásico: o tragas errores reales, o le dices "error" a algo que salió
bien.

Corolario que costó un bug real: **jamás pintes un éxito encolado como pantalla
de Error.** Ver `avoqado-tpv` (`AngelPayPaymentViewModel.handleRecordFailure`),
que sigue teniendo ese defecto.

### 2.4 Identidad local: `localOrderId` y `externalId`

Un dispositivo sin red no conoce ids del server. Genera UUIDs locales:

- **`localOrderId`** — la orden. `OPEN_TABLE` lo mapea al id real, y los intents
  posteriores lo resuelven vía el mapa del batch o `PosSyncIntent.localRef`.
- **`externalId`** — las LÍNEAS. `ADD_ITEMS` inyecta `sync:<intentId>:<idx>`, que
  es determinista y por tanto el cliente lo puede predecir. Es lo que permite
  separar un cheque que aún no sincroniza.

El `deviceId` se reusa del outbox. **No inventes otro**: si cambia al reiniciar,
el mismo POS se ve como dos peers y la elección de árbitro deja de ser estable.

### 2.5 Dinero: idempotencia y todo-o-nada

- `PAY_CASH` viaja con `idempotencyKey` (= id del intent). El server deduplica
  por `[venueId, idempotencyKey]`. Sin esto, un reintento cobra dos veces.
- `ADD_ITEMS` usa CAS real sobre `version` (no incremento ciego) + `externalId`.
- `SPLIT_ORDER` resuelve las referencias **todo-o-nada**: si UNA no resuelve,
  rechaza. Un cheque partido a medias cobra de menos a un cliente y de más a
  otro, y el mesero no tiene cómo notarlo.

---

## 3. Hub LAN (PREMIUM `OFFLINE_LAN_HUB`)

Código: `core/data/lan/` (Android) · `Services/LAN/` (iOS). Cuatro capas:

1. **Núcleo** (`TableLease`, `LeaseRegistry`, `ArbiterElection`) — lógica PURA,
   sin red y con el reloj por parámetro. Toda la corrección vive aquí.
2. **Protocolo** (`LeaseProtocol`) — JSON por línea sobre TCP crudo.
3. **Transporte + descubrimiento** (`LeaseServer`, `LeaseClient`, `LanDiscovery`)
   — mDNS `_avoqado-pos._tcp`.
4. **Coordinador + wiring** (`LanHubCoordinator`, `LanHubService`).

### 3.1 Lo que hay que entender antes de tocarlo

- **LEASE, no candado.** Un candado sin caducidad deja la mesa muerta si la
  tablet se apaga. TTL 30s, renovación a 1/3.
- **ÉPOCA (fencing token).** Sube SIEMPRE — ni al caducar ni al soltar la mesa se
  reinicia. Si la reinicias, un dispositivo zombi con la época vieja vuelve a
  parecer válido y pisa el trabajo de otro.
- **Elección determinista:** cableado > mayor uptime > `deviceId`. El desempate
  por deviceId NO es cosmético: sin él, dos equipos idénticos pueden elegirse
  distinto y habría DOS árbitros.
- **El árbitro NO es fuente de verdad.** Lo sigue siendo el server. Si el árbitro
  se equivoca, el server rechaza al reconectar y cae en cuarentena. Por eso NO
  hace falta consenso tipo Raft.
- 🔴 **DEGRADAR, NUNCA BLOQUEAR.** Sin hub, con el árbitro caído, con permiso de
  red denegado o con error de protocolo → `NoHub` y el POS sigue como isla. El
  hub PREVIENE conflictos, no autoriza ventas: **jamás puede impedir un cobro.**

### 3.2 Asimetría de cable Kotlin ↔ Swift (real, silenciosa)

- Kotlin serializa con `encodeDefaults = true` → manda `"lease":null` EXPLÍCITO.
- Swift (`JSONEncoder`) **omite** los opcionales nil.

Ambos lados tienen un test con el JSON literal que produce el otro. Si cambias
`decodeIfPresent` por `decode`, o quitas un default, truena en el test — no en un
salón con un iPad y una tablet.

### 3.3 Trampas de plataforma

- **Android — MulticastLock:** sin él, muchos equipos tiran el multicast al
  apagarse la pantalla. "Funciona en el escritorio y falla en el salón".
- **Android — resolves EN SERIE:** `resolveService` revienta con
  `FAILURE_ALREADY_ACTIVE` si hay otro en curso.
- **iOS — `NSBonjourServices`:** `_avoqado-pos._tcp` DEBE estar en el Info.plist.
  iOS no permite descubrir un servicio no declarado y **falla en silencio**.
- **iOS — permiso de red local:** en dispositivo real sale un diálogo que alguien
  tiene que aceptar. En simulador no aparece.
- **Filtro por venue en el TXT:** plazas y food courts comparten WiFi. Un peer de
  otro negocio se ignora; arbitrar mesas ajenas sería catastrófico y silencioso.
- El propio anuncio se filtra por `deviceId`, **no por nombre** (el SO renombra a
  "(2)" si hay colisión).

---

## 4. Impresión offline (bug real, 2026-07-25)

`PrintConfigRepository` **debe ser cache-first y NUNCA borrar una config buena en
un refresh fallido.**

Antes lo hacía: al fallar, la pisaba con `PrintConfig()` vacío → cero estaciones
→ cero ruteo → **la comanda no se imprimía sin internet**, aunque las impresoras
estuvieran en la misma LAN. Y peor: un bache de WiFi a media comida dejaba al
local sin imprimir hasta reiniciar la app.

El razonamiento original ("fail-safe over stale") es equivocado en este dominio:
el "fail-safe" era **no imprimir nada**, o sea que la cocina nunca se entera del
pedido. Una IP de impresora ligeramente vieja es muchísimo menos dañina.

> **Consecuencia operativa:** un POS recién instalado que NUNCA se conectó con
> internet no tiene config de impresoras y no imprimirá offline. Hay que abrir la
> app con internet una vez. Está en `docs/INSTALACION-HUB-LAN.md`.

---

## 5. Qué es online-only A PROPÓSITO

No "se nos olvidó": quitar descuento/cargo ya aplicado, cortesía de UN item ya
enviado, canje de lealtad, pago con TARJETA (Blumon necesita red), turnos,
login/logout.

---

## 6. Cómo probar esto de verdad

La lógica pura tiene tests; lo demás necesita hardware. Recetas que funcionan:

**Simular "sin internet" con la LAN viva** (lo que pasa en un apagón real):

```bash
./gradlew assembleDebug -Pavoqado.devBaseUrl=http://<ip-del-mac>:3009/api/v1
# nada escuchando en 3009 → la API falla, el WiFi/LAN sigue vivo
```

**Intermitencia** (la prueba de fuego de la idempotencia): `flaky-proxy.mjs` con
modo `DROP_RESPONSE` — reenvía el request (el efecto SÍ ocurre) pero mata la
respuesta, así que el cliente reintenta. Es el escenario del doble-cobro.

**Peer LAN falso** para probar el hub sin un segundo dispositivo:

```bash
dns-sd -R "Avoqado-POS-fake" "_avoqado-pos._tcp" local 9911 \
    did=fake-device wired=1 boot=1000 venue=<venueId>
```

**Impresora ESC/POS falsa:** escuchar en `:9100` y decodificar lo que llega.
Verifica todo el camino menos el papel.

**adb inalámbrico:** si el daemon se reinicia se pierde el dispositivo. Se
recupera con `adb mdns services` (da el puerto real, **cambia cada vez**) y
`adb connect <ip>:<puerto>`. El 5555 NO sirve en Android 11+.

⚠️ Al probar leases a mano: el TTL es 30s. Entre tomar la mesa desde un peer y
tocar en la tablet tienen que pasar MENOS de 30s, o el lease caduca y parece un
bug que no lo es.

---

## 7. Estado y límites honestos (2026-07-25)

**Funciona y está verificado en hardware:** abrir mesa, rondas, efectivo,
descuentos, cargos, cortesías, mover/asignar/anular, liberar, separar y fusionar
cheques, dividir por puesto — todo sin red. Hub LAN previniendo el doble-abre.
Comanda imprimiendo offline. Cuarentena visible para rechazos.

**NO está hecho:**
- **KDS offline** — es lo único grande que falta del hub.
- **Fencing del lado del server** (rechazar intents con época vieja): necesita
  persistir `lastLeaseEpoch` por mesa. Sin eso el sistema ya es seguro
  (ADD_ITEMS fusiona, PAY_CASH es idempotente, la propiedad de mesa rechaza
  cruces), pero es la capa que falta.
- Indicador visual de árbitro/isla en el plano.
- El fix de impresión offline de **iOS** se hizo por paridad y lectura de código:
  **no se ha probado con un iPad y una impresora físicos.**

**No vender:** "servicio completo offline multi-terminal" mientras el KDS offline
no exista.
