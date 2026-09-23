export interface AssetsFetcherLike {
  fetch(request: Request): Promise<Response>
}

export interface ScheduledEventLike {
  readonly cron: string
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<void>): void
}
