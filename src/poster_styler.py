import sys
import os
import re
from PIL import Image, ImageDraw, ImageOps, ImageFilter

def generate_thumbnail(input_path, output_path, max_size=(240, 320)):
    """Generate lightweight preview thumbnail for WhatsApp document message."""
    try:
        with Image.open(input_path) as im:
            im = im.convert("RGB")
            im.thumbnail(max_size, Image.Resampling.LANCZOS)
            bg = Image.new("RGB", max_size, (15, 15, 20))
            offset = ((max_size[0] - im.width) // 2, (max_size[1] - im.height) // 2)
            bg.paste(im, offset)
            bg.save(output_path, "JPEG", quality=75, optimize=True)
            return True
    except Exception as e:
        sys.stderr.write(f"Thumbnail error: {e}\n")
        return False

def create_branded_poster(
    poster_path,
    avatar_path,
    requester_name,
    output_path,
    storyline_text=None,
    backdrop_path=None,
    title=None,
    year=None,
    rating=None,
    quality=None
):
    """
    Creates a luxury 1:1 square cinematic card matching reference design:
    - 1024x1024 square canvas.
    - Deep atmospheric dark blurred background of poster or backdrop.
    - Outer dark glass card with rounded corners (radius 64) and subtle cyan glow border.
    - Center floating vertical movie poster (388x578 px) with crisp, solid 4px white border and soft drop shadow.
    - Soft glossy reflection below the poster.
    - ZERO Sinhala canvas text rendering: Eliminates tofu boxes [][][][] completely across all operating systems.
    - Movie metadata, storyline, episodes, and direct links are delivered cleanly in the WhatsApp caption.
    """
    try:
        W, H = 1024, 1024

        # 1. Background Source
        valid_backdrop = (
            backdrop_path
            and os.path.exists(backdrop_path)
            and backdrop_path != "NONE"
            and "zt_backdrop" not in backdrop_path.lower()
        )
        bg_source = backdrop_path if valid_backdrop else poster_path

        with Image.open(bg_source) as bg_img:
            bg = bg_img.convert("RGBA")
            bg = ImageOps.fit(bg, (W, H), method=Image.Resampling.LANCZOS)
            bg = bg.filter(ImageFilter.GaussianBlur(40))

        # Dark atmospheric cinema overlay
        overlay = Image.new("RGBA", (W, H), (8, 10, 16, 215))
        bg = Image.alpha_composite(bg, overlay)

        # 2. Outer Glass Card
        card_margin = 94
        card_radius = 64
        card_x1 = card_margin
        card_y1 = card_margin
        card_x2 = W - card_margin
        card_y2 = H - card_margin

        card_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        c_draw = ImageDraw.Draw(card_layer)
        c_draw.rounded_rectangle(
            [(card_x1, card_y1), (card_x2, card_y2)],
            radius=card_radius,
            fill=(12, 14, 22, 185),
            outline=(55, 80, 120, 110),
            width=2
        )
        bg = Image.alpha_composite(bg, card_layer)

        # 3. Center Floating Poster
        poster_w = 388
        poster_h = 578
        poster_x = (W - poster_w) // 2
        poster_y = 128
        border_thickness = 4

        # Soft glossy reflection below the poster
        refl_h = 135
        try:
            with Image.open(poster_path) as p_img:
                p_crop = p_img.convert("RGBA")
                p_crop = ImageOps.fit(p_crop, (poster_w, poster_h), method=Image.Resampling.LANCZOS)
                refl = p_crop.crop((0, poster_h - refl_h, poster_w, poster_h))
                refl = ImageOps.flip(refl)
                refl = refl.filter(ImageFilter.GaussianBlur(16))

                alpha_mask = Image.new("L", (poster_w, refl_h))
                for ry in range(refl_h):
                    val = int(80 * (1.0 - (ry / refl_h)) ** 1.5)
                    for rx in range(poster_w):
                        alpha_mask.putpixel((rx, ry), val)
                refl.putalpha(alpha_mask)
                bg.paste(refl, (poster_x, poster_y + poster_h + 4), refl)
        except Exception:
            pass

        # Soft drop shadow behind poster
        shadow_margin = 30
        shadow = Image.new("RGBA", (poster_w + shadow_margin * 2, poster_h + shadow_margin * 2), (0, 0, 0, 0))
        s_draw = ImageDraw.Draw(shadow)
        s_draw.rectangle(
            [(shadow_margin, shadow_margin), (shadow_margin + poster_w, shadow_margin + poster_h)],
            fill=(0, 0, 0, 210)
        )
        shadow = shadow.filter(ImageFilter.GaussianBlur(22))
        bg.paste(shadow, (poster_x - shadow_margin, poster_y - shadow_margin + 6), shadow)

        # Solid pure white frame & inner poster
        poster_frame = Image.new("RGBA", (poster_w, poster_h), (255, 255, 255, 255))
        inner_w = poster_w - (border_thickness * 2)
        inner_h = poster_h - (border_thickness * 2)

        with Image.open(poster_path) as p_img:
            inner_poster = p_img.convert("RGBA")
            inner_poster = ImageOps.fit(inner_poster, (inner_w, inner_h), method=Image.Resampling.LANCZOS)
            poster_frame.paste(inner_poster, (border_thickness, border_thickness))

        bg.paste(poster_frame, (poster_x, poster_y))

        # Convert to RGB and save
        final_img = bg.convert("RGB")
        final_img.save(output_path, "JPEG", quality=92, optimize=True)
        return True
    except Exception as e:
        sys.stderr.write(f"Branded poster error: {e}\n")
        return False

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python poster_styler.py <command> <args...>")
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "thumb":
        in_p = sys.argv[2]
        out_p = sys.argv[3]
        success = generate_thumbnail(in_p, out_p)
        sys.exit(0 if success else 1)
    elif cmd == "brand":
        poster_p = sys.argv[2]
        avatar_p = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "NONE" else None
        name = sys.argv[4] if len(sys.argv) > 4 else "VIP Member"
        out_p = sys.argv[5] if len(sys.argv) > 5 else "out.jpg"
        storyline = sys.argv[6] if len(sys.argv) > 6 else None
        backdrop_p = sys.argv[7] if len(sys.argv) > 7 and sys.argv[7] != "NONE" else None
        title_arg = sys.argv[8] if len(sys.argv) > 8 else None
        year_arg = sys.argv[9] if len(sys.argv) > 9 else None
        rating_arg = sys.argv[10] if len(sys.argv) > 10 else None
        quality_arg = sys.argv[11] if len(sys.argv) > 11 else None
        success = create_branded_poster(
            poster_p,
            avatar_p,
            name,
            out_p,
            storyline,
            backdrop_p,
            title_arg,
            year_arg,
            rating_arg,
            quality_arg
        )
        sys.exit(0 if success else 1)
