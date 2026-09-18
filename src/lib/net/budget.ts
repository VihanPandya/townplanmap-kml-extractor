/**
 * Per-scan request budget, concurrency gate and per-host throttle.
 *
 * A budget is threaded through a whole discovery scan or export job so a single
 * user action can never fan out into unbounded traffic against the source. It
 * also keeps the tool inside polite request rates rather than hammering an
 * endpoint until it rate-limits us.
 */

import { LIMITS } from '@/lib/config';

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export class RequestBudget {
  private spent = 0;
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly lastHostRequest = new Map<string, number>();
  private bytes = 0;

  constructor(
    readonly maxRequests: number = LIMITS.maxRequestsPerScan,
    readonly maxConcurrent: number = LIMITS.maxConcurrentRequests,
    readonly throttleMs: number = LIMITS.perHostThrottleMs,
  ) {}

  get requestsSpent(): number {
    return this.spent;
  }

  get requestsRemaining(): number {
    return Math.max(0, this.maxRequests - this.spent);
  }

  get bytesDownloaded(): number {
    return this.bytes;
  }

  recordBytes(count: number): void {
    this.bytes += count;
  }

  /** True when another request would exceed the budget. */
  get exhausted(): boolean {
    return this.spent >= this.maxRequests;
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  private releaseSlot(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  private async throttleHost(host: string): Promise<void> {
    if (this.throttleMs <= 0) return;
    const last = this.lastHostRequest.get(host);
    const now = Date.now();
    if (last !== undefined) {
      const wait = this.throttleMs - (now - last);
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    this.lastHostRequest.set(host, Date.now());
  }

  /**
   * Run `task` against the budget: counts one request, waits for a concurrency
   * slot, and spaces requests to the same host.
   */
  async spend<T>(host: string, task: () => Promise<T>): Promise<T> {
    if (this.exhausted) {
      throw new BudgetExceededError(
        `Request budget of ${this.maxRequests} requests for this operation is exhausted.`,
      );
    }
    this.spent += 1;
    await this.acquireSlot();
    try {
      await this.throttleHost(host);
      return await task();
    } finally {
      this.releaseSlot();
    }
  }
}
