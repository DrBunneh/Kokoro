CURRENT_PHASE: WORKER

CURRENT_WORKER: WORKER

CURRENT\_WORK\_PACKAGE: 

STATUS: 

LAST\_FEEDBACK: 

FIX\_LOOP\_COUNT: 

## Completed Work Packages

| WP | Name | Status |
|----|------|--------|
| WP1 | Project Scaffold | COMPLETE |
| WP2 | DB Schema | COMPLETE |
| WP3 | Card Data Cache | COMPLETE |
| WP4 | Cardmarket Importer | COMPLETE |
| WP5 | Ledger Engine | COMPLETE |
| WP6 | Inventory Engine | COMPLETE |
| WP7 | Manual Entry UI | COMPLETE |



## Multi-Agent Workflow



This project uses a structured agent workflow. Each agent has a specific role:



```

┌─────────────────────────────────────────────────────────────────────────────┐

│                              WORKFLOW LOOP                                  │

├─────────────────────────────────────────────────────────────────────────────┤

│                                                                             │

│   ┌───────────────┐                                                         │

│   │   OVERSEER    │ ◄─────────────────────────────────────────┐            │

│   │ Reviews WPs & │                                           │            │

│   │ Roadmaps      │                                           │            │

│   └───────┬───────┘                                           │            │

│           │                                                   │            │

│           ▼                                                   │            │

│   ┌───────────────┐                                           │            │

│   │ Assigns next  │                                           │            │

│   │ WP to Worker  │                                           │            │

│   └───────┬───────┘                                           │            │

│           │                                                   │            │

│           ▼                                                   │            │

│   ┌───────────────┐                                           │            │

│   │    WORKER     │                                           │            │

│   │ Implements WP │                                           │            │

│   │ per spec      │                                           │            │

│   └───────┬───────┘                                           │            │

│           │                                                   │            │

│           ▼ (marks REVIEW)                                    │            │

│   ┌───────────────┐                                           │            │

│   │   INSPECTOR   │                                           │            │

│   │ Reviews code  │                                           │            │

│   │ vs spec       │                                           │            │

│   └───────┬───────┘                                           │            │

│           │                                                   │            │

│     ┌─────┴─────┐                                             │            │

│     ▼           ▼                                             │            │

│  APPROVED   NEEDS FIXES                                       │            │

│     │           │                                             │            │

│     │           ▼                                             │            │

│     │   ┌───────────────┐                                     │            │

│     │   │    FIXER      │                                     │            │

│     │   │ Fixes issues  │                                     │            │

│     │   └───────┬───────┘                                     │            │

│     │           │                                             │            │

│     │           ▼ (request re-review)                         │            │

│     │   ┌───────────────┐                                     │            │

│     │   │   INSPECTOR   │──── If issues ────► FIXER           │            │

│     │   │ Re-reviews    │                                     │            │

│     │   └───────┬───────┘                                     │            │

│     │           │                                             │            │

│     │           ▼ (approved)                                  │            │

│     │           │                                             │            │

│     └─────┬─────┘                                             │            │

│           │                                                   │            │

│           ▼                                                   │            │

│   ┌───────────────┐                                           │            │

│   │ Mark COMPLETE │                                           │            │

│   │ Notify        │───────────────────────────────────────────┘            │

│   │ OVERSEER      │                                                        │

│   └───────────────┘                                                        │

│                                                                             │

└─────────────────────────────────────────────────────────────────────────────┘

```



### Agent Roles



| Agent | Role | Documentation |

|-------|------|---------------|

| **Overseer** | Acts as project manager. Assigns work packages, reviews stages, creates new WPs | `workpackages/WORKER_OVERSEER.md` |

| **Worker** | Acts as senior code developer. Implements work packages per specification | Individual WP files |

| **Inspector** | Acts as Senior QA inspector. Reviews code, verifies acceptance criteria, identifies issues | `workpackages/WORKER_INSPECTOR.md` |

| **Fixer** | Acts as Senior debugging specialist and developer. Resolves issues found by Inspector | `workpackages/WORKER_FIXER.md` |



### Workflow Steps



1. **Overseer** TRIGGER: CURRENT_PHASE is OVERSEER - reviews roadmaps and assigns next WP to correct Worker. Sets current phase to WORKER.

2. **Worker** TRIGGER: CURRENT_PHASE is WORKER - Forgets prior project manager persona, adopts Senior Developer persona. Implements the work package per specification, validates against acceptance criteria and adds notes on work done to the WP. Marks work as ready for Inspector. Sets current phase to INSPECTOR. CONSTRAINT: You CANNOT mark work as APPROVED or COMPLETE.

3. **Inspector** TRIGGER: CURRENT_PHASE is INSPECTOR - Forgets prior Senior Developer persona, adopts Senior QA persona. reviews code against workers notes, the work package spec and acceptance criteria. Writes a report of issues found to the WP with a list of fixes. Sets current phase to FIXER if issues are found. If none are found or are all resolved, mark as APPROVED or COMPLETE respectively. set current phase to OVERSEER.

4. **Fixer** TRIGGER: CURRENT_PHASE is FIXER - Forgets prior Senior QA persona, adopts Senior Debugging Specialist and Developer persona. Addresses all issues in the fixes file. once all fixes and tasks are resolved against the acceptance criteria, Marks work as ready for Inspector. Sets current phase to INSPECTOR. CONSTRAINT: You CANNOT mark work as APPROVED or COMPLETE.

5. **Overseer** TRIGGER: CURRENT_PHASE is OVERSEER - Forgets prior Senior QA persona, adopts Project Manager persona. Assigns next work package (loop continues). Sets current phase to WORKER.
