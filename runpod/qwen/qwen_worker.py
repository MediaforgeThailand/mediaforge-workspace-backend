#!/usr/bin/env python3
"""Small Runpod Pod worker that wraps ComfyUI Qwen workflows.

The Workspace backend talks to this service through:
  POST /run
  GET  /status/{job_id}

ComfyUI itself runs locally on port 8188. This wrapper keeps MediaForge's
backend contract simple and lets us swap the internal Comfy graph later.
"""

from __future__ import annotations

import base64
import io
import json
import mimetypes
import os
import random
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib import error, parse, request

from PIL import Image, ImageFilter


COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
WORKER_TOKEN = os.environ.get("QWEN_WORKER_TOKEN", "").strip()
HOST = os.environ.get("QWEN_WORKER_HOST", "0.0.0.0")
PORT = int(os.environ.get("QWEN_WORKER_PORT", "8000"))

QWEN_IMAGE_UNET = os.environ.get("QWEN_IMAGE_UNET", "qwen-image-Q4_K_M.gguf")
QWEN_IMAGE_CLIP = os.environ.get("QWEN_IMAGE_CLIP", "qwen_2.5_vl_7b_fp8_scaled.safetensors")
QWEN_IMAGE_VAE = os.environ.get("QWEN_IMAGE_VAE", "qwen_image_vae.safetensors")
QWEN_IMAGE_LORA = os.environ.get("QWEN_IMAGE_LORA", "Qwen-Image-Lightning-8steps-V1.0.safetensors")
QWEN_EDIT_UNET = os.environ.get("QWEN_EDIT_UNET", "qwen-image-edit-2511-Q5_0.gguf")
QWEN_EDIT_LORA = os.environ.get("QWEN_EDIT_LORA", "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-fp32.safetensors")

REQUIRED_QWEN_CLASSES = (
    "CLIPLoader",
    "VAELoader",
    "KSampler",
    "VAEDecode",
    "SaveImage",
    "TextEncodeQwenImageEditPlus",
    "FluxKontextImageScale",
    "FluxKontextMultiReferenceLatentMethod",
    "VAEEncode",
    "ModelSamplingAuraFlow",
    "CFGNorm",
)

JOBS: dict[str, dict[str, Any]] = {}
OBJECT_INFO: dict[str, Any] | None = None
OBJECT_INFO_LOCK = threading.Lock()


def choose_unet_loader_class() -> str:
    """Support both ComfyUI-GGUF node names seen in community workflows."""
    info = get_object_info()
    if "LoaderGGUF" in info:
        return "LoaderGGUF"
    if "UnetLoaderGGUF" in info:
        return "UnetLoaderGGUF"
    return "UNETLoader"


def uses_gguf_loader(loader_class: str) -> bool:
    return loader_class in {"LoaderGGUF", "UnetLoaderGGUF"}


