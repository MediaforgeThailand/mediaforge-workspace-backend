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
  -WorkerPort <worker-http-port> `
  -IdentityFile "$HOME\.ssh\id_runpod_mediaforge" `
  -Install `
  -StartServices
```

Use `-LightInstall` instead of `-Install` only when ComfyUI already exists on `/workspace/ComfyUI`
and only Wan/Qwen dependencies need refresh.

If SSH is blocked or the Basic SSH username is not available, use the RunPod **Web Terminal**.
The easiest path is a one-line bootstrap from the pushed repo. Set `WAN_WORKER_PORT` when the
pod exposes a worker HTTP port other than `8888`:

```bash
curl -fsSL https://raw.githubusercontent.com/MediaforgeThailand/mediaforge-workspace-backend/main/runpod/wan/bootstrap_web_terminal.sh | bash
curl -fsSL https://raw.githubusercontent.com/MediaforgeThailand/mediaforge-workspace-backend/main/runpod/wan/bootstrap_web_terminal.sh | WAN_WORKER_PORT=8000 bash
```

The bootstrap downloads the latest bundle from `main` by default so a replacement pod can be brought
up without editing the script. Pin a specific branch or commit only when intentionally testing one:

```bash
curl -fsSL https://raw.githubusercontent.com/MediaforgeThailand/mediaforge-workspace-backend/main/runpod/wan/bootstrap_web_terminal.sh | MEDIAFORGE_BACKEND_REF=main bash
```

By default it downloads and runs the self-contained bundle from:

```text
https://raw.githubusercontent.com/MediaforgeThailand/mediaforge-workspace-backend/main/runpod/wan/dist/mediaforge_wan_vace_web_terminal_bundle.sh
```

If raw GitHub download is blocked, generate the self-contained Web Terminal bundle locally:

```powershell
cd C:\Users\taksi\Documents\GitHub2\mediaforge-workspace-backend
.\runpod\wan\create_web_terminal_bundle.ps1
```

Then open the RunPod Pod **Connect** tab, start **Web Terminal**, upload or paste:

```text
runpod/wan/dist/mediaforge_wan_vace_web_terminal_bundle.sh
```

Run it inside the pod:

```bash
bash mediaforge_wan_vace_web_terminal_bundle.sh
```

The bundle auto-selects full install when `/workspace/ComfyUI/venv` does not exist and light install
when an existing ComfyUI venv is present. Override when needed:

```bash
MEDIAFORGE_INSTALL_MODE=full bash mediaforge_wan_vace_web_terminal_bundle.sh
MEDIAFORGE_INSTALL_MODE=light bash mediaforge_wan_vace_web_terminal_bundle.sh
MEDIAFORGE_INSTALL_MODE=none bash mediaforge_wan_vace_web_terminal_bundle.sh
```

## 2. Runtime gates

The pod must pass all gates before MediaForge sends a paid/job request:

```bash
curl http://127.0.0.1:<worker-port>/health
curl http://127.0.0.1:<worker-port>/diagnostics
curl http://127.0.0.1:<worker-port>/preflight
curl http://127.0.0.1:<worker-port>/qwen/preflight
```

External URL should match the running pod id:

```text
https://<pod-id>-<worker-port>.proxy.runpod.net
```

If the external `/diagnostics` URL returns `404`, the worker is not running on the port used in the URL.

## 3. Supabase secrets

Only after `/diagnostics`, `/preflight`, and `/qwen/preflight` pass:

```powershell
.\runpod\wan\check_vfx_worker_and_configure_supabase.ps1 `
  -PodId <pod-id> `
  -WorkerPort <worker-port> `
  -ProjectRef fymncypboeubdikpbmqc `
  -ConfigureSecrets
```

The helper refuses to set secrets while the worker is still returning 404/503.
Equivalent manual command:

```powershell
supabase secrets set `
  RUNPOD_WAN_WORKER_URL="https://<pod-id>-<worker-port>.proxy.runpod.net" `
  RUNPOD_QWEN_ENDPOINT_URL="https://<pod-id>-<worker-port>.proxy.runpod.net/qwen" `
  --project-ref fymncypboeubdikpbmqc
```

Use the global `supabase` CLI here. On this workstation `npx supabase` may use a separate cached CLI
that is not logged in.

Redeploy `workspace-run-node` only if the function code changed after the last deploy.

## 4. Workspace test flow

In the workspace canvas:

1. Add or use **VFX Full Setup**.
2. Connect the uploaded source MP4 into **Source Clip + Sync**.
3. Run **Source Clip + Sync**.
4. Run **Trim / Extract Frame**.
5. Run **Video Matte** with `Mask Mode = Auto Green Screen Key`.
   - Expected: `mask_video` and `mask_image` outputs.
   - If the matte is white subject/person on black background, enable **Invert Mask** before Wan.
   - If the matte is already white background/edit area on black subject, leave **Invert Mask** off.
6. Run **Reference Plate**.
   - Expected: Qwen generates a warehouse reference image from the start frame.
7. Run **Wan VACE Final Edit**.
   - Expected inputs: source MP4, mask MP4, Qwen reference image.
   - Expected output: MP4, not PNG.
   - First safe 16GB test profile: `width=384`, `height=224`, `total_frames=5`, `chunk_frames=5`,
     `steps=8`, `cfg=4-5`, `invert_mask=true` for white-subject masks.
   - `vace_strength` is the main tradeoff: lower values change the background more, higher values
     preserve the source plate more.

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
- If the output is technically MP4 but still mostly green, the graph ran but `vace_strength`/mask
  polarity is still preserving the green plate too strongly.

## 6. Cost control

Do not start, stop, resize, or recreate RunPod resources without explicit approval in the current
conversation. When the user has already approved this E2E run, stop the running pod immediately
after E2E is done or cannot continue.
