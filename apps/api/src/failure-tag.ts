export const hasFailureTag = (
  failure: unknown,
  ...tags: ReadonlyArray<string>
): boolean =>
  typeof failure === "object" &&
  failure !== null &&
  "_tag" in failure &&
  typeof failure._tag === "string" &&
  tags.includes(failure._tag);
