# Observability and Logging Strategy

## Overview

We adopt a **hybrid observability architecture**.
1.  **Expose & Scrape**: The Router (Control Plane & Data Plane) exposes standard Prometheus metrics for the Agent to scrape.
2.  **Service Push**: The Router acts as a **Metric Sink** for the services it fronts. Services **PUSH** their metrics/logs to the local Router, which aggregates and exposes them.

## Architecture

We utilize a **Push-Aggregation-Scrape** model.

### 1. Services (Push)
- **Mechanism**: Services **PUSH** metrics to the Catalyst Node (Router) via a sidecar-compatible API (e.g., StatsD or HTTP equivalent).
- **Requirement**: Services **DO NOT** expose their own scrape endpoints.
- **Benefit**: Zero-config service discovery; the Router automatically aggregates everything it receives.

### 2. Catalyst Node (Aggregator & Local Endpoint)
- **Role**: Metric Sink & Aggregator.
- **Local Endpoint**: The Router exposes a live view of all aggregated metrics at `http://localhost:X/metrics` (Standard Prometheus format).
- **Usage**:
    1.  **Debugging**: Operators can `curl` this locally to see exact state.
    2.  **Collection**: The DataDog Agent (or Prometheus) scrapes this single endpoint to get the status of the Router AND all behind-it services.

#### 2. Data Plane (Envoy Proxy)
- **Native Support**: Envoy is configured to expose `/stats/prometheus`.
- **Metrics**: Global request rates, per-upstream latency, connection stats.

#### 3. Services (Fronted Applications)
- **Pattern**: **PUSH ONLY**.
- **Behavior**: Services do not run their own exporters. They push metrics (StatsD, OTLP, or HTTP JSON) to the local Catalyst Node (Router).
- **Benefit**: Services can be ephemeral or behind firewalls; they only need to know "localhost:RouterPort".

## Data Flow Diagram

```mermaid
graph LR
    subgraph "Catalyst Node (Router Host)"
        direction TB
        
        subgraph "Services"
            SvcA[Service A] --Push--> Router
            SvcB[Service B] --Push--> Router
        end

        subgraph "Control Plane"
            Router[Catalyst Node] --Exposes Aggregated--> MetricsEndpoint["/metrics"]
        end
        
        subgraph "Data Plane"
            Envoy[Envoy Proxy] --Exposes--> EnvoyStats["/stats/prometheus"]
        end
        
        Agent[Local Agent\n(DataDog / OTel / Prom)]
    end

    Agent --Scrapes--> MetricsEndpoint
    Agent --Scrapes--> EnvoyStats
    
    subgraph "Cloud Backend"
        Msg[DataDog / Prometheus]
    end

    Agent --Forwards--> Msg
```

## Plugin Interface

The Observability Plugin interface now includes methods for **receiving** metrics.

### Interface
```typescript
interface ObservabilityPlugin {
  // Define a metric (Internal)
  createCounter(name: string, help: string, labels?: string[]): Counter;
  createGauge(name: string, help: string, labels?: string[]): Gauge;
  
  // Ingestion (Service Push)
  ingestMetric(metricData: any): void;
  
  // Lifecycle
  startServer(port: number): void; // Starts the /metrics endpoint AND Push Receiver
}
```

### Advantages of Service Push to Router
1.  **Simplified Service Discovery**: The monitoring agent only needs to know about the Router, not every dynamic microservice container.
2.  **Aggregation**: The Router can pre-aggregate metrics (e.g., average latency across 10 service instances) before exposing them, reducing cardinality.
3.  **Security**: Services don't need to expose open HTTP ports for scraping; they strictly connect outbound to the local Router.
