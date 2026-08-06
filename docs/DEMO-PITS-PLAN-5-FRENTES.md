<!-- Generado 2026-08-06 por analisis de 5 agentes. VERIFICADO por Claude:
     - pre-deploy SI corre typecheck (scripts/pre-deploy-check.sh:70) => el archivo
       de reservaciones de otra sesion bloquea de verdad.
     - 0 archivos down.sql en todo prisma/migrations => pg_dump es la unica red.
     - CORRECCION al analisis: el motor de upsell YA esta en main; el despliegue
       NO lo arrastra. Solo viajan las 2 migraciones de compras.
     - develop esta 3 commits adelante de main. -->

# PLAN PITS — jueves 6 → lunes 11 de agosto

## 1. Calendario día por día

### JUEVES 6 (hoy)

**Founder — primeros 90 minutos, en este orden:**

1. **Enviar el correo a Wendy.** Ya redactado, propone el 14. Es lo único con latencia externa: cada hora que espera sube la probabilidad de
   que la fecha caiga el 11 en vez del 14, y esa diferencia son 3 días de trabajo.
2. Pedir el cliente de referencia (llamada, no correo — un "sí" con agenda tarda días).
3. Bloquear 1 hora en la noche: precio de las hojas 3 y 5. Se necesita en el cierre de la demo y la consultora lo va a preguntar.

**Ingeniería — el resto del día:**

- Avisar a la sesión de reservaciones que su árbol no compila (`reservationAvailability.service.test.ts:951`, `duration: null`). **No lo
  arregles tú, no lo stashees.**
- Los 5 commits con rutas explícitas (4 en server, 1 en dashboard). **Nunca `git add -A`.**
- Verificar que el árbol _commiteado_ compila: worktree limpio desde el commit → `tsc`. Eso prueba que CI va a salir verde sin esperar los 7
  minutos ni pelearte con el archivo del vecino.
- `pg_dump` de prod. Un minuto. Es el único rollback que existe (0 archivos `down.sql`).
- Copiarle `SET lock_timeout='5s'` a la primera migración.
- Poner correos falsos a los 3 proveedores de `la-ribera-demo` (crear una OC dispara correo real, y en la demo se crean en vivo).

**Al cerrar:** correo enviado, todo commiteado, árbol commiteado compila, prod respaldada, correos a proveedores desactivados.

### VIERNES 7 — día de despliegue (ingeniería)

- `pre-deploy` sobre el worktree limpio (20-30 min).
- Push a develop → CI verde (8m33s). Ensayo gratis.
- Push a main → Render (13m30s). Verificar `prisma migrate status` = up to date. Probar A MANO una OC con mercancía de reventa en prod.
- **Después** dashboard a main → Cloudflare (6m50s). El orden no es preferencia, es requisito.
- Avisar a las sesiones de iOS/Android: cambió `/mobile` (aditivo, pero un renglón huérfano ahora es 400).

**Founder:** si no hay respuesta de Wendy al mediodía, **llamar** (no re-enviar correo). Cerrar cliente de referencia y precios.

**Al cerrar:** compras vivo en producción, verificado a mano. Frente 3 CERRADO.

### SÁBADO 8 — datos de demo (ingeniería)

Todo sobre `la-ribera-demo` en PROD. **No construir un seed nuevo de paradores** — el guion ya decidió que la demo pasa en La Ribera; un
seed multi-venue es un día completo y 1200 órdenes contra prod.

- RFC + `FiscalEmisor` con **`includeCashInAccounting: true`** (sin eso el libro diario ignora todo el efectivo).
- Sembrar catálogo de cuentas, verificar los 7 mapeos.
- 3-4 CFDIs de proveedor en el Buzón (uno del mismo proveedor de una OC recibida, uno SIN pagar).
- 2 roles a la medida + un usuario cada uno.
- OCs en todos los estados, dos de ellas MIXTAS (insumo + mercancía en la misma orden), una PARCIAL.
- **No generar las pólizas.** Probar el botón en un periodo viejo, borrar esas pólizas, y dejar el momento pico para la sala.
- Recorrer a mano las 8 pantallas.