def flag_enabled(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on", "enabled"}


def http_json(method: str, url: str, payload: Any | None = None, timeout: int = 30) -> Any:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = request.Request(url, data=data, headers=headers, method=method)
    with request.urlopen(req, timeout=timeout) as res:
        raw = res.read()
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


def http_bytes(url: str, timeout: int = 90) -> tuple[bytes, str]:
    if url.startswith("data:image/"):
        header, encoded = url.split(",", 1)
        content_type = header.split(":", 1)[1].split(";", 1)[0]
        return base64.b64decode(encoded), content_type
    req = request.Request(url, headers={"User-Agent": "mediaforge-qwen-worker/1.0"})
    with request.urlopen(req, timeout=timeout) as res:
        return res.read(), res.headers.get_content_type() or "application/octet-stream"


def get_object_info(force_refresh: bool = False) -> dict[str, Any]:
    global OBJECT_INFO
    with OBJECT_INFO_LOCK:
        if force_refresh or OBJECT_INFO is None:
            OBJECT_INFO = http_json("GET", f"{COMFY_URL}/object_info", timeout=60)
        return OBJECT_INFO


def require_class(class_type: str) -> None:
    info = get_object_info()
    if class_type not in info:
        raise RuntimeError(f"ComfyUI node class is missing: {class_type}")


def model_choice(class_type: str, field: str, preferred: str) -> str:
    info = get_object_info().get(class_type, {})
    required = info.get("input", {}).get("required", {})
    choices = required.get(field, [None])[0]
    if not isinstance(choices, list):
        return preferred
    if preferred in choices:
        return preferred
    preferred_tail = preferred.replace("\\", "/").split("/")[-1].lower()
    for choice in choices:
        tail = str(choice).replace("\\", "/").split("/")[-1].lower()
        if tail == preferred_tail:
            return str(choice)
    for choice in choices:
        if preferred_tail in str(choice).replace("\\", "/").lower():
            return str(choice)
    raise RuntimeError(f"Model not found for {class_type}.{field}: {preferred}")


def model_choice_report(class_type: str, field: str, preferred: str) -> dict[str, Any]:
    info = get_object_info().get(class_type, {})
    required = info.get("input", {}).get("required", {})
    choices_raw = required.get(field, [None])[0]
    choices = [str(v) for v in choices_raw] if isinstance(choices_raw, list) else []
    try:
        selected = model_choice(class_type, field, preferred)
        error_msg = ""
    except Exception as exc:
        selected = preferred
        error_msg = str(exc)
    return {
        "class_type": class_type,
        "field": field,
        "requested": preferred,
        "selected": selected,
        "available": selected in choices if choices else None,
        "choices_count": len(choices),
        "error": error_msg or None,
    }


def preflight_report(force_refresh: bool = True) -> dict[str, Any]:
    info = get_object_info(force_refresh=force_refresh)
    loader_class = choose_unet_loader_class()
    missing_classes = [
        class_type
        for class_type in REQUIRED_QWEN_CLASSES
        if class_type not in info
    ]
    if loader_class not in info:
        missing_classes.append(loader_class)
    if "LoraLoaderModelOnly" not in info:
        missing_classes.append("LoraLoaderModelOnly")

    image_unet = QWEN_IMAGE_UNET if uses_gguf_loader(loader_class) else "qwen_image_fp8_e4m3fn.safetensors"
    edit_unet = QWEN_EDIT_UNET if uses_gguf_loader(loader_class) else "qwen_image_edit_2511_bf16.safetensors"
    models = {
        "image_unet": model_choice_report(loader_class, "unet_name", image_unet)
        if loader_class in info else None,
        "edit_unet": model_choice_report(loader_class, "unet_name", edit_unet)
        if loader_class in info else None,
        "clip": model_choice_report("CLIPLoader", "clip_name", QWEN_IMAGE_CLIP)
        if "CLIPLoader" in info else None,
        "vae": model_choice_report("VAELoader", "vae_name", QWEN_IMAGE_VAE)
        if "VAELoader" in info else None,
        "image_lora": model_choice_report("LoraLoaderModelOnly", "lora_name", QWEN_IMAGE_LORA)
        if "LoraLoaderModelOnly" in info else None,
        "edit_lora": model_choice_report("LoraLoaderModelOnly", "lora_name", QWEN_EDIT_LORA)
        if "LoraLoaderModelOnly" in info else None,
    }
    unavailable_models = [
        key
        for key, row in models.items()
        if isinstance(row, dict) and row.get("available") is False
    ]
    status = "ok" if not missing_classes and not unavailable_models else "not_ready"
    return {
        "status": status,
        "comfy_url": COMFY_URL,
        "worker_port": PORT,
        "loader_class": loader_class,
        "missing_classes": missing_classes,
        "models": models,
    }


def upload_to_comfy(source_url: str, prefix: str) -> str:
    image_bytes, content_type = http_bytes(source_url)
    ext = mimetypes.guess_extension(content_type.split(";")[0]) or ".png"
    filename = f"{prefix}_{uuid.uuid4().hex}{ext}"
    boundary = f"----mediaforge-{uuid.uuid4().hex}"
    body = io.BytesIO()

    def part(name: str, value: str) -> None:
        body.write(f"--{boundary}\r\n".encode())
        body.write(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        body.write(value.encode())
        body.write(b"\r\n")

    part("type", "input")
    part("overwrite", "true")
    body.write(f"--{boundary}\r\n".encode())
    body.write(
        f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'.encode()
    )
    body.write(f"Content-Type: {content_type}\r\n\r\n".encode())
    body.write(image_bytes)
    body.write(b"\r\n")
    body.write(f"--{boundary}--\r\n".encode())

    req = request.Request(
        f"{COMFY_URL}/upload/image",
        data=body.getvalue(),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with request.urlopen(req, timeout=120) as res:
        payload = json.loads(res.read().decode("utf-8"))
    return str(payload.get("name") or filename)


def queue_prompt(prompt: dict[str, Any]) -> str:
    payload = {"prompt": prompt, "client_id": f"mediaforge-{uuid.uuid4().hex}"}
    response = http_json("POST", f"{COMFY_URL}/prompt", payload, timeout=60)
    prompt_id = response.get("prompt_id")
    if not prompt_id:
        raise RuntimeError(f"ComfyUI did not return prompt_id: {response}")
    return str(prompt_id)


def wait_for_prompt(prompt_id: str, timeout: int = 1800) -> bytes:
    started = time.time()
    last_payload: Any = None
    while time.time() - started < timeout:
        try:
            history = http_json("GET", f"{COMFY_URL}/history/{parse.quote(prompt_id)}", timeout=60)
        except error.HTTPError as exc:
            if exc.code == 404:
                time.sleep(2)
                continue
            raise
        last_payload = history
        item = history.get(prompt_id)
        if item:
            status = item.get("status", {})
            if status.get("status_str") == "error":
                raise RuntimeError(json.dumps(status, ensure_ascii=True)[:1000])
            outputs = item.get("outputs", {})
            for output in outputs.values():
                images = output.get("images") if isinstance(output, dict) else None
                if not images:
                    continue
                image = images[0]
                params = parse.urlencode(
                    {
                        "filename": image.get("filename", ""),
                        "subfolder": image.get("subfolder", ""),
                        "type": image.get("type", "output"),
                    }
                )
                data, _ = http_bytes(f"{COMFY_URL}/view?{params}", timeout=120)
                return data
        time.sleep(2)
    raise TimeoutError(f"ComfyUI prompt timed out: {json.dumps(last_payload, ensure_ascii=True)[:1000]}")


def data_url_png(image_bytes: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(image_bytes).decode("ascii")


def composite_with_mask(
    edited_bytes: bytes,
    original_url: str,
    mask_url: str,
    expand: int,
    feather: int,
) -> bytes:
    original_bytes, _ = http_bytes(original_url)
    mask_bytes, _ = http_bytes(mask_url)
    original = Image.open(io.BytesIO(original_bytes)).convert("RGBA")
    edited = Image.open(io.BytesIO(edited_bytes)).convert("RGBA").resize(original.size, Image.Resampling.LANCZOS)
    mask = Image.open(io.BytesIO(mask_bytes)).convert("L").resize(original.size, Image.Resampling.NEAREST)
    if expand > 0:
        size = max(3, int(expand) * 2 + 1)
        if size % 2 == 0:
            size += 1
        mask = mask.filter(ImageFilter.MaxFilter(size))
    if feather > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(float(feather)))
    out = Image.composite(edited, original, mask)
    buffer = io.BytesIO()
    out.save(buffer, format="PNG")
    return buffer.getvalue()


def build_qwen_image_prompt(params: dict[str, Any]) -> dict[str, Any]:
    loader_class = choose_unet_loader_class()
    require_class("CLIPLoader")
    require_class("VAELoader")
    require_class("KSampler")
    preferred_unet = QWEN_IMAGE_UNET if uses_gguf_loader(loader_class) else "qwen_image_fp8_e4m3fn.safetensors"
    unet_name = model_choice(loader_class, "unet_name", preferred_unet)
    clip_name = model_choice("CLIPLoader", "clip_name", QWEN_IMAGE_CLIP)
    vae_name = model_choice("VAELoader", "vae_name", QWEN_IMAGE_VAE)

    prompt = str(params.get("prompt") or "").strip()
    negative = str(params.get("negative_prompt") or "").strip()
    width = int(params.get("width") or 1328)
    height = int(params.get("height") or 1328)
    seed = int(params.get("seed") or random.randint(0, 2**31 - 1))
    steps = int(params.get("steps") or 20)
    cfg = float(params.get("cfg") or 4)
    sampler = str(params.get("sampler_name") or "euler")
    scheduler = str(params.get("scheduler") or "simple")
    denoise = float(params.get("denoise") if params.get("denoise") is not None else 1)
    batch_size = int(params.get("batch_size") or 1)
    lightning = flag_enabled(params.get("lightning_lora"))
    if lightning:
        steps = min(steps, 8)
        cfg = min(cfg, 1.0)

    model_source: list[Any] = ["37", 0]
    unet_inputs: dict[str, Any] = {"unet_name": unet_name}
    if loader_class == "UNETLoader":
        unet_inputs["weight_dtype"] = "default"

    graph: dict[str, Any] = {
        "37": {"class_type": loader_class, "inputs": unet_inputs},
        "38": {"class_type": "CLIPLoader", "inputs": {"clip_name": clip_name, "type": "qwen_image", "device": "default"}},
        "39": {"class_type": "VAELoader", "inputs": {"vae_name": vae_name}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["38", 0], "text": prompt}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["38", 0], "text": negative}},
        "58": {"class_type": "EmptySD3LatentImage", "inputs": {"width": width, "height": height, "batch_size": batch_size}},
    }
    if lightning:
        lora_name = model_choice("LoraLoaderModelOnly", "lora_name", QWEN_IMAGE_LORA)
        graph["73"] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {"model": ["37", 0], "lora_name": lora_name, "strength_model": 1.0},
        }
        model_source = ["73", 0]
    graph.update(
        {
            "66": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": model_source, "shift": 3.1}},
            "3": {
                "class_type": "KSampler",
                "inputs": {
                    "model": ["66", 0],
                    "positive": ["6", 0],
                    "negative": ["7", 0],
                    "latent_image": ["58", 0],
                    "seed": seed,
                    "steps": steps,
                    "cfg": cfg,
                    "sampler_name": sampler,
                    "scheduler": scheduler,
                    "denoise": denoise,
                },
            },
            "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["39", 0]}},
            "60": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "MediaForge_Qwen_Image"}},
        }
    )
    return graph


