# ADR-0016: AGPL Containers in Distributed Software — Licensing Analysis

**Status:** Proposed
**Date:** 2026-03-05
**Context:** ADR-0003 excluded Grafana (AGPL) and Loki (AGPL) from the observability stack. This analysis revisits that constraint for unmodified, containerized deployment.

> **Disclaimer:** This analysis has not been reviewed by legal counsel. It reflects Ian's best-effort research based on publicly available sources.

> **TL;DR:** Shipping unmodified AGPL containers alongside proprietary code is legally safe — the [AGPL aggregate clause](https://choosealicense.com/licenses/agpl-3.0/) explicitly exempts it, [Red Hat's legal counsel](https://opensource.com/article/18/1/containers-gpl-and-copyleft) confirms containers don't trigger copyleft across boundaries, and [Grafana's CEO](https://grafana.com/blog/2021/04/20/qa-with-our-ceo-on-relicensing/) states "unmodified distributions are not affected." Additionally, catalyst-router is itself open source, which further reduces any AGPL risk — source availability obligations are already satisfied.

## What is AGPL?

The GNU Affero General Public License v3 (AGPLv3) is a copyleft license. It extends the GPL with one addition: if you run modified AGPL software as a network service, you must provide the source code to users who interact with it over the network. This closes the "SaaS loophole" where companies modify GPL software and offer it as a service without releasing changes.

AGPL triggers source-disclosure obligations when you either:

1. **Distribute** the software (give copies to others), or
2. **Offer it as a network service** (users interact with it remotely)

## Does AGPL apply to our case?

**No.** Our use case — shipping unmodified Grafana and Loki as separate Docker containers in a compose file — does not trigger copyleft on our code. Three independent legal bases support this:

### 1. The AGPL "aggregate" clause (license text)

Section 5 of the AGPLv3 states:

> "A compilation of a covered work with other separate and independent works, which are not by their nature extensions of the covered work, and which are not combined with it such as to form a larger program, in or on a volume of a storage or distribution medium, is called an 'aggregate' [...] **Inclusion of a covered work in an aggregate does not cause this License to apply to the other parts of the aggregate.**"

A docker-compose file referencing independent container images is an aggregate — separate programs on the same distribution medium. Our services are separate codebases, separate binaries, separate processes, communicating only via HTTP.

**Source:** [AGPLv3 Full Text, Section 5](https://choosealicense.com/licenses/agpl-3.0/)

### 2. Containers are separate programs (legal consensus)

Richard Fontana, Senior Commercial Counsel at Red Hat, analyzed this directly:

> "There is nothing in the technical makeup of containers or container images that suggests a need to apply a special form of copyleft scope analysis."

> "The code will run as separate processes, and the whole technical point of using containers is isolation from other software."

> "Communication between containers by way of network interfaces is analogous to such mechanisms as pipes and sockets."

The FSF considers pipes, sockets, and network interfaces as mechanisms "normally suggestive of separateness" — the opposite of derivative-work integration.

FOSSA's compliance analysis states: "Each container is by definition considered a separate program, so there isn't a viral licensing effect between containers."

**Sources:**

- [Containers, the GPL, and Copyleft: No Reason for Concern — Richard Fontana, Red Hat](https://opensource.com/article/18/1/containers-gpl-and-copyleft)
- [Containers and Open Source License Compliance — FOSSA](https://fossa.com/blog/containers-open-source-license-compliance/)

### 3. Grafana Labs confirms unmodified distribution is fine

Grafana Labs CEO Raj Dutt stated directly:

> "Unmodified distributions are not affected."

He cited Red Hat OpenShift and Cloud Foundry as companies that distribute Grafana within their platforms without issue, because "that source is already open, so there is no issue."

**Source:** [Q&A with Grafana Labs CEO on Relicensing](https://grafana.com/blog/2021/04/20/qa-with-our-ceo-on-relicensing/)

### 4. Catalyst Router is open source

Catalyst Router is itself an open-source project. Even if the above analysis were incorrect, AGPL's core obligation is source availability — which is already satisfied by the project being publicly available. The risk of AGPL copyleft affecting the project is negligible when the source is already open.

## Our only obligation

When distributing unmodified AGPL binaries, we must make the corresponding source available to recipients. Grafana and Loki source code is publicly available on GitHub. No additional action is required beyond ensuring recipients can access it (e.g., a note in documentation pointing to the upstream repositories).

## Risk-reduction option

Grafana Labs offers a free, proprietary-licensed Enterprise binary with identical functionality:

> "Users who don't intend to modify Grafana code can simply use our Enterprise download. This is a free-to-use, proprietary-licensed, compiled binary that matches the features of the AGPL version."

Switching from `grafana/grafana-oss` to `grafana/grafana-enterprise` eliminates AGPL from Grafana entirely at no cost. A proprietary-licensed Loki binary is not yet available.

**Source:** [Grafana Labs Licensing](https://grafana.com/licensing/)

## What would trigger AGPL problems

For clarity, here is what _would_ create AGPL obligations on our code:

- **Modifying** Grafana/Loki source code and distributing those modifications
- **Linking** our code against Grafana/Loki libraries in the same process
- **Forking** and distributing a modified version without publishing changes

None of these apply to our use case.

## Decision

ADR-0003's blanket AGPL exclusion was appropriate as a conservative default. However, for containerized, unmodified deployment, the legal risk is negligible. We may include Grafana and Loki as optional observability containers in the distribution, with the following conditions:

1. Containers run unmodified upstream images (no source modifications)
2. Documentation references upstream source repositories for AGPL compliance
3. Consider switching Grafana to the free Enterprise image to eliminate AGPL entirely
