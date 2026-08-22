const GROQ_TRANSCRIPTIONS_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL = "whisper-large-v3";

// Groq validates the uploaded filename's extension, so a blob arriving without
// a usable name has to be given one that matches its MIME type.
const EXTENSION_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mp4": "mp4",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mpga": "mpga",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

function filenameFor(file: File): string {
  if (/\.[a-z0-9]{2,4}$/i.test(file.name)) return file.name;
  const baseMime = file.type.split(";")[0].trim().toLowerCase();
  return `echo.${EXTENSION_BY_MIME[baseMime] ?? "webm"}`;
}

// Groq mirrors OpenAI's error envelope ({ error: { message } }), but be lenient
// about the shape so a gateway or proxy error still surfaces something useful.
function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;

  const { error, message } = payload as { error?: unknown; message?: unknown };

  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const nested = (error as { message?: unknown }).message;
    if (typeof nested === "string" && nested.trim()) return nested;
  }
  if (typeof message === "string" && message.trim()) return message;

  return null;
}

export async function POST(request: Request) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return Response.json(
      {
        error:
          "GROQ_API_KEY is not set. Add it to .env.local (GROQ_API_KEY=gsk_...) and restart the dev server.",
      },
      { status: 500 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: "Expected a multipart/form-data request body." },
      { status: 400 },
    );
  }

  const audio = form.get("audio");
  if (!(audio instanceof File)) {
    return Response.json(
      { error: 'Missing "audio" file field in the form data.' },
      { status: 400 },
    );
  }
  if (audio.size === 0) {
    return Response.json(
      { error: "The audio file was empty — nothing was recorded." },
      { status: 400 },
    );
  }

  const upstreamForm = new FormData();
  upstreamForm.append("file", audio, filenameFor(audio));
  upstreamForm.append("model", MODEL);
  upstreamForm.append("response_format", "verbose_json");
  upstreamForm.append("timestamp_granularities[]", "word");

  let response: Response;
  try {
    response = await fetch(GROQ_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstreamForm,
    });
  } catch (err) {
    console.error("[Echo] could not reach Groq", err);
    return Response.json(
      {
        error:
          err instanceof Error
            ? `Could not reach Groq: ${err.message}`
            : "Could not reach Groq.",
      },
      { status: 502 },
    );
  }

  // Read as text first: error responses are not always JSON.
  const raw = await response.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      extractErrorMessage(payload) ??
      raw.slice(0, 500).trim() ??
      `Groq returned ${response.status}.`;
    console.error("[Echo] Groq transcription failed", response.status, message);
    return Response.json(
      { error: message },
      { status: response.status >= 400 && response.status < 600 ? response.status : 502 },
    );
  }

  if (payload === null) {
    return Response.json(
      { error: "Groq returned a response that could not be parsed as JSON." },
      { status: 502 },
    );
  }

  return Response.json(payload);
}
