# tests/fixtures/customer-display/generar-imagenes.py
# Uso: python3 tests/fixtures/customer-display/generar-imagenes.py   (desde avoqado-server; requiere Pillow con WebP)
#
# Las imágenes que prueba `inspectImage` (customerDisplayAsset.service.ts). Son REALES a propósito: una cabecera PNG armada
# a mano no es una imagen válida y deja sin probar JPEG y WebP. Se commitean junto con este script para poder regenerarlas.
from pathlib import Path
from PIL import Image

d = Path(__file__).parent
base = Image.new('RGB', (1280, 720), (40, 120, 200))
base.save(d / 'imagen-1280x720.png')
base.save(d / 'imagen-1280x720.jpg', quality=85)                            # SOF0
base.save(d / 'imagen-1280x720-progresiva.jpg', quality=85, progressive=True)  # SOF2
base.save(d / 'imagen-1280x720.webp', quality=80)                           # VP8
base.save(d / 'imagen-1280x720-sin-perdida.webp', lossless=True)            # VP8L
Image.new('RGBA', (1280, 720), (40, 120, 200, 128)).save(d / 'imagen-1280x720-alfa.webp', quality=80)  # VP8X
Image.new('RGB', (200, 200), (0, 0, 0)).save(d / 'chica-200x200.png')
Image.new('RGB', (5000, 400), (0, 0, 0)).save(d / 'ancha-5000x400.png')
# Ancho dentro del rango y ALTO fuera: sin éstas, quitar cualquiera de las dos revisiones del alto no tumbaba ninguna prueba
Image.new('RGB', (1280, 5000), (0, 0, 0)).save(d / 'alta-1280x5000.png')
Image.new('RGB', (1280, 200), (0, 0, 0)).save(d / 'baja-1280x200.png')
# Justo en los límites (400 y 4096 de cada lado): se ACEPTAN
Image.new('RGB', (400, 4096), (0, 0, 0)).save(d / 'limite-400x4096.png')
Image.new('RGB', (4096, 400), (0, 0, 0)).save(d / 'limite-4096x400.png')
# Malformadas, a propósito
(d / 'png-truncado.png').write_bytes((d / 'imagen-1280x720.png').read_bytes()[:20])
(d / 'jpeg-sin-sof.jpg').write_bytes(bytes([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]) + b'JFIF\x00' + bytes(9) + bytes([0xFF, 0xD9]))
(d / 'riff-no-webp.webp').write_bytes(b'RIFF' + (36).to_bytes(4, 'little') + b'WAVEfmt ' + bytes(28))
(d / 'zip-disfrazado.png').write_bytes(bytes([0x50, 0x4B, 0x03, 0x04]) + b'esto es un zip')
# Un WebP real con su firma interna borrada: el contenedor dice WEBP pero lo de adentro no es VP8/VP8L
vp8 = bytearray((d / 'imagen-1280x720.webp').read_bytes())
vp8[23:26] = bytes(3)  # el código de inicio del cuadro VP8 (9d 01 2a)
(d / 'webp-vp8-sin-codigo-de-inicio.webp').write_bytes(bytes(vp8))
vp8l = bytearray((d / 'imagen-1280x720-sin-perdida.webp').read_bytes())
vp8l[20] = 0  # la firma de VP8L (0x2f)
(d / 'webp-vp8l-sin-firma.webp').write_bytes(bytes(vp8l))
