"""Download FLUX.1-schnell fp8 and T5 encoder for ComfyUI"""
from huggingface_hub import hf_hub_download
import os, sys

model_dir = sys.argv[1]
clip_dir = sys.argv[2]

print("==> Downloading FLUX.1-schnell fp8...")
hf_hub_download(
    repo_id='Kijai/flux-fp8',
    filename='flux1-schnell-fp8.safetensors',
    local_dir=model_dir,
    local_dir_use_symlinks=False,
    resume_download=True,
)
print("FLUX done")

print("==> Downloading T5 encoder...")
hf_hub_download(
    repo_id='city96/t5-v1_1-xxl-encoder-gguf',
    filename='t5-v1_1-xxl-encoder-only-Q6_K.gguf',
    local_dir=clip_dir,
    local_dir_use_symlinks=False,
    resume_download=True,
)
print("T5 done")
