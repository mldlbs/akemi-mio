"""Robust model download with progress and resume"""
import os, sys, time
import requests
from tqdm import tqdm

MODELS = [
    {
        "name": "FLUX.1-schnell Q4_K_S (6.5GB)",
        "url": "https://hf-mirror.com/city96/FLUX.1-schnell-gguf/resolve/main/flux1-schnell-Q4_K_S.gguf",
        "path": r"C:\Users\gf191\AppData\Roaming\akemi-mio\cache\comfyui\models\checkpoints\flux-schnell\flux1-schnell-Q4_K_S.gguf",
    },
    {
        "name": "T5-v1_1-xxl encoder Q6_K (3.7GB)",
        "url": "https://hf-mirror.com/city96/t5-v1_1-xxl-encoder-gguf/resolve/main/t5-v1_1-xxl-encoder-Q6_K.gguf",
        "path": r"C:\Users\gf191\AppData\Roaming\akemi-mio\cache\comfyui\models\clip\t5-v1_1-xxl-encoder-Q6_K.gguf",
    },
]

CHUNK_SIZE = 32 * 1024 * 1024
TIMEOUT = 30
RETRIES = 5

def download_file(url, dest, name):
    os.makedirs(os.path.dirname(dest), exist_ok=True)

    for attempt in range(1, RETRIES + 1):
        try:
            resume_header = {}
            existing_size = 0
            if os.path.exists(dest):
                existing_size = os.path.getsize(dest)
                resume_header["Range"] = f"bytes={existing_size}-"
                print(f"  [attempt {attempt}/{RETRIES}] resuming from {existing_size // 1024 // 1024} MB")

            resp = requests.get(url, stream=True, timeout=TIMEOUT, headers=resume_header, allow_redirects=True)

            if resp.status_code == 416:
                print(f"  {name}: already complete ({existing_size // 1024 // 1024} MB)")
                return True

            if resp.status_code == 200:
                existing_size = 0
            elif resp.status_code == 206:
                pass
            else:
                print(f"  HTTP {resp.status_code}, retrying...")
                time.sleep(5)
                continue

            total = int(resp.headers.get("content-length", 0)) + existing_size
            mode = "ab" if existing_size > 0 and resp.status_code == 206 else "wb"

            with open(dest, mode) as f:
                with tqdm(total=total, initial=existing_size, unit="B", unit_scale=True, desc=name) as pbar:
                    for chunk in resp.iter_content(chunk_size=CHUNK_SIZE):
                        if chunk:
                            f.write(chunk)
                            pbar.update(len(chunk))

            print(f"  {name}: done ({os.path.getsize(dest) // 1024 // 1024} MB)")
            return True

        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout, requests.exceptions.ChunkedEncodingError) as e:
            print(f"  Connection error: {e}")
            if attempt < RETRIES:
                wait = attempt * 10
                print(f"  Retrying in {wait}s...")
                time.sleep(wait)
            else:
                print(f"  FAILED after {RETRIES} attempts")
                return False
        except Exception as e:
            print(f"  Unexpected error: {e}")
            return False

if __name__ == "__main__":
    success = True
    for model in MODELS:
        if os.path.exists(model["path"]) and os.path.getsize(model["path"]) > 100 * 1024 * 1024:
            print(f"{model['name']}: already exists ({os.path.getsize(model['path']) // 1024 // 1024} MB)")
            continue
        if not download_file(model["url"], model["path"], model["name"]):
            success = False

    if success:
        print("\nAll models downloaded successfully!")
    else:
        print("\nSome downloads failed. Run again to resume.")
