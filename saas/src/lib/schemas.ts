/**
 * Every contract that crosses a boundary, in one place.
 *
 * Note what is absent from `LeadIngest`: there is no `org_id` and no
 * `tenant_id` field. It is not that the API ignores them — the schema is
 * strict, so a request that carries one is rejected outright rather than
 * silently accepted with the field dropped. A caller who believes they can name
 * their own organization should be told they cannot.
 */
import { z } from 'zod';

/** Reject unknown keys everywhere: mass assignment starts with a permissive parser. */
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

// ---------------------------------------------------------------------------
// Public API: lead ingestion
// ---------------------------------------------------------------------------

export const LeadIngest = strict({
  email: z.string().email().max(320),
  first_name: z.string().max(120).optional(),
  last_name: z.string().max(120).optional(),
  company_name: z.string().max(240).optional(),
  job_title: z.string().max(240).optional(),
  phone: z.string().max(64).optional(),
  website: z.string().url().max(2048).optional(),
  /** Free text the model will read. Treated as untrusted data, never as instructions. */
  notes: z.string().max(20_000).optional(),
  source: z.string().max(64).regex(/^[a-z0-9][a-z0-9_-]*$/).default('api'),
  /**
   * Caller-supplied idempotency key. Scoped to the authenticated organization
   * server-side, so two organizations using the same value never collide.
   */
  idempotency_key: z.string().min(8).max(200).optional(),
  /**
   * Request a live run. Honoured only up to the organization's automation
   * ceiling: asking for a real write cannot raise the ceiling.
   */
  dry_run: z.boolean().default(true),
});
export type LeadIngest = z.infer<typeof LeadIngest>;

export const LeadListQuery = strict({
  tier: z.enum(['HOT', 'WARM', 'COLD', 'DISQUALIFIED']).optional(),
  status: z.enum(['received', 'processing', 'qualified', 'failed', 'archived']).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});
export type LeadListQuery = z.infer<typeof LeadListQuery>;

// ---------------------------------------------------------------------------
// SaaS -> n8n dispatch
// ---------------------------------------------------------------------------

/**
 * The minimum the engine needs to do the work.
 *
 * `organization_id` is present as *execution data* — it scopes the engine's own
 * per-tenant state and appears in its logs — and carries no authority. The
 * engine is not asked to decide whether the caller may act on that
 * organization; that was settled before this payload was built.
 *
 * `allowed_actions` is the inverse of the usual design: rather than the engine
 * deciding what it may do and the API trusting it, the API states the ceiling
 * and the engine may only narrow it.
 */
export const DispatchPayload = strict({
  trace_id: z.string().min(8).max(64),
  execution_id: z.string().uuid(),
  organization_id: z.string().uuid(),
  lead: strict({
    id: z.string().uuid(),
    public_id: z.string(),
    email: z.string().email(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    company_name: z.string().optional(),
    job_title: z.string().optional(),
    phone: z.string().optional(),
    website: z.string().optional(),
    notes: z.string().optional(),
    source: z.string(),
  }),
  rubric_version: z.string().nullable(),
  rubric_version_id: z.string().uuid().nullable(),
  dry_run: z.boolean(),
  allowed_actions: z.array(z.enum(['crm_write', 'outreach_draft', 'outreach_send'])),
  callback_url: z.string().url(),
});
export type DispatchPayload = z.infer<typeof DispatchPayload>;

// ---------------------------------------------------------------------------
// n8n -> SaaS callback
// ---------------------------------------------------------------------------

const ScoreComponent = strict({
  signal: z.string().max(120),
  value: z.string().max(240),
  points: z.number().int().min(-100).max(100),
  weight: z.number().optional(),
  supported: z.boolean().default(false),
});

const EvidenceItem = strict({
  signal: z.string().max(120),
  value: z.string().max(240),
  quote: z.string().max(4000).nullable().optional(),
  source_field: z.string().max(120).nullable().optional(),
  supported: z.boolean().default(false),
  points: z.number().int().default(0),
});

const SkippedAction = strict({
  action: z.string().max(120),
  /** Required. A skipped step with no reason is a missing audit record. */
  reason: z.string().min(1).max(1000),
});

/**
 * Note what the callback may NOT say: it carries no organization id and no
 * lead id. The server already knows both from the execution it dispatched, and
 * accepting them here would make the callback an authorization surface.
 */
export const CallbackPayload = strict({
  status: z.enum(['succeeded', 'failed']),
  score: z.number().int().min(0).max(100).nullable().optional(),
  tier: z.enum(['HOT', 'WARM', 'COLD', 'DISQUALIFIED']).nullable().optional(),
  decision: z.string().max(120),
  rubric_version: z.string().max(64).nullable().optional(),
  prompt_versions: z.record(z.string(), z.string()).default({}),
  model_metadata: z
    .object({
      provider: z.string().max(64).optional(),
      model: z.string().max(120).optional(),
      temperature: z.number().optional(),
      reasoning_effort: z.string().max(32).optional(),
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
    })
    .passthrough()
    .default({}),
  score_components: z.array(ScoreComponent).max(100).default([]),
  evidence: z.array(EvidenceItem).max(100).default([]),
  verification: z.record(z.string(), z.unknown()).default({}),
  governance: z.record(z.string(), z.unknown()).default({}),
  actions_taken: z.array(z.record(z.string(), z.unknown())).max(50).default([]),
  actions_skipped: z.array(SkippedAction).max(50).default([]),
  crm_result: z.record(z.string(), z.unknown()).nullable().optional(),
  approval: z
    .object({
      required: z.boolean(),
      action: z.enum(['outreach_send', 'crm_write']),
      risk_level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
      policy_reason: z.string().min(1).max(1000),
      payload: z.record(z.string(), z.unknown()).default({}),
    })
    .optional(),
  started_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional(),
  engine_execution_id: z.string().max(64).optional(),
  error: z.record(z.string(), z.unknown()).nullable().optional(),
  cost_usd: z.number().nonnegative().optional(),
});
export type CallbackPayload = z.infer<typeof CallbackPayload>;

// ---------------------------------------------------------------------------
// Rubric configuration
// ---------------------------------------------------------------------------

/**
 * Declarative only. A customer configures weights, allowed values and
 * thresholds; there is no field here that carries executable logic, which is
 * why customer-authored scoring cannot become customer-authored code
 * execution.
 */
export const RubricDefinition = strict({
  signals: z
    .array(
      strict({
        key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        question: z.string().max(500),
        /** The closed set the model must answer from. */
        values: z
          .array(strict({ value: z.string().max(64), points: z.number().int().min(-100).max(100) }))
          .min(2)
          .max(12),
        requires_quote: z.boolean().default(true),
        /** Points removed when the model's quote is not found in the source text. */
        unsupported_penalty: z.number().int().min(-100).max(0).default(0),
      }),
    )
    .min(1)
    .max(20),
  thresholds: strict({
    HOT: z.number().int().min(0).max(100),
    WARM: z.number().int().min(0).max(100),
  }),
  /** Conditions that force a human review regardless of score. */
  force_review_when: z
    .array(strict({ signal: z.string(), value: z.string() }))
    .max(20)
    .default([]),
});
export type RubricDefinition = z.infer<typeof RubricDefinition>;

export const ApprovalDecision = strict({
  note: z.string().max(2000).optional(),
});
