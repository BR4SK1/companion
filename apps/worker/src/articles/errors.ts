/**
 * Article-domain error classification.
 *
 * Configuration states are deliberately distinct so the runtime logs the
 * right thing: missing/incomplete configuration, configuration that is
 * present but invalid, and an explicitly disabled feature are different
 * rollout states, and actual failures (network, provider, persistence) are
 * runtime errors recorded as bounded categories.
 */

/** Base class for article-domain configuration problems. */
export class ArticleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArticleConfigError";
  }
}

/**
 * Configuration is missing or incomplete (a required row is absent). This is
 * a rollout state: the runtime logs exactly `ingestion not configured` and
 * the attempt returns before any fetch, provider call, or state write.
 */
export class ArticleConfigurationMissingError extends ArticleConfigError {}

/** Configuration rows exist but a value is invalid. Distinct from missing. */
export class ArticleConfigurationInvalidError extends ArticleConfigError {}

/** The behavior row exists with enabled=false: the feature is switched off. */
export class ArticleDisabledError extends Error {
  constructor(message = "article ingestion disabled") {
    super(message);
    this.name = "ArticleDisabledError";
  }
}

/** Bounded category for an attempt failure (never raw error text). */
export function articleErrorCategory(error: unknown): string {
  if (error instanceof ArticleConfigError || error instanceof ArticleDisabledError) {
    return "configuration";
  }
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") return `http_status_${status}`;
  if (error instanceof RangeError || error instanceof URIError) return "network";
  if (error instanceof TypeError) return "network";
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s*out|timeout|abort/i.test(message)) return "timeout";
  return "unexpected";
}
