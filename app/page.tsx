"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

type Status = "idle" | "recording" | "done";

const RECORD_SECONDS = 30;
const DONE_SECONDS = 3;
const ENCOURAGEMENT_EVERY = 5;

const PROMPTS = [
  "Tell me about your morning.",
  "What did you have for breakfast today?",
  "Who did you talk to today?",
  "What's the weather like where you are?",
  "What's on your mind right now?",
  "Tell me about something small that made you smile.",
  "What did you do yesterday afternoon?",
  "Describe the room you're in.",
  "What's the last thing you cooked?",
  "Tell me about someone in your family.",
  "What's the last book, show, or song you enjoyed?",
  "How did you sleep last night?",
];

const ENCOURAGEMENTS = [
  "Take your time...",
  "Almost done...",
  "You're doing great.",
];

// Chrome/Edge land on webm/opus, Safari on mp4. Let the browser fall back to
// its own default if none of these are supported.
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

// Same starting prompt all day, so a check-in feels like a daily ritual rather
// than a shuffle. Read through useSyncExternalStore so the server renders a
// fixed index and the client swaps in the local date without a hydration
// mismatch.
function promptForToday(): number {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor(
    (now.getTime() - startOfYear.getTime()) / 86_400_000,
  );
  return dayOfYear % PROMPTS.length;
}

