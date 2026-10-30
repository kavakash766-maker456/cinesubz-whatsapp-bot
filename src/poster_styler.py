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
    Creates a luxury 16:9 cinema announcement card:
    - Left: Sharp vertical movie poster with FilmFeed golden banner.
    - Right: Dark blurred backdrop with Storyline / සාරාංශය.
    - Bottom-Right: Requester's circular WhatsApp DP with double ring frame & badge.
    """
    try:
        W, H = 1280, 720

        # Read storyline if passed as a file path
        storyline = storyline_text or ""
        if os.path.exists(storyline):
            try:
                with open(storyline, "r", encoding="utf-8") as sf:
                    storyline = sf.read()
            except Exception:
                pass

        storyline = re.sub(r"\s+", " ", storyline).strip()
        if not storyline or storyline.lower() == "none":
            storyline = "A high-octane cinema experience featuring Sinhala subtitles, 5.1 crystal surround audio, and premium 4K master visuals."

        # 1. Background: Blurred Backdrop
        bg_source = backdrop_path if (backdrop_path and os.path.exists(backdrop_path)) else poster_path
        with Image.open(bg_source) as bg_img:
            bg = bg_img.convert("RGBA")
            bg = ImageOps.fit(bg, (W, H), method=Image.Resampling.LANCZOS)
            bg = bg.filter(ImageFilter.GaussianBlur(32))

        # Dark cinema glass vignette overlay
        overlay = Image.new("RGBA", (W, H), (10, 12, 18, 195))
        bg = Image.alpha_composite(bg, overlay)
        draw = ImageDraw.Draw(bg)

        # 2. Left Side: Movie Poster (Portrait, approx 433 x 650)
        poster_margin = 35
        poster_h = H - (poster_margin * 2) # 650
        poster_w = int(poster_h * (2.0 / 3.0)) # 433

        with Image.open(poster_path) as p_img:
            p_img = p_img.convert("RGBA")
            p_img = ImageOps.fit(p_img, (poster_w, poster_h), method=Image.Resampling.LANCZOS)

            # Poster bottom golden banner
            p_overlay = Image.new("RGBA", (poster_w, poster_h), (0, 0, 0, 0))
            p_draw = ImageDraw.Draw(p_overlay)
            banner_h = int(poster_h * 0.10)
            banner_top = poster_h - banner_h
            for y in range(banner_h):
                alpha = int(230 * (y / banner_h) ** 0.8)
                p_draw.line([(0, banner_top + y), (poster_w, banner_top + y)], fill=(8, 10, 15, alpha))

            p_draw.rectangle([(0, banner_top), (poster_w, banner_top + 3)], fill=(245, 197, 24, 255))
            brand_font = get_font(13, bold=True)
            brand_text = "FILMFEED 4K CINEMA  •  SINHALA SUBTITLES"
            b_bbox = p_draw.textbbox((0, 0), brand_text, font=brand_font)
            bw = b_bbox[2] - b_bbox[0]
            p_draw.text(((poster_w - bw) // 2, banner_top + int(banner_h * 0.35)), brand_text, fill=(255, 255, 255, 240), font=brand_font)

            # Poster outer border
            p_draw.rectangle([(0, 0), (poster_w - 1, poster_h - 1)], outline=(245, 197, 24, 180), width=2)
            p_final = Image.alpha_composite(p_img, p_overlay)

            # Drop shadow behind poster
            shadow = Image.new("RGBA", (poster_w + 30, poster_h + 30), (0, 0, 0, 0))
            s_draw = ImageDraw.Draw(shadow)
            s_draw.rectangle([(15, 15), (poster_w + 15, poster_h + 15)], fill=(0, 0, 0, 180))
            shadow = shadow.filter(ImageFilter.GaussianBlur(12))
            bg.paste(shadow, (poster_margin - 5, poster_margin - 5), shadow)
            bg.paste(p_final, (poster_margin, poster_margin), p_final)

        # 3. Right Side: Storyline & Header
        right_x = poster_margin + poster_w + 45
        right_w = W - right_x - 45

        # Header
        header_font = get_font(28, bold=True)
        header_text = "STORYLINE / සාරාංශය"
        draw.text((right_x + 1, 46), header_text, fill=(0, 0, 0, 180), font=header_font)
        draw.text((right_x, 45), header_text, fill=(245, 197, 24, 255), font=header_font)

        # Accent line under header
        draw.line([(right_x, 88), (right_x + 120, 88)], fill=(245, 197, 24, 255), width=3)

        # Storyline text rendering
        story_font = get_font(21, bold=False)
        clean_story = storyline
        if len(clean_story) > 360:
            clean_story = clean_story[:360].rsplit(" ", 1)[0] + "..."

        lines = wrap_text_to_width(draw, clean_story, story_font, right_w)
        display_lines = lines[:6]
        if len(lines) > 6 and not display_lines[-1].endswith("..."):
            display_lines[-1] = display_lines[-1].rstrip(". ") + "..."

        curr_y = 108
        line_height = 32
        for line in display_lines:
            draw.text((right_x + 1, curr_y + 1), line, fill=(0, 0, 0, 200), font=story_font)
            draw.text((right_x, curr_y), line, fill=(235, 238, 245, 255), font=story_font)
            curr_y += line_height

        # 4. Bottom Right Area: Requester Profile Picture (DP)
        avatar_size = 144
        dp_center_x = W - 140
        dp_center_y = H - 150
        dp_x = dp_center_x - (avatar_size // 2)
        dp_y = dp_center_y - (avatar_size // 2)

        # Drop shadow behind avatar
        av_shadow = Image.new("RGBA", (avatar_size + 24, avatar_size + 24), (0, 0, 0, 0))
        as_draw = ImageDraw.Draw(av_shadow)
        as_draw.ellipse((10, 10, avatar_size + 14, avatar_size + 14), fill=(0, 0, 0, 210))
        av_shadow = av_shadow.filter(ImageFilter.GaussianBlur(10))
        bg.paste(av_shadow, (dp_x - 12, dp_y - 12), av_shadow)

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
            d_draw.ellipse((8, 8, mask_dim[0]-8, mask_dim[1]-8), fill=(25, 30, 42, 255), outline=(245, 197, 24, 255), width=6)
            vip_f = get_font(int(46 * mask_scale), bold=True)
            v_bbox = d_draw.textbbox((0, 0), "VIP", font=vip_f)
            vw = v_bbox[2] - v_bbox[0]
            vh = v_bbox[3] - v_bbox[1]
            d_draw.text(((mask_dim[0] - vw) // 2, (mask_dim[1] - vh) // 2 - 8), "VIP", fill=(245, 197, 24, 255), font=vip_f)
            def_av = def_av.resize((avatar_size, avatar_size), Image.Resampling.LANCZOS)
            bg.paste(def_av, (dp_x, dp_y), mask=mask)

        # Double Ring Border (White outer + Gold inner)
        border_img = Image.new("RGBA", mask_dim, (0, 0, 0, 0))
        b_draw = ImageDraw.Draw(border_img)
        b_draw.ellipse((0, 0, mask_dim[0]-1, mask_dim[1]-1), outline=(255, 255, 255, 255), width=8)
        b_draw.ellipse((8, 8, mask_dim[0] - 9, mask_dim[1] - 9), outline=(245, 197, 24, 255), width=6)
        border_img = border_img.resize((avatar_size, avatar_size), Image.Resampling.LANCZOS)
        bg.paste(border_img, (dp_x, dp_y), border_img)

        # Requester Pill Badge
        pill_font = get_font(15, bold=True)
        req_name = (requester_name or "VIP Member").strip()
        if len(req_name) > 20:
            req_name = req_name[:18] + ".."
        pill_text = f"REQUESTED BY: {req_name.upper()}"
        p_bbox = draw.textbbox((0, 0), pill_text, font=pill_font)
        pw = p_bbox[2] - p_bbox[0] + 28
        ph = p_bbox[3] - p_bbox[1] + 16

        pill_x = dp_center_x - (pw // 2)
        pill_y = dp_y + avatar_size + 10

        if pill_x + pw > W - 15:
            pill_x = W - pw - 15
        if pill_x < right_x:
            pill_x = right_x

        draw.rounded_rectangle([(pill_x, pill_y), (pill_x + pw, pill_y + ph)], radius=ph // 2, fill=(12, 14, 20, 240), outline=(245, 197, 24, 230), width=2)
        draw.text((pill_x + 14, pill_y + 8), pill_text, fill=(255, 255, 255, 255), font=pill_font)

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
