import { describe, expect, test } from "vitest";
import { partitionDeploymentSmokeMessages } from "../src/deployment-smoke-production";

describe("production deployment smoke queue", () => {
  test("preserves ordinary ingestion messages in a mixed batch", () => {
    const smoke = {
      body: { canaryId: `smk_${"a".repeat(43)}`, type: "deployment-smoke" },
    };
    const ingestion = { body: { eventId: "evt_ordinary" } };
    const batch = {
      messages: [smoke, ingestion],
      queue: "whatsapp-mcp-ingestion",
    } as unknown as MessageBatch;

    const partitioned = partitionDeploymentSmokeMessages(batch);

    expect(partitioned.smoke).toEqual([smoke]);
    expect(partitioned.remaining.messages).toEqual([ingestion]);
  });
});
