import cors from "cors";
import express from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

type UploadedImage = {
  slot: "image1" | "image2" | "image3";
  label?: string;
  filename: string;
  mimeType: string;
  dataUrl: string;
};

type GenerateRequest = {
  positivePrompt?: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  batchSize?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  samplerName?: string;
  scheduler?: string;
  denoise?: number;
  filenamePrefix?: string;
  saveReferences?: boolean;
  images?: UploadedImage[];
};

type ComfyImage = {
  filename: string;
  subfolder: string;
  type: string;
};

type ComfyOutputImage = ComfyImage & {
  nodeId: string;
  url: string;
  proxyUrl: string;
};

type ComfyHistoryItem = {
  outputs?: Record<string, { images?: ComfyImage[] }>;
  status?: {
    completed?: boolean;
    status_str?: string;
  };
};

type ReferenceSaveResult = {
  directory: string;
  files: string[];
};

type GenerateResult = {
  promptId: string;
  workflowSource: string;
  workflowWarning: string | null;
  references: ReferenceSaveResult | null;
  images: ComfyOutputImage[];
};

type RunEvent =
  | { type: "status"; message: string }
  | { type: "prompt"; promptId: string; message: string }
  | { type: "progress"; value: number; max: number; percent: number; nodeId?: string; message: string }
  | { type: "done"; result: GenerateResult }
  | { type: "error"; message: string };

type RunEventEmitter = (event: RunEvent) => void;

const app = express();
const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "127.0.0.1";
const publicFrontendUrl = process.env.PUBLIC_FRONTEND_URL ?? "http://127.0.0.1:5173";
const comfyUrl = (process.env.COMFYUI_URL ?? "http://127.0.0.1:8188").replace(/\/+$/, "");
const apiToken = process.env.API_TOKEN?.trim() ?? "";
const localDevOrigins = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:8188",
  "http://localhost:8188"
];
const allowedOrigins = Array.from(new Set([
  publicFrontendUrl,
  ...localDevOrigins,
  new URL(comfyUrl).origin,
  ...(process.env.FRONTEND_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean)
].map((origin) => origin.replace(/\/+$/, ""))));
const historyPollMs = 1500;
const historyTimeoutMs = 15 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.join(__dirname, "..");
const workspaceRoot = path.join(serverRoot, "..");
const defaultWorkflowFile = path.join(serverRoot, "workflows", "BJS Qwen rapid AIO.json");
const fallbackWorkflowFile = path.join(workspaceRoot, "BJS Qwen rapid AIO.json");
const referencesRoot = path.join(serverRoot, "reference-library");
const clientDist = path.join(workspaceRoot, "client", "dist");

const nodeIds = {
  positive: "3",
  negative: "4",
  sampler: "2",
  image1: "7",
  image2: "8",
  image3: "10",
  size: "9",
  save: "6"
} as const;


app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// 🚨 Critical: handle preflight explicitly
app.options("*", cors());

app.use(express.json({ limit: "80mb" }));

app.use("/api", (req, res, next) => {
  if (!apiToken) {
    next();
    return;
  }

  const bearerToken = req.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const headerToken = req.get("x-api-token")?.trim();

  if (bearerToken === apiToken || headerToken === apiToken) {
    next();
    return;
  }

  res.status(401).json({ error: "API token is required." });
});

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asObject(value: unknown, message: string): JsonObject {
  if (!isObject(value)) {
    throw new Error(message);
  }

  return value;
}

function asPromptNode(value: unknown): { class_type: string; inputs: JsonObject } | null {
  if (!isObject(value) || typeof value.class_type !== "string" || !isObject(value.inputs)) {
    return null;
  }

  return value as { class_type: string; inputs: JsonObject };
}

function isApiPrompt(value: unknown): value is Record<string, { class_type: string; inputs: JsonObject }> {
  if (!isObject(value)) {
    return false;
  }

  const entries = Object.values(value);
  return entries.length > 0 && entries.every((entry) => asPromptNode(entry) !== null);
}

