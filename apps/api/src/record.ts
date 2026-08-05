export const hasExactKeys = (
  value: object,
  expected: ReadonlyArray<string>,
): boolean =>
  Object.keys(value).sort().join(",") === [...expected].sort().join(",");
