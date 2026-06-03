#!/usr/bin/env python3
"""Runpod Pod worker for MediaForge Wan 2.1 VACE video edits.

Contract used by workspace backend:
  POST /run
  GET  /status/{job_id}
  GET  /outputs/{filename}

ComfyUI runs locally on port 8188. This wrapper builds the Comfy graph from
source video + mask video + reference image so the product does not invent a
separate compositing pipeline.
"""

from __future__ import annotations

import base64
import io
import json
import mimetypes
import os
import shutil
import subprocess
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib import error, parse, request

try:
  import qwen_worker  # type: ignore
except Exception:  # pragma: no cover - reported through /qwen/preflight
  qwen_worker = None  # type: ignore


COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
COMFY_DIR = Path(os.environ.get("COMFY_DIR", "/workspace/ComfyUI"))
COMFY_INPUT_DIR = Path(os.environ.get("COMFY_INPUT_DIR", str(COMFY_DIR / "input")))
OUTPUT_DIR = Path(os.environ.get("WAN_WORKER_OUTPUT_DIR", "/workspace/wan_vace_outputs"))
WORKER_TOKEN = os.environ.get("WAN_WORKER_TOKEN", "").strip()
HOST = os.environ.get("WAN_WORKER_HOST", "0.0.0.0")
PORT = int(os.environ.get("WAN_WORKER_PORT", "8888"))

WAN_BASE_MODEL = os.environ.get("WAN_BASE_MODEL", "WanVideo\\Wan2_1-T2V-1_3B_bf16.safetensors")
WAN_VACE_MODEL = os.environ.get("WAN_VACE_MODEL", "WanVideo\\Wan2_1-VACE_module_1_3B_bf16.safetensors")
WAN_T5_MODEL = os.environ.get("WAN_T5_MODEL", "umt5-xxl-enc-bf16.safetensors")
WAN_VAE_MODEL = os.environ.get("WAN_VAE_MODEL", "wanvideo\\Wan2_1_VAE_bf16.safetensors")
REQUIRED_WAN_CLASSES = (
  "VHS_LoadVideo",
  "LoadImage",
  "ImageToMask",
  "WanVideoVACEModelSelect",
  "WanVideoModelLoader",
  "LoadWanVideoT5TextEncoder",
  "WanVideoVAELoader",
  "WanVideoTextEncode",
  "WanVideoVACEEncode",
  "WanVideoSampler",
  "WanVideoDecode",
  "VHS_VideoCombine",
)

JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()
OBJECT_INFO: dict[str, Any] | None = None
OBJECT_INFO_LOCK = threading.Lock()


def set_job(job_id: str, **patch: Any) -> None:
  with JOBS_LOCK:
    row = JOBS.setdefault(job_id, {"id": job_id, "status": "queued"})
    row.update(patch)


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


def http_bytes(url: str, timeout: int = 180) -> tuple[bytes, str]:
  if url.startswith("data:"):
    header, encoded = url.split(",", 1)
    content_type = header.split(":", 1)[1].split(";", 1)[0]
    return base64.b64decode(encoded), content_type
  req = request.Request(url, headers={"User-Agent": "mediaforge-wan-vace-worker/1.0"})
  with request.urlopen(req, timeout=timeout) as res:
    return res.read(), res.headers.get_content_type() or "application/octet-stream"


def get_object_info(force_refresh: bool = False) -> dict[str, Any]:
  global OBJECT_INFO
  with OBJECT_INFO_LOCK:
    if force_refresh or OBJECT_INFO is None:
      OBJECT_INFO = http_json("GET", f"{COMFY_URL}/object_info", timeout=90)
    return OBJECT_INFO


def require_class(class_type: str) -> None:
  if class_type not in get_object_info():
    raise RuntimeError(f"ComfyUI node class is missing: {class_type}")


def input_specs(class_type: str) -> dict[str, Any]:
  info = get_object_info().get(class_type, {})
  merged: dict[str, Any] = {}
  for section in ("required", "optional"):
    values = info.get("input", {}).get(section, {})
    if isinstance(values, dict):
      merged.update(values)
  return merged


