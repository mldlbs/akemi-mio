@echo off
REM download_models.bat — 在独立窗口中下载 FLUX + T5 模型
set COMFY_DIR=%APPDATA%\akemi-mio\cache\comfyui
set MODEL_DIR=%COMFY_DIR%\models\checkpoints\flux-schnell
set CLIP_DIR=%COMFY_DIR%\models\clip
mkdir %MODEL_DIR% %CLIP_DIR% 2>nul

echo [1/2] 下载 FLUX.1-schnell fp8 (~7GB) ...
curl -L -o "%MODEL_DIR%\flux1-schnell-fp8-e4m3fn.safetensors" -C - --retry 3 "https://hf-mirror.com/Kijai/flux-fp8/resolve/main/flux1-schnell-fp8-e4m3fn.safetensors"
echo FLUX 完成

echo [2/2] 下载 T5 encoder (~5GB) ...
curl -L -o "%CLIP_DIR%\t5-v1_1-xxl-encoder-only-Q6_K.gguf" -C - --retry 3 "https://hf-mirror.com/city96/t5-v1_1-xxl-encoder-gguf/resolve/main/t5-v1_1-xxl-encoder-only-Q6_K.gguf"
echo T5 完成

echo 全部下载完成！
pause