def build_qwen_edit_prompt(params: dict[str, Any]) -> dict[str, Any]:
    require_class("TextEncodeQwenImageEditPlus")
    require_class("FluxKontextImageScale")
    require_class("FluxKontextMultiReferenceLatentMethod")
    require_class("KSampler")
    loader_class = choose_unet_loader_class()
    unet_field = "unet_name"
    preferred_unet = QWEN_EDIT_UNET if uses_gguf_loader(loader_class) else "qwen_image_edit_2511_bf16.safetensors"
    unet_name = model_choice(loader_class, unet_field, preferred_unet)
    clip_name = model_choice("CLIPLoader", "clip_name", QWEN_IMAGE_CLIP)
    vae_name = model_choice("VAELoader", "vae_name", QWEN_IMAGE_VAE)

    image_urls = [str(v) for v in params.get("image_urls") or [] if str(v).strip()]
    if not image_urls:
        raise RuntimeError("qwen_image_edit_2511 needs image_urls[0]")
    image1 = upload_to_comfy(image_urls[0], "qwen_ref1")
    image2 = upload_to_comfy(image_urls[1], "qwen_ref2") if len(image_urls) > 1 else None
    image3 = upload_to_comfy(image_urls[2], "qwen_ref3") if len(image_urls) > 2 else None

    prompt = str(params.get("prompt") or "").strip()
    negative_prompt = str(params.get("negative_prompt") or "").strip()
    seed = int(params.get("seed") or random.randint(0, 2**31 - 1))
    steps = int(params.get("steps") or 40)
    cfg = float(params.get("cfg") or 4)
    sampler = str(params.get("sampler_name") or "euler")
    scheduler = str(params.get("scheduler") or "simple")
    denoise = float(params.get("denoise") if params.get("denoise") is not None else 1)
    lightning = flag_enabled(params.get("lightning_lora"))
    if lightning:
        steps = min(steps, 4)
        cfg = min(cfg, 1.0)

    unet_inputs: dict[str, Any] = {unet_field: unet_name}
    if loader_class == "UNETLoader":
        unet_inputs["weight_dtype"] = "default"

    positive_inputs: dict[str, Any] = {
        "clip": ["162", 0],
        "vae": ["146", 0],
        "image1": ["160", 0],
        "prompt": prompt,
    }
    negative_inputs: dict[str, Any] = {
        "clip": ["162", 0],
        "vae": ["146", 0],
        "image1": ["160", 0],
        "prompt": negative_prompt,
    }
    if image2:
        positive_inputs["image2"] = ["83", 0]
        negative_inputs["image2"] = ["83", 0]
    if image3:
        positive_inputs["image3"] = ["84", 0]
        negative_inputs["image3"] = ["84", 0]

    model_source: list[Any] = ["152", 0]
    graph: dict[str, Any] = {
        "41": {"class_type": "LoadImage", "inputs": {"image": image1}},
        "161": {"class_type": loader_class, "inputs": unet_inputs},
        "162": {"class_type": "CLIPLoader", "inputs": {"clip_name": clip_name, "type": "qwen_image", "device": "default"}},
        "146": {"class_type": "VAELoader", "inputs": {"vae_name": vae_name}},
        "160": {"class_type": "FluxKontextImageScale", "inputs": {"image": ["41", 0]}},
        "151": {"class_type": "TextEncodeQwenImageEditPlus", "inputs": positive_inputs},
        "149": {"class_type": "TextEncodeQwenImageEditPlus", "inputs": negative_inputs},
        "148": {"class_type": "FluxKontextMultiReferenceLatentMethod", "inputs": {"conditioning": ["151", 0], "reference_latents_method": "index_timestep_zero"}},
        "147": {"class_type": "FluxKontextMultiReferenceLatentMethod", "inputs": {"conditioning": ["149", 0], "reference_latents_method": "index_timestep_zero"}},
        "145": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["161", 0], "shift": 3.1}},
        "152": {"class_type": "CFGNorm", "inputs": {"model": ["145", 0], "strength": 1}},
        "156": {"class_type": "VAEEncode", "inputs": {"pixels": ["160", 0], "vae": ["146", 0]}},
    }
    if image2:
        graph["83"] = {"class_type": "LoadImage", "inputs": {"image": image2}}
    if image3:
        graph["84"] = {"class_type": "LoadImage", "inputs": {"image": image3}}
    if lightning:
        lora_name = model_choice("LoraLoaderModelOnly", "lora_name", QWEN_EDIT_LORA)
        graph["153"] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {"model": ["152", 0], "lora_name": lora_name, "strength_model": 1.0},
        }
        model_source = ["153", 0]
    graph.update(
        {
            "169": {
                "class_type": "KSampler",
                "inputs": {
                    "model": model_source,
                    "positive": ["148", 0],
                    "negative": ["147", 0],
                    "latent_image": ["156", 0],
                    "seed": seed,
                    "steps": steps,
                    "cfg": cfg,
                    "sampler_name": sampler,
                    "scheduler": scheduler,
                    "denoise": denoise,
                },
            },
            "158": {"class_type": "VAEDecode", "inputs": {"samples": ["169", 0], "vae": ["146", 0]}},
            "60": {"class_type": "SaveImage", "inputs": {"images": ["158", 0], "filename_prefix": "MediaForge_Qwen_Edit"}},
        }
    )
    return graph


