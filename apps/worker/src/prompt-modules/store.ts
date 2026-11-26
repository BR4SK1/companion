import { createHash } from "node:crypto";
import {
  withTransaction,
  type PostgresPool,
  type PostgresPoolClient,
} from "@companion/postgres";

import {
  PromptModuleTraceWriteError,
  type PromptModuleDefinition,
  type PromptModuleDecisionTrace,
  type PromptModuleExecutionTrace,
  type PromptModuleExecutionMode,
  type PromptModuleHttpPostConfig,
  type PromptModuleTraceRecord,
} from "./types.ts";

export interface PromptModuleChatAssociation {
  readonly attemptId: string;
  readonly chatId: string;
  readonly messages: readonly { readonly moduleId: string; readonly position: number }[];
}

export interface PromptModuleStore {
  loadEnabled(): Promise<readonly PromptModuleDefinition[]>;
  loadAttemptTrace(
    client: PostgresPoolClient,
    attemptId: string,
  ): Promise<readonly PromptModuleTraceRecord[]>;
  recordChatAttribution(
    client: PostgresPoolClient,
    association: PromptModuleChatAssociation,
  ): Promise<void>;
  recordDefinitions(input: {
    readonly turnId: string;
    readonly leaseOwner: string;
    readonly decisionModel: string;
    readonly modules: readonly PromptModuleDefinition[];
  }): Promise<boolean>;
  recordDecision(input: {
    readonly turnId: string;
    readonly leaseOwner: string;
    readonly result: PromptModuleDecisionTrace;
  }): Promise<boolean>;
  recordExecution(input: {
    readonly turnId: string;
    readonly leaseOwner: string;
    readonly result: PromptModuleExecutionTrace;
  }): Promise<boolean>;
}

interface PromptModuleRow {
  readonly id: string;
  readonly module_key: string;
  readonly decision_description: string;
  readonly function_definition: string | null;
  readonly execution_mode: PromptModuleExecutionMode;
  readonly http_endpoint_setting: string | null;
  readonly http_scope_setting: string | null;
  readonly http_scope_field: string | null;
  readonly http_turn_id_field: string | null;
  readonly http_local_datetime_field: string | null;
  readonly http_engagement_state_field?: string | null;
  readonly http_published_routine_message_key_field?: string | null;
  readonly http_pattern_id_field?: string | null;
  readonly http_familiarity_tier_field?: string | null;
  readonly http_previous_assistant_field: string | null;
  readonly http_user_message_field: string | null;
  readonly http_prior_conversation_field: string | null;
  readonly http_response_text_field: string | null;
  readonly http_unavailable_until_field?: string | null;
  readonly http_availability_revision_field?: string | null;
  readonly http_field_max_bytes: number | null;
  readonly http_prior_message_limit: number | null;
  readonly http_request_max_bytes: number | null;
  readonly http_response_max_bytes: number | null;
  readonly fallback_content: string | null;
  readonly timeout_ms: number;
  readonly position: number;
  readonly activation_mode: PromptModuleDefinition["activationMode"];
  readonly output_kind: PromptModuleDefinition["outputKind"];
}

function routineHttpFields(row: PromptModuleRow) {
  const publishedRoutineMessageKeyField = row.http_published_routine_message_key_field;
  const patternIdField = row.http_pattern_id_field;
  const familiarityTierField = row.http_familiarity_tier_field;
  const availabilityRevisionField = row.http_availability_revision_field;
  return {
    ...(publishedRoutineMessageKeyField != null ? { publishedRoutineMessageKeyField } : {}),
    ...(patternIdField != null ? { patternIdField } : {}),
    ...(familiarityTierField != null ? { familiarityTierField } : {}),
    ...(availabilityRevisionField != null ? { availabilityRevisionField } : {}),
  };
}

