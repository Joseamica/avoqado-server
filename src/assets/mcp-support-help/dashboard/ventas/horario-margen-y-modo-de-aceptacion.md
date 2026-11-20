---
title: Horario, margen y modo de aceptación
description: En la tarjeta de cada canal de delivery pon el horario de pedidos y el margen sobre tu precio de mostrador, y elige si los pedidos se aceptan solos o a mano.
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
  - productos-en-delivery
  - problemas-con-pedidos-de-delivery
keywords:
  - margen de delivery
  - horario de delivery
  - aceptar pedidos automático o manual
  - precio distinto en Uber
  - el precio en Rappi es más caro
  - Rappi redondea el precio
  - alguien cambió este canal
---

## Antes de empezar

En **Ventas > Delivery** conectas tus apps de reparto (Uber Eats y Rappi) para que sus pedidos entren solos a Avoqado: salen en la pantalla de cocina del punto de venta, se imprimen en tus impresoras, descuentan inventario y cuentan en tu corte como cualquier venta.

Delivery es una función del plan **Premium**. Si tu plan no la incluye, la pantalla se ve con candado.

Quién puede qué:

- **Dueño y administrador**: conectan, cambian horario, margen, productos e impresión, prenden o apagan **Recibir pedidos** y cambian el modo de aceptación.
- **Gerente**: ve la pantalla de Delivery, pero no cambia la configuración.

## Pasos

### Horario y margen

1. En la tarjeta del canal presiona **Horario, precios, productos e impresión**.
2. En **Horario de pedidos** prende cada día y pon su hora de apertura y cierre. Fuera de ese horario la app no te manda pedidos, así que no tienes que rechazarlos.
3. En **Margen para delivery** escribe el porcentaje que se suma a tu precio de mostrador sólo en ese canal. Debajo ves el ejemplo: «Un producto de $100 se publica en $…».
4. Presiona **Guardar**.

Si nunca pusiste horario, se publica uno estimado de lunes a sábado de 9:00 a 22:00 y la pantalla te lo avisa: ajústalo a tu horario real.

### Automático o Manual

En la tarjeta del canal, **Modo de aceptación**:

- **Automático**: cada pedido se acepta al llegar y va directo a cocina. Es lo recomendado.
- **Manual** (sólo Uber Eats; Rappi no lo tiene): el pedido espera en la pantalla de cocina con **Aceptar** y **No puedo**. El reloj de la app corre igual; si nadie contesta, el pedido se cancela y cuenta en tu contra.

En Rappi los pedidos siempre se aceptan solos: si presionas **Manual** en su tarjeta, sale «No se pudo actualizar el modo de aceptación» y el canal sigue en **Automático**.

## Problemas frecuentes

**El precio en la app es distinto al del mostrador.** Es el **Margen para delivery** o un precio fijo de ese canal. En Rappi, además, se redondea a pesos enteros.

**Al guardar dice «Alguien cambió este canal mientras lo editabas».** Otra persona guardó cambios en ese canal. Presiona **Recargar** y vuelve a hacer tu cambio.
