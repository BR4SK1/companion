/**
 * Small shared helpers for the BFF route handlers.
 *
 * All API responses are no-store and all failures are generic: a stable
 * kind string with no internal detail (stack traces, upstream bodies, or
 * configuration values never reach the client).
 */

import { NextResponse } from "next/server";

export function jsonOk(
  body: Record<string, unknown>,
  status = 200,
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function jsonError(status: number, kind: string): NextResponse {
  return NextResponse.json(
    { error: kind },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