def spec_default(spec: Any) -> Any:
  if isinstance(spec, (list, tuple)) and spec:
    first = spec[0]
    meta = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
    if isinstance(first, list) and first:
      return first[0]
    if "default" in meta:
      return meta["default"]
    if first == "INT":
      return 0
    if first == "FLOAT":
      return 0.0
    if first == "BOOLEAN":
      return False
    if first == "STRING":
      return ""
  return None


def complete_inputs(class_type: str, inputs: dict[str, Any]) -> dict[str, Any]:
  complete = dict(inputs)
  required = get_object_info().get(class_type, {}).get("input", {}).get("required", {})
  if isinstance(required, dict):
    for key, spec in required.items():
      if key in complete:
        continue
      default = spec_default(spec)
      if default is not None:
        complete[key] = default
  return complete


def choice_value(class_type: str, preferred: str, field_candidates: list[str] | None = None) -> tuple[str, str]:
  specs = input_specs(class_type)
  preferred_tail = preferred.replace("\\", "/").split("/")[-1].lower()
  candidate_fields = field_candidates or list(specs.keys())

  def choices_for(field: str) -> list[str] | None:
    spec = specs.get(field)
    if isinstance(spec, (list, tuple)) and spec and isinstance(spec[0], list):
      return [str(v) for v in spec[0]]
    return None

  for field in candidate_fields:
    choices = choices_for(field)
    if not choices:
      continue
    if preferred in choices:
      return field, preferred
    for choice in choices:
      tail = choice.replace("\\", "/").split("/")[-1].lower()
      if tail == preferred_tail:
        return field, choice
    for choice in choices:
      if preferred_tail in choice.replace("\\", "/").lower():
        return field, choice

  for field, spec in specs.items():
    choices = choices_for(field)
    if not choices:
      continue
    for choice in choices:
      tail = choice.replace("\\", "/").split("/")[-1].lower()
      if tail == preferred_tail or preferred_tail in choice.replace("\\", "/").lower():
        return field, choice

  fallback_field = candidate_fields[0] if candidate_fields else "model"
  return fallback_field, preferred


def choice_report(class_type: str, preferred: str, field_candidates: list[str]) -> dict[str, Any]:
  field, selected = choice_value(class_type, preferred, field_candidates)
  specs = input_specs(class_type)
  choices: list[str] = []
  spec = specs.get(field)
  if isinstance(spec, (list, tuple)) and spec and isinstance(spec[0], list):
    choices = [str(v) for v in spec[0]]
  return {
    "class_type": class_type,
    "field": field,
    "requested": preferred,
    "selected": selected,
    "available": selected in choices if choices else None,
    "choices_count": len(choices),
  }


def preflight_report(force_refresh: bool = True) -> dict[str, Any]:
  info = get_object_info(force_refresh=force_refresh)
  missing_classes = [class_type for class_type in REQUIRED_WAN_CLASSES if class_type not in info]
  models = {
    "vace": choice_report("WanVideoVACEModelSelect", WAN_VACE_MODEL, ["vace_model", "model", "model_name"])
      if "WanVideoVACEModelSelect" in info else None,
    "base": choice_report("WanVideoModelLoader", WAN_BASE_MODEL, ["model", "model_name"])
      if "WanVideoModelLoader" in info else None,
    "t5": choice_report("LoadWanVideoT5TextEncoder", WAN_T5_MODEL, ["model_name", "t5_name", "text_encoder_name", "clip_name"])
      if "LoadWanVideoT5TextEncoder" in info else None,
    "vae": choice_report("WanVideoVAELoader", WAN_VAE_MODEL, ["model_name", "vae_name"])
      if "WanVideoVAELoader" in info else None,
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
    "missing_classes": missing_classes,
    "models": models,
  }


