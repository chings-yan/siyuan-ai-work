export type ReconnectScheduler = {
  set: (callback: () => void, delayMs: number) => unknown;
  clear: (handle: unknown) => void;
};

type ReconnectOptions = {
  hasToken: () => boolean;
  refresh: () => Promise<void | boolean>;
  onFailure: (error: unknown) => void;
  onSuccess: () => void;
  scheduler?: ReconnectScheduler;
  delayMs?: number;
};

const defaultScheduler: ReconnectScheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ReconnectController {
  private readonly scheduler: ReconnectScheduler;
  private readonly delayMs: number;
  private readonly hasToken: () => boolean;
  private readonly refresh: () => Promise<void | boolean>;
  private readonly onFailure: (error: unknown) => void;
  private readonly onSuccess: () => void;
  private reconnectTimer: unknown;
  private connectionRefreshInFlight: Promise<void> | undefined;
  private unloaded = false;

  constructor(options: ReconnectOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.delayMs = options.delayMs ?? 5000;
    this.hasToken = options.hasToken;
    this.refresh = options.refresh;
    this.onFailure = options.onFailure;
    this.onSuccess = options.onSuccess;
  }

  async refreshNow(): Promise<void> {
    if (this.unloaded || !this.hasToken()) return;
    if (this.connectionRefreshInFlight) return this.connectionRefreshInFlight;
    this.clearRetry();
    this.connectionRefreshInFlight = this.runRefresh();
    try {
      await this.connectionRefreshInFlight;
    } finally {
      this.connectionRefreshInFlight = undefined;
    }
  }

  scheduleRetry(): void {
    if (this.unloaded || !this.hasToken() || this.reconnectTimer !== undefined) return;
    this.reconnectTimer = this.scheduler.set(() => {
      this.reconnectTimer = undefined;
      void this.refreshNow();
    }, this.delayMs);
  }

  unload(): void {
    this.unloaded = true;
    this.clearRetry();
  }

  private async runRefresh(): Promise<void> {
    try {
      const current = await this.refresh();
      if(this.unloaded)return;
      if(current===false){this.scheduleRetry();return;}
      this.clearRetry();
      this.onSuccess();
    } catch (error) {
      if(this.unloaded)return;
      this.onFailure(error);
      this.scheduleRetry();
    }
  }

  private clearRetry(): void {
    if (this.reconnectTimer === undefined) return;
    this.scheduler.clear(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}
