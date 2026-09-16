# Project webhooks — isolated release-3 integration

This addition is delivered as a patch containing only new web service, route,
page, and test files. It does not wire or edit worker, notify, authentication,
workflow core, IAM, CDK, or navigation. No external webhook, Slack, or email
message has been sent during implementation or tests.

## Parent hooks

```ts
import {
  enqueueWorkflowWebhook,
  reconcileWebhookDeliveries,
} from '@/server/services/webhooks';

// After terminal workflow state is committed, inside a retryable outbox path:
const queued = await enqueueWorkflowWebhook(workflow);
// Promise<{ eventId?: string; subscribers: number }>

// Periodically from the existing Fargate worker, with its shutdown signal:
await reconcileWebhookDeliveries(signal);
// Promise<void>
```

Enqueue is a database operation only. Propagate enqueue failures so the parent’s
durable outbox retries them; do not mark its notification entry delivered first.
Reconciliation should run in its own existing worker loop and catch/log a fixed
ledger-unavailable message if its scan fails. No Lambda, SQS queue, or additional
CloudFormation resource is required.

The implementation rereads the committed workflow. Projectless/nonterminal
workflows produce no event. Do not reconstruct a workflow from SNS subject/body
text. An explicit call from the parent is required: importing the module does
not start a timer or send requests.

## Event and receiver contract

Supported statuses: `SUCCEEDED`, `FAILED`, `CANCELLED`.

The JSON body contains only:

```json
{
  "runId": "run-id",
  "projectId": "project-id",
  "name": "workflow-name",
  "status": "SUCCEEDED",
  "createdAt": "2026-09-16T12:00:00Z",
  "updatedAt": "2026-09-16T12:01:00Z",
  "startedAt": "2026-09-16T12:00:05Z",
  "finishedAt": "2026-09-16T12:01:00Z"
}
```

`startedAt`/`finishedAt` are omitted when absent; they are not invented. There is
no YAML, environment, credential, task token, log, owner, or arbitrary metadata
envelope. Persisted payload identity is checked again before delivery.

Headers:

- `x-pai-event-id`: stable SHA-256-derived identity for
  `(workflow.status.v1, projectId, runId, terminal status)`.
- `x-pai-delivery-id`: stable per-event/per-subscriber ledger ID; informational.
- `x-pai-timestamp`: Unix seconds for this attempt.
- `x-pai-signature`: `v1=<hex HMAC-SHA256>`, over the UTF-8 bytes of
  `timestamp + "." + eventId + "." + exactRawBody`.

The receiver should validate the timestamp within a bounded clock-skew/replay
window, verify the signature with a timing-safe comparison, and deduplicate
using the **signed event ID**. Do not parse/reserialize JSON before verifying.
The delivery ID is not part of the signature and is not the deduplication
authority. Only a 2xx response acknowledges delivery; redirects are not followed.
HTTP acceptance does not certify the receiver’s downstream business processing.

Example receiver verification logic, without any network action:

```python
signed = timestamp.encode() + b"." + event_id.encode() + b"." + raw_body
expected = "v1=" + hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
valid = hmac.compare_digest(expected, received_signature)
```

A subsequent terminal correction, such as `SUCCEEDED` to `FAILED`, has a
different event ID. Ordering across events/subscribers is not guaranteed.
The first enqueue freezes the body and the currently ACTIVE/enabled matching
subscriber set. Repeating it creates no new deliveries, including for hooks
registered later. Configuration updates temporarily suspend new selection;
there is no automatic historical backfill.

## Durable ledger and retries

The existing DynamoDB table and `gsi1` are used:

| Record | Key |
|---|---|
| Hook metadata | `PROJECT#<project>` / `WEBHOOK#<hookId>` |
| Enabled registration counter | Same partition / `WEBHOOK_REGISTRY` |
| Immutable event/body | `WEBHOOK_EVENT#<eventId>` / `META` |
| Subscriber delivery | `WEBHOOK#<project>#<hookId>` / `DELIVERY#<deliveryId>` |
| Due-delivery index | `gsi1pk=TYPE#WEBHOOK_DELIVERY_PENDING`; sortable due-time/ID key |

At most 32 enabled registrations are reserved atomically. Creation/configuration
failures occupy their reserved slot until disabled. Event creation and all
subscriber deliveries are one transaction, conditional on committed workflow
state and the captured hook revisions. A lost transaction reply is adopted by
the stable event key.

Delivery states:

```text
PENDING -> SENDING -> DELIVERED
                    RETRY -> SENDING
                    DEAD
                    CANCELLED
```

A unique delivery lease lasts 30 seconds by default and is renewed while I/O is
pending. Claims, renewal, and acknowledgement use conditional writes. Lease
expiry/loss aborts transport and prevents stale acknowledgement. Shutdown or a
lost acknowledgement leaves the attempt recoverable after lease expiry.
**At-least-once means a receiver may see duplicates**, including when its
successful response or the ledger acknowledgement was lost.

Default automatic limits: eight attempts, a 24-hour delivery cycle, exponential
backoff starting at 10 seconds with deterministic bounded jitter and a one-hour
delay cap. Network/transient configuration errors, 408/425/429, and 5xx retry.
Redirects, other non-2xx responses, unsafe destinations, and size-policy failures
dead-letter. The worker tick processes at most 20 candidate deliveries, four at
a time, with a bounded index scan. GSI discovery is followed by authoritative
primary-key reads; stale index entries do not authorize a send.

Receiver bodies, raw provider errors, endpoint URLs, and signing keys never
enter delivery records. Only bounded error codes and HTTP status numbers are
recorded. A confirmed 2xx remains DELIVERED if configuration changes race the
response; the ledger records `configuration_changed_after_delivery`. Requests
already received cannot be unsent.

