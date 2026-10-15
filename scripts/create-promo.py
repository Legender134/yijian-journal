"""Render a 70-second product film from real app screenshots and authorized game footage.

Requires Python 3.12+, Pillow, NumPy, and FFmpeg on PATH. No network access.
Example: python scripts/create-promo.py --screens .test-data/showcase --game scene.mp4 --out .test-data/promo
"""

import argparse
import json
import math
from pathlib import Path
import shutil
import subprocess
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

W, H, FPS, DURATION = 1920, 1080, 24, 70
INK, PAPER, GOLD, MUTED = "#203d36", "#f6f3e8", "#cfb977", "#6c7d70"
SCENES = [
    (0, 5, "intro", "", "", []),
    (5, 13, "beside", "打开游戏，\n手札在旁。", "流程 · 比武请教 · 图鉴 · 存档", ["companion-flow"]),
    (13, 23, "flow", "下一步，\n心里有数。", "找谁 · 去哪 · 缺什么\n推进前，先看关键影响。", ["companion-flow", "companion-flow-detail"]),
    (23, 34, "duel", "还有谁，\n值得一战？", "剩余私物，重点物品。\n可学技艺与武学，条件一起看。", ["companion-duels", "companion-learning"]),
    (34, 44, "codex", "看到名字，\n就能顺着查。", "悬停看重点，点击看详情。\n人物、物品、任务相互关联。", ["companion-person", "item-detail"]),
    (44, 54, "map", "知道要找什么，\n也知道往哪走。", "地点地图，任务步骤，材料来源。\n在随行里继续查。", ["companion-map", "quest-detail"]),
    (54, 63, "saves", "做选择前，\n留一份退路。", "完整备份 · 历史回顾\n时间线自动存档可按需开启。", ["companion-saves"]),
    (63, 70, "end", "", "", []),
]


def run(args):
    subprocess.run(args, check=True, creationflags=0x08000000 if __import__("os").name == "nt" else 0)


def ease(x):
    x = max(0, min(1, x))
    return 1 - (1 - x) ** 3


def fit(image, size):
    image = image.copy()
    image.thumbnail(size, Image.Resampling.LANCZOS)
    return image


def rounded(image, radius=16):
    image = image.convert("RGBA")
    mask = Image.new("L", image.size)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, image.width - 1, image.height - 1), radius, fill=255)
    image.putalpha(mask)
    return image


