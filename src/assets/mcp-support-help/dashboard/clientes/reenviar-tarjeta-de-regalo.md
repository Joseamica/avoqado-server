---
title: Reenviar una tarjeta de regalo por WhatsApp o correo
description: Desde Clientes › Tarjetas de regalo, revisa cómo va la entrega de una tarjeta digital y vuelve a mandarla al mismo WhatsApp o correo.
product: dashboard
category: clientes
featureCode: GIFT_CARDS
dashboardRoutes:
  - gift-cards
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-11-25
sourceRepo: avoqado-web-dashboard
sourceRef: 501e37072a13f5ed8f22e3d650f2598d3d8820b6
relatedArticles:
  - prender-y-configurar-tarjetas-de-regalo
keywords:
  - reenviar tarjeta de regalo
  - no le llegó la tarjeta de regalo
  - la tarjeta de regalo no llegó por WhatsApp
  - la tarjeta de regalo no llegó por correo
  - no se pudo enviar
---

## Antes de empezar

**Reenviar** y **Cambiar destino** piden el permiso para administrar tarjetas de regalo (de fábrica, gerente, administrador y dueño). Sólo salen en una tarjeta **Activa**; no salen en un saldo a favor ni en una tarjeta guardada en la tarjeta digital de un cliente.

**Reenviar** manda otra vez la tarjeta al mismo destino y el código no cambia. Sólo sale si la tarjeta se mandó por WhatsApp o correo.

Mandarla a **otro** teléfono o correo es **Cambiar destino**, junto a **Reenviar**: eso repone el código (el de antes deja de servir) y tiene sus propios pasos.

## Pasos

1. En **Clientes > Tarjetas de regalo**, busca la tarjeta por sus últimos 4, nombre, teléfono o correo, y ábrela.
2. En **Entrega** revisa el **Destino**, cuándo se **Envió** y los **Intentos**. Si no se pudo mandar, ahí mismo dice por qué.
3. Para mandarla otra vez al mismo destino, toca **Reenviar** y confirma con **Reenviar**. Sale «Listo: la tarjeta va en camino a …».
4. Si el destino estaba mal escrito, no la reenvíes: hay que cambiar el destino, que repone el código.

## Problemas frecuentes

- **«WhatsApp todavía no está disponible para tarjetas…»:** desde el panel, cambia el destino a un correo (eso repone el código). Imprimirla o enseñar su QR se hace desde la venta, en el POS.
- **«WhatsApp avisó que el mensaje no llegó a ese teléfono.»:** revisa el número; si está mal, hay que cambiar el destino.
- **«El correo de quien la recibe no es válido.»:** hay que cambiar el destino a un correo bueno.
- **«No supimos si salió el envío. Reenvíala para estar seguros.»:** toca **Reenviar**.
- **«Ya reenviamos esta tarjeta varias veces. Espera un rato y vuelve a intentar.»:** espera antes de reenviarla otra vez.
- **«No supimos si se guardó. Toca «Intentar otra vez»: no se aplica dos veces.»:** toca **Intentar otra vez** con los mismos datos.
- **«Enviada»** quiere decir que WhatsApp o el correo aceptaron el mensaje, no que la persona ya lo abrió.
