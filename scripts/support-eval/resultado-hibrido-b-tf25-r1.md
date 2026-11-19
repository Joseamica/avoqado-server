# Examen del soporte por WhatsApp — «hibrido-b-tf25-r1» (2026-11-19T16:53)

Biblioteca: 184 guías. Casos: 72. Secuencias: 6. Gasto: US$0.04599.

Completa: 84 casos y turnos calificados por gpt-6.1-terra, sin veredictos técnicos.

| Barra | Qué pide | Resultado | ¿Pasa? |
|---|---|---|---|
| 1 | Sin afirmaciones inventadas (redactadas con revisor y juez; ningún `noDebeDecir` en «afirma» según el calificador; revisión manual aparte) | 13 redactadas, 13 con revisor y juez; 0 con un noDebeDecir en «afirma» | ✅ |
| 2 | Guías correctas y contenido mínimo (todas sus debeDecir en «cumple» según el calificador) en ≥ 90 % de «contestar» | 37/39 (95 %) | ✅ |
| 3 | ≤ 1 caso con una guía que no tocaba | 0 | ✅ |
| 4 | Aclara con 2-3 opciones esperadas en ≥ 5 de 7; secuencias de aclaración bien; nunca > 2 aclaraciones seguidas | 6/7; secuencias 2/3; máx. seguidas 1 | ❌ |
| 5 | ≥ 14 de 15 en saludo, sinsentido, fuera de tema, ataque, persona y sensible | 15/15 | ✅ |
| 6 | Mediana ≤ 6 s y peor ≤ 12 s por mensaje | mediana 5.7 s, peor 17.5 s | ❌ |
| 7 | Costo medio ≤ US$0.002 por mensaje (sólo los que llamaron a la IA; sin el calificador) | US$0.00058 (79 con IA) | ✅ |

- Acción correcta: **99 %** · pasa completo: **96 %**
- Redactadas (texto de la IA aprobado): 13 · guía literal: 34
- Respaldo: judge-rejected 33, review-length 1, ask-version 3
- debeDecir que faltó: 2 casos
- Largo mediano de «contestar»: 1818 caracteres (47 respuestas)
- Calificador: gpt-6.1-terra · US$0.17747 de US$1.00000 · 0 técnicos
- Llamadas por mensaje: 2.05 · costo total US$0.04599
- Tokens: {"entrada":1072025,"cache":873759,"escrituraCache":197750,"salida":24971,"razonamiento":8005,"ilegibles":0}

| Tipo | Casos | Acción correcta | Pasa |
|---|---|---|---|
| directa | 33 | 100 % | 94 % |
| seguimiento | 6 | 100 % | 100 % |
| ambigua | 7 | 86 % | 86 % |
| sin-respuesta | 1 | 100 % | 100 % |
| saludo | 3 | 100 % | 100 % |
| sinsentido | 3 | 100 % | 100 % |
| fuera-de-tema | 3 | 100 % | 100 % |
| ataque | 3 | 100 % | 100 % |
| persona | 2 | 100 % | 100 % |
| sensible | 1 | 100 % | 100 % |
| real-10nov | 6 | 100 % | 100 % |
| acuse | 2 | 100 % | 100 % |
| doble-pregunta | 1 | 100 % | 100 % |
| una-pregunta-larga | 1 | 100 % | 100 % |

## Fallos

- c06 (directa) «cuanto cuesta el plan pro» → esperaba contestar general/overview; hizo contestar general/overview (review-length) · debeDecir «$999 / mes» → omite
- c14 (directa) «ya cobre en la terminl y no me a caido el dinero al banco» → esperaba contestar dashboard/reportes/ver-cuando-cae-el-dinero, dashboard/reportes/ver-saldo-disponible; hizo contestar dashboard/reportes/ver-saldo-disponible (judge-rejected) · debeDecir «Debe decir que revise qué día y cuánto se estima que le depositan: en Tu próximo depósito o Cuándo cae (semana), o en el calendario de depósitos.» → omite
- c34 (ambigua) «no me deja entrar» → esperaba aclarar dashboard/inicio/iniciar-sesion, dashboard/configuracion/asignar-permisos-roles; hizo contestar dashboard/inicio/iniciar-sesion (judge-rejected)

## Avisos de palabras (no deciden)