def music(file):
    """Original deterministic pentatonic plucks, not a recording or sampled song."""
    rate = 48000
    samples = np.zeros((rate * DURATION, 2), dtype=np.float32)
    melody = [62, 69, 74, 76, 69, 66, 64, 69, 62, 66, 69, 74, 71, 69, 64, 62]
    rng = np.random.default_rng(1190)
    for beat in range(math.ceil(DURATION / 0.625)):
        start = int((beat * 0.625 + 0.12) * rate)
        if start >= len(samples):
            break
        note = melody[beat % len(melody)]
        if beat % 4 == 3:
            continue
        length = min(int(rate * 3), len(samples) - start)
        t = np.arange(length) / rate
        freq = 440 * 2 ** ((note - 69) / 12)
        envelope = (1 - np.exp(-t * 90)) * np.exp(-t * 2.5)
        tone = sum(np.sin(2 * np.pi * freq * harmonic * t) / harmonic**2 for harmonic in range(1, 6))
        tone += rng.normal(0, 0.012, length) * np.exp(-t * 80)
        tone *= envelope * (0.13 if beat % 4 else 0.18)
        pan = 0.35 + 0.3 * ((beat % 7) / 6)
        samples[start:start + length, 0] += tone * (1 - pan)
        samples[start:start + length, 1] += tone * pan
    # A quiet sustained low fifth gives the plucks some body.
    t = np.arange(len(samples)) / rate
    bed = (np.sin(2 * np.pi * 146.832 * t) + 0.5 * np.sin(2 * np.pi * 220 * t)) * 0.012
    samples += bed[:, None]
    fade = np.minimum(1, t / 2) * np.minimum(1, (DURATION - t) / 3)
    samples *= fade[:, None]
    with wave.open(str(file), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--screens", required=True, type=Path)
    parser.add_argument("--game", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--font", type=Path, default=Path("C:/Windows/Fonts/msyh.ttc"))
    parser.add_argument("--title-font", type=Path, default=Path("C:/Windows/Fonts/simkai.ttf"))
    parser.add_argument("--preview-only", action="store_true")
    args = parser.parse_args()
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("FFmpeg is required")
    if args.out.exists():
        raise RuntimeError("Choose a new output directory; previous renders are preserved")
    if not args.game.is_file() or not args.font.is_file() or not args.title_font.is_file():
        raise RuntimeError("Missing game clip or font")
    args.out.mkdir(parents=True)
    root = Path(__file__).resolve().parents[1]
    version = json.loads((root / "package.json").read_text(encoding="utf-8-sig"))["version"]
    fonts = {}

    def font(size, title=False):
        key = (size, title)
        if key not in fonts:
            fonts[key] = ImageFont.truetype(str(args.title_font if title else args.font), size)
        return fonts[key]

    panels = {}
    for name in {n for scene in SCENES for n in scene[5]}:
        image = Image.open(args.screens / (name + ".png")).convert("RGB")
        panels[name] = rounded(fit(image, (485, 850)), 16)
    icon = Image.open(root / "src/assets/icon-256.png").convert("RGBA")
    background = Image.new("RGB", (W, H), PAPER)
    draw = ImageDraw.Draw(background)
    draw.line((80, 90, 1840, 90), fill="#dcded2", width=2)
    draw.text((80, 42), "逸剑手札", font=font(30, True), fill=INK)
    draw.text((1550, 48), "YIJIAN JOURNAL", font=font(22), fill=MUTED)

    def text(draw, xy, value, size, color=INK, title=False, spacing=12):
        draw.multiline_text(xy, value, font=font(size, title), fill=color, spacing=spacing)

    def panel(frame, name, x, y, opacity=1):
        im = panels[name]
        if opacity < 1:
            im = im.copy()
            im.putalpha(im.getchannel("A").point(lambda a: int(a * opacity)))
        shadow = Image.new("RGBA", (im.width + 60, im.height + 60))
        ImageDraw.Draw(shadow).rounded_rectangle((28, 25, im.width + 28, im.height + 25), 18, fill=(15, 39, 33, int(48 * opacity)))
        shadow = shadow.filter(ImageFilter.GaussianBlur(12))
        frame.paste(shadow, (int(x - 30), int(y - 18)), shadow)
        frame.paste(im, (int(x), int(y)), im)

    def render(t, game):
        start, end, kind, heading, body, names = next(s for s in SCENES if s[0] <= t < s[1])
        local = t - start
        arrival = ease(local / 0.8)
        if kind in ("intro", "beside", "end"):
            frame = ImageEnhance.Brightness(game).enhance(0.5 if kind == "beside" else 0.24)
            tint = Image.new("RGB", (W, H), INK)
            frame = Image.blend(frame, tint, 0.18)
        else:
            frame = background.copy()
        d = ImageDraw.Draw(frame)
        if kind == "intro":
            mark = fit(icon, (135, 135))
            frame.paste(mark, (100, 180), mark)
            text(d, (92, 345 + (1 - arrival) * 38), "逸剑手札", 148, PAPER, True)
            text(d, (103, 550), "在游戏旁边，知道下一步。", 52, PAPER)
            text(d, (106, 670), "《逸剑风云决》随行助手", 32, GOLD)
        elif kind == "beside":
            text(d, (110, 270), heading, 88, PAPER, True, 22)
            text(d, (114, 535), body, 34, PAPER)
            text(d, (116, 620), "独立小窗  /  随时展开", 29, GOLD)
            panel(frame, names[0], 1310 + 55 * (1 - arrival), 105)
        elif kind == "end":
            mark = fit(icon, (115, 115))
            frame.paste(mark, (120, 170), mark)
            text(d, (108, 330), "逸剑手札", 128, PAPER, True)
            text(d, (119, 510), "在游戏旁边，知道下一步。", 45, PAPER)
            text(d, (122, 625), "下载 Windows 版", 36, GOLD)
            text(d, (122, 690), "github.com/Legender134/yijian-journal", 33, PAPER)
            text(d, (125, 785), "v" + version + "   ·   开源   ·   本地运行", 27, PAPER)
            text(d, (125, 975), "非官方玩家工具。游戏画面及素材权利归原权利人。", 21, "#bac8bb")
        else:
            index = [s[2] for s in SCENES].index(kind) - 1
            text(d, (90, 180), f"0{index}", 32, MUTED)
            text(d, (82, 270 + 32 * (1 - arrival)), heading, 78, INK, True, 20)
            text(d, (90, 510), body, 31, MUTED, spacing=22)
            d.line((90, 670, 195, 670), fill=GOLD, width=4)
            if len(names) == 1:
                panel(frame, names[0], 1170 + 55 * (1 - arrival), 128)
                text(d, (92, 735), "在随行里，直接查看。", 29, INK)
            else:
                for i, name in enumerate(names):
                    reveal = ease((local - i * 0.4) / 0.8)
                    panel(frame, name, 820 + i * 515 + (55 + i * 15) * (1 - reveal), 125, reveal)
        d = ImageDraw.Draw(frame)
        if kind not in ("intro", "end"):
            text(d, (82, 1015), "软件实际界面 · 示例进度演示", 20, "#d5decf" if kind == "beside" else MUTED)
        # A restrained wipe at section boundaries, with a steady chapter progress rule.
        transition = max(0, 1 - local / 0.25) if start else 0
        if transition:
            frame = Image.blend(frame, Image.new("RGB", (W, H), INK), transition)
        d = ImageDraw.Draw(frame)
        d.rectangle((0, H - 5, int(W * t / DURATION), H), fill=GOLD)
        if t > 69:
            frame = ImageEnhance.Brightness(frame).enhance(max(0, 70 - t))
        return frame

    still = args.out / "game-still.png"
    run([ffmpeg, "-v", "error", "-ss", "2", "-i", str(args.game), "-frames:v", "1", "-n", str(still)])
    game = Image.open(still).convert("RGB").resize((W, H), Image.Resampling.LANCZOS)
    hero = render(2, game)
    panel(hero, "companion-flow", 1310, 105)
    text(ImageDraw.Draw(hero), (106, 985), "游戏场景实际采集 · 手札界面使用示例进度", 21, "#bac8bb")
    hero.save(args.out / "hero.webp", quality=91)
    render(2, game).save(args.out / "poster.jpg", quality=95)
    contact = Image.new("RGB", (1280, 1440), PAPER)
    for i, t in enumerate([2, 8, 17, 27, 38, 48, 58, 66]):
        frame = render(t, game)
        frame.save(args.out / f"frame-{t:02}.jpg", quality=95)
        contact.paste(frame.resize((640, 360), Image.Resampling.LANCZOS), ((i % 2) * 640, (i // 2) * 360))
    contact.save(args.out / "contact.jpg", quality=94)
    if args.preview_only:
        return
    soundtrack = args.out / "soundtrack.wav"
    music(soundtrack)
    silent = args.out / "picture.mp4"
    decoder = subprocess.Popen([ffmpeg, "-v", "error", "-stream_loop", "-1", "-i", str(args.game), "-vf", f"fps={FPS},scale={W}:{H}", "-t", str(DURATION), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], stdout=subprocess.PIPE)
    encoder = subprocess.Popen([ffmpeg, "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "pipe:0", "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "19", "-pix_fmt", "yuv420p", "-n", str(silent)], stdin=subprocess.PIPE)
    try:
        for n in range(DURATION * FPS):
            raw = decoder.stdout.read(W * H * 3)
            if len(raw) != W * H * 3:
                raise RuntimeError("Incomplete game decode")
            frame = render(n / FPS, Image.frombytes("RGB", (W, H), raw))
            encoder.stdin.write(frame.tobytes())
            if n % (FPS * 10) == 0:
                print(f"Rendered {n // FPS}/{DURATION}s", flush=True)
        encoder.stdin.close()
        if encoder.wait() or decoder.wait():
            raise RuntimeError("Video encoder/decoder failed")
    finally:
        for process in [decoder, encoder]:
            if process.poll() is None:
                process.kill()
                process.wait()
    movie = args.out / f"YijianJournal-{version}-introduction.mp4"
    run([ffmpeg, "-v", "error", "-i", str(silent), "-i", str(soundtrack), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-af", "volume=2.5", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", "-metadata", "title=逸剑手札 · 在游戏旁边，知道下一步", "-n", str(movie)])
    (args.out / "render.json").write_text(json.dumps({"version": version, "duration": DURATION, "fps": FPS, "resolution": [W, H], "scenes": SCENES, "game": str(args.game), "screens": str(args.screens), "audio": "Original procedural pentatonic score; no sampled audio", "video": movie.name}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(movie)


if __name__ == "__main__":
    main()
