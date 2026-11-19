---
title: Problemas con pedidos de delivery
description: Qué revisar si no te llegan los pedidos de Uber Eats o Rappi, cómo pausarlos un rato o cerrar el día, qué dicen los avisos de la tarjeta del canal y cuándo pedir ayuda.
product: dashboard
category: ventas
featureCode: DELIVERY_CHANNELS
dashboardRoutes:
  - delivery
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-11-18
sourceRepo: avoqado-web-dashboard
relatedArticles:
  - conectar-rappi
  - solicitar-activacion-uber-eats
  - horario-margen-y-modo-de-aceptacion
keywords:
  - no me llegan los pedidos de Rappi
  - no me llegan los pedidos de Uber
  - me saturé
  - pausar Rappi
  - pausar Uber Eats
  - aceptación baja
  - menú sin publicar
---

## Antes de empezar

En **Ventas > Delivery** conectas tus apps de reparto (Uber Eats y Rappi) para que sus pedidos entren solos a Avoqado: salen en la pantalla de cocina del punto de venta, se imprimen en tus impresoras, descuentan inventario y cuentan en tu corte como cualquier venta.

Delivery es una función del plan **Premium**. Si tu plan no la incluye, la pantalla se ve con candado.

Quién puede qué:

- **Dueño y administrador**: conectan, cambian horario, margen, productos e impresión, prenden o apagan **Recibir pedidos** y cambian el modo de aceptación.
- **Gerente**: ve la pantalla de Delivery, pero no cambia la configuración.
- **Cajero, mesero, cocina y gerente**: pueden usar **Me saturé** desde el punto de venta.

## Pasos

### Me saturé y no quiero más pedidos un rato

1. En la pantalla de cocina del punto de venta toca **Me saturé** y elige 20 o 40 minutos, una hora o dos.
2. Se reactiva solo al terminar el tiempo; si te pones al día antes, toca **Ya estamos al día**.

Los pedidos ya aceptados siguen su curso.

### Quiero cerrar todo el día (festivo)

1. En **Ventas > Delivery**, apaga **Recibir pedidos** en la tarjeta del canal y préndelo al otro día.
2. Si es un cambio permanente, ajusta el horario.

## Problemas frecuentes

**No me llegan los pedidos de Uber o de Rappi.** En **Ventas > Delivery**, revisa en **Tus canales** que el canal diga **Activo**. Si dice **Pausado**, el dueño o el administrador prende **Recibir pedidos** en su tarjeta. Revisa también su **Horario de pedidos** en **Horario, precios, productos e impresión**: fuera de ese horario la app no te manda pedidos. Si un pedido de la app nunca llegó a la pantalla de cocina, escala el caso (ve **Cuándo pedir ayuda**).

**La tarjeta dice «Se cerró desde el portal de Rappi».** La tienda se cerró desde el portal de la app. Para volver a abrirla, prende **Recibir pedidos** en la tarjeta; si ya estaba prendido, apágalo y vuelve a prenderlo.

**La tarjeta dice «Aceptación 95%».** De los pedidos que te mandó la app, sólo ese porcentaje entró. Por debajo del 99% la app puede suspender la integración: deja el modo en **Automático** y el horario real.

**La tarjeta dice «Menú sin publicar».** La app todavía no tiene tu carta de Avoqado: puede estar vendiendo otra carta o ninguna. Revisa que el canal tenga productos y horario y guarda; si el aviso sigue, pide ayuda.

## Cuándo pedir ayuda

Escala el caso si un pedido de la app nunca llegó a la pantalla de cocina o si la aceptación baja sin que hayas rechazado pedidos. Incluye sucursal, canal, hora aproximada y número de pedido de la app.
