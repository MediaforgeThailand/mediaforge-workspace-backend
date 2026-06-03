# RunPod Wan VACE Worker

This folder contains the RunPod-side worker for the MediaForge VFX flow:

1. Source green-screen video
2. Mask video
3. Qwen-generated reference image
4. Wan 2.1 VACE video edit

The current RunPod pod exposes HTTP port `8888`, so the worker defaults to `WAN_WORKER_PORT=8888`.
The same worker also serves Qwen reference-image routes under `/qwen`, which avoids needing a second
public HTTP port on the pod.

The Supabase secrets should point to the matching proxy URL:

```bash
RUNPOD_WAN_WORKER_URL=https://<pod-id>-8888.proxy.runpod.net
RUNPOD_QWEN_ENDPOINT_URL=https://<pod-id>-8888.proxy.runpod.net/qwen
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
/workspace/start_wan_vace_services.sh
```

The start script waits for ComfyUI, waits for the worker `/health` endpoint, and then runs both
`/preflight` and `/qwen/preflight`. If a custom node or model is missing, it exits before any
MediaForge job is sent.

Expected local endpoints inside the pod:

```bash
curl http://127.0.0.1:8188/object_info
curl http://127.0.0.1:8888/health
curl http://127.0.0.1:8888/diagnostics
curl http://127.0.0.1:8888/preflight
curl http://127.0.0.1:8888/qwen/preflight
```

`/preflight` checks whether the ComfyUI Wan custom nodes are installed and whether the configured
Wan base, VACE, T5, and VAE model selectors resolve to available model files. It returns HTTP `503`
with details when the pod is not ready.

`/diagnostics` is the first endpoint to check when E2E is blocked. It reports Comfy reachability,
required node classes, configured Wan/Qwen model file paths, file existence, and both Wan and Qwen
preflight summaries in one response.

## Cost control

Do not start, stop, resize, or recreate pods without explicit user approval in the current conversation.
After E2E testing finishes or hits a blocker, stop the pod to avoid ongoing charges.
