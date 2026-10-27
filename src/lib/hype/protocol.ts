// Message protocol between the Hype tool UI and its analysis Web Worker.
import type { HypeSegment, Waveform } from "./analysis-core";

export type AnalyzeRequest = {
  type: "analyze";
  samples: ArrayBuffer;
  sampleRate: number;
  mode: "best" | "montage";
  targetDuration: number;
  pitchWeight: number;
  videoDuration: number;
  reqId: number;
};

export type ReselectRequest = {
  type: "reselect";
  mode: "best" | "montage";
  targetDuration: number;
  pitchWeight: number;
  regenerate: boolean;
  replaceIndex: number | null;
  reqId: number;
};

export type WorkerRequest = AnalyzeRequest | ReselectRequest;

export type WorkerProgress = { type: "progress"; reqId: number; value: number };

export type WorkerDone = {
  type: "done";
  reqId: number;
  segments: HypeSegment[];
  scores: Float32Array;
  waveform?: Waveform;
  frameRate: number;
  analyzedDuration: number;
};

export type WorkerError = { type: "error"; reqId: number; message: string };

export type WorkerResponse = WorkerProgress | WorkerDone | WorkerError;
