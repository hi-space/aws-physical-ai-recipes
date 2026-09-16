# Template revision API

Templates expose `templateVersion`, `contentHash`, `revisionCreatedAt`, `revisionCreatedBy`, and `revisionOwnerSubject` in addition to existing content. Version numbers are positive integers. Hashes cover YAML, params, description, title, category and requirements; creation/ownership/audit fields do not change the content hash.

| Request | Result |
| --- | --- |
| GET `/api/templates` | Array of accessible current custom templates and current builtins |
| GET `/api/templates/:id` | Latest visible template |
| GET `/api/templates/:id?version=N` | Immutable revision N |
| GET `/api/templates/:id/versions` | Full accessible revisions, newest first |
| POST `/api/templates` | Save editable fields as a new revision, or return current revision for identical content |
| DELETE `/api/templates/:id` | Archive discovery metadata; retain immutable revisions |

POST fields: `id`, `title`, `description`, `category`, `yaml`, optional `params`, `requires`, and `baseVersion`. Ownership, builtin status, hashes and target revision numbers are server-controlled. For a strict edit, send the `baseVersion` returned by the last GET. Changed stale edits return 409. Identical current content remains idempotent even when retrying with an older base version.

To restore revision 1 when the current version is 3, GET `?version=1`, select only editable fields from that response, and POST them with `baseVersion: 3`. The response is revision 4. No prior revision is mutated. Archived templates can be read by explicit version/history and saved by an authorized owner/admin to create a new version. An archive racing an already-active save returns a conflict instead of being silently undone.

A project recipe is readable by project members and editable by its owner with project researcher permission, its project administrator, or platform administrator. Builtins cannot be changed through save/delete APIs. New recipes use the authenticated subject and selected project from the existing requestProject helper. Legacy projectless recipes remain private by ownerSubject/createdBy; editing preserves that privacy and original creator. Copy under a new ID to share into a project. Project-token restrictions apply to custom templates even for an administrator token.

The reusable helper is exported from `@/app/api/templates/_shared`:

```ts
canReadTemplate(session, template, repo = getRepo(), selectedProjectId?)
```

It returns a Promise<boolean>. The optional selectedProjectId rejects another project's custom template. Builtins remain readable; private legacy ownership still applies. `readTemplate(session, id, version?, repo?)` also performs builtin registration and 404 access handling. Parent workflow submission can independently resolve `repo.getTemplate(id, version)` and call `canReadTemplate(session, template, repo, project.id)`.

The parent may persist `Workflow.templateVersion`, `templateContentHash`, and `templateModified`; those optional type fields are available. Submission and execution are not changed by this feature.

Repository methods remain backward-compatible: `putTemplate(template)` returns the current/new revision; optional `{expectedVersion, actor, actorSubject}` supports route concurrency/auditing. `getTemplate(id, version?, {includeDeleted?}?)` and `listTemplateVersions(id)` expose history. Builtin hashes deduplicate across history, so identical or older process seeds do not repeatedly append/revert active versions. First update archives a legacy head at its existing version (default 1). DDB transactions reserve revisions, maintain the latest pointer, and protect active saves from concurrent archives.

Templates never resolve credential contents. Save rejects literal credential values, recognized secret-valued defaults/environment fields, and ownership overrides. Parser errors are sanitized without logging YAML source lines. Existing legacy content remains access-controlled and is preserved for reproducibility.