function httpConfigFromRow(row: PromptModuleRow): PromptModuleHttpPostConfig | null {
  const required = [
    row.http_endpoint_setting,
    row.http_response_text_field,
    row.http_field_max_bytes,
    row.http_prior_message_limit,
    row.http_request_max_bytes,
    row.http_response_max_bytes,
  ];
  if (required.some((value) => value === null)) return null;
  return {
    endpointSetting: row.http_endpoint_setting!,
    scopeSetting: row.http_scope_setting,
    scopeField: row.http_scope_field,
    turnIdField: row.http_turn_id_field,
    localDateTimeField: row.http_local_datetime_field,
    engagementStateField: row.http_engagement_state_field ?? null,
    previousAssistantResponseField: row.http_previous_assistant_field,
    userMessageField: row.http_user_message_field,
    priorConversationField: row.http_prior_conversation_field,
    responseTextField: row.http_response_text_field!,
    unavailableUntilField: row.http_unavailable_until_field ?? null,
    ...routineHttpFields(row),
    fieldMaxBytes: row.http_field_max_bytes!,
    priorMessageLimit: row.http_prior_message_limit!,
    requestMaxBytes: row.http_request_max_bytes!,
    responseMaxBytes: row.http_response_max_bytes!,
  };
}

function definitionFingerprint(
  row: PromptModuleRow,
  httpConfig: PromptModuleHttpPostConfig | null,
): string {
  const definition = row.execution_mode === "function"
    ? row.function_definition ?? ""
    : JSON.stringify({ executionMode: row.execution_mode, httpConfig: httpConfig ?? {
        endpointSetting: row.http_endpoint_setting,
        scopeSetting: row.http_scope_setting,
        scopeField: row.http_scope_field,
        turnIdField: row.http_turn_id_field,
        localDateTimeField: row.http_local_datetime_field,
        engagementStateField: row.http_engagement_state_field ?? null,
        previousAssistantResponseField: row.http_previous_assistant_field,
        userMessageField: row.http_user_message_field,
        priorConversationField: row.http_prior_conversation_field,
        responseTextField: row.http_response_text_field,
        unavailableUntilField: row.http_unavailable_until_field ?? null,
        ...routineHttpFields(row),
        fieldMaxBytes: row.http_field_max_bytes,
        priorMessageLimit: row.http_prior_message_limit,
        requestMaxBytes: row.http_request_max_bytes,
        responseMaxBytes: row.http_response_max_bytes,
      } });
  return createHash("sha256").update(definition).digest("hex");
}

async function findOpenAttempt(
  client: PostgresPoolClient,
  turnId: string,
  leaseOwner: string,
): Promise<string | null> {
  const result = await client.query<{ attempt_id: string }>(
    `SELECT a.id AS attempt_id
     FROM trace_attempt a
     JOIN conversation_turn t ON t.id = a.turn_id
     WHERE a.turn_id = $1 AND a.lease_owner = $2 AND a.finished_at IS NULL
       AND t.status = 'in_flight' AND t.lease_owner = $2
       AND t.lease_expires_at > now()`,
    [turnId, leaseOwner],
  );
  return result.rows[0]?.attempt_id ?? null;
}

