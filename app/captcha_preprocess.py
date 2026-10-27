from __future__ import annotations

from io import BytesIO

import numpy as np
from PIL import Image, ImageEnhance, ImageOps


def build_helipay_enhanced_image(image_bytes: bytes) -> bytes:
    image = Image.open(BytesIO(image_bytes)).convert("RGB")
    mask = _blue_mask(image)
    crop_box = _mask_box(mask, image.size)
    cropped = image.crop(crop_box)

    color = ImageEnhance.Color(cropped).enhance(2.0)
    color = ImageEnhance.Contrast(color).enhance(1.8)
    color = ImageEnhance.Sharpness(color).enhance(1.5)

    return _to_png(color, scale=4, border=10)


def is_helipay_style_image(image_bytes: bytes) -> bool:
    image = Image.open(BytesIO(image_bytes)).convert("RGB")
    data = np.asarray(image).astype(np.int16)
    red = data[:, :, 0]
    green = data[:, :, 1]
    blue = data[:, :, 2]
    mask = (blue > red + 18) & (blue > green + 4) & (blue >= 55)
    blue_ratio = float(mask.sum()) / float(mask.size)
    return (
        image.width >= 50
        and image.height >= 20
        and 0.03 <= blue_ratio <= 0.35
    )


def _to_png(image: Image.Image, scale: int, border: int) -> bytes:
    image = ImageOps.expand(image, border=border, fill="white")
    image = image.resize(
        (image.width * scale, image.height * scale),
        Image.Resampling.LANCZOS,
    )

    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _blue_mask(image: Image.Image) -> Image.Image:
    data = np.asarray(image).astype(np.int16)
    red = data[:, :, 0]
    green = data[:, :, 1]
    blue = data[:, :, 2]
    saturation = np.asarray(image.convert("HSV"))[:, :, 1]
    score = blue - red
    mask = (score > 20) & (saturation > 40) & (blue > green + 4)
    mask[:2, :] = False
    mask[-2:, :] = False
    mask[:, :2] = False
    mask[:, -2:] = False
    return Image.fromarray(np.where(mask, score.clip(0, 255), 0).astype(np.uint8))


def _mask_box(mask_image: Image.Image, size: tuple[int, int]) -> tuple[int, int, int, int]:
    mask = np.asarray(mask_image)
    ys, xs = np.where(mask > 0)
    if len(xs) == 0:
        return (0, 0, size[0], size[1])

    padding = 5
    return (
        max(0, int(xs.min()) - padding),
        max(0, int(ys.min()) - padding),
        min(size[0], int(xs.max()) + padding + 1),
        min(size[1], int(ys.max()) + padding + 1),
    )
