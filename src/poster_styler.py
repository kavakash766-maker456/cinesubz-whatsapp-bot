import sys
import os
import re
import textwrap
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps

def get_font(size=20, bold=False, sinhala=False):
    """Select the best available Unicode font with Sinhala and Latin support."""
    candidates = []
    if sys.platform == "win32":
        if sinhala:
            candidates = [
                "C:/Windows/Fonts/NirmalaB.ttf",
                "C:/Windows/Fonts/Nirmala.ttc",
                "C:/Windows/Fonts/iskpotab.ttf",
                "C:/Windows/Fonts/iskpota.ttf",
            ]
        else:
            candidates = [
                "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
                "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
                "C:/Windows/Fonts/Nirmala.ttc",
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
    Creates a luxury 16:9 cinema announcement card:
    - NO requester avatar / profile picture!
    - Left: Full-height crisp vertical movie poster in a glowing luxury glass frame.
    - Right: Cinematic metadata panel with official golden Premiere badge, large movie title,
      rating/year/resolution chip pills, rich storyline/synopsis block, and subtle requester tag.
    """
    try:
        W, H = 1280, 720

        # Parse storyline
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

        # Parse title from storyline or poster name if not provided
        clean_title = (title or "").strip()
        if not clean_title or clean_title.lower() == "none":
            # Extract from poster file name if possible
            base = os.path.basename(poster_path)
            clean_title = re.sub(r"^(?:thumb_|poster_|branded_|[0-9_]+)+", "", base)
            clean_title = os.path.splitext(clean_title)[0].replace("_", " ").title()
        if not clean_title:
            clean_title = "Featured Cinema Release"

        clean_year = (year or "2024").strip()
        clean_rating = (rating or "8.5").strip()
        if not clean_rating.endswith("/10") and clean_rating != "8.5":
            clean_rating = f"{clean_rating}/10"
        elif clean_rating == "8.5":
            clean_rating = "8.5/10"
        clean_quality = (quality or "1080p FHD").strip()
        clean_requester = (requester_name or "VIP Member").replace("@s.whatsapp.net", "").replace("@lid", "").strip()

        # 1. Background: Blurred Backdrop
        bg_source = backdrop_path if (backdrop_path and os.path.exists(backdrop_path) and backdrop_path != "NONE") else poster_path
        with Image.open(bg_source) as bg_img:
            bg = bg_img.convert("RGBA")
            bg = ImageOps.fit(bg, (W, H), method=Image.Resampling.LANCZOS)
            bg = bg.filter(ImageFilter.GaussianBlur(36))

        # Dark cinema glass vignette overlay
        overlay = Image.new("RGBA", (W, H), (10, 12, 18, 205))
        bg = Image.alpha_composite(bg, overlay)

        # 2. Left Side: Full-height Vertical Poster in Elegant Frame
        # Margin: left 45px, top 45px, height 630px, width ~420px (2:3 aspect)
        poster_w = 420
        poster_h = 630
        poster_x = 45
        poster_y = 45

        # Poster drop shadow
        shadow_margin = 20
        shadow_img = Image.new("RGBA", (poster_w + shadow_margin * 2, poster_h + shadow_margin * 2), (0, 0, 0, 0))
        s_draw = ImageDraw.Draw(shadow_img)
        s_draw.rounded_rectangle(
            [(shadow_margin - 4, shadow_margin - 4), (poster_w + shadow_margin + 4, poster_h + shadow_margin + 4)],
            radius=18,
            fill=(0, 0, 0, 190)
        )
        shadow_img = shadow_img.filter(ImageFilter.GaussianBlur(14))
        bg.paste(shadow_img, (poster_x - shadow_margin, poster_y - shadow_margin), shadow_img)

        # Poster image with rounded corners
        with Image.open(poster_path) as p_img:
            p_img = p_img.convert("RGBA")
            p_img = ImageOps.fit(p_img, (poster_w, poster_h), method=Image.Resampling.LANCZOS)

            # Round mask
            mask = Image.new("L", (poster_w, poster_h), 0)
            m_draw = ImageDraw.Draw(mask)
            m_draw.rounded_rectangle([(0, 0), (poster_w, poster_h)], radius=16, fill=255)

            # Golden bottom banner on poster
            p_overlay = Image.new("RGBA", (poster_w, poster_h), (0, 0, 0, 0))
            p_draw = ImageDraw.Draw(p_overlay)
            banner_h = 48
            banner_top = poster_h - banner_h
            for y in range(banner_h):
                alpha = int(240 * (y / banner_h) ** 0.8)
                p_draw.line([(0, banner_top + y), (poster_w, banner_top + y)], fill=(8, 10, 15, alpha))

            # Golden accent line
            p_draw.rectangle([(0, banner_top), (poster_w, banner_top + 3)], fill=(245, 197, 24, 255))
            brand_font = get_font(13, bold=True)
            brand_text = "FILMFEED 4K CINEMA  •  MASTER AUDIO"
            b_bbox = p_draw.textbbox((0, 0), brand_text, font=brand_font)
            bw = b_bbox[2] - b_bbox[0]
            p_draw.text(((poster_w - bw) // 2, banner_top + 16), brand_text, fill=(255, 255, 255, 240), font=brand_font)

            p_composite = Image.alpha_composite(p_img, p_overlay)

            # Subtle luxury gold border around poster
            border_draw = ImageDraw.Draw(p_composite)
            border_draw.rounded_rectangle([(0, 0), (poster_w - 1, poster_h - 1)], radius=16, outline=(245, 197, 24, 180), width=2)

            bg.paste(p_composite, (poster_x, poster_y), mask)

        # 3. Right Side: Luxury Typography & Movie Info
        draw = ImageDraw.Draw(bg)
        right_x = 510
        right_max_w = W - right_x - 50

        # Header Badge: "FILMFEED CINEMA PREMIERE" solid gold pill
        badge_font = get_font(13, bold=True)
        badge_text = "FILMFEED CINEMA PREMIERE"
        b_bbox = draw.textbbox((0, 0), badge_text, font=badge_font)
        badge_w = (b_bbox[2] - b_bbox[0]) + 32
        badge_h = 32
        badge_y = 52

        # Gold gradient pill with dark sharp text
        draw.rounded_rectangle(
            [(right_x, badge_y), (right_x + badge_w, badge_y + badge_h)],
            radius=16,
            fill=(245, 197, 24, 255)
        )
        draw.text((right_x + 16, badge_y + 8), badge_text, fill=(12, 14, 20, 255), font=badge_font)

        # Movie Title
        title_font = get_font(38, bold=True)
        title_lines = wrap_text_to_width(draw, clean_title, title_font, right_max_w)
        # Limit to 2 lines for title
        if len(title_lines) > 2:
            title_lines = title_lines[:2]
            title_lines[1] += "..."

        title_y = badge_y + badge_h + 18
        for line in title_lines:
            # Subtle drop shadow
            draw.text((right_x + 2, title_y + 2), line, fill=(0, 0, 0, 200), font=title_font)
            draw.text((right_x, title_y), line, fill=(255, 255, 255, 255), font=title_font)
            t_bbox = draw.textbbox((0, 0), line, font=title_font)
            title_y += (t_bbox[3] - t_bbox[1]) + 8

        # Metadata Chips Row: Year | Rating | Quality | Sinhala Subtitles
        chip_y = title_y + 10
        chips = [
            clean_year,
            clean_rating,
            clean_quality,
            "Sinhala Subtitles"
        ]
        chip_font = get_font(13, bold=True)
        cur_cx = right_x
        for chip in chips:
            c_bbox = draw.textbbox((0, 0), chip, font=chip_font)
            cw = (c_bbox[2] - c_bbox[0]) + 24
            ch = 30
            draw.rounded_rectangle(
                [(cur_cx, chip_y), (cur_cx + cw, chip_y + ch)],
                radius=15,
                fill=(22, 28, 42, 230),
                outline=(245, 197, 24, 160),
                width=1
            )
            draw.text((cur_cx + 12, chip_y + 7), chip, fill=(255, 255, 255, 255), font=chip_font)
            cur_cx += cw + 12

        # Sleek golden divider line
        divider_y = chip_y + 44
        draw.line([(right_x, divider_y), (right_x + right_max_w, divider_y)], fill=(245, 197, 24, 90), width=1)

        # Synopsis Header & Wrapped Body
        syn_header_font = get_font(14, bold=True)
        syn_head_y = divider_y + 14
        draw.text((right_x, syn_head_y), "OFFICIAL SYNOPSIS", fill=(245, 197, 24, 240), font=syn_header_font)

        # Check if storyline has Sinhala characters
        has_sinhala = bool(re.search(r"[\u0D80-\u0DFF]", storyline))
        syn_body_font = get_font(15, bold=False, sinhala=has_sinhala)
        syn_lines = wrap_text_to_width(draw, storyline, syn_body_font, right_max_w)
        # Limit synopsis to 4 lines
        max_syn_lines = 4
        if len(syn_lines) > max_syn_lines:
            syn_lines = syn_lines[:max_syn_lines]
            syn_lines[-1] = syn_lines[-1].rstrip("., ") + "..."

        syn_y = syn_head_y + 26
        for s_line in syn_lines:
            draw.text((right_x, syn_y), s_line, fill=(215, 222, 235, 220), font=syn_body_font)
            sb_box = draw.textbbox((0, 0), s_line, font=syn_body_font)
            syn_y += (sb_box[3] - sb_box[1]) + 6

        # Bottom Bar: Requester Pill + FilmFeed Network Watermark
        bottom_y = 625
        # Draw sleek subtle requester pill on bottom left of right panel
        req_font = get_font(13, bold=True)
        req_text = f"VIP Request: {clean_requester}"
        rq_bbox = draw.textbbox((0, 0), req_text, font=req_font)
        rq_w = (rq_bbox[2] - rq_bbox[0]) + 24
        rq_h = 30
        draw.rounded_rectangle(
            [(right_x, bottom_y), (right_x + rq_w, bottom_y + rq_h)],
            radius=15,
            fill=(99, 102, 241, 40),
            outline=(99, 102, 241, 140),
            width=1
        )
        draw.text((right_x + 12, bottom_y + 7), req_text, fill=(199, 210, 254, 255), font=req_font)

        # Brand mark on bottom right
        brand_font2 = get_font(13, bold=True)
        brand_str = "FILMFEED 4K CINEMA  •  WHATSAPP BOT"
        bf_bbox = draw.textbbox((0, 0), brand_str, font=brand_font2)
        bw2 = bf_bbox[2] - bf_bbox[0]
        draw.text((W - 50 - bw2, bottom_y + 7), brand_str, fill=(160, 175, 205, 180), font=brand_font2)

        # Convert to RGB and save
        final_img = bg.convert("RGB")
        final_img.save(output_path, "JPEG", quality=90, optimize=True)
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
