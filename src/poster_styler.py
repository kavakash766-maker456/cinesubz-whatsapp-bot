import sys
import os
import re
import textwrap
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps

def get_font(size=20, bold=False):
    """Select the best available Unicode font with Sinhala and Latin support."""
    candidates = []
    if sys.platform == "win32":
        candidates = [
            "C:/Windows/Fonts/NirmalaB.ttf" if bold else "C:/Windows/Fonts/Nirmala.ttc",
            "C:/Windows/Fonts/Nirmala.ttc",
            "C:/Windows/Fonts/iskpotab.ttf" if bold else "C:/Windows/Fonts/iskpota.ttf",
            "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
            "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        ]
    else:
        candidates = [
            "/usr/share/fonts/truetype/noto/NotoSansSinhala-Bold.ttf" if bold else "/usr/share/fonts/truetype/noto/NotoSansSinhala-Regular.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf" if bold else "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
        ]

    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()

def wrap_text_to_width(draw, text, font, max_width):
    """Wrap text by complete words without breaking words across lines."""
    words = text.split()
    lines = []
    current_line = []
    for word in words:
        test_line = " ".join(current_line + [word])
        bbox = draw.textbbox((0, 0), test_line, font=font)
        w = bbox[2] - bbox[0]
        if w <= max_width:
            current_line.append(word)
        else:
            if current_line:
                lines.append(" ".join(current_line))
                current_line = [word]
            else:
                lines.append(word)
                current_line = []
    if current_line:
        lines.append(" ".join(current_line))
    return lines

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

def create_branded_poster(poster_path, avatar_path, requester_name, output_path, storyline_text=None, backdrop_path=None):
    """
    Creates a luxury 16:9 cinema announcement card matching reference template:
    - Left: Full-height sharp vertical movie poster with FilmFeed golden banner.
    - Right: Dark blurred backdrop with centered Storyline / සාරාංශය.
    - Bottom-Right: Requester's circular WhatsApp DP with double ring frame & pill badge.
    """
    try:
        W, H = 1280, 720
        poster_w = int(H * 0.64)  # ~460px width for 2:3 vertical poster covering full height

        storyline = storyline_text or ""
        if os.path.exists(storyline):
            try:
                with open(storyline, "r", encoding="utf-8") as sf:
                    storyline = sf.read()
            except Exception:
                pass

        storyline = re.sub(r"\s+", " ", storyline).strip()
        if not storyline or storyline.lower() == "none":
            storyline = "A high-octane cinema experience featuring Sinhala subtitles, 5.1 surround audio, and premium master visuals."

        # 1. Background: Blurred Backdrop
        bg_source = backdrop_path if (backdrop_path and os.path.exists(backdrop_path) and backdrop_path != "NONE") else poster_path
        with Image.open(bg_source) as bg_img:
            bg = bg_img.convert("RGBA")
            bg = ImageOps.fit(bg, (W, H), method=Image.Resampling.LANCZOS)
            bg = bg.filter(ImageFilter.GaussianBlur(36))

        # Dark cinema glass vignette overlay
        overlay = Image.new("RGBA", (W, H), (10, 12, 18, 185))
        bg = Image.alpha_composite(bg, overlay)

        # 2. Left Side: Full-height Movie Poster (0 to poster_w, 0 to H)
        with Image.open(poster_path) as p_img:
            p_img = p_img.convert("RGBA")
            p_img = ImageOps.fit(p_img, (poster_w, H), method=Image.Resampling.LANCZOS)

            # Poster bottom golden banner
            p_overlay = Image.new("RGBA", (poster_w, H), (0, 0, 0, 0))
            p_draw = ImageDraw.Draw(p_overlay)
            banner_h = int(H * 0.10)
            banner_top = H - banner_h
            for y in range(banner_h):
                alpha = int(240 * (y / banner_h) ** 0.8)
                p_draw.line([(0, banner_top + y), (poster_w, banner_top + y)], fill=(8, 10, 15, alpha))

            # Golden accent line
            p_draw.rectangle([(0, banner_top), (poster_w, banner_top + 3)], fill=(245, 197, 24, 255))
            brand_font = get_font(14, bold=True)
            brand_text = "FILMFEED 4K CINEMA  •  SINHALA SUBTITLES"
            b_bbox = p_draw.textbbox((0, 0), brand_text, font=brand_font)
            bw = b_bbox[2] - b_bbox[0]
            p_draw.text(((poster_w - bw) // 2, banner_top + int(banner_h * 0.35)), brand_text, fill=(255, 255, 255, 240), font=brand_font)

            # Drop shadow / divider on right edge of poster
            edge_shadow = Image.new("RGBA", (24, H), (0, 0, 0, 0))
            es_draw = ImageDraw.Draw(edge_shadow)
            for x in range(24):
                alpha = int(180 * (1 - (x / 24)))
                es_draw.line([(x, 0), (x, H)], fill=(0, 0, 0, alpha))

            p_final = Image.alpha_composite(p_img, p_overlay)
            bg.paste(p_final, (0, 0))
            bg.paste(edge_shadow, (poster_w, 0), edge_shadow)

        draw = ImageDraw.Draw(bg)

        # 3. Right Side: Prominent Centered Requester Avatar (No synopsis, no user name)
        right_x = poster_w
        right_w = W - right_x
        center_x = right_x + (right_w // 2)
        center_y = H // 2

        # Prominent Enlarged Avatar Size
        avatar_size = 380
        dp_x = center_x - (avatar_size // 2)
        dp_y = center_y - (avatar_size // 2)

        # Ambient Glow & Drop Shadow behind avatar
        glow_size = avatar_size + 60
        av_shadow = Image.new("RGBA", (glow_size, glow_size), (0, 0, 0, 0))
        as_draw = ImageDraw.Draw(av_shadow)
        as_draw.ellipse((30, 30, glow_size - 30, glow_size - 30), fill=(245, 197, 24, 70))
        as_draw.ellipse((35, 35, glow_size - 35, glow_size - 35), fill=(0, 0, 0, 220))
        av_shadow = av_shadow.filter(ImageFilter.GaussianBlur(24))
        bg.paste(av_shadow, (center_x - (glow_size // 2), center_y - (glow_size // 2)), av_shadow)

        # Smooth anti-aliased circular mask
        mask_scale = 2
        mask_dim = (avatar_size * mask_scale, avatar_size * mask_scale)
        mask = Image.new("L", mask_dim, 0)
        m_draw = ImageDraw.Draw(mask)
        m_draw.ellipse((0, 0, mask_dim[0], mask_dim[1]), fill=255)
        mask = mask.resize((avatar_size, avatar_size), Image.Resampling.LANCZOS)

        has_custom_avatar = avatar_path and os.path.exists(avatar_path) and avatar_path != "NONE"
        if has_custom_avatar:
            with Image.open(avatar_path) as av_raw:
                av_raw = av_raw.convert("RGBA")
                av_fitted = ImageOps.fit(av_raw, (avatar_size, avatar_size), method=Image.Resampling.LANCZOS)
                circular_av = Image.new("RGBA", (avatar_size, avatar_size), (0, 0, 0, 0))
                circular_av.paste(av_fitted, (0, 0), mask=mask)
                bg.paste(circular_av, (dp_x, dp_y), circular_av)
        else:
            # Elegant VIP Cinema Default Avatar
            def_av = Image.new("RGBA", mask_dim, (18, 22, 32, 255))
            d_draw = ImageDraw.Draw(def_av)
            d_draw.ellipse((12, 12, mask_dim[0]-12, mask_dim[1]-12), fill=(25, 30, 42, 255), outline=(245, 197, 24, 255), width=12)
            vip_f = get_font(int(72 * mask_scale), bold=True)
            v_bbox = d_draw.textbbox((0, 0), "VIP", font=vip_f)
            vw = v_bbox[2] - v_bbox[0]
            vh = v_bbox[3] - v_bbox[1]
            d_draw.text(((mask_dim[0] - vw) // 2, (mask_dim[1] - vh) // 2 - 12), "VIP", fill=(245, 197, 24, 255), font=vip_f)
            def_av = def_av.resize((avatar_size, avatar_size), Image.Resampling.LANCZOS)
            bg.paste(def_av, (dp_x, dp_y), mask=mask)

        # Double Ring Luxury Border (White outer + Gold inner)
        border_img = Image.new("RGBA", mask_dim, (0, 0, 0, 0))
        b_draw = ImageDraw.Draw(border_img)
        b_draw.ellipse((0, 0, mask_dim[0]-1, mask_dim[1]-1), outline=(255, 255, 255, 255), width=14)
        b_draw.ellipse((14, 14, mask_dim[0] - 15, mask_dim[1] - 15), outline=(245, 197, 24, 255), width=10)
        border_img = border_img.resize((avatar_size, avatar_size), Image.Resampling.LANCZOS)
        bg.paste(border_img, (dp_x, dp_y), border_img)

        # Convert to RGB and save
        final_img = bg.convert("RGB")
        final_img.save(output_path, "JPEG", quality=88, optimize=True)
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
        avatar_p = sys.argv[3] if sys.argv[3] != "NONE" else None
        name = sys.argv[4] if len(sys.argv) > 4 else "VIP Member"
        out_p = sys.argv[5] if len(sys.argv) > 5 else "out.jpg"
        storyline = sys.argv[6] if len(sys.argv) > 6 else None
        backdrop_p = sys.argv[7] if len(sys.argv) > 7 and sys.argv[7] != "NONE" else None
        success = create_branded_poster(poster_p, avatar_p, name, out_p, storyline, backdrop_p)
        sys.exit(0 if success else 1)
