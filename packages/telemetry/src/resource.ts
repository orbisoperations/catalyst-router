/**
 * @catalyst/telemetry — Shared resource builder
 *
 * Creates an OpenTelemetry Resource from service metadata.
 * Used by both tracer and meter to avoid duplication.
 */

import { resourceFromAttributes, type Resource } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
// Incubating subpath — not subject to semver stability guarantees, but
// 'deployment.environment.name' has been stable in the spec since v1.25.
import { ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from '@opentelemetry/semantic-conventions/incubating'

interface ResourceOptions {
  serviceName: string
  serviceVersion?: string
  environment?: string
  serviceInstanceId?: string
}

/**
 * Build an OTel {@link Resource} from service metadata.
 *
 * Shared by the tracer, meter, and logger providers so every signal
 * reports the same `service.name`, `service.version`, and
 * `deployment.environment.name` attributes.
 */
export function buildResource(opts: ResourceOptions): Resource {
  const serviceInstanceId =
    opts.serviceInstanceId ?? process.env.OTEL_SERVICE_INSTANCE_ID ?? process.env.HOSTNAME
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? opts.serviceName,
    [ATTR_SERVICE_VERSION]: opts.serviceVersion ?? '0.0.0',
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: opts.environment ?? 'development',
    ...(serviceInstanceId ? { 'service.instance.id': serviceInstanceId } : {}),
  })
}
