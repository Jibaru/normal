mock_provider "cloudflare" {}
mock_provider "vercel" {}

run "development_topology" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    deployment_environment             = "development"
    cloudflare_account_id              = "11111111111111111111111111111111"
    cloudflare_zone_id                 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    vercel_team_id                     = "team_developmentvalidation"
    api_hostname                       = "api.dev.example.com"
    web_hostname                       = "app.dev.example.com"
    clerk_issuer                       = "https://clerk.dev.example.com"
    clerk_publishable_key              = "pk_test_Y2xlcmsuZGV2LmV4YW1wbGUuY29tJA"
    provider_approved_session_capacity = 3
    mcp_requests_per_minute            = 60
    mcp_requests_per_hour              = 600
    oauth_clients = [{
      client_class  = "approved"
      client_id     = "approved-client"
      client_name   = "Approved MCP Client"
      redirect_uris = ["https://client.example.test/callback"]
    }]
  }

  assert {
    condition     = cloudflare_worker.api.name == "whatsapp-mcp-api-development"
    error_message = "Development must have an environment-specific API Worker."
  }

  assert {
    condition     = cloudflare_worker.provider_control.name == "whatsapp-mcp-provider-control-development"
    error_message = "Development must have an environment-specific provider-control Worker."
  }

  assert {
    condition = one([
      for binding in cloudflare_worker_version.api.bindings :
      binding.service if binding.name == "PROVIDER_CONTROL"
    ]) == cloudflare_worker.provider_control.name
    error_message = "The API must bind to provider-control in the same environment."
  }

  assert {
    condition = (
      cloudflare_worker.api.subdomain.enabled == false &&
      cloudflare_worker.api.subdomain.previews_enabled == false &&
      cloudflare_worker.provider_control.subdomain.enabled == false &&
      cloudflare_worker.provider_control.subdomain.previews_enabled == false
    )
    error_message = "Workers must disable public generated hostnames before any version is deployed."
  }

  assert {
    condition     = cloudflare_workers_custom_domain.api.hostname == "api.dev.example.com"
    error_message = "The API must have a public custom-domain route."
  }

  assert {
    condition = one([
      for item in vercel_project.web.environment :
      item.value if item.key == "NEXT_PUBLIC_API_ORIGIN"
    ]) == "https://api.dev.example.com"
    error_message = "The web deployment must call the API Worker directly."
  }

  assert {
    condition = (
      cloudflare_r2_bucket.webhook_ingress.name == "whatsapp-mcp-webhook-ingress-development" &&
      cloudflare_r2_bucket.stored_media.name == "whatsapp-mcp-stored-media-development" &&
      cloudflare_r2_bucket.deletion_capsules.name == "whatsapp-mcp-deletion-capsules-development" &&
      cloudflare_r2_bucket.deletion_markers.name == "whatsapp-mcp-deletion-markers-development" &&
      cloudflare_workers_kv_namespace.oauth.title == "whatsapp-mcp-oauth-development" &&
      cloudflare_queue.connection_setup_provisioning.queue_name == "whatsapp-mcp-connection-setup-provisioning-development" &&
      cloudflare_queue.ingestion.queue_name == "whatsapp-mcp-ingestion-development" &&
      cloudflare_queue.dead_letter.queue_name == "whatsapp-mcp-ingestion-dlq-development"
    )
    error_message = "Development state resources must use isolated environment-specific names."
  }

  assert {
    condition = toset([
      for binding in cloudflare_worker_version.api.bindings :
      "${binding.type}:${binding.name}"
      ]) == toset([
      "inherit:CLERK_JWT_KEY",
      "inherit:MCP_CURSOR_HMAC_SECRET",
      "inherit:OAUTH_PROTOCOL_ENCRYPTION_KEY",
      "inherit:WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET",
      "kv_namespace:OAUTH_KV",
      "plain_text:CLERK_API_AUDIENCE",
      "plain_text:CLERK_AUTHORIZED_PARTY",
      "plain_text:CLERK_ISSUER",
      "plain_text:DEPLOYMENT_ENVIRONMENT",
      "plain_text:OAUTH_CLIENT_REGISTRY",
      "plain_text:OAUTH_ISSUER",
      "plain_text:OAUTH_RESOURCE",
      "plain_text:MCP_REQUESTS_PER_HOUR",
      "plain_text:MCP_REQUESTS_PER_MINUTE",
      "plain_text:PROVIDER_APPROVED_SESSION_CAPACITY",
      "queue:CONNECTION_SETUP_PROVISIONING_QUEUE",
      "queue:INGESTION_QUEUE",
      "r2_bucket:DELETION_CAPSULES",
      "r2_bucket:DELETION_MARKERS",
      "r2_bucket:STORED_MEDIA",
      "r2_bucket:WEBHOOK_INGRESS",
      "service:PROVIDER_CONTROL",
    ])
    error_message = "The API Worker must receive exactly its state, queue producer, and provider-control capabilities."
  }

  assert {
    condition = (
      one([
        for binding in cloudflare_worker_version.api.bindings :
        binding.text if binding.name == "CLERK_API_AUDIENCE"
      ]) == "https://api.dev.example.com" &&
      one([
        for binding in cloudflare_worker_version.api.bindings :
        binding.text if binding.name == "CLERK_AUTHORIZED_PARTY"
      ]) == "https://app.dev.example.com" &&
      one([
        for binding in cloudflare_worker_version.api.bindings :
        binding.text if binding.name == "CLERK_ISSUER"
      ]) == "https://clerk.dev.example.com" &&
      one([
        for binding in cloudflare_worker_version.api.bindings :
        binding.text if binding.name == "PROVIDER_APPROVED_SESSION_CAPACITY"
      ]) == "3"
    )
    error_message = "The API must receive exact same-environment identity and provider-capacity configuration."
  }

  assert {
    condition = (
      one([
        for binding in cloudflare_worker_version.api.bindings :
        binding.text if binding.name == "OAUTH_ISSUER"
      ]) == "https://api.dev.example.com" &&
      one([
        for binding in cloudflare_worker_version.api.bindings :
        binding.text if binding.name == "OAUTH_RESOURCE"
      ]) == "https://api.dev.example.com/mcp" &&
      jsondecode(one([
        for binding in cloudflare_worker_version.api.bindings :
        binding.text if binding.name == "OAUTH_CLIENT_REGISTRY"
      ]))[0].redirectUris == ["https://client.example.test/callback"] &&
      toset(cloudflare_worker_version.api.compatibility_flags) == toset([
        "global_fetch_strictly_public",
        "nodejs_compat",
      ])
    )
    error_message = "OAuth must bind the exact API issuer/resource, reviewed redirects, and strict fetch compatibility."
  }

  assert {
    condition = (
      one([
        for item in vercel_project.web.environment :
        item.value if item.key == "NEXT_PUBLIC_CLERK_JWT_TEMPLATE"
      ]) == "whatsapp-api" &&
      one([
        for item in vercel_project.web.environment :
        item.value if item.key == "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"
      ]) == "pk_test_Y2xlcmsuZGV2LmV4YW1wbGUuY29tJA"
    )
    error_message = "The browser must receive the environment's public Clerk key and exact custom JWT template."
  }

  assert {
    condition = toset([
      for binding in cloudflare_worker_version.provider_control.bindings :
      "${binding.type}:${binding.name}"
      ]) == toset([
      "inherit:WASENDER_API_CREDENTIAL",
      "inherit:WASENDER_REFERENCE_SECRET",
      "plain_text:DEPLOYMENT_ENVIRONMENT",
    ])
    error_message = "Provider-control must receive only its environment and inherited Wasender secrets."
  }
}

