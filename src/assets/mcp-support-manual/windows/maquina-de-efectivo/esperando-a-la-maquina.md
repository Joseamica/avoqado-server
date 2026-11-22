---
title: Cobro «Esperando a la máquina» en el POS Windows
description: Qué hacer si el POS Windows no supo cómo terminó un cobro en la máquina de efectivo: no lo cobres otra vez; un gerente lo resuelve en el panel.
product: windows
category: maquina-de-efectivo
task: esperando-a-la-maquina
requiredPermissions:
  - payments:create
money: true
versionMin: 2.25.57
sourceRepo: avoqado-android
sourceRef: e7d51ad0634df24ba3522a7364884567fd82009d
deviceTested: 2026-11-22
keywords:
  - esperando a la máquina
  - dice esperando a la máquina
  - no lo cobres otra vez
  - la máquina cobró y no se registró
  - se cerró el POS a media venta
  - un gerente lo resuelve en el panel
  - cobro en duda de la máquina
---

## Antes de empezar

Sale cuando la caja no alcanzó a oír cómo terminó el cobro: se cerró el POS, se cortó la red o se apagó la PC a media venta. La máquina pudo haber cobrado, cancelado o seguir cobrando. Nunca se cierra solo: lo resuelve un gerente en el panel, con lo que dice la máquina.

## Pasos

1. La caja dice «Esperando a la máquina: un gerente lo resuelve en el panel» y «La máquina no confirmó cómo terminó este cobro. No lo cobres otra vez.»
2. Mira la pantalla de la máquina para saber si cobró, canceló o sigue cobrando.
3. No vuelvas a cobrar esa venta: *Efectivo en la máquina* regresa a esta misma pantalla y la tarjeta no sale. Si necesitas la caja, toca *Salir*: la venta sigue esperando.
4. Avísale a un gerente: lo resuelve en el panel, en *Ventas* › *Cobros de la máquina en duda* (también desde el celular).
5. La caja revisa sola ese cobro y, cuando el gerente lo resuelve, enseña cómo terminó: la venta cobrada (toca *Venta nueva*) o «El gerente lo resolvió en el panel…» (toca *Listo*).

## Problemas frecuentes

- En la fila de la máquina sale «Esta venta espera a la máquina: un gerente la resuelve en el panel» o «Esta venta ya tiene un cobro en la máquina: espera a que termine o a que un gerente lo resuelva en el panel»: es la misma venta; no se puede cobrar de otra forma.
- «No se cobró la venta: el dinero quedó registrado para que el gerente lo revise.»: no hay venta; el gerente lo revisa en el panel.
- «Revisar en el panel · Folio …»: lo que contó la máquina no cuadra con lo registrado. No pagues nada al cliente hasta que un gerente lo revise.
- «El servidor respondió otros importes para este folio: pide a un gerente que lo revise».
- «Esta PC no está emparejada con la máquina: emparéjala en Ajustes para subir sus cobros»: un gerente la empareja en *Ajustes* › *Máquina de efectivo*.

## Sin internet

La duda se guarda en la PC y sube sola cuando vuelve la conexión. Resolverla necesita internet, en el panel. Si la PC se apagó o perdió la red con dinero a medias, la caja no puede cancelar ese cobro: atiéndelo en la pantalla de la máquina y que un gerente lo resuelva después.
