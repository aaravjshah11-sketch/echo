const GROQ_TRANSCRIPTIONS_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL = "whisper-large-v3";

// Whisper cleans up speech by default. This nudges it to leave the
// disfluencies in, since they are the signal rather than noise here.
const TRANSCRIPTION_PROMPT =
  "Include verbatim all filler words such as um, uh, er, erm, ah, hmm, and preserve word repetitions and false starts exactly as spoken.";

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

// --- Signal 01: word-finding latency ---------------------------------------

// Filled pauses, counted for their own rate and also folded into STOPWORDS so
// they can never be treated as content words.
const FILLER_WORDS = new Set([
  "um", "uh", "uhm", "umm", "uhh", "erm", "hmm", "mhm", "ah", "er", "mm",
]);

// Function words and very common verbs. Retrieval effort shows up before
// content words, so these are excluded from the pause measurement.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has",
  "have", "he", "her", "his", "i", "in", "is", "it", "its", "me", "my", "of",
  "on", "or", "our", "she", "so", "that", "the", "their", "them", "they",
  "this", "to", "was", "we", "were", "will", "with", "you", "your", "but",
  "if", "not", "no", "do", "did", "does", "done", "get", "got", "had", "just",
  "like", "one", "out", "up", "um", "uh",
  ...FILLER_WORDS,
]);

// Below 200ms is co-articulation rather than hesitation; above 3s is a break
// in the recording, not word-finding.
const PAUSE_FLOOR_MS = 200;
const PAUSE_CEILING_MS = 3000;


type TimedWord = { word: string; start: number; end: number };

export type Signals = {
  content_word_pause_avg_ms: number;
  filled_pause_rate_per_min: number;
  repetition_rate_per_min: number;
  speech_rate_wpm: number;
  word_finding_score: number;
};

function normalizeWord(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z]/g, "");
}

function isContentWord(normalized: string): boolean {
  return normalized.length >= 4 && !STOPWORDS.has(normalized);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function extractWords(payload: unknown): TimedWord[] {
  const raw = (payload as { words?: unknown } | null)?.words;

  if (Array.isArray(raw)) {
    return raw
      .filter(
        (entry): entry is { word: string; start?: unknown; end?: unknown } =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as { word?: unknown }).word === "string",
      )
      .map((entry) => ({
        word: entry.word,
        start: Number(entry.start),
        end: Number(entry.end),
      }));
  }

  // No word-level timestamps came back. Fall back to the plain text so the
  // untimed signals (rate, repetition, filled pauses) still mean something.
  const text = (payload as { text?: unknown } | null)?.text;
  if (typeof text !== "string") return [];
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ({ word, start: NaN, end: NaN }));
}

function computeSignals(
  words: TimedWord[],
  durationSeconds: number,
): Signals {
  const normalized = words.map((entry) => normalizeWord(entry.word));
  const minutes = durationSeconds > 0 ? durationSeconds / 60 : 0;

  let pauseTotalMs = 0;
  let pauseSamples = 0;
  for (let i = 1; i < words.length; i++) {
    if (!isContentWord(normalized[i])) continue;

    const previousEnd = words[i - 1].end;
    const currentStart = words[i].start;
    if (!Number.isFinite(previousEnd) || !Number.isFinite(currentStart)) {
      continue;
    }

    const pauseMs = (currentStart - previousEnd) * 1000;
    if (pauseMs > PAUSE_FLOOR_MS && pauseMs < PAUSE_CEILING_MS) {
      pauseTotalMs += pauseMs;
      pauseSamples += 1;
    }
  }
  const contentWordPauseAvgMs =
    pauseSamples > 0 ? pauseTotalMs / pauseSamples : 0;

  const filledPauses = normalized.filter((word) =>
    FILLER_WORDS.has(word),
  ).length;
  const filledPauseRate = minutes > 0 ? filledPauses / minutes : 0;

  let repetitions = 0;
  for (let i = 1; i < normalized.length; i++) {
    // Skip empties so two stripped-to-nothing tokens don't read as a repeat.
    if (normalized[i] && normalized[i] === normalized[i - 1]) repetitions += 1;
  }
  const repetitionRate = minutes > 0 ? repetitions / minutes : 0;

  const speechRate = minutes > 0 ? words.length / minutes : 0;

  // Composite is built from the unrounded parts, then rounded once.
  const score = clamp(
    contentWordPauseAvgMs / 15 + filledPauseRate * 2 + repetitionRate * 3,
    0,
    100,
  );

  return {
    content_word_pause_avg_ms: round(contentWordPauseAvgMs),
    filled_pause_rate_per_min: round(filledPauseRate, 1),
    repetition_rate_per_min: round(repetitionRate, 1),
    speech_rate_wpm: round(speechRate),
    word_finding_score: round(score),
  };
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
  upstreamForm.append("prompt", TRANSCRIPTION_PROMPT);

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

  const record = payload as Record<string, unknown>;
  const durationSeconds = Number(record.duration);
  const signals = computeSignals(
    extractWords(payload),
    Number.isFinite(durationSeconds) ? durationSeconds : 0,
  );

  // Spread Groq's payload through untouched (text, words, duration, segments)
  // and add the derived signals alongside it.
  return Response.json({
    ...record,
    transcript: typeof record.text === "string" ? record.text : "",
    signals,
  });
}