run "preview_topology" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    deployment_environment             = "preview"
    cloudflare_account_id              = "22222222222222222222222222222222"
    cloudflare_zone_id                 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    vercel_team_id                     = "team_previewvalidation"
    api_hostname                       = "api.preview.example.com"
    web_hostname                       = "app.preview.example.com"
    clerk_issuer                       = "https://clerk.preview.example.com"
    clerk_publishable_key              = "pk_test_Y2xlcmsucHJldmlldy5leGFtcGxlJA"
    provider_approved_session_capacity = 3
    mcp_requests_per_minute            = 60
    mcp_requests_per_hour              = 600
    oauth_clients = [{
      client_class  = "approved"
      client_id     = "approved-client"
      client_name   = "Approved MCP Client"
      redirect_uris = ["https://client.example.test/callback"]
    }]
  }

  assert {
    condition     = cloudflare_worker.api.name == "whatsapp-mcp-api-preview"
    error_message = "Preview must have an environment-specific API Worker."
  }

  assert {
    condition     = cloudflare_worker.provider_control.name == "whatsapp-mcp-provider-control-preview"
    error_message = "Preview must have an environment-specific provider-control Worker."
  }

  assert {
    condition     = output.api_origin == "https://api.preview.example.com"
    error_message = "Preview must expose only its own API origin."
  }
}