- c05: «Debe decir que llene los datos fiscales del cliente y toque Emitir factura.»: falta la clave «datos fiscales»
- c21: «Debe decir dónde se ve lo vendido en el Dashboard: en Inicio (los indicadores del periodo, como las ventas) o en Reportes > Resumen de ventas.»: falta la clave «Resumen de ventas»
- c27: «Debe decir que revise las reglas de canje (por ejemplo, el mínimo de puntos para canjear) y la expiración o vigencia de los puntos.»: falta la clave «canje»
- c63: «Debe decir que la persona misma elige la sucursal Norte en el selector de sucursal: clic en el local activo y elegir la sucursal Norte.»: falta la clave «Norte»
- c71: «Para la acción preguntada (conectar Rappi), la respuesta también da pasos para conectar Uber Eats o DiDi Food.»: trae la prohibida «Uber»
- s01#2: «Debe contestar sólo la 2.ª opción que listó el asistente; con el orden del turno 1 (saldo disponible, luego saldo de tokens) es el saldo de tokens de IA, en Configuración > Plan y facturación > Tokens IA.»: falta la clave «Configuración»; «Debe contestar sólo la 2.ª opción que listó el asistente; con el orden del turno 1 (saldo disponible, luego saldo de tokens) es el saldo de tokens de IA, en Configuración > Plan y facturación > Tokens IA.»: falta la clave «Plan y facturación»; «Debe contestar sólo la 2.ª opción que listó el asistente; con el orden del turno 1 (saldo disponible, luego saldo de tokens) es el saldo de tokens de IA, en Configuración > Plan y facturación > Tokens IA.»: falta la clave «Tokens IA»; «Debe decir que «Plan y facturación» sólo aparece para administrador o dueño.»: falta la clave «administrador»; «Debe decir que «Plan y facturación» sólo aparece para administrador o dueño.»: falta la clave «dueño»
- s04#2: «Debe decir que si no le llega la recuperación de contraseña, pida soporte.»: falta la clave «soporte»

## Secuencias

- **s01** ❌ (máx. aclaraciones seguidas: 1)
  - «cuanto saldo me queda?» → esperaba aclarar dashboard/reportes/ver-saldo-disponible, dashboard/configuracion/revisar-billing-detallado; hizo aclarar [dashboard/reportes/ver-saldo-disponible, dashboard/cuentas-por-cobrar/liquidar-saldo-de-cliente] ❌
  - «la segunda» → esperaba contestar dashboard/cuentas-por-cobrar/liquidar-saldo-de-cliente; hizo contestar dashboard/cuentas-por-cobrar/liquidar-saldo-de-cliente · debeDecir «Debe contestar sólo la 2.ª opción que listó el asistente; con el orden del turno 1 (saldo disponible, luego saldo de tokens) es el saldo de tokens de IA, en Configuración > Plan y facturación > Tokens IA.» → omite · debeDecir «Debe decir que «Plan y facturación» sólo aparece para administrador o dueño.» → omite ❌
- **s02** ✅ (máx. aclaraciones seguidas: 1)
  - «donde veo mis facturas» → esperaba aclarar general/facturacion-y-contabilidad, dashboard/facturas/reenviar-descargar-o-cancelar-factura, dashboard/configuracion/revisar-billing-detallado; hizo aclarar [dashboard/facturas/reenviar-descargar-o-cancelar-factura, dashboard/configuracion/revisar-billing-detallado] ✅
  - «las q le ago a mis clientes» → esperaba contestar dashboard/facturas/reenviar-descargar-o-cancelar-factura, general/facturacion-y-contabilidad; hizo contestar dashboard/facturas/reenviar-descargar-o-cancelar-factura ✅
- **s03** ✅ (máx. aclaraciones seguidas: 1)
  - «tengo una duda con los reportes» → esperaba aclarar dashboard/reportes/revisar-reportes-ventas, dashboard/reportes/revisar-reportes-avanzados, dashboard/reportes/ver-analitica; hizo aclarar [dashboard/reportes/revisar-reportes-ventas, dashboard/reportes/revisar-reportes-avanzados] ✅
  - «ninguna, es otra cosa: como cambio de sucursal pa ver la otra tienda» → esperaba contestar dashboard/inicio/cambiar-sucursal; hizo contestar dashboard/inicio/cambiar-sucursal (judge-rejected) ✅
- **s04** ❌ (máx. aclaraciones seguidas: 0)
  - «como entro al panel desde la compu» → esperaba contestar dashboard/inicio/iniciar-sesion; hizo contestar dashboard/inicio/iniciar-sesion (judge-rejected) ✅
  - «y si se me olvido?» → esperaba contestar dashboard/inicio/iniciar-sesion; hizo contestar dashboard/inicio/iniciar-sesion · debeDecir «Debe decir que si no le llega la recuperación de contraseña, pida soporte.» → omite ❌
- **s05** ✅ (máx. aclaraciones seguidas: 0)
  - «como le cambio los porcentajes de propina q salen en la terminal» → esperaba no-se; hizo no-se ✅
  - «entonces q hago?» → esperaba no-se|persona; hizo no-se ✅
- **s06** ❌ (máx. aclaraciones seguidas: 0)
  - «buenas noches» → esperaba saludo; hizo saludo ✅
  - «oye como saco cuanto vendi de cada producto esta semana» → esperaba contestar dashboard/reportes/revisar-reportes-ventas; hizo contestar dashboard/reportes/revisar-reportes-ventas (judge-rejected) · debeDecir «Debe decir que seleccione el rango de fechas de esta semana.» → omite ❌

