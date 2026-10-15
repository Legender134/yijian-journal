"""Create a 59-second film from actual Electron interaction frames.
Requires Python 3.12+, Pillow, NumPy and FFmpeg. No network services.
"""
import argparse
from bisect import bisect_right
from functools import lru_cache
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import wave
import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

W, H, FPS = 1920, 1080, 30
INK, PAPER, GOLD = "#183a32", "#f6f3e8", "#d8bd77"
INTRO, OUTRO = 2.5, 3.5
PARTS = [
    ("flow", 6, "推进之前，先把会错过的事看清楚。"),
    ("material", 7, "缺哪味药，悬停就能看；点开继续查。"),
    ("map", 8, "顺着材料来源，直接找到地点。"),
    ("duels", 7, "私物还剩什么，谁值得再打一场？"),
    ("learning", 12, "能学什么、还差什么条件，一起看。"),
    ("saves", 11, "做关键选择前，给当前进度留份退路。"),
    ("tuck", 2, "收起来，继续你的江湖。"),
]
DURATION = INTRO + sum(row[1] for row in PARTS) + OUTRO
WIDE = (1240, 75, .98)
BACKUP_RESULT = (558, -210, 1.3)
CAMERAS = {
    "flow": [(0, WIDE), (.23, (310, 20, 2.1)), (.78, (310, 20, 2.1)), (1, (420, -80, 1.75))],
    "material": [(0, (420, -80, 1.75)), (.48, (420, -80, 1.75)), (.68, (430, 30, 1.72)), (1, (430, 30, 1.72))],
    "map": [(0, (430, 30, 1.72)), (.38, (430, 30, 1.72)), (.60, (440, 30, 1.68)), (1, (440, 30, 1.68))],
    "duels": [(0, (440, 30, 1.68)), (.32, (440, 30, 1.68)), (.48, (390, -90, 1.85)), (1, (390, -90, 1.85))],
    "learning": [(0, (390, -90, 1.85)), (.34, (449, -260, 1.65)), (.58, (449, -260, 1.65)), (.77, (430, -40, 1.72)), (1, (430, -40, 1.72))],
    "saves": [(0, (430, -40, 1.72)), (.19, (430, 60, 1.7)), (.44, (430, 60, 1.7)), (.52, (440, -255, 1.68)), (.78, (440, -255, 1.68)), (.91, BACKUP_RESULT), (1, BACKUP_RESULT)],
    "tuck": [(0, BACKUP_RESULT), (.35, WIDE), (1, WIDE)],
}


def ease(value):
    value = max(0, min(1, value))
    return value * value * (3 - 2 * value)


def camera(part, progress):
    rows = CAMERAS[part]
    for (a, pa), (b, pb) in zip(rows, rows[1:]):
        if progress <= b:
            u = ease((progress - a) / (b - a))
            return tuple(x + (y - x) * u for x, y in zip(pa, pb))
    return rows[-1][1]


def run(args):
    subprocess.run(args, check=True, creationflags=0x08000000 if os.name == "nt" else 0)


def rounded(image, radius):
    image = image.convert("RGBA")
    mask = Image.new("L", image.size)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, image.width - 1, image.height - 1), radius, fill=255)
    image.putalpha(mask)
    return image


