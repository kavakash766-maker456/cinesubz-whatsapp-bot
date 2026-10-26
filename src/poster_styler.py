import sys
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps

def generate_thumbnail(input_path, output_path, max_size=(240, 320)):
    try:
        with Image.open(input_path) as im:
            im = im.convert("RGB")
            im.thumbnail(max_size, Image.Resampling.LANCZOS)
            # Create exact background if needed
            bg = Image.new("RGB", max_size, (15, 15, 20))
            offset = ((max_size[0] - im.width) // 2, (max_size[1] - im.height) // 2)
            bg.paste(im, offset)
            bg.save(output_path, "JPEG", quality=75, optimize=True)
            return True
    except Exception as e:
        sys.stderr.write(f"Thumbnail error: {e}\n")
        return False

def create_branded_poster(poster_path, avatar_path, requester_name, output_path):
    try:
        with Image.open(poster_path) as base:
            base = base.convert("RGBA")
            W, H = base.size

            # Ensure minimum crisp dimensions
            if W < 700:
                scale_ratio = 720 / W
                base = base.resize((720, int(H * scale_ratio)), Image.Resampling.LANCZOS)
                W, H = base.size

            overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            draw = ImageDraw.Draw(overlay)

            # 1. Sleek Cinema Bottom Banner (Dark Glass Gradient)
            banner_h = int(H * 0.11)
            banner_top = H - banner_h
            
            # Gradient fade
            for y in range(banner_h):
                alpha = int(220 * (y / banner_h) ** 0.8)
                draw.line([(0, banner_top + y), (W, banner_top + y)], fill=(10, 12, 18, alpha))

            # Golden accent line
            accent_y = banner_top + 2
            draw.rectangle([(0, accent_y), (W, accent_y + 4)], fill=(245, 197, 24, 230))

            # Bottom branding text
            font_large = ImageFont.load_default()
            brand_text = "🍿 FILMFEED 4K CINEMA  •  SINHALA SUBTITLES"
            bbox = draw.textbbox((0, 0), brand_text, font=font_large)
            tw = bbox[2] - bbox[0]
            tx = (W - tw) // 2
            ty = banner_top + int(banner_h * 0.4)
            draw.text((tx, ty), brand_text, fill=(255, 255, 255, 240), font=font_large)

            # 2. Requester Avatar PiP Badge (Top-Right)
            if avatar_path and os.path.exists(avatar_path):
                avatar_size = min(int(W * 0.22), 180)
                if avatar_size >= 60:
                    with Image.open(avatar_path) as av:
                        av = av.convert("RGBA")
                        av = ImageOps.fit(av, (avatar_size, avatar_size), method=Image.Resampling.LANCZOS)

                        # Circular mask with smooth anti-aliasing (supersampled 2x)
                        mask_size = (avatar_size * 2, avatar_size * 2)
                        mask = Image.new("L", mask_size, 0)
                        mask_draw = ImageDraw.Draw(mask)
                        mask_draw.ellipse((0, 0, mask_size[0], mask_size[1]), fill=255)
                        mask = mask.resize((avatar_size, avatar_size), Image.Resampling.LANCZOS)

                        # Circular avatar
                        circular_av = Image.new("RGBA", (avatar_size, avatar_size), (0, 0, 0, 0))
                        circular_av.paste(av, (0, 0), mask=mask)

                        margin = int(W * 0.04)
                        pos_x = W - avatar_size - margin
                        pos_y = margin

                        # Drop shadow behind avatar
                        shadow = Image.new("RGBA", (avatar_size + 16, avatar_size + 16), (0, 0, 0, 0))
                        s_draw = ImageDraw.Draw(shadow)
                        s_draw.ellipse((4, 4, avatar_size + 12, avatar_size + 12), fill=(0, 0, 0, 160))
                        shadow = shadow.filter(ImageFilter.GaussianBlur(6))
                        overlay.paste(shadow, (pos_x - 8, pos_y - 8), shadow)

                        # Double Ring Border (White outer + Gold inner)
                        border_img = Image.new("RGBA", mask_size, (0, 0, 0, 0))
                        b_draw = ImageDraw.Draw(border_img)
                        b_draw.ellipse((0, 0, mask_size[0], mask_size[1]), outline=(255, 255, 255, 255), width=10)
                        b_draw.ellipse((8, 8, mask_size[0] - 8, mask_size[1] - 8), outline=(245, 197, 24, 255), width=8)
                        border_img = border_img.resize((avatar_size, avatar_size), Image.Resampling.LANCZOS)

                        overlay.paste(circular_av, (pos_x, pos_y), circular_av)
                        overlay.paste(border_img, (pos_x, pos_y), border_img)

                        # "REQUESTED BY" badge pill under avatar
                        req_name = (requester_name or "MEMBER").strip()[:18]
                        pill_text = f"👑 {req_name}"
                        p_bbox = draw.textbbox((0, 0), pill_text, font=font_large)
                        pw = p_bbox[2] - p_bbox[0] + 20
                        ph = p_bbox[3] - p_bbox[1] + 12
                        pill_x = pos_x + (avatar_size - pw) // 2
                        pill_y = pos_y + avatar_size + 6

                        # Pill background
                        draw.rounded_rectangle([(pill_x, pill_y), (pill_x + pw, pill_y + ph)], radius=ph//2, fill=(15, 15, 20, 220), outline=(245, 197, 24, 220), width=2)
                        draw.text((pill_x + 10, pill_y + 4), pill_text, fill=(255, 255, 255, 255), font=font_large)

            # Merge layers
            final_img = Image.alpha_composite(base, overlay).convert("RGB")
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
        success = create_branded_poster(poster_p, avatar_p, name, out_p)
        sys.exit(0 if success else 1)
