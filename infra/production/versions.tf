terraform {
  required_version = "= 1.12.5"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.22.0"
    }
    neon = {
      source  = "kislerdm/neon"
      version = "0.14.0"
    }
    postgresql = {
      source  = "cyrilgdn/postgresql"
      version = "1.26.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.7.2"
    }
  }

  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}

provider "cloudflare" {}
provider "neon" {}
provider "postgresql" {
  host      = neon_project.private_beta.database_host
  port      = 5432
  database  = local.database_name
  username  = neon_project.private_beta.database_user
  password  = neon_project.private_beta.database_password
  sslmode   = "require"
  superuser = false
}
provider "random" {}