## Configuration privacy and lifecycle

Project administrators manage hooks through browser login, with fresh membership
checks before mutations and after slow validation. Platform admins retain the
existing helper’s override. Viewers receive safe metadata and delivery history.
API-token management is rejected; the existing `/api/v1` allowlist is unchanged.

One SSM **SecureString** contains endpoint URL, signing secret, and an operation
generation under:

```text
/physical-ai/projects/<projectId>/webhooks/<hookId>
```

DynamoDB stores only configuration references/versions/generation and safe
subscription metadata, never the endpoint or key. The caller supplies the
receiver’s random signing key (32–256 characters); no API response returns it,
including create/rotate. URLs and their secret-bearing paths/query strings are
not returned, even to administrators. The page clears submitted signing keys.

Configuration transitions use an exclusive, expiring UPDATING state. An
accepted SSM write with a lost reply can be recovered by its operation generation.
Failed/ambiguous configuration is ERROR and does not deliver. Repair it with
the endpoint and key again. SSM reads are pinned to the recorded parameter
version; no delivery silently falls back to an unrelated latest configuration.

Rotation/replacement invalidates pending deliveries bound to the older
configuration. Disablement cancels pending work and aborts in-flight work when
observed. A project admin can explicitly redrive a DEAD/CANCELLED delivery using
the current active configuration; the original event ID/body are preserved,
and the retry-cycle budget resets. This is an explicit scheduled send action,
not a test message.

DELETE is **soft disable**, not secret erasure. Hook/event/delivery history and
encrypted parameter versions are retained. This release adds no automatic TTL
purge or destructive cleanup; the parent must define retention/erasure policy
without breaking replay/deduplication or in-flight recovery.

## Public HTTPS boundary

- HTTPS on port 443 only. No userinfo, literal IPs (including alternative numeric
  URL forms), fragments, private/reserved DNS suffixes, or ambiguous host syntax.
- DNS is resolved again for every attempt; every returned address must be public
  unicast. Mixed public/private answers are rejected. Private, link-local,
  loopback, reserved/documentation, multicast, IPv4-mapped/NAT64, and tunneling
  address ranges are excluded. IPv6 support is conservative native global unicast.
- The connection uses the validated **IP address**, with the original hostname
  supplied for SNI, HTTP Host, and certificate-name verification. TLS verification
  stays enabled; a fresh connection avoids reused-agent or second-DNS-lookup
  rebinding. No redirect target is contacted.
- Limits: five-second DNS deadline; ten-second total HTTPS deadline; five-second
  socket inactivity limit; 16 KiB request body/header budget; 64 KiB discarded
  response body. SSM operations have their own ten-second deadlines.

## Routes and page

Page: `/webhooks` (parent may add navigation separately).

| Route | Authorization / behavior |
|---|---|
| `GET /api/webhooks` | Project-safe metadata, current project, management capability. |
| `POST /api/webhooks` | Project-admin create: `{name, endpointUrl, secret, statuses?}`. Performs validation/storage only. |
| `GET /api/webhooks/:id` | Safe metadata only. |
| `PATCH /api/webhooks/:id` | Project-admin `{name?, statuses?, enabled?}`. |
| `DELETE /api/webhooks/:id` | Project-admin soft disable. |
| `POST /api/webhooks/:id/rotate` | Project-admin `{secret, endpointUrl?}`; no credential echo. |
| `GET /api/webhooks/:id/deliveries` | Latest 50 safe delivery records. |
| `POST /api/webhooks/:id/deliveries/:deliveryId/redrive` | Project-admin explicit `{}` redrive; no immediate HTTP request. |

All mutation routes retain the existing same-origin checks and standard audit
wrapper. New route/service files are sufficient; auth/core modification is not
required for the browser feature.

## IAM and parent deployment requirements — not applied

- Web task: existing DynamoDB get/query/conditional transaction access;
  `ssm:PutParameter` and `ssm:GetParameter` for
  `parameter/physical-ai/projects/*/webhooks/*`.
- Existing Fargate worker: existing DynamoDB access, plus `ssm:GetParameter`
  for that same prefix and parameter versions.
- Applicable KMS encrypt/decrypt permissions for SecureString, scoped through
  SSM as appropriate to the chosen key. No SSM delete permission is needed.
- DNS and outbound public TCP 443 from the worker; ordinary SSM/DynamoDB access.
  No extra Lambda, queue, or CDK resource is required.

These are integration requirements, not statements that permissions, networking,
or deployment have been applied or verified.

## Local validation

Focused tests use MemoryKV, fake DNS/HTTP/SSM dependencies, a fake native HTTPS
request factory, and a loopback browser/API fixture. No real recipient or AWS
account endpoint is contacted. The browser fixture blocks non-loopback-origin
requests. Browser coverage skips explicitly if local Chromium is unavailable.

```sh
npx --no-install vitest run \
  src/server/services/webhook-http.test.ts \
  src/server/services/webhooks.test.ts \
  src/app/api/webhooks/routes.test.ts \
  src/components/pages/WebhooksPage.test.ts \
  src/components/pages/WebhooksPage.browser.test.ts
```

The parent must add real deployment/integration evidence separately. Any real
receiver test requires an explicitly authorized endpoint; this implementation
does not authorize Slack/email sends or guessing a recipient.

Authoring result: **70 tests passed across five files**, including the local
Chromium registration/dead-letter/redrive/rotation flow. Scoped TypeScript checked
all 16 new source/test roots and their dependencies with zero diagnostics.
These results apply to the isolated release-3 staging copy, not the release-2
build or a live receiver.
