// One streaming Deepgram connection per speaking player.
import WebSocket from "ws";
import { STT_SAMPLE_RATE } from "../../shared/protocol.ts";
import { config } from "../config.ts";

export interface TranscriptWord {
  word: string;
  confidence: number;
}

export interface Transcript {
  text: string;
  words: TranscriptWord[];
  final: boolean;
}

interface DeepgramResults {
  type: "Results";
  is_final?: boolean;
  channel?: { alternatives?: { transcript?: string; words?: TranscriptWord[] }[] };
}

export function sttAvailable(): boolean {
  return Boolean(config.deepgramApiKey);
}

export class DeepgramStream {
  private ws: WebSocket;
  private queue: Buffer[] = [];
  private closed = false;
  lastAudioAt = Date.now();

  constructor(
    keyterms: string[],
    private onTranscript: (t: Transcript) => void,
    onError: (err: Error) => void,
  ) {
    const params = new URLSearchParams({
      model: config.deepgramModel,
      encoding: "linear16",
      sample_rate: String(STT_SAMPLE_RATE),
      channels: "1",
      interim_results: "true",
      punctuate: "false",
      smart_format: "false",
      endpointing: "300",
    });
    for (const term of keyterms) params.append("keyterm", term);

    this.ws = new WebSocket(`${config.deepgramUrl}?${params}`, {
      headers: { Authorization: `Token ${config.deepgramApiKey}` },
    });
    this.ws.on("open", () => {
      for (const chunk of this.queue) this.ws.send(chunk);
      this.queue = [];
    });
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        this.handle(JSON.parse(data.toString()) as DeepgramResults);
      } catch {
        // Ignore malformed frames.
      }
    });
    this.ws.on("error", (err) => {
      if (!this.closed) onError(err);
    });
    this.ws.on("unexpected-response", (_req, res) => {
      onError(new Error(`Deepgram rejected the stream: HTTP ${res.statusCode}`));
    });
  }

  send(chunk: Buffer): void {
    if (this.closed) return;
    this.lastAudioAt = Date.now();
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(chunk);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "CloseStream" }));
      setTimeout(() => this.ws.terminate(), 1000);
    } else {
      this.ws.terminate();
    }
  }

  private handle(msg: DeepgramResults): void {
    if (msg.type !== "Results") return;
    const alt = msg.channel?.alternatives?.[0];
    const text = alt?.transcript?.trim();
    if (!alt || !text) return;
    this.onTranscript({ text, words: alt.words ?? [], final: Boolean(msg.is_final) });
  }
}