def soundtrack(file, clicks, complete_at):
    """Original plucks, bass, percussion, and sounds timed to actual actions."""
    rate = 48000
    audio = np.zeros((math.ceil(DURATION * rate), 2), dtype=np.float32)
    rng = np.random.default_rng(119075)

    def add(at, tone, gain=1, pan=.5):
        start = max(0, int(at * rate))
        n = min(len(tone), len(audio) - start)
        if n <= 0:
            return
        audio[start:start + n, 0] += tone[:n] * gain * math.sqrt(1 - pan)
        audio[start:start + n, 1] += tone[:n] * gain * math.sqrt(pan)

    beat = 60 / 108
    roots, melody = [50, 46, 48, 45], [74, 69, 65, 67, 72, 69, 67, 65]
    for i in range(math.ceil(DURATION / beat)):
        at = i * beat
        if i % 2 == 0:
            t = np.arange(int(rate * 2.1)) / rate
            frequency = 440 * 2 ** ((melody[(i // 2) % len(melody)] - 69) / 12)
            tone = sum(np.sin(2 * np.pi * frequency * h * t) / h**2.2 for h in range(1, 6))
            tone *= (1 - np.exp(-t * 150)) * np.exp(-t * 3)
            add(at + .045, tone, .12, .35 + .15 * ((i // 2) % 3))
        if i % 4 == 0:
            t = np.arange(int(rate * 2.6)) / rate
            frequency = 440 * 2 ** ((roots[(i // 8) % 4] - 69) / 12)
            tone = np.sin(2 * np.pi * frequency * t) + .3 * np.sin(4 * np.pi * frequency * t)
            tone *= (1 - np.exp(-t * 18)) * np.exp(-t * 1.5)
            add(at, tone, .10)
        if INTRO < at < DURATION - OUTRO:
            t = np.arange(int(rate * .22)) / rate
            if i % 2 == 0:
                tone = np.sin(2 * np.pi * (46 * t + 2.8 * (1 - np.exp(-t * 30)))) * np.exp(-t * 22)
                add(at, tone, .13)
            else:
                tone = np.diff(rng.normal(0, 1, len(t)), prepend=0) * np.exp(-t * 32)
                add(at, tone, .017, .55)
    for i, at in enumerate(clicks):
        t = np.arange(int(rate * .075)) / rate
        tone = (np.sin(2 * np.pi * 820 * t) + .32 * np.sin(2 * np.pi * 1700 * t)) * np.exp(-t * 85)
        add(at, tone, .035, .46 + .08 * (i % 2))
    for delay, frequency in [(0, 880), (.115, 1174.66)]:
        t = np.arange(int(rate * .65)) / rate
        tone = np.sin(2 * np.pi * frequency * t) * np.exp(-t * 7) * (1 - np.exp(-t * 180))
        add(complete_at + delay, tone, .07)
    for at in [INTRO, DURATION - OUTRO]:
        t = np.arange(int(rate * .6)) / rate
        tone = np.convolve(rng.normal(0, 1, len(t)), np.ones(20) / 20, mode="same") * np.sin(np.pi * t / .6)**2
        add(at - .2, tone, .035)
    time = np.arange(len(audio)) / rate
    audio *= (np.minimum(1, time / .4) * np.minimum(1, (DURATION - time) / 1.5))[:, None]
    with wave.open(str(file), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", required=True, type=Path)
    parser.add_argument("--game", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--font", type=Path, default=Path("C:/Windows/Fonts/msyh.ttc"))
    parser.add_argument("--title-font", type=Path, default=Path("C:/Windows/Fonts/simkai.ttf"))
    parser.add_argument("--preview-only", action="store_true")
    args = parser.parse_args()
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg or not args.game.is_file() or not args.font.is_file() or not args.title_font.is_file():
        raise RuntimeError("FFmpeg, an authorized game clip, and fonts are required")
    if args.out.exists():
        raise RuntimeError("Choose a new output directory; earlier renders are preserved")
    capture = json.loads((args.capture / "capture.json").read_text(encoding="utf-8"))
    if not capture.get("complete") or capture["errors"]:
        raise RuntimeError("Use a completed, error-free actual UI recording")
    markers = {row["name"]: row["time"] for row in capture["markers"]}
    scenes, cursor = [], INTRO
    for kind, duration, caption in PARTS:
        a, b = markers[kind + "-in"], markers[kind + "-out"]
        if b <= a:
            raise RuntimeError("Invalid recording markers")
        scenes.append(dict(kind=kind, start=cursor, end=cursor + duration, source_start=a, source_end=b, caption=caption))
        cursor += duration
    args.out.mkdir(parents=True)
    frames, events = capture["frames"], capture["events"]
    frame_times = [row["time"] for row in frames]
    movements = [row for row in events if row["kind"] == "move"]
    move_times = [row["time"] for row in movements]
    clicks = [row for row in events if row["kind"] == "click"]
    mapped_clicks, complete_at = [], DURATION - OUTRO - 4
    for event in clicks:
        for scene in scenes:
            if scene["source_start"] <= event["time"] <= scene["source_end"]:
                progress = (event["time"] - scene["source_start"]) / (scene["source_end"] - scene["source_start"])
                at = scene["start"] + progress * (scene["end"] - scene["start"])
                x, y, scale = camera(scene["kind"], progress)
                if not (8 <= x + event["x"] * scale <= W - 8 and 8 <= y + event["y"] * scale < 970):
                    raise RuntimeError("Camera hides a click target: " + event["selector"])
                mapped_clicks.append(at)
                if "backup-confirm" in event["selector"]:
                    complete_at = at + .16
                break
    root = Path(__file__).resolve().parents[1]
    icon = Image.open(root / "src/assets/icon-256.png").convert("RGBA")

    @lru_cache(32)
    def font(size, title=False):
        return ImageFont.truetype(str(args.title_font if title else args.font), size)

    @lru_cache(8)
    def source_frame(index):
        im = Image.open(args.capture / frames[index]["file"]).convert("RGB")
        return rounded(im, 18 if frames[index]["width"] < 100 else 28)

    def source_at(t):
        return max(0, bisect_right(frame_times, t) - 1)

    def pointer_at(t):
        i = max(0, bisect_right(move_times, t) - 1)
        a = movements[i]
        if i + 1 < len(movements):
            b = movements[i + 1]
            u = max(0, min(1, (t - a["time"]) / max(.001, b["time"] - a["time"])))
            return a["x"] + (b["x"] - a["x"]) * u, a["y"] + (b["y"] - a["y"]) * u
        return a["x"], a["y"]

    shadow = Image.new("RGBA", (capture["width"] + 100, capture["height"] + 100))
    ImageDraw.Draw(shadow).rounded_rectangle((50, 50, shadow.width - 50, shadow.height - 50), 20, fill=(0, 0, 0, 130))
    shadow = shadow.filter(ImageFilter.GaussianBlur(24))
    still = args.out / "game-still.png"
    run([ffmpeg, "-v", "error", "-ss", "3", "-i", str(args.game), "-frames:v", "1", "-vf", f"scale={W}:{H}", "-n", str(still)])
    game_still = Image.open(still).convert("RGB")
    dark = Image.blend(ImageEnhance.Brightness(game_still.filter(ImageFilter.GaussianBlur(20))).enhance(.32), Image.new("RGB", (W, H), INK), .60)
    grain = np.random.default_rng(75).normal(0, .85, (H, W, 1))
    dark = Image.fromarray(np.clip(np.asarray(dark).astype(float) + grain, 0, 255).astype("uint8"))
    scrim = Image.new("RGBA", (W, H), (10, 28, 23, 0))
    alpha = np.tile((218 * (1 - np.clip(np.arange(W) / 1300, 0, 1))**.8).astype("uint8"), (H, 1))
    scrim.putalpha(Image.fromarray(alpha))

    def label(frame, xy, value, size, color=PAPER, title=False, opacity=1):
        layer = Image.new("RGBA", frame.size)
        ImageDraw.Draw(layer).text(xy, value, font=font(size, title), fill=color)
        if opacity < 1:
            layer.putalpha(layer.getchannel("A").point(lambda a: round(a * max(0, opacity))))
        frame.alpha_composite(layer)

    def panel(frame, index, pose, opacity=1):
        x, y, scale = pose
        row, im = frames[index], source_frame(index)
        if row["width"] < 100:
            size = (round(row["width"] * 1.15), round(row["height"] * 1.15))
            frame.alpha_composite(im.resize(size, Image.Resampling.LANCZOS), (W - size[0] - 12, 475))
            return
        scaled_shadow = shadow.resize((round(shadow.width * scale), round(shadow.height * scale)), Image.Resampling.BILINEAR)
        # CDP can report half-size device metadata for an unchanged HiDPI window.
        # The recorded viewport remains the full window's stable logical size.
        sized = im.resize((round(capture["width"] * scale), round(capture["height"] * scale)), Image.Resampling.LANCZOS)
        if opacity < 1:
            sized.putalpha(sized.getchannel("A").point(lambda a: round(a * opacity)))
            scaled_shadow.putalpha(scaled_shadow.getchannel("A").point(lambda a: round(a * opacity)))
        frame.alpha_composite(scaled_shadow, (round(x - 50 * scale), round(y - 38 * scale)))
        frame.alpha_composite(sized, (round(x), round(y)))

    def draw_pointer(frame, source_time, pose):
        x, y, scale = pose
        px, py = pointer_at(source_time)
        px, py = x + px * scale, y + py * scale
        if not (0 <= px <= W and 0 <= py <= H):
            return
        layer = Image.new("RGBA", frame.size)
        d = ImageDraw.Draw(layer)
        for event in clicks:
            age = source_time - event["time"]
            if 0 <= age < .48:
                cx, cy = x + event["x"] * scale, y + event["y"] * scale
                radius = 12 + 34 * ease(age / .48)
                d.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), outline=(218, 188, 110, round(220 * (1 - age / .48))), width=3)
        s = min(39, 22 * scale)
        shape = [(px, py), (px + .05 * s, py + s), (px + .31 * s, py + .72 * s), (px + .52 * s, py + 1.08 * s), (px + .72 * s, py + .96 * s), (px + .51 * s, py + .62 * s), (px + .89 * s, py + .58 * s)]
        d.polygon([(a + 2, b + 3) for a, b in shape], fill=(0, 0, 0, 70))
        d.polygon(shape, fill=(250, 250, 244, 255), outline=(25, 54, 47, 255), width=2)
        frame.alpha_composite(layer)

    def caption(frame, value, opacity=1):
        f = font(35)
        box = f.getbbox(value)
        width = box[2] - box[0] + 64
        layer = Image.new("RGBA", (width, 70))
        d = ImageDraw.Draw(layer)
        d.rounded_rectangle((0, 0, width - 1, 69), 18, fill=(17, 39, 33, 240), outline=(216, 189, 119, 85), width=1)
        d.text((32, 11), value, font=f, fill=PAPER)
        layer.putalpha(layer.getchannel("A").point(lambda a: round(a * opacity)))
        frame.alpha_composite(layer, ((W - width) // 2, 987))

    def render(t, game):
        body_opacity = ease((t - INTRO) / 1.2) * (1 - ease((t - (DURATION - OUTRO - 1)) / 1.0))
        live = ImageEnhance.Brightness(game).enhance(.76).convert("RGBA")
        live.alpha_composite(scrim)
        frame = Image.blend(live, dark.convert("RGBA"), body_opacity)
        if t < INTRO:
            arrival = ease((t - .2) / .9)
            panel(frame, source_at(markers["flow-in"]), (WIDE[0] + (1 - arrival) * 140, WIDE[1] + (1 - arrival) * 18, WIDE[2]), arrival)
            opacity = ease(t / .4)
            label(frame, (104, 330), "先别急着拜师。", 94, title=True, opacity=opacity)
            label(frame, (110, 460), "看看，还有什么不能错过。", 45, opacity=opacity)
            label(frame, (112, 560), "逸剑手札  /  游戏旁的随行助手", 30, GOLD, opacity=opacity)
        elif t >= DURATION - OUTRO:
            panel(frame, source_at(markers["tuck-out"]), WIDE)
            a = ease((t - (DURATION - OUTRO)) / .6)
            frame.alpha_composite(icon.resize((104, 104), Image.Resampling.LANCZOS), (112, 230))
            label(frame, (102, 370), "逸剑手札", 112, title=True, opacity=a)
            label(frame, (112, 520), "在游戏旁边，知道下一步。", 46, opacity=a)
            label(frame, (115, 635), "Windows · 开源 · 本地运行", 30, GOLD, opacity=a)
            label(frame, (115, 705), "github.com/Legender134/yijian-journal", 33, opacity=a)
        else:
            scene = next(row for row in scenes if row["start"] <= t < row["end"])
            q = (t - scene["start"]) / (scene["end"] - scene["start"])
            source_time = scene["source_start"] + q * (scene["source_end"] - scene["source_start"])
            index = source_at(source_time)
            pose = camera(scene["kind"], q)
            panel(frame, index, pose)
            if frames[index]["width"] > 100:
                draw_pointer(frame, source_time, pose)
            caption_alpha = min(1, (t - scene["start"]) / .18, (scene["end"] - t) / .18)
            if scene["kind"] == "saves":
                caption_alpha *= 1 - ease((t - complete_at) / .25)
            caption(frame, scene["caption"], caption_alpha)
        if t < INTRO + 1:
            label(frame, (44, 1016), "实际软件操作 · 示例进度", 20, "#d8dfd2")
        if INTRO + 1 <= t < DURATION - OUTRO:
            frame.alpha_composite(icon.resize((30, 30), Image.Resampling.LANCZOS), (28, 26))
            label(frame, (68, 28), "逸剑手札", 22, "#d8dfd2")
        if t > DURATION - .5:
            frame = ImageEnhance.Brightness(frame).enhance((DURATION - t) / .5)
        return frame.convert("RGB")

    preview_times = [1.7, 5.9, 12.2, 19.5, 27.2, 35.8, 40.7, 47.9, 52.7, 57.0]
    contact = Image.new("RGB", (1280, 1800), INK)
    for i, t in enumerate(preview_times):
        rendered = render(t, game_still)
        rendered.save(args.out / f"frame-{t:04.1f}.jpg", quality=94)
        contact.paste(rendered.resize((640, 360), Image.Resampling.LANCZOS), ((i % 2) * 640, (i // 2) * 360))
    contact.save(args.out / "contact.jpg", quality=94)
    render(1.7, game_still).save(args.out / "poster.jpg", quality=95)
    record = dict(duration=DURATION, width=W, height=H, fps=FPS, scenes=scenes, mappedClicks=mapped_clicks, completionSoundAt=complete_at, capturedFrames=len(frames), context=capture["context"], soundtrack="Original deterministic synthesis, no sampled music.", renderer="Actual screencast frames, camera movement, real input timing, edited pauses and captions.")
    (args.out / "render.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.preview_only:
        print(json.dumps(dict(output=str(args.out), duration=DURATION, preview=True)))
        return
    music, silent = args.out / "soundtrack.wav", args.out / "picture.mp4"
    soundtrack(music, mapped_clicks, complete_at)
    decoder = subprocess.Popen([ffmpeg, "-v", "error", "-stream_loop", "-1", "-i", str(args.game), "-vf", f"fps={FPS},scale={W}:{H}", "-t", str(DURATION), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], stdout=subprocess.PIPE)
    closing = subprocess.Popen([ffmpeg, "-v", "error", "-sseof", str(-OUTRO - .5), "-i", str(args.game), "-vf", f"fps={FPS}:start_time=0,scale={W}:{H}", "-t", str(OUTRO), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], stdout=subprocess.PIPE)
    encoder = subprocess.Popen([ffmpeg, "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "pipe:0", "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-n", str(silent)], stdin=subprocess.PIPE)
    try:
        for n in range(round(DURATION * FPS)):
            raw = decoder.stdout.read(W * H * 3)
            if len(raw) != W * H * 3:
                raise RuntimeError("Incomplete game decode")
            if n / FPS >= DURATION - OUTRO:
                raw = closing.stdout.read(W * H * 3)
                if len(raw) != W * H * 3:
                    raise RuntimeError("Game clip must contain a continuous closing shot")
            encoder.stdin.write(render(n / FPS, Image.frombytes("RGB", (W, H), raw)).tobytes())
            if n % (FPS * 5) == 0:
                print(f"Rendered {n / FPS:.0f}/{DURATION:.0f}s", flush=True)
        encoder.stdin.close()
        if encoder.wait() != 0 or decoder.wait() != 0 or closing.wait() != 0:
            raise RuntimeError("FFmpeg rendering failed")
    finally:
        if encoder.poll() is None:
            encoder.kill()
        if decoder.poll() is None:
            decoder.kill()
        if closing.poll() is None:
            closing.kill()
    movie = args.out / "YijianJournal-1.19.0-introduction.mp4"
    run([ffmpeg, "-v", "error", "-i", str(silent), "-i", str(music), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-af", "loudnorm=I=-17:TP=-1.5:LRA=9", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-shortest", "-n", str(movie)])
    print(json.dumps(dict(output=str(movie), duration=DURATION, bytes=movie.stat().st_size)))


if __name__ == "__main__":
    main()