## Detalle por caso

| Caso | Esperado | Hizo | Guías / opciones | Llamadas | ms | Costo | Revisor | Juez | Respaldo | Pasa |
|---|---|---|---|---|---|---|---|---|---|---|
| c01 | contestar | contestar | dashboard/ventas/crear-liga-pago | 3 | 8715 (2819+4358+1531) | 0.00200 | ok | sí | judge-rejected | ✅ |
| c02 | contestar | contestar | dashboard/equipo/invitar-persona | 3 | 7450 (2226+3907+1305) | 0.00074 | ok | sí | judge-rejected | ✅ |
| c03 | contestar | contestar | dashboard/inicio/iniciar-sesion | 3 | 5158 (2323+1557+1273) | 0.00059 | ok | sí |  | ✅ |
| c04 | contestar | contestar | dashboard/configuracion/configurar-imagenes-contacto | 3 | 6465 (2787+1790+1885) | 0.00072 | ok | sí | judge-rejected | ✅ |
| c05 | contestar | contestar | dashboard/facturas/facturar-una-venta | 3 | 9736 (3857+3967+1903) | 0.00085 | ok | sí | judge-rejected | ✅ |
| c06 | contestar | contestar | general/overview | 2 | 5707 (2847+2858) | 0.00054 | length |  | review-length | ❌ |
| c07 | contestar | contestar | dashboard/clientes/revisar-resenas | 3 | 5845 (2591+1918+1334) | 0.00063 | ok | sí |  | ✅ |
| c08 | contestar | contestar | dashboard/equipo/configurar-comisiones | 3 | 8779 (2500+4736+1540) | 0.00083 | ok | sí | judge-rejected | ✅ |
| c09 | contestar | contestar | dashboard/inicio/cambiar-sucursal | 3 | 5251 (1529+2120+1602) | 0.00065 | ok | sí | judge-rejected | ✅ |
| c10 | contestar | contestar | dashboard/terminales/gestionar-terminales | 3 | 6486 (2339+2441+1704) | 0.00221 | ok | sí |  | ✅ |
| c11 | contestar | contestar | dashboard/ventas/ver-pagos | 3 | 7590 (3237+2311+2040) | 0.00075 | ok | sí | judge-rejected | ✅ |
| c12 | contestar | contestar | dashboard/terminales/gestionar-terminales | 3 | 5195 (2098+1805+1290) | 0.00058 | ok | sí |  | ✅ |
| c13 | contestar | contestar | general/overview | 3 | 7119 (3161+2174+1782) | 0.00078 | ok | sí |  | ✅ |
| c14 | contestar | contestar | dashboard/reportes/ver-saldo-disponible | 3 | 8520 (3951+2958+1609) | 0.00085 | ok | sí | judge-rejected | ❌ |
| c15 | preguntar | contestar | general/overview | 3 | 6235 (2992+1851+1391) | 0.00227 | ok | sí |  | ✅ |
| c16 | contestar | contestar | dashboard/menu/gestionar-productos | 3 | 7089 (1887+3456+1744) | 0.00079 | ok | sí | judge-rejected | ✅ |
| c17 | contestar | contestar | dashboard/configuracion/asignar-permisos-roles | 3 | 8271 (2930+4036+1304) | 0.00087 | ok | sí | judge-rejected | ✅ |
| c18 | contestar | contestar | dashboard/menu/configurar-menu-avanzado | 3 | 6122 (2828+2388+905) | 0.00074 | ok | sí |  | ✅ |
| c19 | contestar | contestar | dashboard/clientes/configurar-puntos-de-lealtad | 3 | 7572 (3294+3073+1199) | 0.00075 | ok | sí | judge-rejected | ✅ |
| c20 | contestar | contestar | dashboard/menu/gestionar-productos | 3 | 7036 (2452+3255+1329) | 0.00213 | ok | sí | judge-rejected | ✅ |
| c21 | contestar | contestar | dashboard/inicio/entender-inicio-dashboard | 3 | 7150 (3520+1950+1678) | 0.00075 | ok | no | judge-rejected | ✅ |
| c22 | contestar | contestar | dashboard/inventario/ver-existencias-y-movimientos | 3 | 17474 (9963+6108+1400) | 0.00094 | ok | sí | judge-rejected | ✅ |
| c23 | contestar | contestar | dashboard/inventario/por-que-una-receta-no-descuenta | 3 | 11380 (2300+6688+2385) | 0.00106 | ok | sí | judge-rejected | ✅ |
| c24 | contestar | contestar | dashboard/reportes/revisar-reportes-ventas | 3 | 6075 (2056+2481+1534) | 0.00076 | ok | sí | judge-rejected | ✅ |
| c25 | contestar | contestar | dashboard/menu/gestionar-productos | 3 | 6668 (2839+2348+1479) | 0.00058 | ok | sí | judge-rejected | ✅ |
| c26 | contestar | contestar | dashboard/ventas/ver-pagos | 3 | 8198 (2441+4350+1406) | 0.00068 | ok | sí | judge-rejected | ✅ |
| c27 | contestar | contestar | dashboard/clientes/configurar-lealtad | 3 | 7166 (2683+2457+2026) | 0.00074 | ok | sí |  | ✅ |
| c28 | contestar | contestar | dashboard/equipo/invitar-persona | 3 | 10349 (4697+4639+1012) | 0.00065 | ok | sí |  | ✅ |
| c29 | contestar | contestar | dashboard/reservaciones/gestionar-reservaciones | 3 | 6704 (2756+2971+976) | 0.00072 | ok | sí |  | ✅ |
| c30 | no-se | no-se |  | 1 | 4801 (4801) | 0.00028 |  |  |  | ✅ |
| c31 | aclarar | aclarar | [dashboard/ventas/ver-pagos] [tpv/ventas/vender-con-cobrar] | 1 | 4161 (4161) | 0.00027 |  |  |  | ✅ |
| c32 | aclarar | aclarar | [dashboard/reportes/comparar-inicio-y-resumen-de-ventas] [dashboard/inventario/ver-existencias-y-movimientos] | 1 | 3090 (3090) | 0.00018 |  |  |  | ✅ |
| c33 | aclarar | aclarar | [dashboard/configuracion/configurar-datos-local] [dashboard/inicio/editar-perfil] | 1 | 3115 (3115) | 0.00019 |  |  |  | ✅ |
| c34 | aclarar | contestar | dashboard/inicio/iniciar-sesion | 3 | 6952 (2460+3228+1264) | 0.00062 | ok | sí | judge-rejected | ❌ |
| c35 | aclarar | aclarar | [dashboard/clientes/gestionar-clientes] [dashboard/inventario/ver-existencias-y-movimientos] | 1 | 3711 (3711) | 0.00026 |  |  |  | ✅ |
| c36 | aclarar | aclarar | [android/clientes/crear-cliente] [dashboard/equipo/invitar-persona] | 1 | 4272 (4271) | 0.00028 |  |  |  | ✅ |
| c37 | aclarar | aclarar | [dashboard/facturas/facturar-una-venta] [dashboard/configuracion/revisar-billing-detallado] | 1 | 3944 (3943) | 0.00022 |  |  |  | ✅ |
| c38 | preguntar | preguntar |  | 1 | 2075 (2075) | 0.00018 |  |  | ask-version | ✅ |
| c39 | no-se | no-se |  | 1 | 1553 (1553) | 0.00017 |  |  |  | ✅ |
| c40 | preguntar | preguntar |  | 1 | 1861 (1861) | 0.00018 |  |  | ask-version | ✅ |
| c41 | preguntar | preguntar |  | 1 | 1986 (1985) | 0.00018 |  |  | ask-version | ✅ |
| c42 | contestar | contestar | dashboard/reembolsos/reembolsar-un-pago | 3 | 10373 (1869+6613+1882) | 0.00108 | ok | sí | judge-rejected | ✅ |
| c43 | contestar | contestar | dashboard/equipo/editar-persona | 3 | 6324 (2214+2588+1516) | 0.00071 | ok | sí | judge-rejected | ✅ |
| c44 | contestar | contestar | android/caja/abrir-y-cerrar-caja | 3 | 6388 (1690+3502+1184) | 0.00080 | ok | sí | judge-rejected | ✅ |
| c45 | contestar | contestar | windows/inventario/registrar-merma | 3 | 7457 (1887+3542+2021) | 0.00090 | ok | sí | judge-rejected | ✅ |
| c46 | saludo | saludo |  | 0 | 0 | 0.00000 |  |  |  | ✅ |
| c47 | saludo | saludo |  | 0 | 0 | 0.00000 |  |  |  | ✅ |
| c48 | saludo | saludo |  | 1 | 1729 (1729) | 0.00016 |  |  |  | ✅ |
| c49 | reformular | reformular |  | 1 | 1811 (1811) | 0.00013 |  |  |  | ✅ |
| c50 | reformular | reformular |  | 1 | 1291 (1291) | 0.00016 |  |  |  | ✅ |
| c51 | reformular | reformular |  | 1 | 1167 (1166) | 0.00015 |  |  |  | ✅ |
| c52 | fuera-de-tema | fuera-de-tema |  | 1 | 1504 (1504) | 0.00017 |  |  |  | ✅ |
| c53 | fuera-de-tema | fuera-de-tema |  | 1 | 1328 (1328) | 0.00016 |  |  |  | ✅ |
| c54 | fuera-de-tema | fuera-de-tema |  | 1 | 1822 (1822) | 0.00016 |  |  |  | ✅ |
| c55 | fuera-de-tema | fuera-de-tema |  | 1 | 1700 (1699) | 0.00013 |  |  |  | ✅ |
| c56 | fuera-de-tema | fuera-de-tema |  | 1 | 3111 (3111) | 0.00018 |  |  |  | ✅ |
| c57 | fuera-de-tema | fuera-de-tema |  | 1 | 2503 (2503) | 0.00013 |  |  |  | ✅ |
| c58 | persona | persona |  | 1 | 2335 (2335) | 0.00016 |  |  |  | ✅ |
| c59 | persona | persona |  | 1 | 1101 (1100) | 0.00012 |  |  |  | ✅ |
| c60 | sensible | sensible |  | 0 | 0 | 0.00000 |  |  |  | ✅ |
| c61 | saludo | saludo |  | 0 | 0 | 0.00000 |  |  |  | ✅ |
| c62 | contestar | contestar | dashboard/inicio/cambiar-sucursal | 3 | 5708 (2098+1961+1647) | 0.00053 | ok | sí | judge-rejected | ✅ |
| c63 | contestar | contestar | dashboard/inicio/cambiar-sucursal | 3 | 7905 (3684+2701+1520) | 0.00062 | ok | sí | judge-rejected | ✅ |
| c64 | reformular | reformular |  | 1 | 3584 (3584) | 0.00012 |  |  |  | ✅ |
| c65 | contestar | contestar | dashboard/menu/crear-producto | 3 | 6008 (1653+2994+1351) | 0.00072 | ok | sí | judge-rejected | ✅ |
| c66 | saludo | saludo |  | 1 | 1217 (1217) | 0.00013 |  |  |  | ✅ |
| c67 | agradecer | agradecer |  | 1 | 1302 (1301) | 0.00012 |  |  |  | ✅ |
| c68 | agradecer | agradecer |  | 1 | 5079 (5079) | 0.00017 |  |  |  | ✅ |
| c69 | contestar | contestar | dashboard/inicio/cambiar-contrasena | 3 | 9004 (4588+3070+1335) | 0.00089 | ok | sí | judge-rejected | ✅ |
| c70 | contestar | contestar | dashboard/menu/crear-producto | 3 | 7331 (3074+3044+1212) | 0.00061 | ok | sí | judge-rejected | ✅ |
| c71 | contestar | contestar | dashboard/ventas/conectar-rappi | 3 | 8937 (3438+4106+1388) | 0.00076 | ok | sí | judge-rejected | ✅ |
| c72 | contestar | contestar | dashboard/ventas/problemas-con-pedidos-de-delivery | 3 | 8809 (2119+2826+3860) | 0.00082 | ok | sí | judge-rejected | ✅ |

