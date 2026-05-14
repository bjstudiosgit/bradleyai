import { ChangeEvent, FormEvent, useEffect, useState } from "react";

type WorkflowStatus = {
  name: string;
  modelName: string;
  loaded: boolean;
  path: string | null;
  expectedPath: string;
};

type PortalState = {
  workflow: WorkflowStatus;
};

type ImageSlot = "image1" | "image2" | "image3";

type ReferenceImage = {
  slot: ImageSlot;
  label: string;
  filename: string;
  mimeType: string;
  dataUrl: string;
};

type OutputImage = {
  nodeId: string;
  filename: string;
  url: string;
  proxyUrl: string;
};

type GenerateResponse = {
  promptId: string;
  workflowSource: string;
  workflowWarning: string | null;
  references: {
    directory: string;
    files: string[];
  } | null;
  images: OutputImage[];
};

type LatestResponse = {
  promptId: string | null;
  images: OutputImage[];
};

type RunProgress = {
  value: number;
  max: number;
  percent: number;
  nodeId?: string;
};

type RunEvent =
  | { type: "status"; message: string }
  | { type: "prompt"; promptId: string; message: string }
  | { type: "progress"; value: number; max: number; percent: number; nodeId?: string; message: string }
  | { type: "done"; result: GenerateResponse }
  | { type: "error"; message: string };

const requestTimeoutMs = 16 * 60 * 1000;
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
const apiToken = import.meta.env.VITE_API_TOKEN ?? "";
const imageSlots: Array<{ slot: ImageSlot; label: string; required: boolean; helper: string }> = [
  {
    slot: "image1",
    label: "Main Image",
    required: true,
    helper: "Upload a main image to edit or enhance."
  },
  {
    slot: "image2",
    label: "Style / Secondary Image (optional)",
    required: false,
    helper: "(Optional) Add a second image for style transfer or blending."
  },
  {
    slot: "image3",
    label: "Additional Reference Image (optional)",
    required: false,
    helper: "(Optional) Add a third image for extra detail, reference, or blending."
  }
];