const subscribeToNothing = () => () => {};

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [secondsLeft, setSecondsLeft] = useState(RECORD_SECONDS);
  const startingPrompt = useSyncExternalStore(
    subscribeToNothing,
    promptForToday,
    () => 0,
  );
  const [promptsAdvanced, setPromptsAdvanced] = useState(0);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mountedRef = useRef(true);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const recorder = recorderRef.current;
      if (recorder) {
        recorder.onstop = null;
        recorder.ondataavailable = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      recorderRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      // The onstop handler assembles the blob and moves us to "done".
      recorder.stop();
      return;
    }
    releaseStream();
    setStatus("done");
  }, [releaseStream]);

  const startRecording = useCallback(async () => {
    setError(null);

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setError(
        "This browser can't record audio. Safari on your phone or Chrome on a computer will work.",
      );
      return;
    }

    setIsStarting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        const type = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        console.log("[Echo] recording finished", {
          size: blob.size,
          mimeType: blob.type,
        });
        releaseStream();
        recorderRef.current = null;
        if (mountedRef.current) setStatus("done");
      };

      recorderRef.current = recorder;
      recorder.start();
      setSecondsLeft(RECORD_SECONDS);
      setStatus("recording");
    } catch (err) {
      releaseStream();
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError(
          "Echo needs your permission to listen. Look for the microphone icon near the top of your screen and choose Allow, then tap again.",
        );
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setError(
          "No microphone found. If headphones are plugged in, try unplugging them and tapping again.",
        );
      } else {
        setError(
          "Something got in the way of starting the recording. Take a breath and tap again.",
        );
      }
    } finally {
      if (mountedRef.current) setIsStarting(false);
    }
  }, [releaseStream]);

  // Tick the countdown while recording.
  useEffect(() => {
    if (status !== "recording") return;
    const id = setInterval(() => {
      setSecondsLeft((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [status]);

  // Auto-stop once the 30 seconds are up.
  useEffect(() => {
    if (status === "recording" && secondsLeft === 0) stopRecording();
  }, [status, secondsLeft, stopRecording]);

  // Hold the thank-you, then reset with the next prompt in the rotation.
  useEffect(() => {
    if (status !== "done") return;
    const id = setTimeout(() => {
      setPromptsAdvanced((advanced) => advanced + 1);
      setSecondsLeft(RECORD_SECONDS);
      setStatus("idle");
    }, DONE_SECONDS * 1000);
    return () => clearTimeout(id);
  }, [status]);

  const promptIndex = (startingPrompt + promptsAdvanced) % PROMPTS.length;
  const elapsed = RECORD_SECONDS - secondsLeft;
  const encouragement =
    ENCOURAGEMENTS[
      Math.floor(elapsed / ENCOURAGEMENT_EVERY) % ENCOURAGEMENTS.length
    ];

  const buttonBase =
    "relative z-10 flex h-[200px] w-[200px] touch-manipulation select-none flex-col items-center justify-center gap-3 text-xl font-medium transition-transform duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-offset-4 focus-visible:ring-offset-[#FAF7F2] dark:focus-visible:ring-offset-[#141210] disabled:opacity-70";

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 bg-[#FAF7F2] px-6 py-12 font-sans text-stone-800 dark:bg-[#141210] dark:text-stone-100">
      {/* Prompt / countdown / farewell — fixed height so the button never moves. */}
      <div className="flex min-h-[10rem] w-full max-w-md flex-col items-center justify-end gap-3 text-center">
        {status === "idle" && (
          <p className="text-[1.75rem] leading-snug font-medium text-balance">
            {PROMPTS[promptIndex]}
          </p>
        )}

        {status === "recording" && (
          <>
            <p
              className="text-6xl font-light tabular-nums text-[#C0483C] dark:text-[#E8897B]"
              aria-hidden="true"
            >
              {secondsLeft}
            </p>
            <p className="text-lg text-stone-500 dark:text-stone-400">
              seconds left
            </p>
          </>
        )}

        {status === "done" && (
          <p className="text-[1.75rem] leading-snug font-medium text-balance">
            Thank you. See you tomorrow.
          </p>
        )}
      </div>

      <div className="relative flex items-center justify-center">
        {status === "recording" && (
          <span
            className="pointer-events-none absolute -inset-5 animate-pulse rounded-[4rem] bg-[#C0483C]/20 motion-reduce:animate-none"
            aria-hidden="true"
          />
        )}

        {status === "idle" && (
          <button
            type="button"
            onClick={startRecording}
            disabled={isStarting}
            aria-label="Tap to record"
            className={`${buttonBase} rounded-full bg-[#2E2A27] text-[#FAF7F2] shadow-[0_12px_40px_-12px_rgba(46,42,39,0.55)] ring-[#2E2A27] dark:bg-[#F3EEE8] dark:text-[#231F1D] dark:shadow-[0_12px_40px_-14px_rgba(0,0,0,0.8)] dark:ring-[#F3EEE8]`}
          >
            <MicIcon />
            <span>Tap to record</span>
          </button>
        )}

        {status === "recording" && (
          <button
            type="button"
            onClick={stopRecording}
            aria-label="Tap to stop recording"
            className={`${buttonBase} rounded-[3rem] bg-[#C0483C] text-white shadow-[0_12px_40px_-12px_rgba(192,72,60,0.6)] ring-[#C0483C]`}
          >
            <span
              className="h-14 w-14 rounded-2xl bg-white"
              aria-hidden="true"
            />
            <span>Tap to stop</span>
          </button>
        )}

        {status === "done" && (
          <div
            className="flex h-[200px] w-[200px] items-center justify-center rounded-full bg-[#2E2A27]/8 text-[#2E2A27] dark:bg-white/10 dark:text-[#F3EEE8]"
            aria-hidden="true"
          >
            <CheckIcon />
          </div>
        )}
      </div>

      {/* Supporting line — also height-reserved to keep the layout still. */}
      <div className="flex min-h-[7rem] w-full max-w-md flex-col items-center gap-4 text-center">
        {status === "idle" && !error && (
          <p className="text-lg leading-relaxed text-stone-500 dark:text-stone-400">
            Take 30 seconds — no need to think about it.
          </p>
        )}

        {status === "recording" && (
          <p
            className="text-xl text-stone-500 dark:text-stone-400"
            aria-live="polite"
          >
            {encouragement}
          </p>
        )}

        {error && (
          <p
            role="alert"
            className="max-w-sm rounded-3xl bg-[#F3E4DF] px-6 py-5 text-lg leading-relaxed text-[#7A2E22] dark:bg-[#3A211C] dark:text-[#F0C7BE]"
          >
            {error}
          </p>
        )}
      </div>
    </main>
  );
}

function MicIcon() {
  return (
    <svg
      width="56"
      height="56"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="64"
      height="64"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 12.5l5 5L20 6.5" />
    </svg>
  );
}
