---
title: Abrir y cerrar la caja en la terminal
description: Abre la caja con el efectivo inicial y ciérrala con el conteo de efectivo en la terminal, cuando el negocio usa turnos de caja.
product: tpv
category: caja
task: abrir-y-cerrar-caja
requiredPermissions:
  - tpv-shifts:create
  - tpv-shifts:close
money: true
versionMin: 2.16.0
sourceRepo: avoqado-tpv
sourceRef: 18685818f1b0b1059d1f4b34e00710c451db4341
deviceTested: 2026-11-18
keywords:
  - abrir caja
  - cerrar caja
  - turno de caja
  - corte de caja
  - arqueo
  - fondo de caja
  - no puedo abrir la caja
  - caja cerrada en otro aparato
  - pin de gerente para abrir caja
---

## Antes de empezar

El botón *Turnos de caja* sale en el inicio sólo si el negocio usa turnos de caja.

La caja la abren y la cierran los puestos de mesero, cajero, gerente, administrador y dueño (el negocio puede cambiarlo en los permisos de cada puesto). Cocina, hostess y consulta no la abren.

## Pasos

1. En el inicio, toca *Turnos de caja*.
2. Para abrir, toca *Abrir caja* (o *Abrir nueva caja*), escribe el *Efectivo Inicial* o toca un monto sugerido, y toca *Abrir caja*.
3. Para cerrar, toca *Cerrar caja*.
4. Si sale *Arqueo de caja*, cuenta el efectivo, escribe el *Efectivo total contado* (incluye el fondo inicial) y toca *Cerrar y conciliar*.
5. Si no vas a contar, toca *Cerrar sin conteo* y luego *Sí, cerrar sin conteo*. Si no sale el arqueo, confirma con *Cerrar caja*.
6. Al cerrar, la pantalla dice «Cierre pendiente» hasta que Avoqado confirma el cierre, y después «Caja cerrada». Si sale *Listo*, tócalo.

## Problemas frecuentes

- «Caja pendiente de revisión»: toca *Revisar registros pendientes*.
- «Cierre guardado en este aparato» con «Pendiente de confirmación. No es un corte definitivo.»: el cierre todavía no se confirma; toca *Listo*.
- «Tu puesto no puede abrir la caja: un cajero, gerente o el dueño pondrá su PIN» (app 2.22.4 o más nueva): toca *Abrir caja* (o *Abrir nueva caja*), escribe el *Efectivo Inicial* y toca *Abrir caja*; luego alguien que sí pueda abrirla escribe su PIN en «PIN de un gerente» y toca *Autorizar*. El PIN necesita internet.
- «Tu puesto no puede abrir la caja. Pide a un cajero, gerente o al dueño que entre y la abra»: el negocio tiene apagado el PIN de gerente. Que esa persona entre con su usuario, abra la caja y salga.
- En versiones anteriores a la 2.22.4, sin permiso el botón sale en gris con «No tienes permiso para abrir la caja»: que entre alguien que sí pueda abrirla.
- «Caja cerrada o cerrándose en otro aparato»: la caja se cerró en otra terminal, en la tablet o en el panel. Si el negocio ya abrió otra, la terminal la usa sola en cuanto se conecta (desde la 2.22.4, también si quien entró es de Cocina). Si no hay otra abierta, toca *Abrir nueva caja*.

## Sin internet

Si arriba dice «Sin conexión · guardado en este aparato», la apertura o el cierre quedaron guardados en la terminal y se envían después.
