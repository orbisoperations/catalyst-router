group "core" {
  targets = ["gateway", "orchestrator", "auth", "envoy", "web-ui", "video"]
}

target "gateway" {
  context    = "."
  dockerfile = "apps/gateway/Dockerfile"
  tags       = ["catalyst-gateway:local"]
}

target "orchestrator" {
  context    = "."
  dockerfile = "apps/orchestrator/Dockerfile"
  tags       = ["catalyst-orchestrator:local"]
}

target "auth" {
  context    = "."
  dockerfile = "apps/auth/Dockerfile"
  tags       = ["catalyst-auth:local"]
}

target "envoy" {
  context    = "."
  dockerfile = "apps/envoy/Dockerfile"
  tags       = ["catalyst-envoy:local"]
}

target "web-ui" {
  context    = "."
  dockerfile = "apps/web-ui/Dockerfile"
  tags       = ["catalyst-web-ui:local"]
}

target "video" {
  context    = "."
  dockerfile = "apps/video/Dockerfile"
  tags       = ["catalyst-video:local"]
}