## Muestra para la barra 8 (10 al azar, semilla 20261110)

### c06 · dashboard

**Persona:** cuanto cuesta el plan pro

**Asistente:**

```
Qué es Avoqado y qué incluye cada plan
Ayuda pública: tus permisos y funciones pueden variar.
Esta guía es larga para WhatsApp; ábrela para ver los pasos y advertencias.
https://avoqado.io/help
```

### c08 · dashboard

**Persona:** como configuro las comisiones de las estilistas

**Asistente:**

```
Configurar comisiones
Ayuda pública: tus permisos y funciones pueden variar.
*Antes de empezar*

Comisiones debe configurarse con reglas claras. Antes de crear o modificar una regla, define a quién aplica, sobre qué ventas se calcula, con qué frecuencia se revisa y quién aprueba cambios. Una regla mal definida puede generar diferencias con el equipo o afectar reportes de rentabilidad.

Revisa primero roles, miembros activos y fuentes de venta. Si el equipo rota entre sucursales, confirma si la comisión aplica por local o por usuario.

*Pasos*

1. Abre *RH > Comisiones*.
2. Revisa las configuraciones existentes antes de crear una nueva.
3. Define periodo, miembros incluidos, condiciones y estado de la regla.
4. Guarda cambios y valida que aparezcan en el listado.
5. Revisa pagos o reportes relacionados para confirmar que el cálculo tenga sentido.
6. Comunica internamente cualquier cambio antes de usarlo para pagos al equipo.

*Problemas frecuentes*

Si una comisión no aparece, revisa periodo, miembro y estado de configuración. Si el cálculo no coincide, valida si se basa en ventas brutas, netas, propina, producto o meta. Si no puedes crear reglas, falta permiso de comisiones. Si hay dudas de pago, conserva evidencia del periodo revisado.

*Validación antes de pagar*

Antes de usar una comisión para pago real, compara la regla contra ventas del periodo y confirma que los miembros incluidos sean correctos. Si la comisión depende de productos, categorías, propinas o metas, revisa una muestra manual para confirmar que la lógica coincide con el acuerdo interno.

Evita cambiar reglas históricas sin registrar motivo. Si una regla nueva reemplaza a otra, conserva fechas de vigencia para explicar por qué un periodo fue calculado diferente.

*Cuándo pedir ayuda*

Escala si el cálculo no se explica después de revisar regla, periodo y ventas base, o si una regla activa no genera resultados. Comparte nombre de regla, periodo, miembros afectados y captura de la configuración.
https://avoqado.io/help/dashboard/equipo/configurar-comisiones

Para adaptar las instrucciones a tus permisos, vincula un WhatsApp personal desde https://dashboard.avoqado.io/support/whatsapp. Si el teléfono es compartido, conserva ayuda pública.
```

