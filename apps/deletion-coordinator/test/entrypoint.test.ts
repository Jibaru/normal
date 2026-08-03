import { describe, expect, test } from "vitest";
import worker from "../src/index";

describe("deletion coordinator entrypoint", () => {
  test("exposes only the scheduled cleanup boundary", () => {
    expect(Object.keys(worker)).toEqual(["scheduled"]);
    expect(worker.scheduled).toBeTypeOf("function");
  });
});
