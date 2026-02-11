# Contributing to Catalyst Node

Thank you for your interest in contributing to Catalyst Node. This document
explains the process for contributing to the project, from signing the
Contributor License Agreement to submitting your first pull request.

Catalyst Node is maintained by **Orbis Operations LLC**.

---

## Contributor License Agreement (CLA)

Before any contribution can be accepted, you must sign the project's Contributor
License Agreement. This is a one-time requirement.

The CLA ensures that:

- You **retain full copyright** over your contributions
- You grant Orbis Operations LLC a broad, irrevocable license to use, modify,
  sublicense, and distribute the contributed work
- The project can be maintained and, if necessary, relicensed in the future

### How to sign

1. Read the full agreement in [CLA.md](./CLA.md)
2. Print, sign, and scan the agreement (or apply a digital signature)
3. Email the signed copy to the project maintainers
4. Wait for confirmation before opening your first pull request

Pull requests from contributors who have not signed the CLA will not be reviewed.

---

## Getting started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally
3. **Install dependencies** with `bun install`
4. **Read** the [constitution.md](./constitution.md) -- it defines the
   architectural principles that all code must follow. Constitutional violations
   block merge with no exceptions.

---

## Development workflow

Catalyst Node uses **Graphite** for stacked pull requests. All branching,
committing, and submitting should use `gt` commands rather than raw `git`.

### Creating a branch and PR

```bash
# Sync with trunk
gt sync

# Stage your changes and create a stacked branch
gt add <files>
gt create -m "type(scope): description"

# Push immediately so the team has visibility
gt submit
```

### Commit message format

All commits must follow the **Conventional Commits** specification, enforced by
commitlint:

```
type(scope): description
```

- **type**: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, or `perf`
- **scope**: the package or area of the codebase (e.g., `auth`, `gateway`,
  `orchestrator`)
- **description**: lowercase, max 100 characters, no trailing period

Examples:

```
feat(gateway): add telemetry instrumentation
fix(auth): handle expired bootstrap tokens
test(orchestrator): add dispatch action coverage
```

---

## Pull request guidelines

### Size and scope

- **Under 600 lines** per PR
- **One logical change** per PR -- do not mix refactoring with new features
- Use stacked PRs to break large changes into reviewable pieces

### PR description

- Provide a clear summary of what changed and why
- Reference related issues where applicable
- Note any architectural decisions or trade-offs

### Checklist before submitting

- [ ] Code compiles without errors (`bun run lint` and type checking pass)
- [ ] Tests pass (`bun test`)
- [ ] New features include tests committed alongside the implementation
- [ ] Bug fixes include a regression test
- [ ] Documentation is updated if the change affects APIs, config, or CLI
- [ ] Commit messages follow the conventional format
- [ ] The PR stays within the 600-line guideline

---

## Coding conventions

The project's [constitution.md](./constitution.md) is the authoritative source
for coding standards. Key conventions include:

- **ESM modules** with `.js` extensions in all imports
- **Strict TypeScript** -- no `any`, no `@ts-ignore` without justification
- **Zod schemas** for validating all external boundaries
- **Discriminated union results** for operations that can fail
- **Dependency inversion** -- accept interfaces, not concrete implementations
- **kebab-case** file names, **PascalCase** types, **camelCase** functions
- **No `console.log`** -- use the `@catalyst/telemetry` package for all logging

---

## Testing

Catalyst Node follows test-driven development. Write tests before or alongside
your implementation, not as an afterthought.

- **Unit tests**: `*.test.ts` -- for core logic, no external dependencies
- **Integration tests**: `*.integration.test.ts` -- for cross-package boundaries
- **Topology tests**: `*.topology.test.ts` -- for orchestrator and peering flows
- **Container tests**: `*.container.test.ts` -- for end-to-end Docker-based
  validation (requires `CATALYST_CONTAINER_TESTS_ENABLED=true`)

Run tests with:

```bash
bun test
```

---

## Code review process

1. Submit your PR via `gt submit`
2. A maintainer will review your changes
3. Address any feedback by amending with `gt modify` and resubmitting
4. Once approved, a maintainer will merge the PR

Reviews focus on correctness, adherence to the constitution, test coverage, and
clarity. Constitutional violations are treated as critical findings and block
merge.

---

## Code of conduct

This project intends to adopt a formal code of conduct. In the meantime, all
participants are expected to treat each other with respect, communicate
constructively, and collaborate in good faith.

---

## License

By contributing to Catalyst Node, you agree that your contributions will be
licensed under the project's [LICENSE](./LICENSE) (Commons Clause + Elastic
License 2.0) and that you have signed the [CLA](./CLA.md).
