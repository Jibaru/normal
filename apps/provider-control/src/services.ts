import type {
  DeployableName,
  DeploymentEnvironment,
} from "@whatsapp-mcp/domain/deployment";
import { Context, type Effect } from "effect";

export interface ApplicationConfig {
  readonly environment: DeploymentEnvironment;
  readonly service: DeployableName;
}

export const ApplicationConfig = Context.GenericTag<ApplicationConfig>(
  "@whatsapp-mcp/provider-control/ApplicationConfig",
);

export interface HttpCompletedEvent {
  readonly event: "http.request.completed";
  readonly method: string;
  readonly route: "health" | "unmatched";
  readonly service: DeployableName;
  readonly status: number;
}

export interface SafeTelemetry {
  readonly emit: (event: HttpCompletedEvent) => Effect.Effect<void>;
}

export const SafeTelemetry = Context.GenericTag<SafeTelemetry>(
  "@whatsapp-mcp/provider-control/SafeTelemetry",
);