def run_job(job_id: str, input_payload: dict[str, Any]) -> None:
    try:
        JOBS[job_id].update({"status": "IN_PROGRESS", "updated_at": time.time()})
        workflow = str(input_payload.get("workflow") or "qwen_image").lower()
        if workflow == "qwen_image_edit_2511":
            graph = build_qwen_edit_prompt(input_payload)
        else:
            graph = build_qwen_image_prompt(input_payload)
        prompt_id = queue_prompt(graph)
        JOBS[job_id]["prompt_id"] = prompt_id
        image_bytes = wait_for_prompt(prompt_id)
        mask_url = str(input_payload.get("mask_image_url") or "").strip()
        image_urls = [str(v) for v in input_payload.get("image_urls") or [] if str(v).strip()]
        if (
            workflow == "qwen_image_edit_2511"
            and mask_url
            and image_urls
            and bool(input_payload.get("protect_original", True))
        ):
            image_bytes = composite_with_mask(
                image_bytes,
                image_urls[0],
                mask_url,
                int(input_payload.get("mask_expand") or 0),
                int(input_payload.get("mask_feather") or 0),
            )
        JOBS[job_id].update(
            {
                "status": "COMPLETED",
                "output": {"image_url": data_url_png(image_bytes)},
                "updated_at": time.time(),
            }
        )
    except Exception as exc:
        JOBS[job_id].update(
            {
                "status": "FAILED",
                "error": str(exc),
                "traceback": traceback.format_exc()[-4000:],
                "updated_at": time.time(),
            }
        )


