mock_provider "cloudflare" {}
mock_provider "vercel" {}

run "development_topology" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    deployment_environment = "development"
    cloudflare_account_id  = "11111111111111111111111111111111"
    cloudflare_zone_id     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    vercel_team_id         = "team_developmentvalidation"
    api_hostname           = "api.dev.example.com"
    web_hostname           = "app.dev.example.com"
  }

  assert {
    condition     = cloudflare_workers_script.api.script_name == "whatsapp-mcp-api-development"
    error_message = "Development must have an environment-specific API Worker."
  }

  assert {
    condition     = cloudflare_workers_script.provider_control.script_name == "whatsapp-mcp-provider-control-development"
    error_message = "Development must have an environment-specific provider-control Worker."
  }

  assert {
    condition = one([
      for binding in cloudflare_workers_script.api.bindings :
      binding.service if binding.name == "PROVIDER_CONTROL"
    ]) == cloudflare_workers_script.provider_control.script_name
    error_message = "The API must bind to provider-control in the same environment."
  }

  assert {
    condition = (
      cloudflare_workers_script_subdomain.api.enabled == false &&
      cloudflare_workers_script_subdomain.api.previews_enabled == false &&
      cloudflare_workers_script_subdomain.provider_control.enabled == false &&
      cloudflare_workers_script_subdomain.provider_control.previews_enabled == false
    )
    error_message = "Workers must not expose workers.dev or preview ingress."
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
}

run "preview_topology" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    deployment_environment = "preview"
    cloudflare_account_id  = "22222222222222222222222222222222"
    cloudflare_zone_id     = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    vercel_team_id         = "team_previewvalidation"
    api_hostname           = "api.preview.example.com"
    web_hostname           = "app.preview.example.com"
  }

  assert {
    condition     = cloudflare_workers_script.api.script_name == "whatsapp-mcp-api-preview"
    error_message = "Preview must have an environment-specific API Worker."
  }

  assert {
    condition     = cloudflare_workers_script.provider_control.script_name == "whatsapp-mcp-provider-control-preview"
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
    deployment_environment = "production"
    cloudflare_account_id  = "33333333333333333333333333333333"
    cloudflare_zone_id     = "cccccccccccccccccccccccccccccccc"
    vercel_team_id         = "team_productionvalidation"
    api_hostname           = "api.example.com"
    web_hostname           = "app.example.com"
  }

  assert {
    condition     = cloudflare_workers_script.api.script_name == "whatsapp-mcp-api"
    error_message = "Production must retain the canonical API Worker name."
  }

  assert {
    condition     = cloudflare_workers_script.provider_control.script_name == "whatsapp-mcp-provider-control"
    error_message = "Production must retain the canonical provider-control Worker name."
  }

  assert {
    condition     = output.provider_control_service == "whatsapp-mcp-provider-control"
    error_message = "Provider-control must be exported only as a service-binding target."
  }
}

run "reject_same_web_and_api_origin" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    deployment_environment = "production"
    cloudflare_account_id  = "33333333333333333333333333333333"
    cloudflare_zone_id     = "cccccccccccccccccccccccccccccccc"
    vercel_team_id         = "team_productionvalidation"
    api_hostname           = "app.example.com"
    web_hostname           = "app.example.com"
  }

  expect_failures = [vercel_project.web]
}
