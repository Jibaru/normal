export interface OperationsControlEnvironment {
  readonly ALERT_RECEIPTS: KVNamespace;
  readonly API_ORIGIN: string;
  readonly CLOUDFLARE_ANALYTICS_TOKEN: string;
  readonly CLOUDFLARE_ZONE_ID: string;
  readonly DEPLOYMENT_ENVIRONMENT: string;
  readonly OBSERVABILITY_QUERY_TOKEN: string;
  readonly PAGER_DESTINATION_ADDRESS: string;
  readonly PAGER_EMAIL: SendEmail;
  readonly PAGER_RECEIPT_TOKEN: string;
  readonly PAGER_WEBHOOK_TOKEN: string;
  readonly SMOKE_CHECK_SECRET: string;
}
