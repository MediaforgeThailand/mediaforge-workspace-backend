#!/usr/bin/env python3
"""Static contract checks for the Supabase RunPod Qwen helper.

The workspace VFX path uses a single RunPod pod worker:

  RUNPOD_WAN_WORKER_URL=https://<pod>-<worker-port>.proxy.runpod.net
  RUNPOD_QWEN_ENDPOINT_URL=https://<pod>-<worker-port>.proxy.runpod.net/qwen

That direct pod-proxy Qwen endpoint must not require RUNPOD_QWEN_API_KEY.
An API key is only needed for RunPod serverless URLs on api.runpod.ai.
"""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RUNPOD_QWEN_TS = ROOT / "supabase" / "functions" / "_shared" / "runpodQwen.ts"


def source() -> str:
  return RUNPOD_QWEN_TS.read_text(encoding="utf-8")


def test_direct_worker_auth_is_optional() -> None:
  src = source()
  assert 'new URL(rawUrl).hostname === "api.runpod.ai"' in src
  assert 'return { Authorization: `Bearer ${runpodApiKey()}` };' in src
  assert "const token = workerToken();" in src
  assert "return token ? { Authorization: `Bearer ${token}` } : {};" in src


def test_direct_worker_accepts_shared_tokens() -> None:
  src = source()
  assert 'Deno.env.get("RUNPOD_QWEN_WORKER_TOKEN")' in src
  assert 'Deno.env.get("RUNPOD_WAN_WORKER_TOKEN")' in src
  assert 'Deno.env.get("RUNPOD_WORKER_TOKEN")' in src


def test_submit_and_poll_use_endpoint_specific_auth() -> None:
  src = source()
  assert "...endpointAuthHeaders(base)" in src
  assert "headers: endpointAuthHeaders(url)" in src
  assert 'Authorization: `Bearer ${runpodApiKey()}`' not in src.split(
    "export async function executeRunpodQwen", 1
  )[1].split("export async function pollRunpodQwenOnce", 1)[0]


if __name__ == "__main__":
  test_direct_worker_auth_is_optional()
  test_direct_worker_accepts_shared_tokens()
  test_submit_and_poll_use_endpoint_specific_auth()
  print("runpod_qwen direct worker contract tests ok")