_Si el founder no trabaja el sábado, esto se va al lunes y el ensayo al martes — y eso sólo funciona si Wendy confirma el 13 o 14._

### DOMINGO 9 — colchón + puerta dura

Se usa para lo que se rompió jueves-sábado. Si no se rompió nada: el founder escribe la lista de "lo que NO está" con fecha comprometida
para cada hueco. **Puerta dura, domingo 20:00:** si el ambiente de demo no está listo, el frente 2 muere sin importar la fecha.

### LUNES 10 — ENSAYO. NO SE TOCA.

- Corrida completa con cronómetro, dos veces. Bloque 4, tres veces.
- Pestaña del Anexo 24 precargada con Bearer token (no tiene pantalla, en el navegador normal falla).
- Capturas de las 8 pantallas guardadas en una carpeta, por si prod hipa.
- Segundo perfil de navegador con Comprador y Almacenista ya logueados.
- **Cero despliegues el lunes. Congelado.**

### MARTES 11 — demo, o día de holgura

Si Wendy dijo el 11: se corre. Si dijo 12-14: el martes es la única ventana posible para la tajada del frente 2, con re-ensayo la víspera.

---

## 2. HOY MISMO, por urgencia real

1. **Enviar el correo a Wendy (10 min).** Es lo único que no controlas y lo que fija todo lo demás. Mantén la propuesta del 14 — no ofrezcas
   el 11.
2. **Avisar a la sesión de reservaciones (2 min).** Su archivo bloquea tu `pre-deploy` y no es tuyo para arreglar.
3. **`pg_dump` de prod (1 min).** No hay migraciones de bajada. Es la única red.
4. **Los 5 commits con rutas explícitas (1-2 h).**
5. **Verificar el árbol commiteado en un worktree limpio (10 min).**
6. **Correos falsos a los proveedores de La Ribera (5 min).** Se olvida siempre y sale un correo a un tercero en plena reunión.
7. **Pedir el cliente de referencia (15 min).** También tiene latencia de días.
8. **Precio hojas 3 y 5 (1 h, noche).**

---

## 3. Camino crítico

```
commits → typecheck limpio del árbol commiteado → push main
    → migraciones aplicadas en PROD  ← ESTE ES EL ESLABÓN
        → sembrado de la-ribera-demo (RFC, catálogo, mapeos, CFDIs, roles, OC mixta)
            → ensayo cronometrado
                → demo
```

