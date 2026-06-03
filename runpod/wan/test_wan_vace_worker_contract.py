#!/usr/bin/env python3
"""Local contract checks for the Wan VACE worker graph.

These tests do not need ComfyUI or a GPU. They patch a minimal Comfy
object_info response and assert that the worker builds the expected
source video + mask video + reference image Wan VACE graph.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType


def load_worker() -> ModuleType:
  path = Path(__file__).with_name("wan_vace_worker.py")
  spec = importlib.util.spec_from_file_location("wan_vace_worker_under_test", path)
  if spec is None or spec.loader is None:
    raise RuntimeError(f"Unable to load {path}")
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  return module


def fake_object_info() -> dict[str, object]:
  def node_info(required: dict[str, object] | None = None) -> dict[str, object]:
    return {"input": {"required": required or {}, "optional": {}}}

  return {
    "VHS_LoadVideo": node_info(),
    "LoadImage": node_info(),
    "ImageToMask": node_info(),
    "InvertMask": node_info(),
    "WanVideoVACEModelSelect": node_info({
      "vace_model": [["WanVideo\\Wan2_1-VACE_module_1_3B_bf16.safetensors"], {}],
    }),
    "WanVideoModelLoader": node_info({
      "model": [["WanVideo\\Wan2_1-T2V-1_3B_bf16.safetensors"], {}],
    }),
    "LoadWanVideoT5TextEncoder": node_info({
      "model_name": [["umt5-xxl-enc-bf16.safetensors"], {}],
    }),
    "WanVideoVAELoader": node_info({
      "model_name": [["wanvideo\\Wan2_1_VAE_bf16.safetensors"], {}],
    }),
    "WanVideoTextEncode": node_info(),
    "WanVideoVACEEncode": node_info(),
    "WanVideoSampler": node_info(),
    "WanVideoDecode": node_info(),
    "VHS_VideoCombine": node_info(),
  }


def build_prompt(params: dict[str, object]) -> dict[str, object]:
  worker = load_worker()
  worker.get_object_info = fake_object_info
  return worker.build_prompt(
    params,
    {
      "source_video": "source.mp4",
      "mask_video": "mask.mp4",
      "ref_image": "ref.png",
    },
  )


def test_false_string_does_not_invert_mask() -> None:
  prompt = build_prompt({"invert_mask": "false"})
  assert "5" not in prompt
  assert prompt["15"]["inputs"]["input_masks"] == ["4", 0]


def test_true_string_inverts_mask() -> None:
  prompt = build_prompt({"invert_mask": "true"})
  assert prompt["5"]["class_type"] == "InvertMask"
  assert prompt["15"]["inputs"]["input_masks"] == ["5", 0]


def test_vace_inputs_are_source_mask_and_reference() -> None:
  prompt = build_prompt({"num_frames": 24, "fps": 24})
  assert prompt["1"]["class_type"] == "VHS_LoadVideo"
  assert prompt["1"]["inputs"]["video"] == "source.mp4"
  assert prompt["2"]["class_type"] == "VHS_LoadVideo"
  assert prompt["2"]["inputs"]["video"] == "mask.mp4"
  assert prompt["3"]["class_type"] == "LoadImage"
  assert prompt["3"]["inputs"]["image"] == "ref.png"
  assert prompt["15"]["class_type"] == "WanVideoVACEEncode"
  assert prompt["15"]["inputs"]["input_frames"] == ["1", 0]
  assert prompt["15"]["inputs"]["ref_images"] == ["3", 0]
  assert prompt["18"]["class_type"] == "VHS_VideoCombine"


def test_vace_strength_respects_zero_and_timing_controls() -> None:
  prompt = build_prompt({
    "vace_strength": 0,
    "vace_start_percent": 0.25,
    "vace_end_percent": 0.75,
  })
  vace_inputs = prompt["15"]["inputs"]
  assert vace_inputs["strength"] == 0
  assert vace_inputs["vace_start_percent"] == 0.25
  assert vace_inputs["vace_end_percent"] == 0.75


if __name__ == "__main__":
  test_false_string_does_not_invert_mask()
  test_true_string_inverts_mask()
  test_vace_inputs_are_source_mask_and_reference()
  test_vace_strength_respects_zero_and_timing_controls()
  print("wan_vace_worker contract tests ok")