def model_file_status(base: str, configured_name: str) -> dict[str, Any]:
  rel = configured_name.replace("\\", "/").strip("/")
  path = COMFY_DIR / "models" / base / Path(rel)
  return {
    "configured": configured_name,
    "path": str(path),
    "exists": path.exists(),
    "size_bytes": path.stat().st_size if path.exists() else None,
  }


def qwen_model_file_status() -> dict[str, Any] | None:
  if qwen_worker is None:
    return None
  return {
    "image_unet": model_file_status("unet/gguf", str(qwen_worker.QWEN_IMAGE_UNET)),
    "image_clip": model_file_status("text_encoders", str(qwen_worker.QWEN_IMAGE_CLIP)),
    "image_vae": model_file_status("vae", str(qwen_worker.QWEN_IMAGE_VAE)),
    "image_lora": model_file_status("loras", str(qwen_worker.QWEN_IMAGE_LORA)),
    "edit_unet": model_file_status("unet/gguf", str(qwen_worker.QWEN_EDIT_UNET)),
    "edit_lora": model_file_status("loras", str(qwen_worker.QWEN_EDIT_LORA)),
  }


def runtime_diagnostics() -> dict[str, Any]:
  try:
    info = get_object_info()
    comfy_error = None
  except Exception as exc:
    info = {}
    comfy_error = str(exc)

  try:
    preflight = preflight_report() if info else None
  except Exception as exc:
    preflight = {"status": "not_ready", "error": str(exc)}

  qwen_preflight: dict[str, Any] | None = None
  if qwen_worker is not None:
    try:
      qwen_preflight = qwen_worker.preflight_report()
    except Exception as exc:
      qwen_preflight = {"status": "not_ready", "error": str(exc)}

  return {
    "status": "ok" if preflight and preflight.get("status") == "ok" else "not_ready",
    "worker": {
      "server_version": Handler.server_version,
      "host": HOST,
      "port": PORT,
      "comfy_url": COMFY_URL,
      "comfy_reachable": comfy_error is None,
      "comfy_error": comfy_error,
      "worker_token_enabled": bool(WORKER_TOKEN),
    },
    "paths": {
      "comfy_dir": {"path": str(COMFY_DIR), "exists": COMFY_DIR.exists()},
      "comfy_input_dir": {"path": str(COMFY_INPUT_DIR), "exists": COMFY_INPUT_DIR.exists()},
      "output_dir": {"path": str(OUTPUT_DIR), "exists": OUTPUT_DIR.exists()},
    },
    "node_classes": {
      class_type: class_type in info
      for class_type in REQUIRED_WAN_CLASSES
    },
    "model_files": {
      "wan_base": model_file_status("diffusion_models", WAN_BASE_MODEL),
      "wan_vace": model_file_status("diffusion_models", WAN_VACE_MODEL),
      "wan_t5": model_file_status("text_encoders", WAN_T5_MODEL),
      "wan_vae": model_file_status("vae", WAN_VAE_MODEL),
      "qwen": qwen_model_file_status(),
    },
    "preflight": preflight,
    "qwen": {
      "importable": qwen_worker is not None,
      "preflight": qwen_preflight,
    },
  }


def localize_media_file(source_url: str, prefix: str, fallback_ext: str) -> str:
  data, content_type = http_bytes(source_url)
  ext = mimetypes.guess_extension(content_type.split(";")[0]) or fallback_ext
  if ext == ".jpe":
    ext = ".jpg"
  filename = f"{prefix}_{uuid.uuid4().hex}{ext}"
  COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
  path = COMFY_INPUT_DIR / filename
  path.write_bytes(data)
  return filename


def node(class_type: str, inputs: dict[str, Any]) -> dict[str, Any]:
  require_class(class_type)
  return {"class_type": class_type, "inputs": complete_inputs(class_type, inputs)}