function isGraphWorkflow(value: unknown): value is JsonObject {
  if (!isObject(value) || !Array.isArray(value.nodes) || value.nodes.length === 0) {
    return false;
  }

  return value.nodes.some((node) => isObject(node) && typeof node.type === "string");
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function workflowPath() {
  const override = process.env.WORKFLOW_PATH;

  if (override && await fileExists(override)) {
    return override;
  }

  if (await fileExists(defaultWorkflowFile)) {
    return defaultWorkflowFile;
  }

  if (await fileExists(fallbackWorkflowFile)) {
    return fallbackWorkflowFile;
  }

  return null;
}

async function workflowStatus() {
  const foundPath = await workflowPath();

  return {
    name: "BJS Qwen rapid AIO.json",
    modelName: await workflowModelName(),
    loaded: foundPath !== null,
    path: foundPath,
    expectedPath: defaultWorkflowFile
  };
}

async function workflowModelName() {
  try {
    const workflow = await loadWorkflowPrompt();
    return findModelName(workflow.prompt);
  } catch {
    return findModelName(builtInPrompt());
  }
}

function widgetValue(node: JsonObject, index: number) {
  const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : [];
  return widgets[index];
}

function graphToPrompt(workflow: JsonObject) {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes.filter(isObject) : [];
  const links = Array.isArray(workflow.links) ? workflow.links.filter(Array.isArray) : [];
  const linkMap = new Map<number, unknown[]>();

  for (const link of links) {
    const id = Number(link[0]);
    if (Number.isFinite(id)) {
      linkMap.set(id, link);
    }
  }

  const prompt: Record<string, { class_type: string; inputs: JsonObject }> = {};

  for (const node of nodes) {
    const id = String(node.id ?? "");
    const classType = String(node.type ?? "");

    if (!id || !classType) {
      continue;
    }

    const inputs: JsonObject = {};
    const nodeInputs = Array.isArray(node.inputs) ? node.inputs.filter(isObject) : [];

    for (const input of nodeInputs) {
      const inputName = String(input.name ?? "");
      const linkId = Number(input.link);
      const link = linkMap.get(linkId);

      if (inputName && link) {
        inputs[inputName] = [String(link[1]), Number(link[2])];
      }
    }

    if (/checkpoint/i.test(classType)) {
      inputs.ckpt_name = widgetValue(node, 0);
    } else if (/loadimage|reference image/i.test(classType) || id === nodeIds.image1 || id === nodeIds.image2 || id === nodeIds.image3) {
      inputs.image = widgetValue(node, 0);
    } else if (/textencodeqwenimageeditplus|qwen.*text.*encode/i.test(classType)) {
      inputs.prompt = widgetValue(node, 0) ?? "";
    } else if (/ksampler/i.test(classType)) {
      const widgetNames = ["seed", "control_after_generate", "steps", "cfg", "sampler_name", "scheduler", "denoise"];
      widgetNames.forEach((name, index) => {
        const value = widgetValue(node, index);
        if (value !== undefined) {
          inputs[name] = value;
        }
      });
    } else if (/latent|output size/i.test(classType) || id === nodeIds.size) {
      const widgetNames = ["width", "height", "batch_size"];
      widgetNames.forEach((name, index) => {
        const value = widgetValue(node, index);
        if (value !== undefined) {
          inputs[name] = value;
        }
      });
    } else if (/saveimage|save image/i.test(classType)) {
      inputs.filename_prefix = widgetValue(node, 0) ?? "QwenAIO";
    }

    prompt[id] = {
      class_type: classType,
      inputs
    };
  }

  if (!isApiPrompt(prompt)) {
    throw new Error("Workflow graph could not be converted to a ComfyUI API prompt.");
  }

  return prompt;
}

function findModelName(prompt: Record<string, { class_type: string; inputs: JsonObject }>) {
  for (const node of Object.values(prompt)) {
    const checkpoint = node.inputs.ckpt_name;

    if (typeof checkpoint === "string" && checkpoint.trim()) {
      return checkpoint;
    }
  }

  return "Qwen-Rapid-AIO";
}

function builtInPrompt() {
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: {
        ckpt_name: "Qwen-Rapid-AIO-NSFW-v23.safetensors"
      }
    },
    "2": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0],
        positive: ["3", 0],
        negative: ["4", 0],
        latent_image: ["9", 0],
        seed: 1,
        control_after_generate: "randomize",
        steps: 4,
        cfg: 1,
        sampler_name: "sa_solver",
        scheduler: "beta",
        denoise: 1
      }
    },
    "3": {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: {
        clip: ["1", 1],
        vae: ["1", 2],
        image1: ["7", 0],
        image2: ["8", 0],
        image3: ["10", 0],
        prompt: ""
      }
    },
    "4": {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: {
        clip: ["1", 1],
        vae: ["1", 2],
        image1: ["7", 0],
        image2: ["8", 0],
        image3: ["10", 0],
        prompt: ""
      }
    },
    "5": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["2", 0],
        vae: ["1", 2]
      }
    },
    "6": {
      class_type: "SaveImage",
      inputs: {
        images: ["5", 0],
        filename_prefix: "QwenAIO"
      }
    },
    "7": {
      class_type: "LoadImage",
      inputs: {
        image: ""
      }
    },
    "8": {
      class_type: "LoadImage",
      inputs: {
        image: ""
      }
    },
    "9": {
      class_type: "EmptySD3LatentImage",
      inputs: {
        width: 1280,
        height: 1280,
        batch_size: 1
      }
    },
    "10": {
      class_type: "LoadImage",
      inputs: {
        image: ""
      }
    }
  } satisfies Record<string, { class_type: string; inputs: JsonObject }>;
}

