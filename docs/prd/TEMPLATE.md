# PRD: [Feature/Product Name]

| Field            | Value                        |
| ---------------- | ---------------------------- |
| **Author**       | @name                        |
| **Status**       | Draft / In Review / Approved |
| **Last Updated** | YYYY-MM-DD                   |
| **Reviewers**    | @design-lead, @eng-lead      |

## Change History

| Date       | Author | Changes       |
| ---------- | ------ | ------------- |
| YYYY-MM-DD | @name  | Initial draft |

---

## 1. Problem Statement

### What problem are we solving?

[1-2 paragraphs describing the problem. Be specific about who experiences it and in what context.]

### Why now?

[What's changed that makes this urgent? Market shift, customer feedback volume, competitive pressure, strategic priority?]

### Customer Evidence

**Quantitative:**

- [X% of users abandon at step Y (source: analytics)]
- [$X revenue impact per month (source: finance)]
- [X support tickets/week mentioning this (source: Zendesk)]

**Qualitative:**

> "[Direct customer quote about the pain point]"
> — Customer Name, Segment (source: interview/survey/support ticket)

> "[Another quote showing different angle]"
> — Customer Name, Segment

**Research:** [Link to user research, surveys, competitive analysis]

### Competitive Context

| Competitor     | How They Solve It | Gap/Opportunity         |
| -------------- | ----------------- | ----------------------- |
| [Competitor A] | [Their approach]  | [What we can do better] |
| [Competitor B] | [Their approach]  | [What we can do better] |

---

## 2. Target Users

### Primary User: [Persona Name]

**Who:** [Role/description]
**Pain points:**

- [Specific pain point 1]
- [Specific pain point 2]

**Why they matter:** [Revenue, volume, strategic importance]

### Secondary User: [Persona Name]

**Who:** [Role/description]
**Pain points:**

- [Specific pain point]

**Why they matter:** [Why include them in scope]

---

## 3. Goals & Success Metrics

### Goals

1. **[Goal 1]** - [Measurable outcome, e.g., "Reduce checkout abandonment by 20%"]
2. **[Goal 2]** - [Measurable outcome]

### Success Metrics

| Metric             | Baseline        | Target                  | Measurement          | Owner |
| ------------------ | --------------- | ----------------------- | -------------------- | ----- |
| [Primary KPI]      | [Current value] | [Target value]          | [How/where measured] | @name |
| [Secondary KPI]    | [Current value] | [Target value]          | [How/where measured] | @name |
| [Guardrail metric] | [Current value] | [Don't regress below X] | [How/where measured] | @name |

### How We'll Know We Failed

[What would indicate this was the wrong solution? Be honest about what failure looks like.]

---

## 4. User Journeys

### Journey 1: [Primary Use Case Name]

**Trigger:** [What initiates this journey]
**User goal:** [What they're trying to accomplish]

| Step | User Action | System Response | Notes |
| ---- | ----------- | --------------- | ----- |
| 1    | [Action]    | [Response]      |       |
| 2    | [Action]    | [Response]      |       |
| 3    | [Action]    | [Response]      |       |

**Success state:** [How user knows they succeeded]

### Journey 2: [Secondary Use Case Name]

**Trigger:** [What initiates this journey]
**User goal:** [What they're trying to accomplish]

[Steps...]

---

## 5. Requirements

### P0 - Must Have (Launch Blockers)

| ID   | Requirement   | Rationale       | Acceptance Criteria                        |
| ---- | ------------- | --------------- | ------------------------------------------ |
| P0-1 | [Requirement] | [Why essential] | - [ ] [Criterion 1]<br>- [ ] [Criterion 2] |
| P0-2 | [Requirement] | [Why essential] | - [ ] [Criterion]                          |

### P1 - Should Have (Important)

| ID   | Requirement   | Rationale       | Acceptance Criteria |
| ---- | ------------- | --------------- | ------------------- |
| P1-1 | [Requirement] | [Why important] | - [ ] [Criterion]   |

### P2 - Nice to Have (Enhancements)

| ID   | Requirement   | Rationale     | Acceptance Criteria |
| ---- | ------------- | ------------- | ------------------- |
| P2-1 | [Requirement] | [Why desired] | - [ ] [Criterion]   |

---

## 6. Non-Goals (Out of Scope)

Explicitly NOT included in this initiative:

| Item                 | Reason         | Future Consideration? |
| -------------------- | -------------- | --------------------- |
| [Feature/scope item] | [Why excluded] | [Yes - Q3 / No / TBD] |
| [Feature/scope item] | [Why excluded] | [Yes/No/TBD]          |

---

## 7. Design

**Design Lead:** @designer
**Design Status:** Not Started / In Progress / Complete

### Key Screens/Flows

[Link to Figma/design files]

### User Flow Diagram

```
[Start] → [Step 1] → [Decision Point] → [Step 2A] → [End]
                           ↓
                      [Step 2B] → [End]
```

### Design Principles for This Feature

- [Principle 1, e.g., "Progressive disclosure - don't overwhelm on first use"]
- [Principle 2]

---

## 8. Assumptions & Risks

### Assumptions

| Assumption     | How We'll Validate  | Impact if Wrong |
| -------------- | ------------------- | --------------- |
| [Assumption 1] | [Validation method] | [What happens]  |
| [Assumption 2] | [Validation method] | [What happens]  |

### Risks

| Risk     | Likelihood | Impact | Mitigation        |
| -------- | ---------- | ------ | ----------------- |
| [Risk 1] | H/M/L      | H/M/L  | [Mitigation plan] |
| [Risk 2] | H/M/L      | H/M/L  | [Mitigation plan] |

---

## 9. Dependencies

| Dependency     | Team/System | Status   | Impact if Delayed | Contact |
| -------------- | ----------- | -------- | ----------------- | ------- |
| [Dependency 1] | [Team]      | [Status] | [Impact]          | @name   |
| [Dependency 2] | [Team]      | [Status] | [Impact]          | @name   |

---

## 10. Timeline

| Milestone           | Target Date | Status | Notes |
| ------------------- | ----------- | ------ | ----- |
| PRD Approved        | [Date]      |        |       |
| Design Complete     | [Date]      |        |       |
| Eng Kickoff         | [Date]      |        |       |
| Dev Complete        | [Date]      |        |       |
| QA Complete         | [Date]      |        |       |
| Beta/Staged Rollout | [Date]      |        |       |
| GA Launch           | [Date]      |        |       |

---

## 11. Go-to-Market

_[Include for customer-facing launches]_

### Launch Type

- [ ] Silent (no announcement)
- [ ] Soft launch (limited announcement)
- [ ] Full launch (marketing, comms, etc.)

### GTM Checklist

- [ ] Marketing: [What's needed]
- [ ] Sales enablement: [What's needed]
- [ ] Support documentation: [What's needed]
- [ ] Customer comms: [What's needed]

---

## 12. Open Questions

| Question     | Owner | Due Date | Resolution                   |
| ------------ | ----- | -------- | ---------------------------- |
| [Question 1] | @name | [Date]   | [Pending / Resolved: answer] |
| [Question 2] | @name | [Date]   | [Pending / Resolved: answer] |

---

## Appendix

### A. Research & References

- [Link to user research]
- [Link to competitive analysis]
- [Link to analytics dashboard]

### B. Technical Considerations

- [Link to technical design doc / ADR]
- [Known technical constraints]

### C. Related PRDs

- [Link to related PRD 1]
- [Link to related PRD 2]
