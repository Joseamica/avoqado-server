---
title: Enviar el recibo de un pago por correo en el panel
description: Manda por correo el recibo digital de un pago desde Ventas › Transacciones en el panel.
product: dashboard
category: pagos
task: enviar-recibo-por-correo
requiredPermissions:
  - payments:refund
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
keywords:
  - enviar recibo
  - recibo digital
  - mandar ticket por correo
  - reenviar recibo
---

## Antes de empezar

Mandar el recibo pide el mismo permiso que reembolsar. Sin ese permiso sale «No se pudo enviar el recibo».

## Pasos

1. En *Ventas* › *Transacciones*, abre el pago.
2. Arriba del detalle, toca *Enviar Recibo Digital*.
3. En *Correo electrónico*, escribe el correo del cliente y toca *Enviar*.

## Problemas frecuentes

- *Enviar* se prende hasta que escribes un correo.
- «Recibo enviado» quiere decir que el recibo quedó listo. El correo se manda después y, si ese envío falla, el panel no avisa.
- Si sale «No se pudo enviar el recibo», revisa que tengas el permiso, pero no lo mandes otra vez: el recibo pudo quedar listo en un primer intento. Si el cliente no lo recibe, pide que lo revise una persona del equipo de Avoqado.
