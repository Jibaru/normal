const REFRESH_INTERVAL_MS = 20 * 60 * 1_000;
const STS_ORIGIN = "https://sts.us-east-1.amazonaws.com/";

const required = (name: string) => {
  const value = process.env[name];
  if (!value || /example|placeholder|replace/iu.test(value)) {
    throw new Error(`${name} is unavailable`);
  }
  return value;
};

const xmlValue = (xml: string, name: string) => {
  const match = xml.match(new RegExp(`<${name}>([^<]+)</${name}>`, "u"));
  if (match?.[1] === undefined) {
    throw new Error("AWS recovery credential response is invalid");
  }
  return match[1];
};

export const decodeAssumedRoleCredentials = (xml: string, now = Date.now()) => {
  const accessKeyId = xmlValue(xml, "AccessKeyId");
  const secretAccessKey = xmlValue(xml, "SecretAccessKey");
  const sessionToken = xmlValue(xml, "SessionToken");
  const expiration = xmlValue(xml, "Expiration");
  const expiresAt = Date.parse(expiration);
  if (
    !/^[A-Z0-9]{16,128}$/u.test(accessKeyId) ||
    secretAccessKey.length < 32 ||
    sessionToken.length < 64 ||
    !Number.isFinite(expiresAt) ||
    expiresAt - now < 45 * 60 * 1_000
  ) {
    throw new Error("AWS recovery credential response is invalid");
  }
  return { accessKeyId, secretAccessKey, sessionToken } as const;
};

const requestGitHubOidcToken = async () => {
  const requestUrl = new URL(required("ACTIONS_ID_TOKEN_REQUEST_URL"));
  if (
    requestUrl.protocol !== "https:" ||
    !requestUrl.hostname.endsWith(".actions.githubusercontent.com") ||
    requestUrl.username !== "" ||
    requestUrl.password !== ""
  ) {
    throw new Error("GitHub recovery identity is unavailable");
  }
  requestUrl.searchParams.set("audience", "sts.amazonaws.com");
  const response = await fetch(requestUrl, {
    headers: {
      authorization: `Bearer ${required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const body = response.ok ? await response.json() : null;
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    typeof (body as { value?: unknown }).value !== "string"
  ) {
    throw new Error("GitHub recovery identity is unavailable");
  }
  return (body as { value: string }).value;
};

const assumeRecoveryRole = async (webIdentityToken: string) => {
  const roleArn = required("AWS_RECOVERY_GAME_DAY_ROLE_ARN");
  if (
    !/^arn:aws:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]{1,128}$/u.test(roleArn)
  ) {
    throw new Error("AWS recovery role is unavailable");
  }
  const response = await fetch(STS_ORIGIN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      Action: "AssumeRoleWithWebIdentity",
      DurationSeconds: "3600",
      RoleArn: roleArn,
      RoleSessionName: `quarterly-recovery-${crypto.randomUUID()}`,
      Version: "2011-06-15",
      WebIdentityToken: webIdentityToken,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("AWS recovery role is unavailable");
  return decodeAssumedRoleCredentials(await response.text());
};

const uploadWorkerCredentials = async (
  credentials: ReturnType<typeof decodeAssumedRoleCredentials>,
) => {
  const accountId = required("CLOUDFLARE_ACCOUNT_ID");
  const keyArn = required("KMS_RECOVERY_GAME_DAY_KEY_ARN");
  if (!/^[a-f0-9]{32}$/u.test(accountId)) {
    throw new Error("Cloudflare recovery account is unavailable");
  }
  if (!/^arn:aws:kms:us-east-1:[0-9]{12}:key\/[0-9a-f-]{36}$/u.test(keyArn)) {
    throw new Error("Recovery KMS key is unavailable");
  }
  const child = Bun.spawn(
    [
      "bun",
      "x",
      "wrangler",
      "secret",
      "bulk",
      "--name",
      "whatsapp-mcp-recovery-game-day",
    ],
    {
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: required("CLOUDFLARE_API_TOKEN"),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write(
    JSON.stringify({
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_SESSION_TOKEN: credentials.sessionToken,
      KMS_RECOVERY_GAME_DAY_KEY_ARN: keyArn,
    }),
  );
  child.stdin.end();
  await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ]);
  if ((await child.exited) !== 0) {
    throw new Error("Recovery game day credential rotation failed");
  }
};

export const refreshRecoveryGameDayCredentials = async () => {
  const token = await requestGitHubOidcToken();
  const credentials = await assumeRecoveryRole(token);
  await uploadWorkerCredentials(credentials);
};

export const makeRecoveryGameDayCredentialRefresher = (
  refresh: () => Promise<void> = refreshRecoveryGameDayCredentials,
  clock: () => number = Date.now,
) => {
  let nextRefreshAt = 0;
  return async () => {
    const now = clock();
    if (now < nextRefreshAt) return;
    await refresh();
    nextRefreshAt = clock() + REFRESH_INTERVAL_MS;
  };
};
