---
title: Reimprimir el comprobante de un retiro de efectivo en el POS Windows
description: Saca otra vez el comprobante de un retiro (bajada) desde los movimientos de la caja en el POS Windows, sin volver a registrar el retiro.
product: windows
category: caja
task: reimprimir-un-retiro
requiredPermissions:
  - payments:create
money: true
sourceRepo: avoqado-android
sourceRef: adc29e59deece813637b183210db8f6f5905110f
versionMin: 2.25.62
keywords:
  - reimprimir retiro
  - reimprimir bajada
  - otra copia del retiro
  - imprimir dos veces el retiro
  - copia del comprobante de retiro
  - se perdió el ticket del retiro
  - ticket de retiro de efectivo
---

## Antes de empezar

Hace falta la caja abierta y una impresora de recibos (o la impresora integrada del aparato). *Caja* en *Más* es sólo para
cajero, gerente, administrador y dueño.

## Pasos

1. En *Más*, toca *Caja*. Si la ventana está angosta, toca luego *Turno en curso*.
2. En *Movimientos*, busca el retiro (dice *Egreso* o *Retiro*, con su concepto y la hora).
3. Toca el botón de la impresora a la derecha del importe.
4. Sale el mismo comprobante con la leyenda *REIMPRESIÓN* y aparece *¡Retiro reimpreso!*.

## Importante

- **No vuelvas a hacer el retiro para sacar otra copia:** cada retiro nuevo resta efectivo de la caja y el corte saldría mal.
  Para otra copia usa siempre el botón de la impresora.
- Reimprimir no registra nada ni mueve dinero.
- Si el retiro lo hizo otra caja, o es de antes de esta versión, el comprobante sale sin la línea *Autorizado por*.
- Si dice *No se pudo reimprimir el retiro*, revisa que la impresora esté prendida y con papel, y vuelve a tocar el botón.

## Sin internet

Funciona igual sin conexión: el comprobante se arma con lo que ya está en la computadora.
