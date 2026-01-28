# OTEL Collector Configuration

OpenTelemetry Collector configuration for the Catalyst Node observability stack.

## Overview

The collector acts as a central hub for all telemetry:

```
Services → OTLP HTTP/gRPC → Collector → Backends
                                │
                    ┌───────────┼───────────┐
                    ▼           ▼           ▼
                 Jaeger    Prometheus   InfluxDB
                (traces)   (metrics)     (logs)
```

## Configuration

### `otel-collector-config.yaml`

#### Receivers

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
```

Services send telemetry to:

- **gRPC**: `localhost:4317`
- **HTTP**: `localhost:4318`

#### Processors

```yaml
processors:
  memory_limiter: # Prevent OOM
  batch: # Batch exports for efficiency
  attributes: # Add/modify attributes
```

#### Exporters

| Exporter                | Target           | Signal         |
| ----------------------- | ---------------- | -------------- |
| `otlp/jaeger`           | Jaeger :4317     | Traces         |
| `prometheusremotewrite` | Prometheus :9090 | Metrics        |
| `influxdb`              | InfluxDB :8086   | Logs           |
| `debug`                 | stdout           | All (dev only) |

#### Pipelines

```yaml
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch, attributes]
      exporters: [otlp/jaeger, debug]

    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheusremotewrite, debug]

    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [influxdb, debug]
```

## Customization

### Add Sampling

```yaml
processors:
  probabilistic_sampler:
    sampling_percentage: 10

  tail_sampling:
    decision_wait: 10s
    policies:
      - name: errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow
        type: latency
        latency: { threshold_ms: 1000 }
```

### Add Resource Attributes

```yaml
processors:
  resource:
    attributes:
      - key: deployment.environment
        value: production
        action: upsert
      - key: service.namespace
        value: catalyst
        action: upsert
```

### Filter Telemetry

```yaml
processors:
  filter/traces:
    traces:
      span:
        - 'attributes["http.route"] == "/health"'
```

## Debugging

Enable verbose logging:

```yaml
service:
  telemetry:
    logs:
      level: debug
```

Check collector metrics:

```bash
curl http://localhost:8888/metrics
```

## Production Considerations

1. **Remove debug exporter** — logs all telemetry to stdout
2. **Add authentication** — use `bearertokenauth` extension
3. **Enable TLS** — configure `tls:` on receivers/exporters
4. **Tune memory limits** — adjust based on traffic
5. **Add tail sampling** — reduce storage costs

## Reference

- [OTEL Collector Docs](https://opentelemetry.io/docs/collector/)
- [Collector Configuration](https://opentelemetry.io/docs/collector/configuration/)
- [Available Components](https://github.com/open-telemetry/opentelemetry-collector-contrib)
