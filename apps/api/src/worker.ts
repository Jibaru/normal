export interface WorkerHandlers<Environment> {
  readonly fetch: ExportedHandlerFetchHandler<Environment>;
  readonly queue?: ExportedHandlerQueueHandler<Environment>;
  readonly scheduled?: ExportedHandlerScheduledHandler<Environment>;
}

/**
 * The single modules-format dispatch used by production and test composition
 * roots. Tests may replace external services and bindings, but not Worker
 * event dispatch.
 */
export const createWorker = <Environment>(
  handlers: WorkerHandlers<Environment>,
): ExportedHandler<Environment> => ({
  fetch: handlers.fetch,
  ...(handlers.queue === undefined ? {} : { queue: handlers.queue }),
  ...(handlers.scheduled === undefined
    ? {}
    : { scheduled: handlers.scheduled }),
});