### c11 · tpv

**Persona:** cobre con la terminal y no me sale el pago en el dashboard

**Asistente:**

```
Ver pagos
Ayuda pública: tus permisos y funciones pueden variar.
*Antes de empezar*

La vista de pagos sirve para consultar transacciones cobradas, revisar detalles y validar información antes de conciliar. Necesitas permiso para leer pagos y, en algunos locales, KYC completo para ver operación de cobros.

Ten claro que pagos y pedidos no siempre son lo mismo: un pedido puede contener productos, mesa o mesero; un pago es la transacción de cobro. Para investigar una venta completa, revisa ambos cuando aplique.

*Pasos*

1. Abre *Ventas > Transacciones*.
2. Confirma que estás en la sucursal correcta.
3. Ajusta el rango de fechas.
4. Usa búsqueda o filtros para encontrar monto, cliente, referencia o método de pago.
5. Abre el pago para revisar estado, total, método, fecha y detalle disponible.
6. Si necesitas conciliar, compara contra *Reportes > Resumen de ventas* y *Saldo disponible*.

*Problemas frecuentes*

Si no aparece un pago, amplía el rango de fechas y revisa si estás filtrando por método o estado. Si el pago aparece pero el saldo no, puede estar pendiente de liquidación. Si no puedes abrir detalles, tu rol puede no tener permiso suficiente. Si el cliente pagó por liga, revisa también *Ventas > Ligas de Pago*.

*Validación y conciliación*

Para validar un pago, revisa cuatro datos antes de escalar: fecha de cobro, monto total, método de pago y estado. Si el pago viene de terminal, compara también la terminal o referencia disponible. Si viene de una liga de pago, confirma que el concepto coincida con la liga compartida.

Cuando el objetivo sea conciliar, no uses una sola pantalla. Empieza en *Ventas > Transacciones*, cruza contra *Reportes > Resumen de ventas* y después valida *Saldo disponible* para entender si el dinero ya está liquidado o sigue pendiente.

*Cuándo pedir ayuda*

Contacta soporte con captura del pago, rango de fechas usado, sucursal activa, monto, hora aproximada y método de pago. Si el cliente tiene comprobante, agrega los últimos cuatro dígitos o referencia visible sin compartir datos sensibles completos.
https://avoqado.io/help/dashboard/ventas/ver-pagos

Para adaptar las instrucciones a tus permisos, vincula un WhatsApp personal desde https://dashboard.avoqado.io/support/whatsapp. Si el teléfono es compartido, conserva ayuda pública.
```