run "production_topology" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    deployment_environment             = "production"
    cloudflare_account_id              = "33333333333333333333333333333333"
    cloudflare_zone_id                 = "cccccccccccccccccccccccccccccccc"
    vercel_team_id                     = "team_productionvalidation"
    api_hostname                       = "api.example.com"
    web_hostname                       = "app.example.com"
    clerk_issuer                       = "https://clerk.example.com"
    clerk_publishable_key              = "pk_live_Y2xlcmsuZXhhbXBsZS5jb20k"
    provider_approved_session_capacity = 3
    mcp_requests_per_minute            = 60
    mcp_requests_per_hour              = 600
    oauth_clients = [{
      client_class  = "approved"
      client_id     = "approved-client"
      client_name   = "Approved MCP Client"
      redirect_uris = ["https://client.example.test/callback"]
    }]
  }

  assert {
    condition     = cloudflare_worker.api.name == "whatsapp-mcp-api"
    error_message = "Production must retain the canonical API Worker name."
  }

  assert {
    condition     = cloudflare_worker.provider_control.name == "whatsapp-mcp-provider-control"
    error_message = "Production must retain the canonical provider-control Worker name."
  }

  assert {
    condition     = output.provider_control_service == "whatsapp-mcp-provider-control"
    error_message = "Provider-control must be exported only as a service-binding target."
  }

  assert {
    condition = (
      cloudflare_r2_managed_domain.webhook_ingress.enabled == false &&
      cloudflare_r2_managed_domain.stored_media.enabled == false &&
      cloudflare_r2_managed_domain.deletion_capsules.enabled == false &&
      cloudflare_r2_managed_domain.deletion_markers.enabled == false
    )
    error_message = "Every R2 bucket must explicitly disable its public r2.dev domain."
  }

  assert {
    condition = one([
      for rule in cloudflare_r2_bucket_lifecycle.webhook_ingress.rules :
      rule.delete_objects_transition.condition.max_age
      if rule.id == "expire-encrypted-webhook-events"
    ]) == 604800
    error_message = "Encrypted Webhook Events must expire after seven days."
  }

  assert {
    condition = one([
      for rule in cloudflare_r2_bucket_lock.deletion_markers.rules :
      rule.condition.type
      if rule.id == "retain-deletion-markers"
    ]) == "Indefinite"
    error_message = "Deletion markers must be protected by an indefinite bucket lock."
  }

  assert {
    condition = (
      cloudflare_queue.connection_setup_provisioning.settings.message_retention_period == 604800 &&
      cloudflare_queue_consumer.connection_setup_provisioning.script_name == cloudflare_worker.api.name &&
      cloudflare_queue_consumer.connection_setup_provisioning.settings.batch_size == 1 &&
      cloudflare_queue_consumer.connection_setup_provisioning.settings.max_retries == 10 &&
      cloudflare_queue_consumer.connection_setup_provisioning.settings.retry_delay == 30 &&
      cloudflare_queue_consumer.connection_setup_provisioning.settings.visibility_timeout_ms == 180000 &&
      cloudflare_queue_consumer.ingestion.dead_letter_queue == cloudflare_queue.dead_letter.queue_name &&
      cloudflare_queue_consumer.ingestion.settings.max_retries == 7 &&
      cloudflare_queue_consumer.ingestion.settings.retry_delay == 10800 &&
      cloudflare_queue_consumer.dead_letter.settings.max_retries == 100 &&
      cloudflare_queue_consumer.dead_letter.settings.retry_delay == 300 &&
      cloudflare_queue.dead_letter.settings.message_retention_period == 345600
    )
    error_message = "Provisioning, ingestion, and dead-letter Queues must retain their bounded production delivery policies."
  }

  assert {
    condition = (
      cloudflare_queue_consumer.ingestion.script_name == cloudflare_worker.api.name &&
      cloudflare_queue_consumer.dead_letter.script_name == cloudflare_worker.api.name
    )
    error_message = "The API Worker must actively consume both ingestion and dead-letter queues."
  }

  assert {
    condition = toset([
      for schedule in cloudflare_workers_cron_trigger.api.schedules : schedule.cron
    ]) == toset(["* * * * *", "*/5 * * * *", "0 * * * *"])
    error_message = "The API Worker must schedule maintenance, five-minute health reconciliation, and hourly retention work."
  }
}

run "reject_same_web_and_api_origin" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    deployment_environment             = "production"
    cloudflare_account_id              = "33333333333333333333333333333333"
    cloudflare_zone_id                 = "cccccccccccccccccccccccccccccccc"
    vercel_team_id                     = "team_productionvalidation"
    api_hostname                       = "app.example.com"
    web_hostname                       = "app.example.com"
    clerk_issuer                       = "https://clerk.example.com"
    clerk_publishable_key              = "pk_live_Y2xlcmsuZXhhbXBsZS5jb20k"
    provider_approved_session_capacity = 3
    mcp_requests_per_minute            = 60
    mcp_requests_per_hour              = 600
    oauth_clients = [{
      client_class  = "approved"
      client_id     = "approved-client"
      client_name   = "Approved MCP Client"
      redirect_uris = ["https://client.example.test/callback"]
    }]
  }

  expect_failures = [vercel_project.web]
}
