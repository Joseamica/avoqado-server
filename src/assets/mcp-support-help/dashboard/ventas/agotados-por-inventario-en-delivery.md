---
title: Agotados por inventario en delivery
description: Haz que un producto se marque agotado solo en Uber Eats o en Rappi cuando se acaba en tu inventario de Avoqado, o apágalo si no llevas tu inventario al día.
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
  - productos-en-delivery
  - horario-margen-y-modo-de-aceptacion
  - problemas-con-pedidos-de-delivery
keywords:
  - se agotó solo en Uber
  - se agotó solo en Rappi
  - no se agota en Uber
---

## Antes de empezar

En **Ventas > Delivery** conectas tus apps de reparto (Uber Eats y Rappi) para que sus pedidos entren solos a Avoqado: salen en la pantalla de cocina del punto de venta, se imprimen en tus impresoras, descuentan inventario y cuentan en tu corte como cualquier venta.

Delivery es una función del plan **Premium**. Si tu plan no la incluye, la pantalla se ve con candado.

Quién puede qué:

- **Dueño y administrador**: conectan, cambian horario, margen, productos e impresión, prenden o apagan **Recibir pedidos** y cambian el modo de aceptación.
- **Gerente**: ve la pantalla de Delivery, pero no cambia la configuración.

## Pasos

### Que se agote solo según tu inventario

En la tarjeta del canal presiona **Horario, precios, productos e impresión**.

En la misma pantalla, **Marcar agotado en Rappi según tu inventario** (o en Uber Eats):

- **Prendido** (viene así): cuando un producto se queda sin existencias en Avoqado, se marca agotado en ese canal solo.
- **Apagado**: nunca se agota por inventario. Apágalo si no llevas tu inventario al día, para que no salgan agotados productos que sí tienes.

Presiona **Guardar**: sale «Ajustes guardados». Si cierras la pantalla sin guardar, el cambio no se aplica.

Los cambios de precio, de productos y de agotados viajan solos a cada canal. Si un cambio no aparece en la app, revisa **Última sincronización de menú** en la tarjeta del canal.

## Problemas frecuentes

**Se agotó solo en Uber o en Rappi y sí lo tengo.** Tu inventario en Avoqado llegó a cero. Corrige las existencias o apaga **Marcar agotado según tu inventario** en ese canal.

**No se agota en la app aunque ya no tengo.** Revisa que **Marcar agotado según tu inventario** esté prendido y que el producto lleve inventario. Si se acabó a media operación, márcalo agotado en tu carta de Avoqado.