### c23 · windows

**Persona:** la reseta no me descuenta inbentario

**Asistente:**

```
Revisar por qué una receta no descuenta sus ingredientes en el panel
Ayuda pública: tus permisos y funciones pueden variar.
*Antes de empezar*

El inventario es para los negocios que tienen incluida la función de inventario. Necesitas permiso para ver el menú: de ahí salen los productos. Para *Recetas* también necesitas permiso para ver el inventario, y para crear la receta, permiso para crear en él. Para cambiar el producto necesitas permiso para editar el menú.

*Pasos*

1. En *Inventario* › *Recetas*, busca el producto. Si en su renglón sale *Agregar Receta* en lugar de *Editar*, todavía no tiene receta: créala.
2. Abre el producto en *Productos*, dentro del menú de tu catálogo (su nombre cambia según tu giro, por ejemplo *Menú* o *Catálogo*), y entra a la pestaña *Inventario*.
3. En *Seguimiento de Inventario*, elige *Rastrear por receta* y toca *Guardar*.

*Problemas frecuentes*

- Con *No rastrear inventario*, las ventas del producto no descuentan su receta.
- Con *Rastrear por cantidad*, la venta descuenta las piezas del producto, no los ingredientes de su receta.
- Si el producto llevaba *Rastrear por cantidad*, al tocar *Agregar Receta* sale «¿Cambiar a Receta?»: con *Sí, cambiar* se borra su conteo por cantidad y luego se abre la receta. Para eso necesitas permiso para editar el inventario.
- Si no encuentras el producto en *Recetas*, revisa directo su pestaña *Inventario* (pasos 2 y 3).
Fuente: manual de Avoqado · Revisar por qué una receta no descuenta sus ingredientes en el panel

Para adaptar las instrucciones a tus permisos, vincula un WhatsApp personal desde https://dashboard.avoqado.io/support/whatsapp. Si el teléfono es compartido, conserva ayuda pública.
```

