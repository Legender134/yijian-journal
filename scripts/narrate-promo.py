"""Generate the public demo narration and speech-aligned subtitles (authoring only)."""
import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import subprocess
import os


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--script', type=Path, default=Path(__file__).resolve().parents[1] / 'docs/promo-script.json')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise RuntimeError('Choose a new narration directory')
    import edge_tts
    script_bytes = args.script.read_bytes()
    script = json.loads(script_bytes)
    args.out.mkdir(parents=True)
    result = dict(scriptSha256=hashlib.sha256(script_bytes).hexdigest(), voice=script['voice'], rate=script['rate'], disclosure=script['disclosure'], scenes=[])
    for scene in script['scenes']:
        audio, metadata = args.out / (scene['id'] + '.mp3'), args.out / (scene['id'] + '.jsonl')
        await edge_tts.Communicate(scene['text'], script['voice'], rate=script['rate'], boundary='SentenceBoundary').save(str(audio), str(metadata))
        duration = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', str(audio)], creationflags=0x08000000 if os.name == 'nt' else 0))
        boundaries = [json.loads(line) for line in metadata.read_text(encoding='utf-8').splitlines()]
        result['scenes'].append(dict(**scene, audio=audio.name, audioSha256=hashlib.sha256(audio.read_bytes()).hexdigest(), duration=duration, boundaries=boundaries))
        print(f"{scene['id']}: {duration:.2f}s", flush=True)
    result['complete'] = True
    (args.out / 'narration.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    asyncio.run(main())
