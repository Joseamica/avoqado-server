---
title: Aplicar un cupón o una promoción al cobrar en el POS Android
description: En Cobrar, valida el código de un cupón y aplícalo a la venta, o agrega al carrito un combo o paquete de Promociones.
product: android
category: cobro
task: aplicar-cupon-o-promocion
requiredPermissions:
  - coupons:redeem
  - discounts:apply
money: true
versionMin: 2.25.46
sourceRepo: avoqado-android
sourceRef: 78e5372f37ed7791d86fc1fe621d4a073e5a09ff
keywords:
  - aplicar cupón
  - código de cupón
  - el cupón no funciona
  - validar cupón
  - promoción
  - combo
  - paquete
  - 2x1
---

## Antes de empezar

Es en *Cobrar*, con productos en el carrito. Los cupones y las promociones se crean en el panel (o en *Más* › *Artículos*); las promociones (combos y paquetes) vienen en el plan Pro. Validar un cupón pide el permiso de canjear cupones y aplicar una promoción, el de aplicar descuentos (de fábrica los dos, del mesero para arriba).

## Pasos

1. Para un cupón, en la pestaña *Atajos* toca *Cupones*.
2. Escribe el *Código de cupón* y toca *Validar cupón*.
3. Si es válido, sale el nombre del cupón, su valor y el «Ahorro estimado». Toca *Aplicar cupón* y cobra como siempre.
4. Para una promoción, abre la pestaña *Promociones* (o el panel de promociones a un lado) y toca la promoción.
5. Elige una opción de cada grupo y toca *Agregar al carrito · …*: la promoción entra al carrito con su precio.

## Problemas frecuentes

- Si el código no es válido, debajo sale por qué; revisa que esté bien escrito y vigente. Si dice que no tienes permiso, tu usuario no puede canjear cupones.
- Si dice «Aún no hay promociones. Créalas desde el dashboard.», el negocio no tiene combos ni paquetes activos.
- Si dice «Pídele a tu administrador el permiso para aplicar promociones.», tu usuario no tiene ese permiso.
- Si dice «Esta función es parte del plan Pro…», el plan del negocio no incluye promociones.
- Si no ves la pestaña *Promociones*, el negocio la tiene como panel a un lado, o la apagó.
- Si una promoción dice «Empieza a las …», todavía no está en su horario.

## Sin internet

- Si aparece «Sin conexión: el cupón necesita internet para validarse. Reintenta cuando vuelva la conexión.», el cupón no se aplicó: vuelve a validarlo cuando regrese la red.
- Si se va la red después de aplicar el cupón, al cobrar (también en efectivo) sale «Sin conexión: el cupón necesita internet. Reintenta cuando vuelva la conexión, o quita el cupón para cobrar sin él.»: la venta no se cobró.
- Si dice «No pudimos cargar las promociones. Revisa tu conexión.», no se pudieron leer las promociones.