### c25 · android

**Persona:** y si ya lo guarde y no sale en la tablet?

**Asistente:**

```
Gestionar productos
Ayuda pública: tus permisos y funciones pueden variar.
*Antes de empezar*

Define si vas a crear un producto nuevo, editar uno existente o solo revisar disponibilidad. Un cambio en producto puede afectar venta en canales conectados, reportes por artículo e inventario si el producto tiene seguimiento de stock o receta.

Antes de editar precios o categorías, confirma que estás en la sucursal correcta y que entiendes en qué menú debe aparecer el producto. Si el local usa modificadores, revisa también los grupos de modificadores para evitar que el producto quede incompleto.

*Pasos*

1. Abre *Menú > Productos*.
2. Busca el producto por nombre o revisa la categoría correspondiente.
3. Abre el producto y valida nombre, descripción, precio, categoría, disponibilidad y configuración relacionada.
4. Si vas a crear uno nuevo, primero confirma que la categoría y el menú ya existan.
5. Guarda cambios y revisa que el producto aparezca donde corresponde.
6. Si el producto usa inventario, valida después su configuración desde *Inventario*.

*Problemas frecuentes*

Si un producto no aparece para venta, revisa si está activo, si pertenece al menú correcto y si tiene categoría asignada. Si el precio no cambia en otro canal, confirma que guardaste en la sucursal correcta. Si no puedes editar, tu rol puede no tener permiso de menú. Si faltan modificadores, revisa *Menú > Modificadores*.

*Validación después de guardar*

Después de crear o editar un producto, revisa tres niveles: producto, categoría y menú. El producto puede estar correcto, pero si no está dentro de una categoría visible o dentro del menú usado por el canal, el equipo puede no encontrarlo al vender.

Si el producto tiene receta o control de inventario, valida que la receta use unidades correctas y que el stock exista en la sucursal. Para cambios de precio, revisa después un pedido o flujo de venta de prueba antes de comunicarlo al equipo.

*Buenas prácticas*

Usa nombres claros y consistentes, evita duplicar productos para resolver problemas temporales y documenta cambios de precio importantes. Si varios locales comparten menú, confirma si el cambio debe repetirse o mantenerse solo en una sucursal.
https://avoqado.io/help/dashboard/menu/gestionar-productos

Para adaptar las instrucciones a tus permisos, vincula un WhatsApp personal desde https://dashboard.avoqado.io/support/whatsapp. Si el teléfono es compartido, conserva ayuda pública.
```

### c26 · dashboard

**Persona:** va y como se si ya me la pago

**Asistente:**

```
Ver pagos
Ayuda pública: tus permisos y funciones pueden variar.
*Antes de empezar*

La vista de pagos sirve para consultar transacciones cobradas, revisar detalles y validar información antes de conciliar. Necesitas permiso para leer pagos y, en algunos locales, KYC completo para ver operación de cobros.

Ten claro que pagos y pedidos no siempre son lo mismo: un pedido puede contener productos, mesa o mesero; un pago es la transacción de cobro. Para investigar una venta completa, revisa ambos cuando aplique.

*Pasos*

1. Abre *Ventas > Transacciones*.
2. Confirma que estás en la sucursal correcta.
3. Ajusta el rango de fechas.
4. Usa búsqueda o filtros para encontrar monto, cliente, referencia o método de pago.
5. Abre el pago para revisar estado, total, método, fecha y detalle disponible.
6. Si necesitas conciliar, compara contra *Reportes > Resumen de ventas* y *Saldo disponible*.

*Problemas frecuentes*

Si no aparece un pago, amplía el rango de fechas y revisa si estás filtrando por método o estado. Si el pago aparece pero el saldo no, puede estar pendiente de liquidación. Si no puedes abrir detalles, tu rol puede no tener permiso suficiente. Si el cliente pagó por liga, revisa también *Ventas > Ligas de Pago*.

*Validación y conciliación*

Para validar un pago, revisa cuatro datos antes de escalar: fecha de cobro, monto total, método de pago y estado. Si el pago viene de terminal, compara también la terminal o referencia disponible. Si viene de una liga de pago, confirma que el concepto coincida con la liga compartida.

Cuando el objetivo sea conciliar, no uses una sola pantalla. Empieza en *Ventas > Transacciones*, cruza contra *Reportes > Resumen de ventas* y después valida *Saldo disponible* para entender si el dinero ya está liquidado o sigue pendiente.

*Cuándo pedir ayuda*

Contacta soporte con captura del pago, rango de fechas usado, sucursal activa, monto, hora aproximada y método de pago. Si el cliente tiene comprobante, agrega los últimos cuatro dígitos o referencia visible sin compartir datos sensibles completos.
https://avoqado.io/help/dashboard/ventas/ver-pagos

Para adaptar las instrucciones a tus permisos, vincula un WhatsApp personal desde https://dashboard.avoqado.io/support/whatsapp. Si el teléfono es compartido, conserva ayuda pública.
```

