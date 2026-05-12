# Manifest starter template

Template for new CrossEngin manifests.

## How to create a manifest from this template

```bash
cp -r manifests/_starter manifests/<your-pack>/<your-vertical>
# then edit manifest.yaml
```

For example, to create a community-pharmacy manifest under the
Pharma + Healthcare pack:

```bash
cp -r manifests/_starter manifests/operate-pharma-healthcare/community-pharmacy
```

## Manifest format

The declarative bundle format is defined by **ADR-0004 (Manifest
specification)**. A manifest declares:

- **entities** — names, fields, validation, indexes
- **relations** — one-to-many / many-to-many / hierarchies
- **workflows** — state machines + transitions per entity
- **roles** — permission set per role (per ADR-0008)
- **views** — list / record / kanban / calendar / map / dashboard / form (per ADR-0018)
- **integrations** — webhooks, OAuth, EDI / HL7 / FHIR / UBL (per ADR-0011)
- **compliance_pack** — reference to a regulatory bundle (per ADR-0012)

## Status

Placeholder. The concrete YAML / JSON schema is materialized in
Phase 3 alongside the kernel's manifest interpreter.