El eslabón que arrastra todo es **las migraciones vivas en prod**. Sin ellas no se puede capturar una OC con mercancía de reventa, y sin esa
OC no hay bloque 1 (el módulo #1 de su ponderación) ni datos que alimenten la contabilidad del bloque 4.

El eslabón débil que **nadie posee**: el typecheck rojo del archivo de reservaciones. No es tuyo, no es de compras, y bloquea el
`pre-deploy` local. Por eso se avisa hoy y se resuelve con worktree, no esperando a que alguien más lo arregle.

Si el deploy se pasa del sábado, el sembrado se pasa del domingo y el ensayo se come el lunes. **El día que el founder dijo que no se toca
es el primero que se pierde.**

---

## 4. Dónde YA NO CABE

**Los 4 días del frente 2 no caben. Punto.**

La aritmética: hoy ya se va en commits. Viernes es deploy. Sábado es sembrado. Lunes es ensayo intocable. Quedan **cero** días. Un frente 2
que arranque el viernes termina el martes 11 en el mejor caso — y eso es sólo el código: le cuelga una tercera migración, un segundo
despliegue en semana de demo, resembrar roles y re-ensayar. Aterriza el 12, después de la fecha más temprana posible de la demo.

**Se corta, en este orden:**

- **El umbral de autorización por sucursal: FUERA, completo.** Exige cambio de esquema → tercera migración → segundo deploy en semana de
  demo. No vale el riesgo. Se declara con fecha.
- **Los permisos separados (`inventory:approve` / `inventory:receive`): fuera, salvo que Wendy confirme el 13 o el 14.** Con esa
  confirmación hay una ventana real: martes 11 el código, miércoles 12 deploy en la mañana y re-sembrado de roles en la tarde, re-ensayo
  el 13. Ya es agresivo.
- **El seed nuevo de paradores (`seed-pits-demo.ts`, 3 venues + 2 ligeros): FUERA.** Es un día completo, choca con lo que ya decidió el
  guion, y sembrar ~1200 órdenes contra prod el fin de semana es exactamente el escenario de "se cayó a la mitad y hay que hacer teardown
  bajo presión". La demo pasa en La Ribera.

---

## 5. Plan B — la demo se sostiene sin el frente 2

Sí, y no por poco.

- **El bloque 2 son 12 de 90 minutos y no es el pico.** El pico son los quince segundos entre pulsar "generar pólizas" y ver la balanza
  cuadrada al centavo. Eso no depende del frente 2 en absoluto.

**Qué se enseña en su lugar, todo real y ya construido:**

1. El editor de roles por sucursal, en vivo: los permisos son por venue y por rol y se configuran. Ahí es donde va a vivir el umbral, y se
   enseña el lugar.
2. Los sellos que SÍ existen en el detalle de la orden: quién pidió, quién recibió, con fecha.
3. El candado real y probado el 5 de agosto: una orden con recepción registrada **ya no se puede editar**.
4. La bitácora de la orden (ActivityLog).
5. La declaración con fecha comprometida en la sala.

Las respuestas P2 y P3 del guion ya están escritas y funcionan **igual de bien como declaración que como demostración**: «un nivel más
umbral por sucursal, exactamente lo que trae Odoo de fábrica; lo estamos cerrando y la fecha es \_\_\_».

Un evaluador de ERP castiga la sorpresa del mes 6, no el hueco nombrado en la reunión. Y nombrarlo compra credibilidad para los otros cinco
huecos del bloque 6.

**Lo que NO se debe hacer:** crear dos roles que se ven distintos y tienen el mismo poder real. Si la consultora lo pica en vivo, cuesta más
que el hueco.

---

## 6. Los tres riesgos que más probablemente tumban esto

**R1 — La fecha cae el 11, o se pasa del 14, porque el correo sigue en borradores.** Probabilidad: alta, y es 100% autoinfligido.
_Mitigación:_ enviarlo hoy antes del mediodía manteniendo la propuesta del 14. Si no hay respuesta el viernes al mediodía, llamar por
teléfono. Nunca ofrecer el 11 como alternativa.

**R2 — El despliegue no aterriza porque el árbol tiene trabajo ajeno roto y cada intento cuesta 7 minutos de typecheck.** _Mitigación:_ no
arreglar ni stashear el archivo del vecino — commitear con rutas explícitas y validar en worktree limpio. Desplegar el **viernes**, no el
lunes, para tener dos días de colchón. `pg_dump` antes de cualquier migración. Ensayar el regreso: redeploy del anterior en Render (4-5
min) + rollback instantáneo en Cloudflare.

**R3 — El bloque 4, el pico, falla en vivo.** Tres formas: el libro diario sale casi vacío porque `includeCashInAccounting` quedó en false,
el XML del Anexo 24 pide token frente al cliente, o prod hipa. _Mitigación:_ prender el flag y **probar la generación de pólizas en un
periodo viejo el sábado**, luego borrarlas; precargar la pestaña del Anexo 24 con el token antes de entrar a la sala; capturas de las 8
pantallas guardadas el lunes; y ensayar el bloque 4 tres veces. Si sólo se ensaya una cosa en toda la semana, es ésa.