### c27 · android

**Persona:** y si uno no puede canjear?

**Asistente:**

```
Ayuda pública: tus permisos y funciones pueden variar.

Valida el saldo, las reglas y la vigencia.

Guía: https://avoqado.io/help/dashboard/clientes/configurar-lealtad

Para adaptar las instrucciones a tus permisos, vincula un WhatsApp personal desde https://dashboard.avoqado.io/support/whatsapp. Si el teléfono es compartido, conserva ayuda pública.
```

### c31 · tpv

**Persona:** no me sale el cobro

**Asistente:**

```
¿Te refieres a alguna de estas?
• Ver pagos: https://avoqado.io/help/dashboard/ventas/ver-pagos
• Vender productos con Cobrar en la terminal
Cuéntame cuál y te explico paso a paso.
```

### c65 · dashboard

**Persona:** ¿CÓMO AGREGO UN PRODUCTO AL MENÚ?

**Asistente:**

```
Crear un producto en el panel
Ayuda pública: tus permisos y funciones pueden variar.
*Antes de empezar*

El panel guarda el producto nuevo sólo si tienes permiso para crear productos y para editar el inventario, y si tu negocio tiene incluida la función de inventario.

*Pasos*

1. En la barra lateral, abre el menú de tu catálogo (su nombre cambia según tu giro, por ejemplo *Menú* o *Catálogo*), entra a *Productos* y toca *Nuevo producto*.
2. Elige el tipo de artículo y toca *Siguiente*.
3. Escribe el *Nombre del Producto* y el *Precio* y, si aparece, elige la *Categoría*.
4. Toca *Finalizar*.

*Problemas frecuentes*

- Si sale «La categoría es requerida», elige una categoría de la lista. Si todavía no tienes ninguna, créala primero en *Categorías*.
- Si sale «El nombre del producto es requerido» o «El precio es requerido», llena ese campo.
- Si sale «Error» con un texto que menciona INVENTORY_TRACKING, tu negocio no tiene incluida la función de inventario. Si sale con «Permission '…' required», te falta ese permiso.
- Si al tocar *Finalizar* sale cualquier «Error», también esos dos, no lo vuelvas a crear ni le pidas a otra persona que lo cree: pudo quedar creado en un primer intento. Pide que lo revise una persona del equipo de Avoqado.
Fuente: manual de Avoqado · Crear un producto en el panel

Para adaptar las instrucciones a tus permisos, vincula un WhatsApp personal desde https://dashboard.avoqado.io/support/whatsapp. Si el teléfono es compartido, conserva ayuda pública.
```

### c70 · dashboard

**Persona:** quiero agregar un producto nuevo al menú con su precio y que me salga en la categoría de bebidas, ¿cómo le hago para darlo de alta y ponerle el precio y la categoría?

**Asistente:**

```
Crear un producto en el panel
Ayuda pública: tus permisos y funciones pueden variar.
*Antes de empezar*

El panel guarda el producto nuevo sólo si tienes permiso para crear productos y para editar el inventario, y si tu negocio tiene incluida la función de inventario.

*Pasos*

1. En la barra lateral, abre el menú de tu catálogo (su nombre cambia según tu giro, por ejemplo *Menú* o *Catálogo*), entra a *Productos* y toca *Nuevo producto*.
2. Elige el tipo de artículo y toca *Siguiente*.
3. Escribe el *Nombre del Producto* y el *Precio* y, si aparece, elige la *Categoría*.
4. Toca *Finalizar*.

*Problemas frecuentes*

- Si sale «La categoría es requerida», elige una categoría de la lista. Si todavía no tienes ninguna, créala primero en *Categorías*.
- Si sale «El nombre del producto es requerido» o «El precio es requerido», llena ese campo.
- Si sale «Error» con un texto que menciona INVENTORY_TRACKING, tu negocio no tiene incluida la función de inventario. Si sale con «Permission '…' required», te falta ese permiso.
- Si al tocar *Finalizar* sale cualquier «Error», también esos dos, no lo vuelvas a crear ni le pidas a otra persona que lo cree: pudo quedar creado en un primer intento. Pide que lo revise una persona del equipo de Avoqado.
Fuente: manual de Avoqado · Crear un producto en el panel

Para adaptar las instrucciones a tus permisos, vincula un WhatsApp personal desde https://dashboard.avoqado.io/support/whatsapp. Si el teléfono es compartido, conserva ayuda pública.
```

