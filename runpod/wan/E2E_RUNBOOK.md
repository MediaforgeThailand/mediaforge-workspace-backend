# MediaForge VFX E2E Runbook

Goal: verify the product flow end to end:

1. Source green-screen MP4
2. VFX Mask node creates a synced black/white mask video
3. Qwen Reference Image node generates a warehouse reference from the first frame and mask image
4. Wan VACE node receives source video + mask video + Qwen reference image
5. Final output is MP4 with original motion preserved and green-screen background replaced

## 1. Pod access

Copy the SSH command from the RunPod Pod **Connect** tab. Use the full username shown by RunPod.

Basic SSH example:

```powershell
cd C:\Users\taksi\Documents\GitHub2\mediaforge-workspace-backend
.\runpod\wan\deploy_wan_vace_worker.ps1 `
  -SshUserHost "<runpod-user>@ssh.runpod.io" `
  -IdentityFile "$HOME\.ssh\id_runpod_mediaforge" `
  -Install `
  -StartServices
```

Full SSH example:

```powershell
.\runpod\wan\deploy_wan_vace_worker.ps1 `
  -SshUserHost "root@<public-ip>" `
  -Port <external-ssh-port> `
  -IdentityFile "$HOME\.ssh\id_runpod_mediaforge" `
  -Install `
  -StartServices
```

Use `-LightInstall` instead of `-Install` only when ComfyUI already exists on `/workspace/ComfyUI`
and only Wan/Qwen dependencies need refresh.

## 2. Runtime gates

The pod must pass all gates before MediaForge sends a paid/job request:

```bash
curl http://127.0.0.1:8888/health
curl http://127.0.0.1:8888/diagnostics
curl http://127.0.0.1:8888/preflight
curl http://127.0.0.1:8888/qwen/preflight
```

External URL should match the running pod id:

```text
https://<pod-id>-8888.proxy.runpod.net
```

If the external `/diagnostics` URL returns `404`, the worker is not running on port `8888`.

## 3. Supabase secrets

Only after `/diagnostics`, `/preflight`, and `/qwen/preflight` pass:

```powershell
npx supabase secrets set `
  RUNPOD_WAN_WORKER_URL="https://<pod-id>-8888.proxy.runpod.net" `
  RUNPOD_QWEN_ENDPOINT_URL="https://<pod-id>-8888.proxy.runpod.net/qwen" `
  --project-ref fymncypboeubdikpbmqc
```

Redeploy `workspace-run-node` only if the function code changed after the last deploy.

## 4. Workspace test flow

In the workspace canvas:

1. Add or use **VFX Full Setup**.
2. Connect the uploaded source MP4 into **Source Clip + Sync**.
3. Run **Source Clip + Sync**.
4. Run **Trim / Extract Frame**.
5. Run **Video Matte** with `Mask Mode = Auto Green Screen Key`.
   - Expected: `mask_video` and `mask_image` outputs.
   - For auto green-screen, white should mean the background area to edit.
6. Run **Reference Plate**.
   - Expected: Qwen generates a warehouse reference image from the start frame.
7. Run **Wan VACE Final Edit**.
   - Expected inputs: source MP4, mask MP4, Qwen reference image.
   - Expected output: MP4, not PNG.

## 5. Audit expectations

Do not consider the E2E complete unless all are true:

- Final result is an MP4.
- The actor/person motion follows the original source clip.
- The green-screen area is replaced with a warehouse-style scene.
- The person is not replaced by a new generated duplicate.
- The mask polarity is correct:
  - `white_edits` when white is the area to regenerate.
  - `black_edits` when black is the area to regenerate.
- The output plays from start to end without obvious chunk breaks.

## 6. Cost control

Do not start, stop, resize, or recreate RunPod resources without explicit approval in the current
conversation. Once E2E is done or cannot continue, ask for approval to stop the running pod.
