export interface RecoveryServiceFetcher {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface RecoveryVerifierEnvironment {
  readonly DEPLOYMENT_ENVIRONMENT: string;
  readonly NEON_PARENT_BRANCH_ID: string;
  readonly NEON_PROJECT_ID: string;
  readonly NEON_RECOVERY_API_KEY: string;
  readonly OBSERVABILITY_QUERY_TOKEN: string;
  readonly OBSERVABILITY_QUERY_URL: string;
  readonly RECOVERY_BRANCH_PREFIX: string;
  readonly RECOVERY_DATABASE_NAME: string;
  readonly RECOVERY_EVIDENCE_TOKEN: string;
  readonly RECOVERY_VERIFIER_DATABASE_PASSWORD: string;
  readonly RECOVERY_GAME_DAY: RecoveryServiceFetcher;
}