export function createPromptModuleStore(pool: PostgresPool): PromptModuleStore {
  async function loadEnabled(): Promise<readonly PromptModuleDefinition[]> {
    const result = await pool.query<PromptModuleRow>(
      `SELECT id, module_key, decision_description, function_definition,
              execution_mode, http_endpoint_setting, http_scope_setting,
              http_scope_field, http_turn_id_field, http_local_datetime_field,
              http_engagement_state_field, http_published_routine_message_key_field,
              http_pattern_id_field, http_familiarity_tier_field,
              http_previous_assistant_field, http_user_message_field,
              http_prior_conversation_field, http_response_text_field,
              http_unavailable_until_field, http_availability_revision_field,
              http_field_max_bytes, http_prior_message_limit,
              http_request_max_bytes, http_response_max_bytes,
              fallback_content, timeout_ms, position, activation_mode, output_kind
       FROM prompt_module
       WHERE enabled = true
       ORDER BY position, id`,
    );
    return result.rows.map((row) => {
      const executionMode: PromptModuleExecutionMode = row.execution_mode === "function"
        ? "function"
        : "http_post";
      const httpConfig = executionMode === "http_post" ? httpConfigFromRow(row) : null;
      const definitionRow = { ...row, execution_mode: executionMode };
      return {
        id: row.id,
        key: row.module_key,
        decisionDescription: row.decision_description,
        functionDefinition: executionMode === "function" ? row.function_definition : null,
        executionMode,
        httpConfig,
        definitionHash: definitionFingerprint(definitionRow, httpConfig),
        fallbackContent: row.fallback_content,
        timeoutMs: row.timeout_ms,
        position: row.position,
        activationMode: row.activation_mode,
        outputKind: row.output_kind,
      };
    });
  }

  async function loadAttemptTrace(
    client: PostgresPoolClient,
    attemptId: string,
  ): Promise<readonly PromptModuleTraceRecord[]> {
    const modules = await client.query<{
      module_id: string;
      module_key: string;
      position: number;
      decision_description: string;
      function_hash: string;
      activation_mode: PromptModuleTraceRecord["activationMode"];
      output_kind: PromptModuleTraceRecord["outputKind"];
      execution_mode: PromptModuleTraceRecord["executionMode"];
      fallback_available: boolean;
      decision_state: PromptModuleTraceRecord["decisionState"];
      decision_model: string | null;
      response_model: string | null;
      response_provider: string | null;
      decision_choice: string | null;
      selected: boolean | null;
      decision_confidence: number | null;
      decision_ms: number | null;
      execution_state: PromptModuleTraceRecord["executionState"];
      execution_ordinal: number | null;
      execution_ms: number | null;
      failure_kind: string | null;
      output_ready: boolean;
      fallback_selected: boolean;
      fallback_used: boolean;
      included: boolean;
      chat_message_position: number | null;
    }>(
      `SELECT module.module_id, module.module_key, module.position,
              module.decision_description, module.function_hash,
              module.activation_mode, module.output_kind, module.execution_mode,
              module.fallback_available, module.decision_state,
              module.decision_model, module.response_model,
              module.response_provider, module.decision_choice,
              module.selected, module.decision_confidence, module.decision_ms,
              module.execution_state, module.execution_ordinal,
              module.execution_ms, module.failure_kind, module.output_ready,
              module.fallback_selected, module.fallback_used, module.included,
              association.message_position AS chat_message_position
       FROM trace_attempt_prompt_module AS module
       LEFT JOIN trace_attempt_prompt_module_chat_message AS association
         ON association.attempt_id = module.attempt_id
        AND association.module_id = module.module_id
       WHERE module.attempt_id = $1
       ORDER BY module.position, module.module_id`,
      [attemptId],
    );
    const records: PromptModuleTraceRecord[] = [];
    for (const module of modules.rows) {
      const probabilities = await client.query<{ option_id: string; value: number }>(
        `SELECT option_id, value
         FROM trace_attempt_prompt_module_probability
         WHERE attempt_id = $1 AND module_id = $2
         ORDER BY option_id`,
        [attemptId, module.module_id],
      );
      records.push({
        moduleId: module.module_id,
        moduleKey: module.module_key,
        position: module.position,
        decisionDescription: module.decision_description,
        definitionHash: module.function_hash,
        activationMode: module.activation_mode,
        outputKind: module.output_kind,
        executionMode: module.execution_mode,
        fallbackAvailable: module.fallback_available,
        decisionState: module.decision_state,
        decisionModel: module.decision_model,
        responseModel: module.response_model,
        responseProvider: module.response_provider,
        decisionChoice: module.decision_choice,
        selected: module.selected,
        confidence: module.decision_confidence === null
          ? null
          : Number(module.decision_confidence),
        probabilities: probabilities.rows.map((row) => ({
          optionId: row.option_id,
          value: Number(row.value),
        })),
        decisionMs: module.decision_ms,
        executionState: module.execution_state,
        executionOrdinal: module.execution_ordinal,
        executionMs: module.execution_ms,
        failureKind: module.failure_kind,
        outputReady: module.output_ready,
        fallbackSelected: module.fallback_selected,
        fallbackUsed: module.fallback_used,
        included: module.included,
        chatMessagePosition: module.chat_message_position,
      });
    }
    return records;
  }

  async function recordDefinitions(input: {
    readonly turnId: string;
    readonly leaseOwner: string;
    readonly decisionModel: string;
    readonly modules: readonly PromptModuleDefinition[];
  }): Promise<boolean> {
    return await withTransaction(pool, async (client) => {
      const attemptId = await findOpenAttempt(client, input.turnId, input.leaseOwner);
      if (attemptId === null) return false;
      for (const module of input.modules) {
        await client.query(
          `INSERT INTO trace_attempt_prompt_module
             (attempt_id, module_id, module_key, position, decision_description,
              function_hash, fallback_available, activation_mode, output_kind,
              execution_mode, decision_state, decision_model, requested_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              CASE WHEN $8 = 'every_turn' THEN 'not_requested' ELSE 'requested' END,
              CASE WHEN $8 = 'model_gated' THEN $11 ELSE NULL END, now())
           ON CONFLICT (attempt_id, module_id) DO UPDATE SET
             module_key = EXCLUDED.module_key,
             position = EXCLUDED.position,
             decision_description = EXCLUDED.decision_description,
             function_hash = EXCLUDED.function_hash,
             fallback_available = EXCLUDED.fallback_available,
             activation_mode = EXCLUDED.activation_mode,
             output_kind = EXCLUDED.output_kind,
             execution_mode = EXCLUDED.execution_mode,
             decision_state = EXCLUDED.decision_state,
             decision_model = EXCLUDED.decision_model,
             response_model = NULL,
             response_provider = NULL,
             decision_choice = NULL,
             selected = NULL,
             decision_confidence = NULL,
             decision_ms = NULL,
             execution_state = 'not_selected',
             execution_ordinal = NULL,
             execution_ms = NULL,
             failure_kind = NULL,
             output_ready = false,
             fallback_selected = false,
             fallback_used = false,
             included = false,
             requested_at = EXCLUDED.requested_at,
             decided_at = NULL,
             executed_at = NULL,
             recorded_at = now()`,
          [
            attemptId,
            module.id,
            module.key,
            module.position,
            module.decisionDescription,
            module.definitionHash,
            module.fallbackContent !== null,
            module.activationMode,
            module.outputKind,
            module.executionMode,
            input.decisionModel,
          ],
        );
        await client.query(
          `DELETE FROM trace_attempt_prompt_module_probability
           WHERE attempt_id = $1 AND module_id = $2`,
          [attemptId, module.id],
        );
      }
      return true;
    });
  }

  async function recordDecision(input: {
    readonly turnId: string;
    readonly leaseOwner: string;
    readonly result: PromptModuleDecisionTrace;
  }): Promise<boolean> {
    return await withTransaction(pool, async (client) => {
      const attemptId = await findOpenAttempt(client, input.turnId, input.leaseOwner);
      if (attemptId === null) return false;
      for (const selection of input.result.selections) {
        const updated = await client.query<{ module_id: string }>(
          `UPDATE trace_attempt_prompt_module
           SET decision_state = $3,
               decision_model = $4,
               response_model = $5,
               response_provider = $6,
               decision_choice = $7,
               selected = $8,
               decision_confidence = $9,
               decision_ms = $10,
               execution_state = CASE WHEN $8::boolean IS TRUE THEN 'pending' ELSE 'not_selected' END,
               failure_kind = $11,
               requested_at = COALESCE(requested_at, now()),
               decided_at = now(),
               recorded_at = now()
           WHERE attempt_id = $1 AND module_id = $2
           RETURNING module_id`,
          [
            attemptId,
            selection.moduleId,
            input.result.state,
            input.result.decisionModel,
            input.result.responseModel,
            input.result.responseProvider,
            selection.choice,
            selection.selected,
            selection.confidence,
            input.result.durationMs,
            input.result.failureKind,
          ],
        );
        if (updated.rows.length !== 1) return false;
        await client.query(
          `DELETE FROM trace_attempt_prompt_module_probability
           WHERE attempt_id = $1 AND module_id = $2`,
          [attemptId, selection.moduleId],
        );
        if (selection.probabilities !== null) {
          for (const [optionId, value] of Object.entries(selection.probabilities)) {
            await client.query(
              `INSERT INTO trace_attempt_prompt_module_probability
                 (attempt_id, module_id, option_id, value)
               VALUES ($1, $2, $3, $4)`,
              [attemptId, selection.moduleId, optionId, value],
            );
          }
        }
      }
      return true;
    });
  }

  async function recordChatAttribution(
    client: PostgresPoolClient,
    association: PromptModuleChatAssociation,
  ): Promise<void> {
    const seen = new Set<string>();
    for (const message of association.messages) {
      if (seen.has(message.moduleId)) {
        throw new PromptModuleTraceWriteError("chat_attribution");
      }
      seen.add(message.moduleId);
    }
    try {
      await client.query(
        `DELETE FROM trace_attempt_prompt_module_chat_message WHERE attempt_id = $1`,
        [association.attemptId],
      );
      await client.query(
        `UPDATE trace_attempt_prompt_module
         SET included = false, fallback_used = false
         WHERE attempt_id = $1`,
        [association.attemptId],
      );
      for (const message of association.messages) {
        const inserted = await client.query<{ module_id: string }>(
          `INSERT INTO trace_attempt_prompt_module_chat_message
             (attempt_id, module_id, chat_id, message_position)
           SELECT $1, $2, $3, $4
           WHERE EXISTS (
             SELECT 1 FROM trace_attempt_prompt_module
             WHERE attempt_id = $1 AND module_id = $2
               AND selected IS TRUE AND output_ready = true
           )
           RETURNING module_id`,
          [association.attemptId, message.moduleId, association.chatId, message.position],
        );
        if (inserted.rows.length !== 1) {
          throw new PromptModuleTraceWriteError("chat_attribution");
        }
        const updated = await client.query<{ module_id: string }>(
          `UPDATE trace_attempt_prompt_module
           SET included = true,
               fallback_used = fallback_selected,
               recorded_at = now()
           WHERE attempt_id = $1 AND module_id = $2
             AND selected IS TRUE AND output_ready = true
           RETURNING module_id`,
          [association.attemptId, message.moduleId],
        );
        if (updated.rows.length !== 1) {
          throw new PromptModuleTraceWriteError("chat_attribution");
        }
      }
    } catch (error) {
      if (error instanceof PromptModuleTraceWriteError) throw error;
      throw new PromptModuleTraceWriteError("chat_attribution");
    }
  }

  async function recordExecution(input: {
    readonly turnId: string;
    readonly leaseOwner: string;
    readonly result: PromptModuleExecutionTrace;
  }): Promise<boolean> {
    return await withTransaction(pool, async (client) => {
      const attemptId = await findOpenAttempt(client, input.turnId, input.leaseOwner);
      if (attemptId === null) return false;
      const result = await client.query(
        `UPDATE trace_attempt_prompt_module
         SET execution_state = $3,
             execution_ordinal = $4,
             execution_ms = $5,
             output_ready = $6,
             fallback_selected = $7,
             fallback_used = false,
             included = false,
             failure_kind = $8,
             executed_at = now(),
             recorded_at = now()
         WHERE attempt_id = $1 AND module_id = $2
           AND decision_state IN ('responded', 'not_required') AND selected IS TRUE
         RETURNING module_id`,
        [
          attemptId,
          input.result.moduleId,
          input.result.state,
          input.result.executionOrdinal,
          input.result.durationMs,
          input.result.outputReady,
          input.result.fallbackSelected,
          input.result.state === "succeeded"
            ? null
            : input.result.state === "timed_out"
              ? "execution_timeout"
              : input.result.state === "invalid_result"
                ? "execution_invalid_result"
                : "execution_error",
        ],
      );
      return result.rows.length === 1;
    });
  }

  return {
    loadEnabled,
    loadAttemptTrace,
    recordDefinitions,
    recordDecision,
    recordExecution,
    recordChatAttribution,
  };
}
