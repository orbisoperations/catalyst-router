# Request For Information (RFI) / Advanced Requirements

## Post-Quantum Cryptography (PQC) Support

**Objective**: Secure transport layer against future quantum decryption capabilities.

- **Requirement**: Support **TLS 1.3** with **Kyber** key encapsulation mechanism (KEM).
- **Target Component**: Data Plane (Envoy Proxy).
- **Technical Challenge**: Standard Envoy distributions link against BoringSSL. We need to verify if the upstream BoringSSL used by Envoy supports Kyber, or if we need to switch to a PQC-enabled fork (like `OQS-OpenSSL` aka Open Quantum Safe) or a specific Google BoringSSL branch.
- **Implementation Strategy**:
  - **Strategy**: **Docker Build Container**.
    1.  Create a base Docker image that compiles **OpenSSL with Kyber support**.
    2.  Use this base image to compile **Envoy** (linking against the custom SSL).
    3.  Resulting binary is copied to the final runtime image.
  - **Benefit**: This isolates the complex Bazel/C++ toolchain from the local developer machine (macOS), ensuring that "it works on my machine" means "it works in the container."

## PKI & mTLS Infrastructure

**Objective**: Simple, team-accessible PKI for enabling mTLS between nodes and plugins during development and testing.

- **Requirement**: A lightweight Certificate Authority (CA) solution available to the whole team.
- **Target**: Local development and testing environment.
- **Potential Solutions**:
  - **cfssl** or **easyrsa**: Standard tools for managing simple CAs.
  - **Smallstep step-ca**: More modern, automated.
  - **Custom scripts**: Simple `openssl` wrappers committed to the repo.
- **Action Item**: Define a "make certs" workflow that generates valid test certificates for developers instantly.

## Deployment & Infrastructure

**Objective**: Transition from Fly.io to Google Cloud Platform (GCP) with robust Infrastructure-as-Code (IaC).

- **Target Cloud**: **GCP** (Google Cloud Platform).
- **Deployment Model**: **Config-Driven Automation (GitOps)**.
  - _Decision_: We will NOT build a "Click-to-Spin-Up" dynamic UI for now.
  - _Rationale_: Business model supports scheduled/config-based updates. JIT provisioning is unnecessary complexity.
- **Requirements**:
  - **IaC Tooling**: Selection needed (Terraform, Pulumi, or OpenTofu?) to provision resources.
  - **Registry**: GCP Artifact Registry for our Docker images.
  - **Compute**: Decide between Cloud Run (Serverless) vs GKE (Kubernetes) vs GCE (VMs).
    - _Note_: Cloud Run is eager to scale to zero, which might conflict with our BGP-style long-lived connections.
