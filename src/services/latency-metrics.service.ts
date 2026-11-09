import {
  LATENCY_METRIC_NAMES,
  type LatencyMetricName,
  type LatencySnapshot,
  type LatencyStats,
} from '@shared';
import { roundTo } from '../mvc/models/numbers';

class SampleWindow {
  private readonly samples: number[] = [];
  total = 0;

  constructor(private readonly capacity: number) {}

  push(value: number): void {
    this.samples.push(value);
    this.total += 1;
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  stats(): LatencyStats | null {
    const count = this.samples.length;
    if (count === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, value) => acc + value, 0);
    return {
      count: this.total,
      last: roundTo(this.samples[count - 1] ?? 0),
      avg: roundTo(sum / count),
      p50: roundTo(percentile(sorted, 0.5)),
      p95: roundTo(percentile(sorted, 0.95)),
      min: roundTo(sorted[0] ?? 0),
      max: roundTo(sorted[count - 1] ?? 0),
    };
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? 0;
}

/**
 * Records pipeline latencies per interview over a bounded sliding window
 * (so long sessions cannot grow memory) and produces percentile snapshots.
 */
export class LatencyMetricsService {
  private readonly scopes = new Map<string, Map<LatencyMetricName, SampleWindow>>();

  constructor(private readonly options: { windowSize: number } = { windowSize: 200 }) {}

  record(scopeId: string, metric: LatencyMetricName, valueMs: number): void {
    // Negative values come from clock skew; drop them rather than distort stats.
    if (!Number.isFinite(valueMs) || valueMs < 0) return;
    let metrics = this.scopes.get(scopeId);
    if (!metrics) {
      metrics = new Map();
      this.scopes.set(scopeId, metrics);
    }
    let window = metrics.get(metric);
    if (!window) {
      window = new SampleWindow(this.options.windowSize);
      metrics.set(metric, window);
    }
    window.push(valueMs);
  }

  snapshot(scopeId: string): LatencySnapshot {
    const metrics = this.scopes.get(scopeId);
    const entries = LATENCY_METRIC_NAMES.map(
      (name) => [name, metrics?.get(name)?.stats() ?? null] as const,
    );
    return Object.fromEntries(entries) as LatencySnapshot;
  }

  clear(scopeId: string): void {
    this.scopes.delete(scopeId);
  }
}