function apiUrl(path: string) {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  return `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function apiHeaders(headers?: HeadersInit) {
  const next = new Headers(headers);

  if (apiToken) {
    next.set("x-api-token", apiToken);
  }

  return next;
}

async function apiFetch(path: string, options: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    return await fetch(apiUrl(path), {
      ...options,
      headers: apiHeaders(options.headers),
      signal: controller.signal
    });
  } finally {
    window.clearTimeout(timeout);
  }
}

async function readError(response: Response, fallback: string) {
  const text = await response.text();

  if (!text) {
    return fallback;
  }

  try {
    const body = JSON.parse(text) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read image."));
    reader.readAsDataURL(file);
  });
}

function displayModelName(modelName?: string) {
  const name = (modelName ?? "Qwen-Rapid-AIO-NSFW-v23.safetensors")
    .replace(/\.(safetensors|ckpt)$/i, "")
    .replace(/-/g, " ")
    .replace(/\s+NSFW.*$/i, "")
    .replace(/\s+v\d+$/i, "")
    .trim();

  return name || "Qwen Rapid AIO";
}

export default function App() {
  const [workflow, setWorkflow] = useState<WorkflowStatus | null>(null);
  const [positivePrompt, setPositivePrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [filenamePrefix, setFilenamePrefix] = useState("QwenAIO");
  const [width, setWidth] = useState(1280);
  const [height, setHeight] = useState(1280);
  const [steps, setSteps] = useState(4);
  const [cfg, setCfg] = useState(1);
  const [denoise, setDenoise] = useState(1);
  const [seed, setSeed] = useState("");
  const [saveReferences, setSaveReferences] = useState(true);
  const [references, setReferences] = useState<Partial<Record<ImageSlot, ReferenceImage>>>({});
  const [outputs, setOutputs] = useState<OutputImage[]>([]);
  const [promptId, setPromptId] = useState("");
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [savedReferencePath, setSavedReferencePath] = useState("");
  const [runProgress, setRunProgress] = useState<RunProgress | null>(null);

  const selectedReferences = imageSlots
    .map(({ slot }) => references[slot])
    .filter(Boolean) as ReferenceImage[];
  const canRun = Boolean(positivePrompt.trim() && references.image1 && !running);
  const runRequirements = [
    {
      label: "Prompt",
      met: Boolean(positivePrompt.trim())
    },
    {
      label: "Main Image",
      met: Boolean(references.image1)
    }
  ];

  function applyRunEvent(event: RunEvent) {
    if (event.type === "status") {
      setStatus(event.message);
    }

    if (event.type === "prompt") {
      setPromptId(event.promptId);
      setStatus(event.message);
    }

    if (event.type === "progress") {
      setRunProgress({
        value: event.value,
        max: event.max,
        percent: event.percent,
        nodeId: event.nodeId
      });
      setStatus(event.message);
    }
  }

  async function readRunStream(response: Response) {
    if (!response.body) {
      return await response.json() as GenerateResponse;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult: GenerateResponse | null = null;

    async function processLine(line: string) {
      if (!line.trim()) {
        return;
      }

      const event = JSON.parse(line) as RunEvent;

      if (event.type === "done") {
        finalResult = event.result;
        return;
      }

      if (event.type === "error") {
        throw new Error(event.message);
      }

      applyRunEvent(event);
    }

    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        await processLine(line);
      }

      if (finalResult) {
        await reader.cancel();
        break;
      }
    }

    if (buffer.trim() && !finalResult) {
      await processLine(buffer);
    }

    if (!finalResult) {
      throw new Error("Generation ended without a final ComfyUI result.");
    }

    return finalResult;
  }

  async function loadPortal() {
    setError("");
    try {
      const response = await apiFetch("/api/portal");
      if (!response.ok) {
        throw new Error(await readError(response, "Could not load portal."));
      }

      const body = await response.json() as PortalState;
      setWorkflow(body.workflow);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load portal.");
    }
  }

  async function chooseImage(slot: ImageSlot, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const dataUrl = await readFileAsDataUrl(file);
    setReferences((current) => ({
      ...current,
      [slot]: {
        slot,
        label: imageSlots.find((item) => item.slot === slot)?.label ?? slot,
        filename: file.name,
        mimeType: file.type,
        dataUrl
      }
    }));
  }

  function removeImage(slot: ImageSlot) {
    setReferences((current) => {
      const next = { ...current };
      delete next[slot];
      return next;
    });
  }

  async function loadLatestOutput() {
    setError("");
    setStatus("Loading latest output");

    try {
      const response = await apiFetch("/api/portal/latest");

      if (!response.ok) {
        throw new Error(await readError(response, "Could not load latest output."));
      }

      const body = await response.json() as LatestResponse;
      setOutputs(body.images);
      setPromptId(body.promptId ?? "");
      setStatus(body.images.length > 0 ? "Latest output loaded" : "No output found");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load latest output.");
      setStatus("Ready");
    }
  }

  async function runWorkflow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canRun) {
      setError("Main Image and Prompt are required.");
      return;
    }

    setRunning(true);
    setError("");
    setOutputs([]);
    setPromptId("");
    setSavedReferencePath("");
    setRunProgress(null);
    setStatus("Starting generation");

    try {
      const response = await apiFetch("/api/portal/generate/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          positivePrompt,
          negativePrompt,
          width,
          height,
          steps,
          cfg,
          denoise,
          seed: seed ? Number(seed) : undefined,
          filenamePrefix,
          saveReferences,
          images: selectedReferences
        })
      });

      if (!response.ok) {
        throw new Error(await readError(response, "Generation failed."));
      }

      const body = await readRunStream(response);
      setPromptId(body.promptId);
      setOutputs(body.images);
      setSavedReferencePath(body.references?.directory ?? "");
      setStatus(body.images.length > 0 ? "Complete" : "Complete with no image output");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        setError("The run took too long and timed out.");
      } else {
        setError(caught instanceof Error ? caught.message : "Generation failed.");
      }
      setStatus("Stopped");
    } finally {
      setRunning(false);
      setRunProgress(null);
    }
  }

  useEffect(() => {
    void loadPortal();
  }, []);

  const modelLabel = displayModelName(workflow?.modelName);
  const statusIsPositive = !error && !["stopped", "failed"].some((word) => status.toLowerCase().includes(word));

  const referenceCards = () => (
    <section className="grid gap-3">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {imageSlots.map(({ slot, label, required, helper }) => {
          const image = references[slot];

          return (
            <article key={slot} className="grid grid-rows-[7.5rem_10.5rem_3.5rem] overflow-hidden rounded-md border border-white/10 bg-[#101419]">
              <div className="flex h-full flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-white/10 px-3 py-3 sm:px-4">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-white">{label}</h2>
                  <p className="mt-1 text-xs leading-5 text-slate-400">{helper}</p>
                </div>
                <span className="shrink-0 rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-[0.65rem] font-medium uppercase tracking-[0.08em] text-slate-400">
                  {required ? "Required" : "Optional"}
                </span>
              </div>
              <label className="block cursor-pointer">
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={(event) => void chooseImage(slot, event)}
                />
                <div className="flex h-full items-center justify-center bg-[#0b0d10]">
                  {image ? (
                    <img
                      src={image.dataUrl}
                      alt={image.label}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="px-4 text-center text-sm text-slate-500">
                      Upload image
                    </span>
                  )}
                </div>
              </label>
              <div className="grid h-full gap-2 px-3 py-3 sm:px-4">
                <p className="truncate text-sm text-slate-300" title={image?.filename}>
                  {image?.filename ?? "No file selected"}
                </p>
                {image && (
                  <button
                    type="button"
                    onClick={() => removeImage(slot)}
                    className="h-9 rounded border border-rose-300/25 text-sm text-rose-100 hover:bg-rose-500/10"
                  >
                    Remove
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );

  return (
    <main className="min-h-screen bg-[#0b0d10] text-slate-100">
      <div className="mx-auto grid max-w-[1120px] gap-4 px-4 py-4 sm:px-5 sm:py-5 lg:px-8">
        <header className="grid gap-3 border-b border-white/10 pb-4 md:grid-cols-[1fr_auto] md:items-end">
          <div>
            <p className="text-xl font-black uppercase tracking-normal text-white sm:text-2xl">
              <span className="text-orange-400">BRADLEY</span>AI
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal text-white sm:text-3xl">
              Image Manpuliation Engine
            </h1>
          </div>
          <div className="grid gap-2 rounded-md border border-white/10 bg-[#101419] px-4 py-3 text-sm md:min-w-72">
            <p className="text-slate-300">
              <span className="text-slate-500">Model:</span>{" "}
              <span className="font-medium text-white" title={workflow?.modelName}>
                {modelLabel}
              </span>
            </p>
            <p className="flex items-center gap-2 text-slate-300">
              <span className="text-slate-500">Status:</span>
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  statusIsPositive ? "bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.75)]" : "bg-rose-400"
                }`}
              />
              <span className="font-medium text-white">{status}</span>
            </p>
          </div>
        </header>

        <form className="grid gap-4" onSubmit={runWorkflow}>
          {referenceCards()}

          <button
            disabled={running}
            className="h-12 w-full rounded-md bg-orange-400 px-5 text-sm font-black uppercase tracking-normal text-slate-950 shadow-[0_0_28px_rgba(251,146,60,0.35)] transition hover:bg-orange-300 hover:shadow-[0_0_36px_rgba(251,146,60,0.55)] disabled:cursor-not-allowed disabled:bg-slate-600 disabled:text-slate-300 disabled:shadow-none"
          >
            {running ? "Generating image..." : "Generate Image"}
          </button>

          <section className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-2 text-sm font-medium text-slate-200 md:col-span-2" htmlFor="positive-prompt">
              Prompt
              <textarea
                id="positive-prompt"
                value={positivePrompt}
                onChange={(event) => setPositivePrompt(event.target.value)}
                placeholder="Describe what you want to create or change..."
                className="min-h-28 resize-y rounded-md border border-white/10 bg-[#11161b] px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-slate-500 focus:border-orange-300/80"
              />
            </label>
            <label className="grid gap-2 text-sm font-medium text-slate-200 md:col-span-2" htmlFor="negative-prompt">
              Negative Prompt
              <textarea
                id="negative-prompt"
                value={negativePrompt}
                onChange={(event) => setNegativePrompt(event.target.value)}
                placeholder="What should be avoided..."
                className="min-h-20 resize-y rounded-md border border-white/10 bg-[#11161b] px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-slate-500 focus:border-orange-300/80"
              />
            </label>
          </section>

          <details className="rounded-md border border-white/10 bg-[#101419] p-4">
            <summary className="cursor-pointer text-sm font-medium text-slate-200">
              Advanced settings
            </summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <label className="grid gap-2 text-sm text-slate-300">
                Width
                <input
                  type="number"
                  min={64}
                  step={64}
                  value={width}
                  onChange={(event) => setWidth(Number(event.target.value))}
                  className="h-10 rounded border border-white/10 bg-[#0b0d10] px-3 text-white outline-none focus:border-orange-300/80"
                />
              </label>
              <label className="grid gap-2 text-sm text-slate-300">
                Height
                <input
                  type="number"
                  min={64}
                  step={64}
                  value={height}
                  onChange={(event) => setHeight(Number(event.target.value))}
                  className="h-10 rounded border border-white/10 bg-[#0b0d10] px-3 text-white outline-none focus:border-orange-300/80"
                />
              </label>
              <label className="grid gap-2 text-sm text-slate-300">
                Steps
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={steps}
                  onChange={(event) => setSteps(Number(event.target.value))}
                  className="h-10 rounded border border-white/10 bg-[#0b0d10] px-3 text-white outline-none focus:border-orange-300/80"
                />
              </label>
              <label className="grid gap-2 text-sm text-slate-300">
                CFG
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={cfg}
                  onChange={(event) => setCfg(Number(event.target.value))}
                  className="h-10 rounded border border-white/10 bg-[#0b0d10] px-3 text-white outline-none focus:border-orange-300/80"
                />
              </label>
              <label className="grid gap-2 text-sm text-slate-300">
                Denoise
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={denoise}
                  onChange={(event) => setDenoise(Number(event.target.value))}
                  className="h-10 rounded border border-white/10 bg-[#0b0d10] px-3 text-white outline-none focus:border-orange-300/80"
                />
              </label>
              <label className="grid gap-2 text-sm text-slate-300">
                Seed
                <input
                  inputMode="numeric"
                  value={seed}
                  onChange={(event) => setSeed(event.target.value.replace(/\D/g, ""))}
                  placeholder="Random"
                  className="h-10 rounded border border-white/10 bg-[#0b0d10] px-3 text-white outline-none placeholder:text-slate-500 focus:border-orange-300/80"
                />
              </label>
              <label className="grid gap-2 text-sm text-slate-300 lg:col-span-3">
                Filename prefix
                <input
                  value={filenamePrefix}
                  onChange={(event) => setFilenamePrefix(event.target.value)}
                  className="h-10 rounded border border-white/10 bg-[#0b0d10] px-3 text-white outline-none focus:border-orange-300/80"
                />
              </label>
            </div>
          </details>

          <div className="grid gap-3 lg:grid-cols-[1fr_1fr]">
            <label className="flex items-center gap-3 rounded-md border border-white/10 bg-[#101419] px-4 py-3 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={saveReferences}
                onChange={(event) => setSaveReferences(event.target.checked)}
                className="h-4 w-4 accent-orange-400"
              />
              Save uploaded reference set locally
            </label>

            <div className="rounded-md border border-white/10 bg-[#101419] px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-500">
                  Run status
                </p>
                {runProgress && (
                  <span className="text-xs text-orange-100">
                    {runProgress.percent}% {runProgress.nodeId ? `node ${runProgress.nodeId}` : ""}
                  </span>
                )}
              </div>
              <div className="mt-2 text-sm leading-6 text-slate-100">{status}</div>
              {runProgress && (
                <div className="mt-3 h-2 overflow-hidden rounded bg-white/10">
                  <div
                    className="h-full bg-orange-300 transition-all"
                    style={{ width: `${runProgress.percent}%` }}
                  />
                </div>
              )}
            </div>
          </div>

          {error && (
            <div className="whitespace-pre-wrap break-words rounded-md border border-rose-300/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
              {error}
            </div>
          )}

          <div className="grid gap-2 rounded-md border border-white/10 bg-[#101419] px-4 py-3 sm:grid-cols-2">
            {runRequirements.map((requirement) => (
              <div
                key={requirement.label}
                className={`rounded border px-3 py-2 text-sm ${
                  requirement.met
                    ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-100"
                    : "border-amber-300/25 bg-amber-400/10 text-amber-100"
                }`}
              >
                {requirement.met ? "Ready" : "Missing"}: {requirement.label}
              </div>
            ))}
          </div>
        </form>

        <section className="min-h-[260px] border-t border-white/10 pt-4">
          <div className="mb-3 grid gap-3 sm:flex sm:items-end sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">Output Preview</h2>
              <p className="mt-1 text-sm text-slate-400">
                {promptId ? `Prompt ${promptId}` : "Your generated image will appear here"}
              </p>
            </div>
            <div className="grid min-w-0 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-end">
              {savedReferencePath && (
                <span className="max-w-full truncate rounded border border-emerald-300/25 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-100">
                  References saved locally
                </span>
              )}
              <button
                type="button"
                onClick={() => void loadLatestOutput()}
                className="h-10 rounded border border-white/10 px-3 text-sm text-slate-200 hover:border-orange-300/60 hover:text-orange-100 sm:h-9"
              >
                Load latest
              </button>
            </div>
          </div>

          {outputs.length === 0 ? (
            <div className="flex min-h-[220px] items-center justify-center rounded-md border border-dashed border-white/15 bg-[#101419] px-6 text-center text-slate-500 sm:min-h-[260px]">
              {running ? "Waiting for ComfyUI output" : "Your generated image will appear here"}
            </div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {outputs.map((image) => (
                <article key={`${image.nodeId}-${image.filename}`} className="overflow-hidden rounded-md border border-white/10 bg-[#101419]">
                  <a href={apiUrl(image.proxyUrl)} target="_blank" rel="noreferrer">
                    <img
                      src={apiUrl(image.proxyUrl)}
                      alt={image.filename}
                      className="aspect-square w-full bg-[#0b0d10] object-contain"
                    />
                  </a>
                  <div className="grid gap-3 px-4 py-3 sm:flex sm:flex-wrap sm:items-center sm:justify-between">
                    <p className="min-w-0 truncate text-sm text-slate-300" title={image.filename}>
                      {image.filename}
                    </p>
                    <a
                      href={apiUrl(image.proxyUrl)}
                      download={image.filename}
                      className="rounded bg-emerald-300 px-3 py-2 text-center text-sm font-bold text-slate-950 hover:bg-emerald-200"
                    >
                      Save
                    </a>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
