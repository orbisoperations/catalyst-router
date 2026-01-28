/**
 * @catalyst/telemetry — Shared resource builder
 *
 * Creates an OpenTelemetry Resource from service metadata.
 * Used by both tracer and meter to avoid duplication.
 */

import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'

const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name'

interface ResourceOptions {
  serviceName: string
  serviceVersion?: string
  environment?: string
}

export function buildResource(opts: ResourceOptions) {
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: opts.serviceName,
    [ATTR_SERVICE_VERSION]: opts.serviceVersion ?? '0.0.0',
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: opts.environment ?? 'development',
  })
}
