# RunPod Wan VACE Worker

This folder contains the RunPod-side worker for the MediaForge VFX flow:

1. Source green-screen video
2. Mask video
3. Qwen-generated reference image
4. Wan 2.1 VACE video edit

The worker defaults to `WAN_WORKER_PORT=8888`, but the port should match the HTTP port exposed by
the active RunPod pod. Some fallback pods expose `8000` instead. The same worker also serves Qwen
reference-image routes under `/qwen`, which avoids needing a second public HTTP port on the pod.

The Supabase secrets should point to the matching proxy URL:

```bash
RUNPOD_WAN_WORKER_URL=https://<pod-id>-<worker-port>.proxy.runpod.net
RUNPOD_QWEN_ENDPOINT_URL=https://<pod-id>-<worker-port>.proxy.runpod.net/qwen
```

When `RUNPOD_QWEN_ENDPOINT_URL` points at the pod proxy `/qwen` route, Qwen runs through the
same direct worker as Wan VACE. A RunPod API key is only required when using a RunPod serverless
endpoint (`api.runpod.ai`) instead of the pod proxy.

## Pod setup

Copy these files to `/workspace` on the pod:

```bash
wan_vace_worker.py
qwen_worker.py
install_comfy_wan_vace.sh
install_wan_vace_light.sh
start_wan_vace_services.sh
```

First-time setup:

```bash
chmod +x /workspace/install_comfy_wan_vace.sh /workspace/start_wan_vace_services.sh
/workspace/install_comfy_wan_vace.sh
```

The installer aligns the pod with the community workflows used as the product baseline:

- Qwen start/reference image:
  - `models/unet/gguf/qwen-image-edit-2511-Q5_0.gguf`
  - `models/loras/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-fp32.safetensors`
  - `models/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors`
  - `models/vae/qwen_image_vae.safetensors`
- Wan VACE video edit:
  - `models/diffusion_models/WanVideo/Wan2_1-T2V-1_3B_bf16.safetensors`
  - `models/diffusion_models/WanVideo/Wan2_1-VACE_module_1_3B_bf16.safetensors`
  - `models/text_encoders/umt5-xxl-enc-bf16.safetensors`
  - `models/vae/wanvideo/Wan2_1_VAE_bf16.safetensors`

Start ComfyUI and the MediaForge worker:

```bash
WAN_WORKER_PORT=<worker-port> /workspace/start_wan_vace_services.sh
```

On GPUs with 24GB VRAM or less, the start script automatically adds `--lowvram`
unless `COMFY_EXTRA_ARGS` is already set. This is the safe default for the
lower-cost RunPod pods we use for MVP validation. Larger GPUs can override it:

```bash
COMFY_EXTRA_ARGS="" WAN_WORKER_PORT=<worker-port> /workspace/start_wan_vace_services.sh
```

The start script waits for ComfyUI, waits for the worker `/health` endpoint, and then runs both
`/preflight` and `/qwen/preflight`. If a custom node or model is missing, it exits before any
MediaForge job is sent.

Expected local endpoints inside the pod:

```bash
curl http://127.0.0.1:8188/object_info
curl http://127.0.0.1:<worker-port>/health
curl http://127.0.0.1:<worker-port>/diagnostics
curl http://127.0.0.1:<worker-port>/preflight
curl http://127.0.0.1:<worker-port>/qwen/preflight
```

`/preflight` checks whether the ComfyUI Wan custom nodes are installed and whether the configured
Wan base, VACE, T5, and VAE model selectors resolve to available model files. It returns HTTP `503`
with details when the pod is not ready.

`/diagnostics` is the first endpoint to check when E2E is blocked. It reports Comfy reachability,
required node classes, configured Wan/Qwen model file paths, file existence, and both Wan and Qwen
preflight summaries in one response.

## Green-screen mask polarity

The current worker uses the open-source Wan VACE graph directly:

```text
source video + mask video + Qwen reference image -> WanVideoVACEEncode -> WanVideoSampler -> MP4
```

For the astronaut green-screen footage tested in E2E, the provided mask video is:

- white = subject/person
- black = background/green screen

To replace the background while preserving the subject, set `invert_mask=true` so Wan receives
the background as the active edit area. If a matte already uses white for the background/edit
area, leave `invert_mask=false`.

Practical tuning observed on a 16GB RTX 2000 Ada pod:

- `vace_strength` around `0.30` can replace the green screen, but may weaken subject detail.
- Higher `vace_strength` preserves more of the source clip, but can also preserve the green plate.
- Keep first tests short, for example `total_frames=5`, `chunk_frames=5`, `width=384`, `height=224`.
- Restart ComfyUI between Qwen and heavier Wan attempts on 16GB pods if the process is reused for many jobs.

## Cost control

Do not start, stop, resize, or recreate pods without explicit user approval in the current conversation.
When the user has already approved the active E2E session, stop the pod as soon as testing finishes
or hits a blocker to avoid ongoing charges.