def queue_prompt(prompt: dict[str, Any]) -> str:
  payload = {"prompt": prompt, "client_id": f"mediaforge-wan-{uuid.uuid4().hex}"}
  response = http_json("POST", f"{COMFY_URL}/prompt", payload, timeout=60)
  prompt_id = response.get("prompt_id")
  if not prompt_id:
    raise RuntimeError(f"ComfyUI did not return prompt_id: {response}")
  return str(prompt_id)


def view_output(item: dict[str, Any]) -> tuple[bytes, str, str]:
  filename = str(item.get("filename") or "")
  subfolder = str(item.get("subfolder") or "")
  file_type = str(item.get("type") or "output")
  if not filename:
    raise RuntimeError(f"Output item missing filename: {item}")
  params = parse.urlencode({"filename": filename, "subfolder": subfolder, "type": file_type})
  data, content_type = http_bytes(f"{COMFY_URL}/view?{params}", timeout=240)
  ext = Path(filename).suffix or (".mp4" if content_type.startswith("video/") else ".png")
  return data, content_type, ext


def wait_for_prompt(prompt_id: str, timeout: int = 3600) -> tuple[bytes, str, str]:
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
        raise RuntimeError(json.dumps(status, ensure_ascii=True)[:2000])
      outputs = item.get("outputs", {})
      for output in outputs.values():
        if not isinstance(output, dict):
          continue
        for key in ("videos", "gifs", "animated", "images"):
          values = output.get(key)
          if isinstance(values, list) and values:
            return view_output(values[0])
    time.sleep(2)
  raise TimeoutError(f"ComfyUI prompt timed out: {json.dumps(last_payload, ensure_ascii=True)[:1000]}")


def int_param(params: dict[str, Any], key: str, fallback: int, minimum: int = 1, maximum: int = 10000) -> int:
  try:
    value = int(float(params.get(key, fallback)))
  except (TypeError, ValueError):
    value = fallback
  return max(minimum, min(maximum, value))


def bool_param(params: dict[str, Any], key: str, fallback: bool = False) -> bool:
  value = params.get(key, fallback)
  if isinstance(value, bool):
    return value
  if isinstance(value, (int, float)):
    return value != 0
  if isinstance(value, str):
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on", "enabled"}:
      return True
    if normalized in {"0", "false", "no", "off", "disabled", ""}:
      return False
  return fallback


def write_segment_file(job_id: str, index: int, data: bytes, ext: str) -> Path:
  OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
  suffix = ext if ext.startswith(".") else f".{ext}"
  if suffix.lower() not in (".mp4", ".webm", ".mov"):
    suffix = ".mp4"
  path = OUTPUT_DIR / f"{job_id}_chunk_{index:03d}{suffix}"
  path.write_bytes(data)
  return path


def ffmpeg_executable() -> str:
  found = shutil.which("ffmpeg")
  if found:
    return found
  try:
    import imageio_ffmpeg  # type: ignore

    return str(imageio_ffmpeg.get_ffmpeg_exe())
  except Exception as exc:
    raise RuntimeError("ffmpeg is required to stitch Wan VACE chunks. Install ffmpeg or imageio-ffmpeg.") from exc


