import { describe, expect, test } from "bun:test";
import {
  decodeAssumedRoleCredentials,
  makeRecoveryGameDayCredentialRefresher,
} from "./refresh-recovery-game-day-credentials";

const response = (expiration: string) => `
  <AssumeRoleWithWebIdentityResponse>
    <Credentials>
      <AccessKeyId>${"A".repeat(20)}</AccessKeyId>
      <SecretAccessKey>${"s".repeat(40)}</SecretAccessKey>
      <SessionToken>${"t".repeat(100)}</SessionToken>
      <Expiration>${expiration}</Expiration>
    </Credentials>
  </AssumeRoleWithWebIdentityResponse>`;

describe("recovery game day credential refresh", () => {
  test("accepts only a fresh one hour AWS session", () => {
    expect(
      decodeAssumedRoleCredentials(
        response("2026-08-19T06:00:00.000Z"),
        Date.parse("2026-08-19T05:00:00.000Z"),
      ),
    ).toEqual({
      accessKeyId: "A".repeat(20),
      secretAccessKey: "s".repeat(40),
      sessionToken: "t".repeat(100),
    });
    expect(() =>
      decodeAssumedRoleCredentials(
        response("2026-08-19T05:30:00.000Z"),
        Date.parse("2026-08-19T05:00:00.000Z"),
      ),
    ).toThrow("AWS recovery credential response is invalid");
  });

  test("refreshes immediately and at most every twenty minutes", async () => {
    let now = 0;
    let refreshes = 0;
    const refresh = makeRecoveryGameDayCredentialRefresher(
      async () => {
        refreshes += 1;
      },
      () => now,
    );

    await refresh();
    now = 19 * 60 * 1_000;
    await refresh();
    now = 20 * 60 * 1_000;
    await refresh();

    expect(refreshes).toBe(2);
  });
});
