---
title: Enviar un SPEI desde tu cuenta de banco conectada en el panel
description: Desde Bancos › SPEI externo, el dueño manda dinero de su cuenta conectada a una CLABE de cualquier banco.
product: dashboard
category: bancos
task: enviar-spei
requiredPermissions: []
featureCode: BANKING_HUB
gateKind: FEATURE
money: true
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
keywords:
  - spei
  - transferir a otro banco
  - mandar dinero
  - clabe
  - bancos
---

## Antes de empezar

*Bancos* sólo sale para el dueño del negocio. Para enviar hace falta un plan que incluya la banca (sin él, la pantalla sale borrosa) y una cuenta de banco conectada (sin ella, sale «Conecta tu banco»). El dinero sale de verdad de tu cuenta y el envío no se puede deshacer.

## Pasos

1. En *Bancos* › *SPEI externo*, elige la *Cuenta origen*.
2. Escribe la *CLABE destino* de 18 dígitos. Con una CLABE válida, el *Banco destino* se elige solo cuando el panel lo reconoce; si no, elígelo tú.
3. Escribe el *Nombre del beneficiario*, el *Monto* y, si quieres, el *Concepto*. Toca *Revisar envío*.
4. Revisa el monto, el nombre, la CLABE y el banco, y toca *Enviar*. «SPEI enviado» puede ser este envío o uno idéntico (misma CLABE y monto) de hace unos minutos; guarda el folio si sale debajo.

## Problemas frecuentes

- Si sale «Esa CLABE no es válida. Revisa los 18 dígitos.», corrige la CLABE: *Revisar envío* no se prende hasta que sea válida.
- Si querías mandar dos envíos iguales seguidos, no lo repitas: pide que lo revise una persona del equipo de Avoqado.
- Si sale «No se pudo enviar el SPEI», puede que sí se haya enviado: no lo repitas. Pide que lo revise una persona del equipo de Avoqado antes de mandar otro.
- Si en vez del formulario sale «Esta función solo está disponible para cuentas personales.» o «Por ahora el envío SPEI solo está disponible para conexiones con una sola cuenta.», tu conexión no permite enviar SPEI desde el panel.
