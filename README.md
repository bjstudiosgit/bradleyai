# ComfyUI Hackotron

A focused front end and API for running the `BJS Qwen rapid AIO` ComfyUI workflow.

## Setup

```bash
npm run install:all
```

## Development

Run the backend:

```bash
npm run dev:server
```

Run the frontend in another terminal:

```bash
npm run dev:client
```

- Frontend: http://127.0.0.1:5173
- Backend: http://127.0.0.1:4000

By default, the API connects to local ComfyUI at `http://127.0.0.1:8188`.
Put the workflow JSON at `server/workflows/BJS Qwen rapid AIO.json`. The backend can also run with its built-in node map, but the saved workflow file is preferred because it preserves your exact model and node settings.

## Hosted Setup

The deploy shape is:

```text
Internet
  -> Frontend on Vercel or Netlify
  -> Node API
  -> private ComfyUI
```

Host the frontend and API separately. The API should run somewhere that can reach ComfyUI, such as the same machine, a VPS on the same private network, or a tunnel/VPN endpoint.

Frontend environment:

```bash
VITE_API_BASE_URL=https://api.your-domain.com
# Optional, only if API_TOKEN is set on the API:
# VITE_API_TOKEN=change-me
```

API environment:

```bash
PORT=4000
HOST=0.0.0.0
COMFYUI_URL=http://127.0.0.1:8188
PUBLIC_FRONTEND_URL=https://your-frontend.vercel.app
FRONTEND_ORIGIN=https://your-frontend.vercel.app,https://your-domain.com,http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:8188,http://localhost:8188
# Optional:
# API_TOKEN=change-me
```

If the API runs on the same server as ComfyUI, keep `COMFYUI_URL=http://127.0.0.1:8188`. If ComfyUI is on another private host, set `COMFYUI_URL` to that private URL or tunnel URL.

Useful API routes:

- `GET /api/health` checks whether the API can reach ComfyUI.
- `GET /api/portal` returns workflow status.
- `POST /api/portal/generate/stream` runs the workflow and streams newline-delimited status events.
- `GET /api/portal/latest` returns the latest ComfyUI output images.
- `GET /api/portal/image?...` proxies private ComfyUI images back to the frontend.

Vercel is a good fit for the static frontend. For the API, prefer a long-running Node host for generation streaming because image workflows can exceed serverless time limits.

## What it does

- Connects to local ComfyUI.
- Uploads reference images into ComfyUI.
- Patches the positive prompt, optional negative prompt, size, sampler settings, and filename prefix into the workflow.
- Queues the workflow through `/prompt`, waits for `/history`, previews output images, and exposes a Save link.
- Optionally stores uploaded reference sets under `server/reference-library`.
