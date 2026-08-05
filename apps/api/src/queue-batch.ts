export const handleQueueBatch = async <Body, Result>(
  batch: MessageBatch,
  isBody: (value: unknown) => value is Body,
  process: (body: Body) => Promise<Result>,
  retryDelayFor: (result: Result) => number | null,
  fallbackRetryDelaySeconds: number,
): Promise<void> => {
  for (const message of batch.messages) {
    if (!isBody(message.body)) {
      message.ack();
      continue;
    }
    try {
      const delaySeconds = retryDelayFor(await process(message.body));
      if (delaySeconds === null) message.ack();
      else message.retry({ delaySeconds });
    } catch {
      message.retry({ delaySeconds: fallbackRetryDelaySeconds });
    }
  }
};
