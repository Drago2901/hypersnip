import { describe, expect, it } from "vitest";

import {
  computeExcitement,
  extractFeatures,
  replaceSegment,
  selectSegments,
  type FeatureSet,
  type FrameFeatures,
  type SelectionRequest,
} from "../lib/hype/analysis-core";

function featureSet(frameCount: number, valid = true): FeatureSet {
  const features: FrameFeatures[] = Array.from({ length: frameCount }, () => ({
    rmsDb: -20,
    pitchHz: 220,
    pitchConf: 0.9,
    variation: 1,
    centroidHz: 2000,
  }));
  const validArr = new Uint8Array(frameCount).fill(valid ? 1 : 0);
  return { features, valid: validArr, frameCount };
}

function withScores(fs: FeatureSet, peaks: Array<[number, number, number]>): Float32Array {
  const scores = new Float32Array(fs.frameCount);
  for (const [from, to, level] of peaks) {
    for (let i = from; i < to && i < fs.frameCount; i++) scores[i] = level;
  }
  return scores;
}

const req = (mode: "best" | "montage", target: number, videoDuration = 0): SelectionRequest => ({
  mode,
  targetDuration: target,
  videoDuration,
});

describe("selectSegments — montage", () => {
  it("returns chronological, non-overlapping segments totalling the target", () => {
    const fs = featureSet(600); // 60 s
    // Three clear hype bursts.
    const scores = withScores(fs, [
      [100, 140, 1],
      [300, 340, 1],
      [480, 520, 1],
    ]);
    const segments = selectSegments(fs, scores, req("montage", 15));

    expect(segments.length).toBe(3);
    let prevEnd = 0;
    for (const seg of segments) {
      expect(seg.start).toBeGreaterThanOrEqual(prevEnd);
      expect(seg.dur).toBeGreaterThan(3.5);
      expect(seg.dur).toBeLessThan(6.5);
      prevEnd = seg.start + seg.dur;
    }
    const total = segments.reduce((sum, s) => sum + s.dur, 0);
    expect(total).toBeGreaterThanOrEqual(13);
    expect(total).toBeLessThanOrEqual(17);
  });

  it("never returns overlapping segments", () => {
    const fs = featureSet(900);
    const scores = withScores(fs, [
      [50, 150, 1],
      [200, 300, 0.9],
      [400, 500, 0.8],
      [600, 700, 0.7],
      [800, 850, 0.6],
    ]);
    const segments = selectSegments(fs, scores, req("montage", 30));
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.start).toBeGreaterThanOrEqual(
        segments[i - 1]!.start + segments[i - 1]!.dur,
      );
    }
    const total = segments.reduce((sum, s) => sum + s.dur, 0);
    expect(total).toBeLessThanOrEqual(31);
  });
});

describe("selectSegments — best moment", () => {
  it("picks one segment around the strongest peak", () => {
    const fs = featureSet(600);
    const scores = withScores(fs, [
      [30, 70, 0.5],
      [280, 380, 1],
    ]);
    const [segment] = selectSegments(fs, scores, req("best", 15));
    expect(segment).toBeDefined();
    expect(segment!.start).toBeGreaterThanOrEqual(20);
    expect(segment!.start).toBeLessThanOrEqual(27);
    expect(segment!.start + segment!.dur).toBeGreaterThanOrEqual(36);
  });

  it("caps the segment at a hard 30 s", () => {
    const fs = featureSet(1200);
    const scores = withScores(fs, [[0, 1200, 0.8]]);
    const [segment] = selectSegments(fs, scores, req("best", 60));
    expect(segment).toBeDefined();
    expect(segment!.dur).toBeLessThanOrEqual(30);
  });
});

describe("selectSegments — fallback", () => {
  it("uses the first portion when no valid frames exist", () => {
    const fs = featureSet(600, false);
    const [bestSeg] = selectSegments(fs, new Float32Array(600), req("best", 20));
    expect(bestSeg).toEqual({ start: 0, dur: 20, score: 0 });

    const montage = selectSegments(fs, new Float32Array(600), req("montage", 30));
    expect(montage.length).toBeGreaterThanOrEqual(2);
    expect(montage[0]!.start).toBe(0);
    const total = montage.reduce((sum, s) => sum + s.dur, 0);
    expect(total).toBeLessThanOrEqual(30.5);
  });
});

describe("replaceSegment", () => {
  it("returns segments that do not overlap the kept ones", () => {
    const fs = featureSet(900);
    const scores = withScores(fs, [
      [50, 150, 1],
      [200, 300, 0.9],
      [400, 500, 0.8],
      [600, 700, 0.7],
    ]);
    const current = selectSegments(fs, scores, req("montage", 30));
    expect(current.length).toBeGreaterThanOrEqual(2);
    const replaced = replaceSegment(fs, scores, current, 1);
    expect(replaced.length).toBe(current.length);
    for (let i = 1; i < replaced.length; i++) {
      expect(replaced[i]!.start).toBeGreaterThanOrEqual(
        replaced[i - 1]!.start + replaced[i - 1]!.dur,
      );
    }
  });
});

describe("computeExcitement", () => {
  it("ranks louder frames higher and stays within [0, 1]", () => {
    const samples = new Float32Array(16000 * 4); // 4 s
    for (let i = 0; i < samples.length; i++) {
      const level = i < samples.length / 2 ? 0.02 : 0.4;
      samples[i] = level * Math.sin((i * Math.PI) / 100);
    }
    const fs = extractFeatures(samples, 16000);
    const scores = computeExcitement(fs, { pitchWeight: 0.5 });
    expect(scores.length).toBe(40);
    for (const s of scores) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
    const avg = (from: number, to: number) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += scores[i] ?? 0;
      return sum / (to - from);
    };
    expect(avg(25, 40)).toBeGreaterThan(avg(0, 15));
  });
});
