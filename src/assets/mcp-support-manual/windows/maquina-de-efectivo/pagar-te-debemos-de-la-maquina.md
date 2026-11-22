---
title: Pagar el «Te debemos» de la máquina de efectivo en el POS Windows
description: Qué significa «Te debemos $X» en el ticket de la máquina de efectivo y cómo se le paga al cliente con un retiro de caja con el folio en la nota.
product: windows
category: maquina-de-efectivo
task: pagar-te-debemos-de-la-maquina
requiredPermissions:
  - cash-drawer:pay-out
money: true
versionMin: 2.25.58
sourceRepo: avoqado-android
sourceRef: e7d51ad0634df24ba3522a7364884567fd82009d
deviceTested: 2026-11-22
keywords:
  - me deben cambio
  - la máquina no me dio cambio
  - te debemos
  - pasa a caja a cobrarlo
  - comprobante de la máquina
  - comprobante de diferencia
  - folio de la máquina
  - pagar cambio pendiente
---

## Antes de empezar

«Te debemos…» quiere decir que la máquina le quedó a deber dinero al cliente: no tuvo cambio suficiente, al cancelar no devolvió todo, o el precio bajó antes de subir una venta hecha sin internet. Sale en la pantalla y en el ticket («Te debemos $X de cambio: pasa a caja a cobrarlo · Folio …») o en el *COMPROBANTE DE LA MÁQUINA* o *COMPROBANTE DE DIFERENCIA* («Te debemos $X: pasa a caja a cobrarlo»), con un folio que empieza con AQ.

Se paga con un retiro desde la caja que tiene el cajón, con la caja abierta.

## Pasos

1. Pide el ticket o el comprobante y revisa el monto y el folio. En la PC de la máquina también salen en *Ajustes* › *Máquina de efectivo*, en «Lo que la máquina les debe a clientes».
2. En la caja con el cajón, en *Más*, toca *Caja* y luego *Egreso*.
3. En *Registrar egreso*, escribe en *Monto ($)* lo que se debe y en *Concepto* «Te debemos folio» con el folio. Toca *Confirmar*.
4. Si sale *Autorizar retiro*, un gerente teclea su PIN.
5. Entrega el dinero al cliente.

## Problemas frecuentes

- La lista de la PC no se borra al pagar: todavía no lleva quién pagó. Por eso el folio va en el concepto: antes de pagar, revisa en *Movimientos* de la caja que no haya ya un egreso con ese folio.
- Para reimprimir un comprobante, toca *Imprimir comprobante* junto a su folio; si hay más, *Ver más*.
- Si en vez del monto dice «Revisar en el panel», lo que contó la máquina no cuadra: no pagues hasta que un gerente lo revise en el panel.
- Si el cobro se canceló porque nadie contestó «¿Sigues ahí?», la caja dice «Se canceló el cobro» sin monto: la máquina guardó el dinero. Si la persona regresa, un gerente confirma cuánto dejó antes de pagarlo así.
- «Sólo un gerente puede retirar efectivo. Pídele que lo haga con su usuario, o que el dueño active el PIN de gerente en el panel.»

## Sin internet

Con permiso para retirar, el retiro se guarda y sube solo: «Retiro registrado. Se subirá al servidor cuando vuelva la conexión.» Con el PIN de un gerente sale «Sin conexión. Para retirar necesitas el PIN de un gerente, y eso requiere internet. El efectivo se queda en la caja.»
