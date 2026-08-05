export const hasExactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
): boolean =>
  Object.keys(value).sort().join(",") === [...expected].sort().join(",");