async function loadWorkflowPrompt() {
  const foundPath = await workflowPath();

  if (!foundPath) {
    return {
      prompt: builtInPrompt(),
      source: "built-in node map",
      warning: `Workflow JSON not found. Put BJS Qwen rapid AIO.json at ${defaultWorkflowFile} for exact node settings.`
    };
  }

  const workflow = JSON.parse(await fs.readFile(foundPath, "utf8")) as unknown;
  const root = asObject(workflow, "Workflow JSON must be an object.");

  if (isApiPrompt(root)) {
    return { prompt: structuredClone(root), source: foundPath, warning: null };
  }

  if (isApiPrompt(root.prompt)) {
    return { prompt: structuredClone(root.prompt), source: foundPath, warning: null };
  }

  if (isGraphWorkflow(root)) {
    return { prompt: graphToPrompt(root), source: foundPath, warning: null };
  }

  throw new Error("Workflow JSON is not a ComfyUI API prompt or a graph workflow.");
}

function setNodeInput(
  prompt: Record<string, { class_type: string; inputs: JsonObject }>,
  nodeId: string,
  inputName: string,
  value: unknown
) {
  const node = prompt[nodeId];

  if (!node) {
    throw new Error(`Workflow node ${nodeId} is missing.`);
  }

  node.inputs[inputName] = value;
}

function patchPrompt(
  prompt: Record<string, { class_type: string; inputs: JsonObject }>,
  body: Required<Pick<GenerateRequest, "positivePrompt" | "filenamePrefix">> & GenerateRequest,
  uploadedNames: Partial<Record<UploadedImage["slot"], string>>
) {
  setNodeInput(prompt, nodeIds.positive, "prompt", body.positivePrompt);
  setNodeInput(prompt, nodeIds.negative, "prompt", body.negativePrompt ?? "");
  setNodeInput(prompt, nodeIds.size, "width", body.width ?? 1280);
  setNodeInput(prompt, nodeIds.size, "height", body.height ?? 1280);
  setNodeInput(prompt, nodeIds.size, "batch_size", body.batchSize ?? 1);
  setNodeInput(prompt, nodeIds.save, "filename_prefix", body.filenamePrefix);

  if (body.steps !== undefined) {
    setNodeInput(prompt, nodeIds.sampler, "steps", body.steps);
  }

  if (body.cfg !== undefined) {
    setNodeInput(prompt, nodeIds.sampler, "cfg", body.cfg);
  }

  if (body.denoise !== undefined) {
    setNodeInput(prompt, nodeIds.sampler, "denoise", body.denoise);
  }

  if (body.samplerName) {
    setNodeInput(prompt, nodeIds.sampler, "sampler_name", body.samplerName);
  }

  if (body.scheduler) {
    setNodeInput(prompt, nodeIds.sampler, "scheduler", body.scheduler);
  }

  setNodeInput(
    prompt,
    nodeIds.sampler,
    "seed",
    body.seed && body.seed > 0 ? body.seed : Math.floor(Math.random() * 1_000_000_000_000_000)
  );

  const fallbackImage = uploadedNames.image1;

  for (const slot of ["image1", "image2", "image3"] satisfies UploadedImage["slot"][]) {
    const imageName = uploadedNames[slot] ?? fallbackImage;

    if (imageName) {
      setNodeInput(prompt, nodeIds[slot], "image", imageName);
    }
  }
}

