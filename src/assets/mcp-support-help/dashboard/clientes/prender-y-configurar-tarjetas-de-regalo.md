---
title: Prender y configurar las tarjetas de regalo
description: Prende la venta de tarjetas de regalo aceptando sus reglas, y elige los montos sugeridos, el mínimo, el máximo y la vigencia de las que vendas desde ahora.
product: dashboard
category: clientes
featureCode: GIFT_CARDS
dashboardRoutes:
  - settings/gift-cards
  - gift-cards
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-11-25
sourceRepo: avoqado-web-dashboard
sourceRef: 501e37072a13f5ed8f22e3d650f2598d3d8820b6
relatedArticles:
  - reenviar-tarjeta-de-regalo
keywords:
  - prender tarjetas de regalo
  - activar tarjetas de regalo
  - vender tarjetas de regalo
  - no me deja vender tarjetas de regalo
  - las tarjetas de regalo están apagadas
  - montos de la tarjeta de regalo
  - vigencia de la tarjeta de regalo
  - apagar tarjetas de regalo
  - gift card
---

## Antes de empezar

Las tarjetas de regalo se venden en el punto de venta de Android y Windows; en iPad y iPhone todavía no. Vender y prenderlas viene en el plan **Pro** o como función suelta. Ver los saldos y el historial de las que ya vendiste nunca se esconde, aunque bajes de plan.

Hay dos permisos distintos:

- **Prender o apagar** las tarjetas: de fábrica, el dueño y el administrador. Sin ese permiso sale «Sólo el dueño o un administrador pueden prenderlas o apagarlas.».
- **Cambiar los montos y la vigencia**: de fábrica, el gerente, el administrador y el dueño. Sin ese permiso la página se ve en sólo lectura.

El interruptor está en dos lugares con el mismo efecto: **Configuración > Tarjetas de regalo** y **Clientes > Tarjetas de regalo**. En esta última se ve mientras están apagadas; ya prendidas, sólo lo ve quien puede apagarlas.

## Pasos

1. Abre **Configuración > Tarjetas de regalo**.
2. En **Vender tarjetas de regalo**, prende el interruptor.
3. En **Antes de prender las tarjetas de regalo**, lee las reglas, marca la casilla de los términos y toca **Prender**. Sale «Tarjetas de regalo prendidas».
4. En **Montos y vigencia**, escribe hasta tres **Montos sugeridos** (son los botones que ve el cajero; también puede escribir otro monto), el **Monto mínimo**, el **Monto máximo** y elige la **Vigencia**.
5. Toca **Guardar**. Sale «Cambios guardados».

Para apagarlas, apaga el mismo interruptor y confirma con **Apagar**. Ya no se venden nuevas, pero las que vendiste se siguen cobrando y las sigues viendo en **Clientes > Tarjetas de regalo**.

## Problemas frecuentes

- **El interruptor no se deja prender:** si sale «No pudimos confirmar tu plan, así que todavía no se pueden prender.», toca **Intentar otra vez**. Si tu plan no incluye tarjetas de regalo, la página se ve con el cartel del plan.
- **«Tu plan ya no incluye vender tarjetas de regalo.»:** bajaste de plan. Puedes apagarlas; las ya vendidas se siguen cobrando.
- **«A Avoqado le falta un paso para que vendas tarjetas de regalo.»:** falta una configuración del lado de Avoqado. Pide que lo revise una persona del equipo de Avoqado.
- **Un monto no se guarda:** el mínimo no puede ser mayor que el máximo, los montos sugeridos tienen que quedar entre el mínimo y el máximo, y el aviso dice el tope por tarjeta. Si sale «Escribe al menos un monto sugerido.», llena al menos uno.
- **La vigencia:** lo recomendado es **Sin vencimiento**. Lo que cambies aplica a las tarjetas que vendas desde ahora; las que ya vendiste conservan lo que se le dijo al cliente.
- **En el punto de venta no sale la tarjeta de regalo:** revisa que el interruptor esté prendido aquí y que la persona tenga permiso para vender tarjetas de regalo.

## Así funcionan

Se venden en el punto de venta en una cuenta aparte de la mercancía. El cliente paga con el saldo, completo o una parte, y lo que falte con otro medio. El saldo nunca se cambia por efectivo ni se transfiere, y se factura cuando se usa, no cuando se vende.