class Handler(BaseHTTPRequestHandler):
    server_version = "MediaForgeQwenWorker/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", flush=True)

    def _auth_ok(self) -> bool:
        if not WORKER_TOKEN:
            return True
        return self.headers.get("Authorization", "") == f"Bearer {WORKER_TOKEN}"

    def _json(self, status: int, payload: Any) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        if self.path == "/health":
            try:
                info = get_object_info()
                self._json(
                    200,
                    {
                        "status": "ok",
                        "comfy_url": COMFY_URL,
                        "nodes": {
                            "UNETLoader": "UNETLoader" in info,
                            "LoaderGGUF": "LoaderGGUF" in info,
                            "UnetLoaderGGUF": "UnetLoaderGGUF" in info,
                            "TextEncodeQwenImageEditPlus": "TextEncodeQwenImageEditPlus" in info,
                        },
                    },
                )
            except Exception as exc:
                self._json(503, {"status": "error", "error": str(exc)})
            return
        if self.path == "/preflight":
            if not self._auth_ok():
                self._json(401, {"error": "unauthorized"})
                return
            try:
                report = preflight_report()
                self._json(200 if report.get("status") == "ok" else 503, report)
            except Exception as exc:
                self._json(
                    503,
                    {
                        "status": "not_ready",
                        "error": str(exc),
                        "traceback": traceback.format_exc(),
                        "comfy_url": COMFY_URL,
                        "worker_port": PORT,
                    },
                )
            return
        if self.path.startswith("/status/"):
            if not self._auth_ok():
                self._json(401, {"error": "unauthorized"})
                return
            job_id = parse.unquote(self.path.split("/status/", 1)[1]).strip("/")
            self._json(200, JOBS.get(job_id, {"id": job_id, "status": "NOT_FOUND"}))
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/run":
            self._json(404, {"error": "not found"})
            return
        if not self._auth_ok():
            self._json(401, {"error": "unauthorized"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        input_payload = payload.get("input") or payload
        if not isinstance(input_payload, dict):
            self._json(400, {"error": "input must be an object"})
            return
        job_id = uuid.uuid4().hex
        JOBS[job_id] = {"id": job_id, "status": "IN_QUEUE", "created_at": time.time()}
        thread = threading.Thread(target=run_job, args=(job_id, input_payload), daemon=True)
        thread.start()
        self._json(202, {"id": job_id, "status": "IN_QUEUE"})


def main() -> None:
    print(f"Starting Qwen worker on {HOST}:{PORT}, ComfyUI={COMFY_URL}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
