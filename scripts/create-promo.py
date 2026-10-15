"""Create a narrated product film from actual Electron interaction frames.
Requires Python 3.12+, Pillow, NumPy, FFmpeg and pre-generated narration.
"""
import argparse
from bisect import bisect_right
from functools import lru_cache
import json
import hashlib
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
WIDE = (1240, 75, .98)
READING = (449, 20, 1.65)
BACKUP_RESULT = (558, -255, 1.25)


def ease(value):
    value = max(0, min(1, value))
    return value * value * (3 - 2 * value)


def camera_at(rows, time):
    for (a, pa), (b, pb) in zip(rows, rows[1:]):
        if time <= b:
            u = ease((time - a) / max(.001, b - a))
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


def soundtrack(file, clicks, complete_at, duration, intro, outro):
    """Original plucks, bass, percussion, and sounds timed to actual actions."""
    rate = 48000
    audio = np.zeros((math.ceil(duration * rate), 2), dtype=np.float32)
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
    for i in range(math.ceil(duration / beat)):
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
        if intro < at < duration - outro:
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
    for at in [intro, duration - outro]:
        t = np.arange(int(rate * .6)) / rate
        tone = np.convolve(rng.normal(0, 1, len(t)), np.ones(20) / 20, mode="same") * np.sin(np.pi * t / .6)**2
        add(at - .2, tone, .035)
    time = np.arange(len(audio)) / rate
    audio *= (np.minimum(1, time / .4) * np.minimum(1, (duration - time) / 1.5))[:, None]
    with wave.open(str(file), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", required=True, type=Path)
    parser.add_argument("--narration", required=True, type=Path)
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
    root = Path(__file__).resolve().parents[1]
    narration = json.loads((args.narration / 'narration.json').read_text(encoding='utf-8'))
    if not narration.get('complete') or narration['scriptSha256'] != hashlib.sha256((root / 'docs/promo-script.json').read_bytes()).hexdigest():
        raise RuntimeError('Narration must match the current public script')
    voices = {row['id']: row for row in narration['scenes']}
    for voice in voices.values():
        if hashlib.sha256((args.narration / voice['audio']).read_bytes()).hexdigest() != voice['audioSha256']:
            raise RuntimeError('Narration audio changed')
    quantize = lambda value: math.ceil(value * FPS) / FPS
    INTRO = quantize(max(voices['intro']['minimum'], voices['intro']['duration'] + .6))
    OUTRO = quantize(max(voices['outro']['minimum'], voices['outro']['duration'] + .6))
    markers = {row["name"]: row["time"] for row in capture["markers"]}
    scenes, cursor, speech = [], INTRO, []
    for voice in narration['scenes'][1:-1]:
        kind = voice['id']
        a, b = markers[kind + "-in"], markers[kind + "-out"]
        if b <= a:
            raise RuntimeError("Invalid recording markers")
        lead = 2.1 if kind == 'choice' else .35
        duration = quantize(max(voice['minimum'], voice['duration'] + lead + .45, (b - a) * .85))
        scenes.append(dict(kind=kind, start=cursor, end=cursor + duration, source_start=a, source_end=b, title=voice['title']))
        speech.append(dict(**voice, start=cursor + lead))
        cursor += duration
    DURATION = quantize(cursor + OUTRO)
    speech = [dict(**voices['intro'], start=.25), *speech, dict(**voices['outro'], start=cursor + .25)]
    captions = []
    for voice in speech:
        boundaries = voice['boundaries']
        for i, boundary in enumerate(boundaries):
            start = voice['start'] + boundary['offset'] / 10_000_000
            end = voice['start'] + (boundary['offset'] + boundary['duration']) / 10_000_000
            if i + 1 < len(boundaries):
                end = min(end, voice['start'] + boundaries[i + 1]['offset'] / 10_000_000)
            captions.append(dict(start=start, end=end, text=boundary['text']))
    args.out.mkdir(parents=True)
    frames, events = capture["frames"], capture["events"]
    frame_times = [row["time"] for row in frames]
    movements = [row for row in events if row["kind"] == "move"]
    move_times = [row["time"] for row in movements]
    clicks = [row for row in events if row["kind"] == "click"]
    mapped_clicks, click_rows, complete_at = [], [], DURATION - OUTRO - 4
    def mapped(scene, source_time):
        return scene['start'] + (source_time - scene['source_start']) / (scene['source_end'] - scene['source_start']) * (scene['end'] - scene['start'])

    camera_rows = [(0, WIDE), (INTRO, WIDE)]
    for scene in scenes:
        base = WIDE if scene['kind'] == 'tuck' else READING
        camera_rows.extend([(scene['start'], camera_rows[-1][1]), (scene['start'] + .75, base)])
        for event in events:
            if event['kind'] == 'read' and scene['source_start'] <= event['time'] <= scene['source_end']:
                at = mapped(scene, event['time'])
                pose = (READING[0], max(-650, min(45, 380 - event['y'] * READING[2])), READING[2])
                camera_rows.extend([(max(scene['start'] + .8, at - .2), camera_rows[-1][1]), (at + .55, pose), (min(scene['end'] - .01, at + 1.8), pose)])
        camera_rows.append((scene['end'] - .005, camera_rows[-1][1]))
    for event in clicks:
        for scene in scenes:
            if scene["source_start"] <= event["time"] <= scene["source_end"]:
                at = mapped(scene, event['time'])
                mapped_clicks.append(at)
                click_rows.append(dict(**event, at=at, scene=scene['kind']))
                if any(value in event['selector'] for value in ['database-detail', 'flow-now h3', 'world-quest', 'world-place']):
                    camera_rows.extend([(at + 1.0, READING), (at + 1.4, READING)])
                if "backup-confirm" in event["selector"]:
                    complete_at = at + .16
                    camera_rows.extend([(at + .9, BACKUP_RESULT), (scene['end'] - .01, BACKUP_RESULT)])
                break
    camera_rows.sort(key=lambda row: row[0])
    for scene in scenes:
        boundary = scene['end']
        camera_rows = [row for row in camera_rows if not (boundary - .006 <= row[0] <= boundary + .001)]
        prior = [row for row in camera_rows if row[0] < boundary]
        camera_rows.append((boundary, prior[-1][1]))
        camera_rows.sort(key=lambda row: row[0])
    # Keep every real click visible; only reframe when a target leaves the reading area.
    for i, event in enumerate(click_rows):
        at = event['at']
        x, y, scale = camera_at(camera_rows, at)
        screen_y = y + event['y'] * scale
        if screen_y < 105 or screen_y > 865:
            target_y = 165 if screen_y < 105 else 810
            pose = (x, y + target_y - screen_y, scale)
            before = max(INTRO, at - .65, click_rows[i - 1]['at'] + .08 if i else 0)
            camera_rows = [row for row in camera_rows if not (before < row[0] < at + .25)]
            camera_rows.extend([(before, camera_at(camera_rows, before)), (at - .04, pose), (at + .25, pose)])
            camera_rows.sort(key=lambda row: row[0])
    for event in click_rows:
        x, y, scale = camera_at(camera_rows, event['at'])
        if not (8 <= x + event['x'] * scale <= W - 8 and 70 <= y + event['y'] * scale <= 920):
            raise RuntimeError('Camera hides a click target: ' + event['selector'])
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
    @lru_cache(8)
    def scaled_shadow(width, height):
        return shadow.resize((width, height), Image.Resampling.BILINEAR)

    @lru_cache(12)
    def scaled_panel(index, width, height):
        return source_frame(index).resize((width, height), Image.Resampling.LANCZOS)
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
        panel_shadow = scaled_shadow(round(shadow.width * scale), round(shadow.height * scale))
        # CDP can report half-size device metadata for an unchanged HiDPI window.
        # The recorded viewport remains the full window's stable logical size.
        sized = scaled_panel(index, round(capture["width"] * scale), round(capture["height"] * scale))
        if opacity < 1:
            sized = sized.copy()
            panel_shadow = panel_shadow.copy()
            sized.putalpha(sized.getchannel("A").point(lambda a: round(a * opacity)))
            panel_shadow.putalpha(panel_shadow.getchannel("A").point(lambda a: round(a * opacity)))
        frame.alpha_composite(panel_shadow, (round(x - 50 * scale), round(y - 38 * scale)))
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

    @lru_cache(64)
    def caption_image(value):
        f = font(34)
        lines, line = [], ''
        for character in value:
            if f.getlength(line + character) > 1350:
                lines.append(line)
                line = ''
            line += character
        if line:
            lines.append(line)
        if len(lines) > 2:
            raise RuntimeError('Subtitle sentence is too long')
        width = math.ceil(max(f.getlength(line) for line in lines)) + 64
        height = len(lines) * 43 + 24
        layer = Image.new("RGBA", (width, height))
        d = ImageDraw.Draw(layer)
        d.rounded_rectangle((0, 0, width - 1, height - 1), 18, fill=(17, 39, 33, 245), outline=(216, 189, 119, 85), width=1)
        for i, line in enumerate(lines):
            d.text(((width - f.getlength(line)) / 2, 7 + i * 43), line, font=f, fill=PAPER)
        return layer

    def caption(frame, value, opacity=1):
        layer = caption_image(value)
        if opacity < 1:
            layer = layer.copy()
            layer.putalpha(layer.getchannel('A').point(lambda a: round(a * opacity)))
        frame.alpha_composite(layer, ((W - layer.width) // 2, H - layer.height - 22))

    def render(t, game):
        body_opacity = ease((t - INTRO) / 1.2) * (1 - ease((t - scenes[-1]['start']) / 1.0))
        if body_opacity == 1:
            frame = dark.convert('RGBA')
        else:
            live = ImageEnhance.Brightness(game).enhance(.76).convert("RGBA")
            live.alpha_composite(scrim)
            frame = Image.blend(live, dark.convert("RGBA"), body_opacity)
        if t < INTRO:
            arrival = ease((t - .2) / .9)
            panel(frame, source_at(markers["now-in"]), (WIDE[0] + (1 - arrival) * 140, WIDE[1] + (1 - arrival) * 18, WIDE[2]), arrival)
            opacity = ease(t / .4)
            label(frame, (104, 330), "下一步，该做什么？", 88, title=True, opacity=opacity)
            label(frame, (110, 460), "把不能错过的线索，放在游戏旁边。", 43, opacity=opacity)
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
            pose = camera_at(camera_rows, t)
            panel(frame, index, pose)
            if frames[index]["width"] > 100:
                draw_pointer(frame, source_time, pose)
            for i, line in enumerate(scene['title'].split(' · ')):
                label(frame, (28, 68 + i * 35), line, 26, GOLD)
        current_caption = next((c for c in captions if c['start'] <= t < c['end']), None)
        if current_caption:
            caption(frame, current_caption['text'], min(1, (t - current_caption['start']) / .08, (current_caption['end'] - t) / .08))
        if t < INTRO:
            label(frame, (112, 620), narration['disclosure'], 24, "#d8dfd2")
        if INTRO + 1 <= t < DURATION - OUTRO:
            frame.alpha_composite(icon.resize((30, 30), Image.Resampling.LANCZOS), (28, 26))
            label(frame, (68, 28), "逸剑手札", 22, "#d8dfd2")
        if t > DURATION - .5:
            frame = ImageEnhance.Brightness(frame).enhance((DURATION - t) / .5)
        return frame.convert("RGB")

    preview_times = [3, *[row['start'] + (row['end'] - row['start']) * .65 for row in scenes], DURATION - 3]
    contact = Image.new("RGB", (1280, math.ceil(len(preview_times) / 2) * 360), INK)
    for i, t in enumerate(preview_times):
        rendered = render(t, game_still)
        rendered.save(args.out / f"frame-{t:04.1f}.jpg", quality=94)
        contact.paste(rendered.resize((640, 360), Image.Resampling.LANCZOS), ((i % 2) * 640, (i // 2) * 360))
    contact.save(args.out / "contact.jpg", quality=94)
    render(1.7, game_still).save(args.out / "poster.jpg", quality=95)
    record = dict(duration=DURATION, width=W, height=H, fps=FPS, scenes=scenes, speech=speech, captions=captions, camera=camera_rows, mappedClicks=mapped_clicks, clickTargets=click_rows, completionSoundAt=complete_at, capturedFrames=len(frames), context=capture["context"], soundtrack="Original deterministic music with speech ducking and synthetic Mandarin narration.", renderer="Actual screencast frames, camera movement, real input timing and speech-aligned subtitles.")
    (args.out / "render.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    def timestamp(value):
        milliseconds = round(value * 1000)
        return f'{milliseconds // 3600000:02}:{milliseconds // 60000 % 60:02}:{milliseconds // 1000 % 60:02},{milliseconds % 1000:03}'
    (args.out / 'subtitles.srt').write_text('\n\n'.join(f"{i + 1}\n{timestamp(c['start'])} --> {timestamp(c['end'])}\n{c['text']}" for i, c in enumerate(captions)) + '\n', encoding='utf-8')
    if args.preview_only:
        print(json.dumps(dict(output=str(args.out), duration=DURATION, preview=True)))
        return
    music, silent = args.out / "soundtrack.wav", args.out / "picture.mp4"
    soundtrack(music, mapped_clicks, complete_at, DURATION, INTRO, OUTRO)
    with wave.open(str(music), 'rb') as wav:
        music_samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32).reshape(-1, 2) / 32768
    rate = 48000
    narration_samples = np.zeros_like(music_samples)
    duck = np.ones(len(music_samples), dtype=np.float32) * .8
    timeline = np.arange(len(duck)) / rate
    for voice in speech:
        raw = subprocess.check_output([ffmpeg, '-v', 'error', '-i', str(args.narration / voice['audio']), '-af', 'loudnorm=I=-18:TP=-2:LRA=7', '-ar', str(rate), '-ac', '1', '-f', 'f32le', 'pipe:1'], creationflags=0x08000000 if os.name == 'nt' else 0)
        samples = np.frombuffer(raw, dtype='<f4')
        start = round(voice['start'] * rate)
        if start + len(samples) > len(narration_samples):
            raise RuntimeError('Narration exceeds the scene timeline')
        narration_samples[start:start + len(samples)] += samples[:, None] * .85
        envelope = np.minimum(np.clip((timeline - voice['start'] + .18) / .18, 0, 1), np.clip((voice['start'] + len(samples) / rate + .55 - timeline) / .55, 0, 1))
        duck = np.minimum(duck, .8 - .55 * envelope)
    mix = narration_samples + music_samples * duck[:, None]
    mixed = args.out / 'mix.wav'
    with wave.open(str(mixed), 'wb') as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes((np.clip(mix, -1, 1) * 32767).astype('<i2').tobytes())
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
    run([ffmpeg, "-v", "error", "-i", str(silent), "-i", str(mixed), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=9", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-shortest", "-n", str(movie)])
    print(json.dumps(dict(output=str(movie), duration=DURATION, bytes=movie.stat().st_size)))


if __name__ == "__main__":
    main()
