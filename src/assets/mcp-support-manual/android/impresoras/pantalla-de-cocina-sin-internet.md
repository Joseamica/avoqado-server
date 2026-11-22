---
title: Cuando la pantalla de cocina no está conectada a internet en el POS Android
description: Qué hacer cuando el POS Android avisa arriba que una pantalla de cocina no está conectada a internet o no se alcanza por el WiFi.
product: android
category: impresoras
task: pantalla-de-cocina-sin-internet
requiredPermissions: []
featureCode: KITCHEN_DISPLAY
gateKind: FEATURE
versionMin: 2.25.54
sourceRepo: avoqado-android
sourceRef: 6e37a5418eda101109e73fd319bdb3eb5932cbe6
keywords:
  - la pantalla de cocina no está conectada
  - pantalla de cocina sin internet
  - no está conectada a internet
  - no se alcanza por el wifi
  - franja naranja de la pantalla de cocina
  - no llegan las comandas a la pantalla
  - la pantalla de cocina no recibe comandas
  - ya no avisa no salió la comanda
  - comanda de respaldo pantalla sin conexión
---

## Antes de empezar

Con internet en la caja, arriba puede salir la franja naranja «La pantalla de cocina de … no está conectada a internet» (con varias, «Las pantallas de cocina de … no están conectadas a internet»). Quiere decir que esa pantalla lleva más de un minuto sin pedir sus comandas por internet. Lo más común: está cerrada, su aparato está apagado o no tiene internet.

No es al instante: puede tardar unos 2 minutos en salir o en quitarse. Puede salir junto a otro aviso, separados por « · ».

## Pasos

1. En la caja, lee en la franja de qué estación es la pantalla. Mientras se arregla, avisa a cocina de palabra lo que mandes a esa estación.
2. En el aparato de esa pantalla, abre el POS y en *Más* toca *Pantalla de cocina* (esa entrada pide el permiso de actualizar pedidos).
3. Si sale «¿Qué estación es esta pantalla?», elige la estación de esa pantalla, la que nombra la franja.
4. Déjala abierta y a la vista. Cerrada, con el aparato apagado o, en una tablet, con el POS en segundo plano, esa pantalla no pide sus comandas.
5. Si en esa pantalla sale un aviso que empieza con «Sin conexión» o «Sin internet», ese aparato no tiene internet: revisa su red.
6. Regresa a la caja: la franja se quita sola cuando la pantalla vuelve a pedir sus comandas.

## Problemas frecuentes

- Si la pantalla ya está abierta y la franja sigue, revisa que arriba del tablero diga el nombre de esa estación: abierta en otra estación no cuenta para la de la franja. Si dice otra, toca el engrane y *Cambiar de estación*.
- Si arriba sale «La pantalla de … no se alcanza por el WiFi» (con varias, «Las pantallas de … no se alcanzan por el WiFi»), la caja y esa pantalla no se encuentran en la red del local: deja la pantalla abierta y conecta los dos aparatos a la misma red (no a la de invitados). Se quita con la primera comanda que esa pantalla reciba por el WiFi.
- Mientras una pantalla no se alcanza por el WiFi, las comandas de una estación que sólo tiene pantalla (sin impresora) salen en papel de respaldo, con el encabezado «RESPALDO · …», si la caja tiene dónde imprimirlas. Lo que salió en papel de respaldo puede ya no aparecer en esa pantalla: que cocina trabaje con el papel.
- Con internet, cuando la comanda de una estación que sólo tiene pantalla no llega por el WiFi ni sale en papel, la caja ya no avisa «No salió la comanda de: …» en cada orden: la venta ya está en el servidor y la pantalla la toma de ahí. Sí sigue avisando si falla una impresora, si se quedó sin papel otra estación que no es sólo pantalla, si la venta se cobró sólo en parte o si la caja no ha podido confirmar con el servidor que esa estación tiene pantalla.
- Que no salga ninguna franja no quiere decir que la pantalla esté conectada: la de internet no sale sin internet en la caja ni en una sesión sin el permiso de ver pedidos.

## Sin internet

- Sin internet en la caja, la franja «… no está conectada a internet» no sale: la caja no puede saberlo. Arriba sale «Sin conexión — …».
- Si esa franja agrega «Las comandas de … salen en papel si la pantalla no contesta», son las estaciones que sólo tienen pantalla: su comanda les llega por el WiFi del local o, si la pantalla no contesta, sale en papel de respaldo.
- Sin internet, si la comanda de una estación no llega a su pantalla por el WiFi ni sale en papel, la caja sí avisa «No salió la comanda de: …».