def concat_video_segments(job_id: str, segment_paths: list[Path], fps: int, crf: int) -> Path:
  if not segment_paths:
    raise RuntimeError("No Wan VACE video segments were produced")
  OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
  if len(segment_paths) == 1:
    out_path = OUTPUT_DIR / f"{job_id}.mp4"
    if segment_paths[0] != out_path:
      shutil.copyfile(segment_paths[0], out_path)
    return out_path

  list_path = OUTPUT_DIR / f"{job_id}_concat.txt"
  list_path.write_text(
    "".join(f"file '{path.as_posix()}'\n" for path in segment_paths),
    encoding="utf-8",
  )
  out_path = OUTPUT_DIR / f"{job_id}.mp4"
  ffmpeg = ffmpeg_executable()
  copy_cmd = [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(list_path), "-c", "copy", str(out_path)]
  copy_result = subprocess.run(copy_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
  if copy_result.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0:
    return out_path

  encode_cmd = [
    ffmpeg,
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    str(list_path),
    "-r",
    str(fps),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    str(crf),
    str(out_path),
  ]
  encode_result = subprocess.run(encode_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
  if encode_result.returncode != 0 or not out_path.exists() or out_path.stat().st_size <= 0:
    raise RuntimeError(
      "ffmpeg concat failed: "
      f"copy={copy_result.stderr[-1000:]} encode={encode_result.stderr[-1000:]}"
    )
  return out_path


def build_prompt(params: dict[str, Any], files: dict[str, str]) -> dict[str, Any]:
  for class_type in REQUIRED_WAN_CLASSES:
    require_class(class_type)

  width = int(params.get("width") or 832)
  height = int(params.get("height") or 480)
  num_frames = int(params.get("num_frames") or params.get("frame_load_cap") or 49)
  fps = int(params.get("fps") or params.get("force_rate") or 16)
  steps = int(params.get("steps") or 20)
  cfg = float(params.get("cfg") or 4)
  shift = float(params.get("shift") or 8)
  seed = int(params.get("seed") or int(time.time()) % 2147483647)
  skip_first_frames = int(params.get("skip_first_frames") or 0)
  select_every_nth = int(params.get("select_every_nth") or 1)
  crf = int(params.get("crf") or 19)
  prompt_text = str(params.get("prompt") or "").strip()
  negative_prompt = str(params.get("negative_prompt") or "bad quality, blurry, distorted, flicker").strip()
  mask_channel = str(params.get("mask_channel") or "red")
  invert_mask = bool_param(params, "invert_mask")

  vace_field, vace_model = choice_value("WanVideoVACEModelSelect", WAN_VACE_MODEL, ["vace_model", "model", "model_name"])
  base_field, base_model = choice_value("WanVideoModelLoader", WAN_BASE_MODEL, ["model", "model_name"])
  t5_field, t5_model = choice_value("LoadWanVideoT5TextEncoder", WAN_T5_MODEL, ["model_name", "t5_name", "text_encoder_name", "clip_name"])
  vae_field, vae_model = choice_value("WanVideoVAELoader", WAN_VAE_MODEL, ["model_name", "vae_name"])

  source_video = node("VHS_LoadVideo", {
    "video": files["source_video"],
    "force_rate": fps,
    "custom_width": width,
    "custom_height": height,
    "frame_load_cap": num_frames,
    "skip_first_frames": skip_first_frames,
    "select_every_nth": select_every_nth,
    "format": "AnimateDiff",
  })
  mask_video = node("VHS_LoadVideo", {
    "video": files["mask_video"],
    "force_rate": fps,
    "custom_width": width,
    "custom_height": height,
    "frame_load_cap": num_frames,
    "skip_first_frames": skip_first_frames,
    "select_every_nth": select_every_nth,
    "format": "AnimateDiff",
  })
  ref_image = node("LoadImage", {"image": files["ref_image"]})
  mask_node_id = "4"
  mask_to_mask = node("ImageToMask", {"image": ["2", 0], "channel": mask_channel})

  prompt: dict[str, Any] = {
    "1": source_video,
    "2": mask_video,
    "3": ref_image,
    "4": mask_to_mask,
  }
  if invert_mask:
    require_class("InvertMask")
    prompt["5"] = node("InvertMask", {"mask": ["4", 0]})
    mask_node_id = "5"

  prompt.update({
    "10": node("WanVideoVACEModelSelect", {vace_field: vace_model}),
    "11": node("WanVideoModelLoader", {
      base_field: base_model,
      "extra_model": ["10", 0],
      "base_precision": "fp16",
      "quantization": "disabled",
      "load_device": "offload_device",
      "attention_mode": "sdpa",
    }),
    "12": node("LoadWanVideoT5TextEncoder", {
      t5_field: t5_model,
      "precision": "bf16",
      "load_device": "offload_device",
      "quantization": "disabled",
    }),
    "13": node("WanVideoVAELoader", {
      vae_field: vae_model,
      "precision": "bf16",
    }),
    "14": node("WanVideoTextEncode", {
      "t5": ["12", 0],
      "model_to_offload": ["11", 0],
      "positive_prompt": prompt_text,
      "negative_prompt": negative_prompt,
      "force_offload": True,
    }),
    "15": node("WanVideoVACEEncode", {
      "vae": ["13", 0],
      "input_frames": ["1", 0],
      "ref_images": ["3", 0],
      "input_masks": [mask_node_id, 0],
      "width": width,
      "height": height,
      "num_frames": num_frames,
      "strength": float(params.get("vace_strength") or 1),
      "vace_start_percent": float(params.get("vace_start_percent") or 0),
      "vace_end_percent": float(params.get("vace_end_percent") or 1),
      "tiled_vae": bool_param(params, "tiled_vae"),
    }),
    "16": node("WanVideoSampler", {
      "model": ["11", 0],
      "text_embeds": ["14", 0],
      "image_embeds": ["15", 0],
      "steps": steps,
      "cfg": cfg,
      "shift": shift,
      "seed": seed,
      "scheduler": str(params.get("scheduler") or "unipc"),
      "force_offload": True,
    }),
    "17": node("WanVideoDecode", {
      "vae": ["13", 0],
      "samples": ["16", 0],
      "enable_vae_tiling": False,
      "tile_x": 272,
      "tile_y": 272,
      "tile_stride_x": 144,
      "tile_stride_y": 128,
    }),
    "18": node("VHS_VideoCombine", {
      "images": ["17", 0],
      "frame_rate": fps,
      "loop_count": 0,
      "filename_prefix": str(params.get("output_prefix") or "mediaforge_wan_vace"),
      "format": "video/h264-mp4",
      "pix_fmt": "yuv420p",
      "crf": crf,
      "save_metadata": False,
      "trim_to_audio": False,
      "pingpong": False,
      "save_output": True,
    }),
  })
  return prompt


def run_comfy_segment(
  job_id: str,
  input_payload: dict[str, Any],
  files: dict[str, str],
  index: int,
  offset_frames: int,
  num_frames: int,
) -> tuple[bytes, str, str]:
  base_skip = int_param(input_payload, "skip_first_frames", 0, minimum=0, maximum=100000)
  segment_payload = dict(input_payload)
  segment_payload["skip_first_frames"] = base_skip + offset_frames
  segment_payload["frame_load_cap"] = num_frames
  segment_payload["num_frames"] = num_frames
  prompt = build_prompt(segment_payload, files)
  comfy_prompt_id = queue_prompt(prompt)
  set_job(
    job_id,
    comfy_prompt_id=comfy_prompt_id,
    status="processing",
    segment=index + 1,
    segment_skip_frames=base_skip + offset_frames,
    segment_num_frames=num_frames,
  )
  return wait_for_prompt(comfy_prompt_id, timeout=int(input_payload.get("timeout_seconds") or 3600))


def run_job(job_id: str, input_payload: dict[str, Any]) -> None:
  try:
    set_job(job_id, status="running", started_at=time.time())
    files = {
      "source_video": localize_media_file(str(input_payload["source_video_url"]), f"{job_id}_source", ".mp4"),
      "mask_video": localize_media_file(str(input_payload["mask_video_url"]), f"{job_id}_mask", ".mp4"),
      "ref_image": localize_media_file(str(input_payload["ref_image_url"]), f"{job_id}_ref", ".png"),
    }
    total_frames = int_param(
      input_payload,
      "total_frames",
      int_param(input_payload, "frame_load_cap", int_param(input_payload, "num_frames", 49, maximum=10000), maximum=10000),
      maximum=10000,
    )
    chunk_frames = int_param(input_payload, "chunk_frames", total_frames, maximum=total_frames)
    chunk_frames = max(1, min(chunk_frames, total_frames))
    fps = int_param(input_payload, "fps", int_param(input_payload, "force_rate", 16, maximum=60), maximum=60)
    crf = int_param(input_payload, "crf", 19, minimum=10, maximum=35)

    segment_paths: list[Path] = []
    offset = 0
    index = 0
    while offset < total_frames:
      count = min(chunk_frames, total_frames - offset)
      data, content_type, ext = run_comfy_segment(job_id, input_payload, files, index, offset, count)
      if content_type.startswith("image/"):
        raise RuntimeError("Wan VACE returned an image segment instead of a video. Check the Comfy graph output node.")
      segment_paths.append(write_segment_file(job_id, index, data, ext))
      offset += count
      index += 1

    out_path = concat_video_segments(job_id, segment_paths, fps=fps, crf=crf)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    set_job(
      job_id,
      status="COMPLETED",
      completed_at=time.time(),
      output={
        "video_url": f"/outputs/{out_path.name}",
        "content_type": "video/mp4",
        "segments": len(segment_paths),
        "total_frames": total_frames,
        "chunk_frames": chunk_frames,
      },
    )
  except Exception as exc:
    set_job(
      job_id,
      status="FAILED",
      error=str(exc),
      traceback=traceback.format_exc(),
      completed_at=time.time(),
    )


class Handler(BaseHTTPRequestHandler):
  server_version = "MediaForgeWanVaceWorker/1.0"

  def _send_json(self, payload: Any, status: int = 200) -> None:
    raw = json.dumps(payload).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "application/json")
    self.send_header("Content-Length", str(len(raw)))
    self.end_headers()
    self.wfile.write(raw)

  def _unauthorized(self) -> bool:
    if not WORKER_TOKEN:
      return False
    auth = self.headers.get("Authorization", "")
    if auth == f"Bearer {WORKER_TOKEN}":
      return False
    self._send_json({"error": "unauthorized"}, status=401)
    return True

  def do_GET(self) -> None:  # noqa: N802
    if self.path == "/health":
      self._send_json({"status": "ok"})
      return
    if self.path == "/diagnostics":
      if self._unauthorized():
        return
      try:
        report = runtime_diagnostics()
        self._send_json(report, status=200 if report.get("status") == "ok" else 503)
      except Exception as exc:
        self._send_json(
          {
            "status": "not_ready",
            "error": str(exc),
            "traceback": traceback.format_exc(),
            "comfy_url": COMFY_URL,
            "worker_port": PORT,
          },
          status=503,
        )
      return
    if self.path == "/qwen/health":
      if qwen_worker is None:
        self._send_json({"status": "not_ready", "error": "qwen_worker.py is not importable"}, status=503)
        return
      try:
        info = qwen_worker.get_object_info()
        self._send_json(
          {
            "status": "ok",
            "comfy_url": qwen_worker.COMFY_URL,
            "nodes": {
              "UNETLoader": "UNETLoader" in info,
              "LoaderGGUF": "LoaderGGUF" in info,
              "UnetLoaderGGUF": "UnetLoaderGGUF" in info,
              "TextEncodeQwenImageEditPlus": "TextEncodeQwenImageEditPlus" in info,
            },
          }
        )
      except Exception as exc:
        self._send_json({"status": "error", "error": str(exc)}, status=503)
      return
    if self.path == "/qwen/preflight":
      if self._unauthorized():
        return
      if qwen_worker is None:
        self._send_json({"status": "not_ready", "error": "qwen_worker.py is not importable"}, status=503)
        return
      try:
        report = qwen_worker.preflight_report()
        self._send_json(report, status=200 if report.get("status") == "ok" else 503)
      except Exception as exc:
        self._send_json(
          {
            "status": "not_ready",
            "error": str(exc),
            "traceback": traceback.format_exc(),
            "comfy_url": COMFY_URL,
            "worker_port": PORT,
          },
          status=503,
        )
      return
    if self.path.startswith("/qwen/status/"):
      if self._unauthorized():
        return
      if qwen_worker is None:
        self._send_json({"status": "NOT_FOUND", "error": "qwen_worker.py is not importable"}, status=503)
        return
      job_id = parse.unquote(self.path.split("/qwen/status/", 1)[1]).strip("/")
      row = dict(qwen_worker.JOBS.get(job_id) or {})
      if not row:
        self._send_json({"status": "NOT_FOUND", "id": job_id}, status=404)
        return
      self._send_json(row)
      return
    if self.path == "/preflight":
      if self._unauthorized():
        return
      try:
        report = preflight_report()
        self._send_json(report, status=200 if report.get("status") == "ok" else 503)
      except Exception as exc:
        self._send_json(
          {
            "status": "not_ready",
            "error": str(exc),
            "traceback": traceback.format_exc(),
            "comfy_url": COMFY_URL,
            "worker_port": PORT,
          },
          status=503,
        )
      return
    if self.path.startswith("/outputs/"):
      if self._unauthorized():
        return
      filename = Path(parse.unquote(self.path.split("/outputs/", 1)[1])).name
      path = OUTPUT_DIR / filename
      if not path.exists():
        self._send_json({"error": "not_found"}, status=404)
        return
      content_type = mimetypes.guess_type(str(path))[0] or "video/mp4"
      self.send_response(200)
      self.send_header("Content-Type", content_type)
      self.send_header("Content-Length", str(path.stat().st_size))
      self.end_headers()
      with path.open("rb") as fh:
        shutil.copyfileobj(fh, self.wfile)
      return
    if self.path.startswith("/status/"):
      if self._unauthorized():
        return
      job_id = parse.unquote(self.path.rsplit("/", 1)[-1])
      with JOBS_LOCK:
        row = dict(JOBS.get(job_id) or {})
      if not row:
        self._send_json({"status": "NOT_FOUND", "id": job_id}, status=404)
        return
      self._send_json(row)
      return
    self._send_json({"error": "not_found"}, status=404)

  def do_POST(self) -> None:  # noqa: N802
    if self._unauthorized():
      return
    if self.path == "/qwen/run":
      if qwen_worker is None:
        self._send_json({"error": "qwen_worker.py is not importable"}, status=503)
        return
      length = int(self.headers.get("Content-Length") or "0")
      try:
        payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        input_payload = payload.get("input") if isinstance(payload, dict) else None
        if not isinstance(input_payload, dict):
          raise ValueError("Body must be { input: {...} }")
        job_id = uuid.uuid4().hex
        qwen_worker.JOBS[job_id] = {"id": job_id, "status": "IN_QUEUE", "created_at": time.time()}
        thread = threading.Thread(target=qwen_worker.run_job, args=(job_id, input_payload), daemon=True)
        thread.start()
        self._send_json({"id": job_id, "status": "IN_QUEUE"}, status=202)
      except Exception as exc:
        self._send_json({"error": str(exc)}, status=400)
      return
    if self.path != "/run":
      self._send_json({"error": "not_found"}, status=404)
      return
    length = int(self.headers.get("Content-Length") or "0")
    try:
      payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
      input_payload = payload.get("input") if isinstance(payload, dict) else None
      if not isinstance(input_payload, dict):
        raise ValueError("Body must be { input: {...} }")
      for key in ("source_video_url", "mask_video_url", "ref_image_url"):
        if not input_payload.get(key):
          raise ValueError(f"Missing required input: {key}")
      job_id = uuid.uuid4().hex
      set_job(job_id, status="queued", created_at=time.time(), input=input_payload)
      thread = threading.Thread(target=run_job, args=(job_id, input_payload), daemon=True)
      thread.start()
      self._send_json({"id": job_id, "status": "IN_QUEUE"})
    except Exception as exc:
      self._send_json({"error": str(exc)}, status=400)


def main() -> None:
  OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
  COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
  server = ThreadingHTTPServer((HOST, PORT), Handler)
  print(f"Wan VACE worker listening on {HOST}:{PORT}; ComfyUI={COMFY_URL}", flush=True)
  server.serve_forever()


if __name__ == "__main__":
  main()