function dataUrlToBuffer(dataUrl: string) {
  const match = /^data:([^;]+);base64,(.+)$/u.exec(dataUrl);

  if (!match) {
    throw new Error("Image data must be a base64 data URL.");
  }

  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64")
  };
}

function safeFilename(input: string) {
  return input.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "reference.png";
}

async function uploadImage(comfyUrl: string, image: UploadedImage) {
  const { buffer, mimeType } = dataUrlToBuffer(image.dataUrl);
  const form = new FormData();
  const filename = `${image.slot}-${Date.now()}-${safeFilename(image.filename)}`;

  form.append("image", new Blob([buffer], { type: image.mimeType || mimeType }), filename);
  form.append("type", "input");
  form.append("overwrite", "true");

  const response = await fetch(`${comfyUrl}/upload/image`, {
    method: "POST",
    body: form
  });

  if (!response.ok) {
    throw new Error(`ComfyUI image upload failed with HTTP ${response.status}.`);
  }

  const uploaded = await response.json() as { name?: string };
  if (!uploaded.name) {
    throw new Error("ComfyUI did not return an uploaded image name.");
  }

  return uploaded.name;
}

function formatComfyError(text: string) {
  if (!text) {
    return "";
  }

  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string };
      node_errors?: Record<string, {
        class_type?: string;
        errors?: Array<{
          message?: string;
          details?: string;
          extra_info?: {
            input_name?: string;
            received_value?: string;
          };
        }>;
      }>;
    };
    const lines: string[] = [];

    if (parsed.error?.message) {
      lines.push(parsed.error.message);
    }

    for (const [nodeId, nodeError] of Object.entries(parsed.node_errors ?? {})) {
      for (const error of nodeError.errors ?? []) {
        const received = error.extra_info?.received_value;
        const input = error.extra_info?.input_name;
        const detail = error.details || error.message || "Validation error";
        lines.push(
          `Node ${nodeId}${nodeError.class_type ? ` (${nodeError.class_type})` : ""}: ${detail}`
        );

        if (input && received) {
          lines.push(`Missing or invalid ${input}: ${received}`);
        }
      }
    }

    return lines.length > 0 ? lines.join("\n") : text;
  } catch {
    return text;
  }
}

function explainWorkflowFailure(message: string) {
  if (/ckpt_name|checkpoint|not in \(list/i.test(message)) {
    return `${message}\n\nLocal ComfyUI is missing the checkpoint/model required by this workflow. Install the model in your local ComfyUI setup.`;
  }

  if (/class_type|not found|does not exist|node/i.test(message)) {
    return `${message}\n\nLocal ComfyUI may be missing custom nodes required by this workflow.`;
  }

  return message;
}

async function saveReferenceSet(images: UploadedImage[]): Promise<ReferenceSaveResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = path.join(referencesRoot, stamp);
  await fs.mkdir(directory, { recursive: true });

  const saved: string[] = [];
  for (const image of images) {
    const { buffer } = dataUrlToBuffer(image.dataUrl);
    const filename = `${image.slot}-${safeFilename(image.filename)}`;
    const filePath = path.join(directory, filename);
    await fs.writeFile(filePath, buffer);
    saved.push(filePath);
  }

  return { directory, files: saved };
}

