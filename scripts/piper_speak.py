import sys, wave, numpy as np, os
from pathlib import Path
import piper

# espeak-ng 数据路径（piper 内置）
os.environ.setdefault('ESPEAK_DATA_PATH', str(Path(piper.__file__).parent / 'espeak-ng-data'))

model_path = Path(r'D:\work\code\akemi-mio\models\piper\zh_CN-huayan-medium.onnx')
out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('output.wav')
import re
text = sys.stdin.buffer.read().decode('utf-8', errors='replace').strip()
text = re.sub(r'[\ud800-\udfff]', '', text)

voice = piper.PiperVoice.load(str(model_path))
floats = []
for chunk in voice.synthesize(text):
    floats.append(chunk.audio_float_array)
audio = np.concatenate(floats)
pcm = (audio * 32767).astype(np.int16).tobytes()

with wave.open(str(out_path), 'w') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(voice.config.sample_rate)
    w.writeframes(pcm)
