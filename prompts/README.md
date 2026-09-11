# Prompt registry

Every prompt used by the workflows in this repository lives here as a Markdown
file with front matter. **08 GitOps Prompt Management** fetches these files from
GitHub at run time and returns the rendered prompt together with the blob SHA it
came from, so every model call can be traced to an exact prompt version.

## File format

    ---
    id: research/planner            # must equal <folder>/<filename without .md>
    version: 3                      # positive integer, bump on every change
    description: One line.
    variables: [objective, depth]   # every {{name}} used in the body
    owner: platform
    updated: 2026-09-08
    ---
    Body text with {{objective}} placeholders.

Rules enforced by `scripts/validate-prompts.py`:

1. Front matter parses and contains id, version, description, variables, owner, updated.
2. `id` matches the file path.
3. `version` is a positive integer.
4. Every `{{placeholder}}` in the body is declared in `variables`.
5. Every declared variable is used at least once.
6. The body is non-empty and `updated` is an ISO date.
7. Prompt ids are unique across the registry.

## Changing a prompt

Edit the file, bump `version`, commit. No workflow JSON is edited and no n8n node
is touched. The next execution picks up the new content and reports the new SHA.

## Rolling back

Pass a previous commit SHA or tag as the `ref` input to 08. The registry resolves
any Git ref, so a rollback is just a different `ref`. Pin a `ref` in a caller when
you need a frozen prompt for a reproducible run; leave it empty to track `main`.

## Directories

| Folder | Used by |
| --- | --- |
| `api-integration/` | 01 Autonomous API Integration Engineer |
| `rag/` | 03 Production RAG Intelligence |
| `research/` | 04 Autonomous Research Agent |
| `governance/` | 05 Agent Governance |
| `finance/` | 06 Financial Document Intelligence |
| `analytics/` | 07 Conversational Analytics |
| `verification/` | 09 AI Output Verification |
| `voice/` | 10 Real-Time Voice Agent |
| `shared/` | Cross-cutting system prompts |