function comfySocketUrl(comfyUrl: string, clientId: string) {
  const url = new URL(comfyUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = new URLSearchParams({ clientId }).toString();
  return url.toString();
}

function parseComfySocketMessage(raw: string): RunEvent | null {
  const body = JSON.parse(raw) as unknown;

  if (!isObject(body) || typeof body.type !== "string") {
    return null;
  }

  const data = isObject(body.data) ? body.data : {};
  const nodeId = typeof data.node === "string" ? data.node : undefined;
  const promptId = typeof data.prompt_id === "string" ? data.prompt_id : undefined;

  if (body.type === "execution_start") {
    return { type: "status", message: "ComfyUI started executing the prompt" };
  }

  if (body.type === "execution_cached") {
    return { type: "status", message: "ComfyUI is using cached nodes" };
  }

  if (body.type === "executing") {
    if (data.node === null) {
      return { type: "status", message: "ComfyUI finished node execution" };
    }

    return { type: "status", message: nodeId ? `Executing node ${nodeId}` : "ComfyUI is executing" };
  }

  if (body.type === "executed") {
    return { type: "status", message: nodeId ? `Node ${nodeId} completed` : "A ComfyUI node completed" };
  }

  if (body.type === "progress") {
    const value = Number(data.value ?? 0);
    const max = Number(data.max ?? 0);

    if (Number.isFinite(value) && Number.isFinite(max) && max > 0) {
      const percent = Math.min(100, Math.max(0, Math.round((value / max) * 100)));
      return {
        type: "progress",
        value,
        max,
        percent,
        nodeId,
        message: `ComfyUI progress ${value}/${max}${nodeId ? ` on node ${nodeId}` : ""}`
      };
    }
  }

  if (body.type === "execution_error") {
    const exception = typeof data.exception_message === "string" ? data.exception_message : "ComfyUI reported an execution error.";
    return { type: "error", message: promptId ? `${exception} (prompt ${promptId})` : exception };
  }

  if (body.type === "execution_interrupted") {
    return { type: "error", message: "ComfyUI interrupted the prompt." };
  }

  return null;
}

function connectComfySocket(
  comfyUrl: string,
  clientId: string,
  emit: RunEventEmitter,
  onImages?: (images: ComfyOutputImage[]) => void
) {
  type RuntimeWebSocketEvent = { data?: unknown };
  type RuntimeWebSocket = {
    addEventListener: (event: string, listener: (event: RuntimeWebSocketEvent) => void) => void;
    close: () => void;
  };
  type RuntimeWebSocketConstructor = new (url: string) => RuntimeWebSocket;

  const WebSocketCtor = (globalThis as typeof globalThis & { WebSocket?: RuntimeWebSocketConstructor }).WebSocket;

  if (!WebSocketCtor) {
    emit({ type: "status", message: "Live ComfyUI feed unavailable; polling for completion" });
    return null;
  }

  try {
    const socket = new WebSocketCtor(comfySocketUrl(comfyUrl, clientId));
    socket.addEventListener("open", () => {
      emit({ type: "status", message: "Connected to ComfyUI live feed" });
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      try {
        const images = collectLiveImages(event.data);
        if (images.length > 0) {
          onImages?.(images);
          emit({ type: "status", message: `ComfyUI produced ${images.length} image${images.length === 1 ? "" : "s"}` });
        }

        const parsed = parseComfySocketMessage(event.data);
        if (parsed) {
          emit(parsed);
        }
      } catch {
        emit({ type: "status", message: "Received an unreadable ComfyUI live update" });
      }
    });
    socket.addEventListener("error", () => {
      emit({ type: "status", message: "ComfyUI live feed disconnected; polling for completion" });
    });

    return socket;
  } catch {
    emit({ type: "status", message: "Could not connect to ComfyUI live feed; polling for completion" });
    return null;
  }
}

async function queuePrompt(
  comfyUrl: string,
  prompt: Record<string, { class_type: string; inputs: JsonObject }>,
  clientId = crypto.randomUUID()
) {
  const response = await fetch(`${comfyUrl}/prompt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: clientId,
      prompt
    })
  });

  if (!response.ok) {
    const text = await response.text();
    const formatted = explainWorkflowFailure(formatComfyError(text));
    throw new Error(`ComfyUI queue failed with HTTP ${response.status}${formatted ? `:\n${formatted}` : ""}`);
  }

  const body = await response.json() as { prompt_id?: string };
  if (!body.prompt_id) {
    throw new Error("ComfyUI did not return a prompt_id.");
  }

  return body.prompt_id;
}

async function readHistory(comfyUrl: string, promptId: string) {
  const response = await fetch(`${comfyUrl}/history/${encodeURIComponent(promptId)}`);

  if (!response.ok) {
    throw new Error(`ComfyUI history failed with HTTP ${response.status}.`);
  }

  const body = await response.json() as Record<string, ComfyHistoryItem>;
  return body[promptId];
}

function collectImages(history: ComfyHistoryItem | undefined) {
  const outputImages: ComfyOutputImage[] = [];

  if (!history?.outputs) {
    return outputImages;
  }

  for (const [nodeId, output] of Object.entries(history.outputs)) {
    for (const image of output.images ?? []) {
      outputImages.push(outputImage(nodeId, image));
    }
  }

  return outputImages;
}

function outputImage(nodeId: string, image: ComfyImage): ComfyOutputImage {
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder ?? "",
    type: image.type ?? "output"
  });

  return {
    nodeId,
    filename: image.filename,
    subfolder: image.subfolder ?? "",
    type: image.type ?? "output",
    url: `/api/portal/image?${params.toString()}`,
    proxyUrl: `/api/portal/image?${params.toString()}`
  };
}

function collectLiveImages(raw: string): ComfyOutputImage[] {
  const body = JSON.parse(raw) as unknown;

  if (!isObject(body) || body.type !== "executed" || !isObject(body.data)) {
    return [];
  }

  const nodeId = String(body.data.node ?? "");
  const output = isObject(body.data.output) ? body.data.output : {};
  const images = Array.isArray(output.images) ? output.images : [];

  if (!nodeId || images.length === 0) {
    return [];
  }

  return images.flatMap((image) => {
    if (!isObject(image) || typeof image.filename !== "string") {
      return [];
    }

    return outputImage(nodeId, {
      filename: image.filename,
      subfolder: typeof image.subfolder === "string" ? image.subfolder : "",
      type: typeof image.type === "string" ? image.type : "output"
    });
  });
}

async function waitForOutputs(
  comfyUrl: string,
  promptId: string,
  emit?: RunEventEmitter,
  liveImages?: () => ComfyOutputImage[]
) {
  const start = Date.now();
  let completedAt: number | null = null;
  let lastHistory: ComfyHistoryItem | undefined;
  let lastWaitStatusAt = 0;

  while (Date.now() - start < historyTimeoutMs) {
    const capturedImages = liveImages?.() ?? [];

    if (capturedImages.length > 0) {
      emit?.({ type: "status", message: `ComfyUI returned ${capturedImages.length} image${capturedImages.length === 1 ? "" : "s"}` });
      return { history: lastHistory, images: capturedImages };
    }

    const elapsedSeconds = Math.round((Date.now() - start) / 1000);
    if (Date.now() - lastWaitStatusAt > 5_000) {
      lastWaitStatusAt = Date.now();
      emit?.({ type: "status", message: `Waiting for ComfyUI output (${elapsedSeconds}s)` });
    }

    const history = await readHistory(comfyUrl, promptId);
    lastHistory = history;
    const images = collectImages(history);

    if (images.length > 0) {
      emit?.({ type: "status", message: `ComfyUI returned ${images.length} image${images.length === 1 ? "" : "s"}` });
      return { history, images };
    }

    if (history?.status?.status_str === "error") {
      emit?.({ type: "error", message: "ComfyUI reported an error while running the prompt." });
      throw new Error("ComfyUI reported an error while running the prompt.");
    }

    if (history?.status?.completed) {
      completedAt ??= Date.now();
      emit?.({ type: "status", message: "ComfyUI marked the prompt complete" });

      if (Date.now() - completedAt > 10_000) {
        return { history, images };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, historyPollMs));
  }

  const images = collectImages(lastHistory);

  if (images.length > 0) {
    return { history: lastHistory, images };
  }

  throw new Error("Timed out waiting for ComfyUI output.");
}

function imageDtos(images: ComfyOutputImage[]): ComfyOutputImage[] {
  return images.map((image) => ({
    ...image,
    url: image.proxyUrl,
    proxyUrl: `/api/portal/image?${new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder,
      type: image.type
    }).toString()}`
  }));
}

async function runGeneration(body: GenerateRequest, emit: RunEventEmitter = () => undefined): Promise<GenerateResult> {
  const positivePrompt = String(body.positivePrompt ?? "").trim();
  const filenamePrefix = String(body.filenamePrefix ?? "QwenAIO").trim() || "QwenAIO";
  const images = Array.isArray(body.images) ? body.images : [];

  if (!positivePrompt) {
    throw new Error("Positive prompt is required.");
  }

  if (!images.some((image) => image.slot === "image1")) {
    throw new Error("Reference image 1 is required.");
  }

  emit({ type: "status", message: "Uploading references to ComfyUI" });
  const uploadedNames: Partial<Record<UploadedImage["slot"], string>> = {};

  for (const image of images) {
    emit({ type: "status", message: `Uploading ${image.label ?? image.slot}` });
    uploadedNames[image.slot] = await uploadImage(comfyUrl, image);
  }

  emit({ type: "status", message: "Preparing workflow" });
  const references = body.saveReferences ? await saveReferenceSet(images) : null;
  const workflow = await loadWorkflowPrompt();
  patchPrompt(workflow.prompt, { ...body, positivePrompt, filenamePrefix }, uploadedNames);

  const clientId = crypto.randomUUID();
  const liveOutputImages: ComfyOutputImage[] = [];
  const socket = connectComfySocket(comfyUrl, clientId, emit, (images) => {
    for (const image of images) {
      const key = `${image.nodeId}:${image.filename}:${image.subfolder}:${image.type}`;
      const exists = liveOutputImages.some((current) => (
        `${current.nodeId}:${current.filename}:${current.subfolder}:${current.type}` === key
      ));

      if (!exists) {
        liveOutputImages.push(image);
      }
    }
  });

  try {
    emit({ type: "status", message: "Queueing prompt in ComfyUI" });
    const promptId = await queuePrompt(comfyUrl, workflow.prompt, clientId);
    emit({ type: "prompt", promptId, message: `Queued ComfyUI prompt ${promptId}` });
    const result = await waitForOutputs(comfyUrl, promptId, emit, () => liveOutputImages);

    return {
      promptId,
      workflowSource: workflow.source,
      workflowWarning: workflow.warning,
      references,
      images: imageDtos(result.images)
    };
  } finally {
    socket?.close();
  }
}

app.get("/api/portal", async (_req, res) => {
  res.json({
    workflow: await workflowStatus()
  });
});

app.get("/api/health", async (_req, res) => {
  try {
    const response = await fetch(`${comfyUrl}/system_stats`, {
      signal: AbortSignal.timeout(5000)
    });

    res.status(response.ok ? 200 : 502).json({
      ok: response.ok,
      comfyReachable: response.ok,
      comfyStatus: response.status
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      comfyReachable: false,
      error: error instanceof Error ? error.message : "Could not reach ComfyUI."
    });
  }
});

app.post("/api/portal/generate", async (req, res, next) => {
  try {
    res.json(await runGeneration(req.body as GenerateRequest));
  } catch (error) {
    next(error);
  }
});

app.post("/api/portal/generate/stream", async (req, res) => {
  res.status(200);
res.setHeader("Access-Control-Allow-Origin", "*");
res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const emit: RunEventEmitter = (event) => {
    if (!res.writableEnded) {
      res.write(`${JSON.stringify(event)}\n`);
    }
  };

  try {
    const result = await runGeneration(req.body as GenerateRequest, emit);
    emit({ type: "done", result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation failed.";
    emit({ type: "error", message });
  } finally {
    res.end();
  }
});

app.get("/api/portal/latest", async (_req, res, next) => {
  try {
    const response = await fetch(`${comfyUrl}/history`);

    if (!response.ok) {
      throw new Error(`ComfyUI history failed with HTTP ${response.status}.`);
    }

    const body = await response.json() as Record<string, ComfyHistoryItem>;
    const entries = Object.entries(body).reverse();

    for (const [promptId, history] of entries) {
      const images = collectImages(history);

      if (images.length > 0) {
        return res.json({
          promptId,
          images: imageDtos(images)
        });
      }
    }

    return res.json({
      promptId: null,
      images: []
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/portal/image", async (req, res, next) => {
  try {
    const filename = String(req.query.filename ?? "");
    const subfolder = String(req.query.subfolder ?? "");
    const type = String(req.query.type ?? "output");

    if (!filename) {
      return res.status(400).json({ error: "Filename is required." });
    }

    const params = new URLSearchParams({ filename, subfolder, type });
    const response = await fetch(`${comfyUrl}/view?${params.toString()}`);

    if (!response.ok || !response.body) {
      throw new Error(`ComfyUI image fetch failed with HTTP ${response.status}.`);
    }

    res.setHeader("Content-Type", response.headers.get("content-type") ?? "image/png");
    res.setHeader("Content-Disposition", `inline; filename="${safeFilename(filename)}"`);
    const bytes = Buffer.from(await response.arrayBuffer());
    res.send(bytes);
  } catch (error) {
    next(error);
  }
});

app.use(express.static(clientDist));

app.get("/", async (_req, res) => {
  if (await fileExists(path.join(clientDist, "index.html"))) {
    return res.sendFile(path.join(clientDist, "index.html"));
  }

  return res.redirect(publicFrontendUrl);
});

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (res.headersSent) {
      return next(error);
    }

    const message = error instanceof Error ? error.message : "Something went wrong.";
    res.status(400).json({ error: message });
  }
);

await fs.mkdir(path.dirname(defaultWorkflowFile), { recursive: true });
await fs.mkdir(referencesRoot, { recursive: true });

app.listen(port, host, () => {
  console.log(`ComfyUI API running on http://${host}:${port}`);
});
