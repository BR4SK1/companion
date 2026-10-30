// Deterministic contract tests for the OpenRouter Decisions contract
// (libraries/openrouter/src/decisions.ts).
//
// No network: every payload below is an inline fake response body. These
// tests validate the typed request/answer variants and the native-validation
// rules only — no transport, provider, fallback, calibration, or
// normalization behavior is exercised or implied.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DecisionsContractError,
  parseDecisionsExchange,
  parseDecisionsRequest,
  parseDecisionsResponse,
} from "../../libraries/openrouter/src/decisions.ts";

function assertContractError(fn, pathFragment, messageFragment) {
  assert.throws(fn, (error) => {
    assert.ok(
      error instanceof DecisionsContractError,
      `expected DecisionsContractError, got ${error}`,
    );
    if (pathFragment !== undefined) {
      assert.ok(
        error.path.includes(pathFragment),
        `expected path to include "${pathFragment}", got "${error.path}"`,
      );
    }
    if (messageFragment !== undefined) {
      assert.ok(
        error.message.includes(messageFragment),
        `expected message to include "${messageFragment}", got "${error.message}"`,
      );
    }
    return true;
  });
}

describe("Decisions request contract", () => {
  const baseRequest = {
    model: "typesafe/jev-1.13",
    state: { ticket: "Checkout page shows a blank screen." },
    questions: {
      is_bug: {
        type: "noul",
        instructions: "Is the customer reporting a software defect?",
      },
      team: {
        type: "choice",
        instructions: "Which team should own this ticket?",
        criteria: {
          payments: "Checkout, billing, or payment processing issues.",
          frontend: null,
        },
      },
      urgency: {
        type: "score",
        instructions: "How urgent is this ticket?",
        criteria: [
          "Can wait for the next release",
          "Should be fixed this week",
          "Blocking revenue right now",
        ],
      },
    },
  };

  it("parses a request with all three question variants", () => {
    const parsed = parseDecisionsRequest(baseRequest);
    assert.equal(parsed.model, "typesafe/jev-1.13");
    assert.deepEqual(parsed.state, baseRequest.state);
    assert.equal(parsed.questions.is_bug.type, "noul");
    assert.equal(parsed.questions.team.type, "choice");
    assert.deepEqual(parsed.questions.team.criteria, {
      payments: "Checkout, billing, or payment processing issues.",
      frontend: null,
    });
    assert.equal(parsed.questions.urgency.type, "score");
  });

  it("preserves score criteria order (lowest level first)", () => {
    const parsed = parseDecisionsRequest(baseRequest);
    assert.deepEqual(parsed.questions.urgency.criteria, [
      "Can wait for the next release",
      "Should be fixed this week",
      "Blocking revenue right now",
    ]);
  });

  it("keeps noul criteria optional and does not fabricate it", () => {
    const parsed = parseDecisionsRequest(baseRequest);
    assert.equal("criteria" in parsed.questions.is_bug, false);

    const withCriteria = parseDecisionsRequest({
      ...baseRequest,
      questions: {
        is_bug: {
          type: "noul",
          instructions: "Is this a bug?",
          criteria: { true: "It is a bug.", false: "It is not a bug." },
        },
      },
    });
    assert.deepEqual(withCriteria.questions.is_bug.criteria, {
      true: "It is a bug.",
      false: "It is not a bug.",
    });
  });

  it("accepts string, object, and array state", () => {
    for (const state of ["a string", { a: 1 }, [1, "two", { three: null }]]) {
      const parsed = parseDecisionsRequest({ ...baseRequest, state });
      assert.deepEqual(parsed.state, state);
    }
  });

  it("preserves a provider preference object and an explicit provider null", () => {
    // The published ProviderPreferences schema is `object | null`.
    const withNull = parseDecisionsRequest({ ...baseRequest, provider: null });
    assert.equal("provider" in withNull, true);
    assert.strictEqual(withNull.provider, null);

    const withObject = parseDecisionsRequest({
      ...baseRequest,
      provider: { order: ["TypeSafe"], allow_fallbacks: false },
    });
    assert.deepEqual(withObject.provider, {
      order: ["TypeSafe"],
      allow_fallbacks: false,
    });
  });

  it("rejects the assets image-reference map instead of silently dropping it", () => {
    assertContractError(
      () =>
        parseDecisionsRequest({
          ...baseRequest,
          assets: { photo: { type: "image", format: "png", data_base64: "aGk=" } },
        }),
      "assets",
      "not supported by this contract",
    );
  });

  it("rejects session_id and user values longer than the published maxLength 256", () => {
    const long = "x".repeat(257);
    assertContractError(
      () => parseDecisionsRequest({ ...baseRequest, session_id: long }),
      "session_id",
    );
    assertContractError(
      () => parseDecisionsRequest({ ...baseRequest, user: long }),
      "user",
    );
    const parsed = parseDecisionsRequest({
      ...baseRequest,
      session_id: "x".repeat(256),
      user: "y".repeat(256),
    });
    assert.equal(parsed.session_id?.length, 256);
    assert.equal(parsed.user?.length, 256);
  });

  it("preserves map keys named __proto__, constructor, and toString as own keys", () => {
    // Built via JSON.parse so "__proto__" is a real own property of the input.
    const raw = JSON.parse(`{
      "model": "typesafe/jev-1.13",
      "state": { "__proto__": "polluted?" },
      "questions": {
        "__proto__": { "type": "noul", "instructions": "Is it so?" },
        "toString": {
          "type": "choice",
          "instructions": "Pick",
          "criteria": { "constructor": "A", "__proto__": null }
        },
        "constructor": {
          "type": "score",
          "instructions": "Rate",
          "criteria": ["low", "high"]
        }
      }
    }`);
    const parsed = parseDecisionsRequest(raw);

    assert.equal(Object.hasOwn(parsed.questions, "__proto__"), true);
    assert.equal(Object.hasOwn(parsed.questions, "toString"), true);
    assert.equal(Object.hasOwn(parsed.questions, "constructor"), true);
    assert.deepEqual(Object.keys(parsed.questions).sort(), [
      "__proto__",
      "constructor",
      "toString",
    ]);
    assert.equal(parsed.questions["__proto__"].type, "noul");
    assert.equal(parsed.questions["toString"].type, "choice");
    assert.equal(parsed.questions["constructor"].type, "score");

    const choice = parsed.questions["toString"];
    assert.equal(Object.hasOwn(choice.criteria, "__proto__"), true);
    assert.strictEqual(choice.criteria["__proto__"], null);
    assert.equal(Object.hasOwn(choice.criteria, "constructor"), true);
    assert.equal(choice.criteria["constructor"], "A");
  });

  it("preserves __proto__ keys in provider and trace pass-through copies", () => {
    const raw = JSON.parse(`{
      "model": "m",
      "state": "s",
      "questions": { "q": { "type": "noul", "instructions": "Is it so?" } },
      "provider": { "__proto__": { "order": ["TypeSafe"] } },
      "trace": { "__proto__": { "trace_id": "t1" } }
    }`);
    const parsed = parseDecisionsRequest(raw);
    assert.equal(Object.hasOwn(parsed.provider, "__proto__"), true);
    assert.deepEqual(parsed.provider["__proto__"], { order: ["TypeSafe"] });
    assert.equal(Object.getPrototypeOf(parsed.provider), Object.prototype);
    assert.equal(Object.hasOwn(parsed.trace, "__proto__"), true);
    assert.deepEqual(parsed.trace["__proto__"], { trace_id: "t1" });
  });

  it("keeps optional request fields optional and validates them when present", () => {
    const minimal = parseDecisionsRequest({
      model: "typesafe/jev-1.13",
      state: "s",
      questions: {
        q: { type: "noul", instructions: "Is it so?" },
      },
    });
    assert.equal("provider" in minimal, false);
    assert.equal("session_id" in minimal, false);
    assert.equal("user" in minimal, false);
    assert.equal("trace" in minimal, false);

    const full = parseDecisionsRequest({
      ...baseRequest,
      provider: { order: ["TypeSafe"] },
      session_id: "session-1",
      user: "owner",
      trace: { run: "r1" },
    });
    assert.deepEqual(full.provider, { order: ["TypeSafe"] });
    assert.equal(full.session_id, "session-1");
    assert.equal(full.user, "owner");
    assert.deepEqual(full.trace, { run: "r1" });
  });

  it("rejects a score question with an empty criteria array (published minItems: 1)", () => {
    assertContractError(
      () =>
        parseDecisionsRequest({
          ...baseRequest,
          questions: { q: { type: "score", instructions: "Rate", criteria: [] } },
        }),
      "questions.q.criteria",
      "at least one level",
    );
  });

  it("rejects malformed requests", () => {
    assertContractError(() => parseDecisionsRequest(null), "request");
    assertContractError(
      () => parseDecisionsRequest({ ...baseRequest, model: 7 }),
      "model",
    );
    assertContractError(
      () => parseDecisionsRequest({ ...baseRequest, state: 42 }),
      "state",
    );
    assertContractError(
      () => parseDecisionsRequest({ ...baseRequest, state: null }),
      "state",
    );
    assertContractError(
      () => parseDecisionsRequest({ ...baseRequest, questions: {} }),
      "questions",
    );
    assertContractError(
      () => parseDecisionsRequest({ ...baseRequest, questions: undefined }),
      "questions",
    );
    assertContractError(
      () =>
        parseDecisionsRequest({
          ...baseRequest,
          questions: { q: { type: "ranking", instructions: "Rank it" } },
        }),
      "questions.q.type",
      "unknown question type",
    );
    assertContractError(
      () =>
        parseDecisionsRequest({
          ...baseRequest,
          questions: { q: { type: "choice", criteria: { a: "A" } } },
        }),
      "questions.q.instructions",
    );
    assertContractError(
      () =>
        parseDecisionsRequest({
          ...baseRequest,
          questions: { q: { type: "score", instructions: "Rate" } },
        }),
      "questions.q.criteria",
    );
    assertContractError(
      () =>
        parseDecisionsRequest({
          ...baseRequest,
          questions: {
            q: {
              type: "score",
              instructions: "Rate",
              criteria: "not an array",
            },
          },
        }),
      "questions.q.criteria",
    );
    assertContractError(
      () =>
        parseDecisionsRequest({
          ...baseRequest,
          questions: {
            q: {
              type: "noul",
              instructions: "Is it so?",
              criteria: { true: "Yes" },
            },
          },
        }),
      "questions.q.criteria",
      'expected exactly "true" and "false"',
    );
    assertContractError(
      () =>
        parseDecisionsRequest({
          ...baseRequest,
          questions: { q: { type: "noul", instructions: "Is it so?", criteria: {} } },
        }),
      "questions.q.criteria",
    );
    assertContractError(
      () =>
        parseDecisionsRequest({
          ...baseRequest,
          questions: {
            q: {
              type: "choice",
              instructions: "Pick",
              criteria: { a: 3 },
            },
          },
        }),
      "questions.q.criteria.a",
    );
    assertContractError(
      () =>
        parseDecisionsRequest({
          ...baseRequest,
          questions: { box: { type: "box", instructions: "Where?" } },
        }),
      "questions.box.type",
      "box",
    );
  });
});

describe("Decisions response contract", () => {
  const fullResponse = {
    id: "gen-dec-1",
    model: "typesafe/jev-1.13-20260917",
    provider: "TypeSafe",
    answers: {
      is_bug: { type: "noul", noul: 0.96 },
      team: {
        type: "choice",
        choice: "payments",
        probabilities: { payments: 0.78, frontend: 0.22, account: 0, none: 0 },
        confidence: 0.67,
      },
      urgency: {
        type: "score",
        score: 1.99,
        legend: {
          0: "Can wait for the next release",
          1: "Should be fixed this week",
          2: "Blocking revenue right now",
        },
        probabilities: { 0: 0, 1: 0, 2: 1 },
        confidence: 0.99,
      },
    },
    usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
  };

  it("parses a response with all three answer variants", () => {
    const parsed = parseDecisionsResponse(fullResponse);
    assert.equal(parsed.model, "typesafe/jev-1.13-20260917");
    assert.deepEqual(parsed.answers.is_bug, { type: "noul", noul: 0.96 });
    assert.equal(parsed.answers.team.choice, "payments");
    assert.equal(parsed.answers.urgency.score, 1.99);
    assert.deepEqual(parsed.answers.urgency.legend, {
      0: "Can wait for the next release",
      1: "Should be fixed this week",
      2: "Blocking revenue right now",
    });
    assert.deepEqual(parsed.answers.urgency.probabilities, { 0: 0, 1: 0, 2: 1 });
    assert.deepEqual(parsed.usage, {
      input_tokens: 476,
      output_tokens: 70,
      cost: 0.000019992,
    });
  });

  it("keeps the noul probability numeric, never a Boolean", () => {
    const parsed = parseDecisionsResponse({
      model: "m",
      answers: { q: { type: "noul", noul: 0 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    assert.equal(typeof parsed.answers.q.noul, "number");
    assert.strictEqual(parsed.answers.q.noul, 0);
  });

  it("keeps optional answer fields optional and never fabricated", () => {
    const parsed = parseDecisionsResponse({
      model: "m",
      answers: {
        c: { type: "choice", choice: "a" },
        s: { type: "score", score: 2 },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    assert.equal("probabilities" in parsed.answers.c, false);
    assert.equal("confidence" in parsed.answers.c, false);
    assert.equal("legend" in parsed.answers.s, false);
    assert.equal("probabilities" in parsed.answers.s, false);
    assert.equal("confidence" in parsed.answers.s, false);
    assert.equal("cost" in parsed.usage, false);
    assert.equal("id" in parsed, false);
    assert.equal("provider" in parsed, false);
  });

  it("preserves native results without normalization", () => {
    const parsed = parseDecisionsResponse({
      model: "m",
      answers: {
        c: {
          type: "choice",
          choice: "a",
          // Deliberately does not sum to 1 and contains a value outside [0, 1];
          // the contract preserves it rather than renormalizing or clamping.
          probabilities: { a: 0.6, b: 0.3, c: 1.4 },
        },
        s: { type: "score", score: 3.7 },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    assert.deepEqual(parsed.answers.c.probabilities, { a: 0.6, b: 0.3, c: 1.4 });
    assert.strictEqual(parsed.answers.s.score, 3.7);
  });

  it("preserves legend values with their native JSON structure", () => {
    const parsed = parseDecisionsResponse({
      model: "m",
      answers: {
        s: {
          type: "score",
          score: 1,
          legend: { 0: "low", 1: { label: "high", detail: ["a", "b"] } },
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    assert.deepEqual(parsed.answers.s.legend, {
      0: "low",
      1: { label: "high", detail: ["a", "b"] },
    });
  });

  it("preserves map keys named __proto__, constructor, and toString as own keys", () => {
    const raw = JSON.parse(`{
      "model": "m",
      "answers": {
        "__proto__": { "type": "noul", "noul": 0.5 },
        "toString": { "type": "choice", "choice": "a", "probabilities": { "__proto__": 0 } },
        "constructor": { "type": "score", "score": 1, "legend": { "0": { "toString": "nested" } } }
      },
      "usage": { "input_tokens": 1, "output_tokens": 1 }
    }`);
    const parsed = parseDecisionsResponse(raw);

    assert.equal(Object.hasOwn(parsed.answers, "__proto__"), true);
    assert.equal(Object.hasOwn(parsed.answers, "toString"), true);
    assert.equal(Object.hasOwn(parsed.answers, "constructor"), true);
    assert.deepEqual(Object.keys(parsed.answers).sort(), [
      "__proto__",
      "constructor",
      "toString",
    ]);
    assert.deepEqual(parsed.answers["__proto__"], { type: "noul", noul: 0.5 });

    const choice = parsed.answers["toString"];
    assert.equal(Object.hasOwn(choice.probabilities, "__proto__"), true);
    assert.strictEqual(choice.probabilities["__proto__"], 0);

    const score = parsed.answers["constructor"];
    assert.deepEqual(score.legend["0"], { toString: "nested" });
  });

  it("rejects malformed responses", () => {
    const usage = { input_tokens: 1, output_tokens: 1 };

    assertContractError(() => parseDecisionsResponse("nope"), "response");
    assertContractError(() => parseDecisionsResponse([]), "response");
    assertContractError(
      () => parseDecisionsResponse({ answers: {}, usage }),
      "model",
    );
    assertContractError(
      () => parseDecisionsResponse({ model: "m", usage }),
      "answers",
    );
    assertContractError(
      () => parseDecisionsResponse({ model: "m", answers: {} }),
      "usage",
    );
    assertContractError(
      () =>
        parseDecisionsResponse({
          model: "m",
          answers: { q: { type: "choice" } },
          usage,
        }),
      "answers.q.choice",
    );
    assertContractError(
      () =>
        parseDecisionsResponse({
          model: "m",
          answers: { q: { type: "score" } },
          usage,
        }),
      "answers.q.score",
    );
    assertContractError(
      () =>
        parseDecisionsResponse({
          model: "m",
          answers: { q: { type: "noul" } },
          usage,
        }),
      "answers.q.noul",
    );
    // An unexpected answer type is an error, not a default (official guidance).
    assertContractError(
      () =>
        parseDecisionsResponse({
          model: "m",
          answers: { q: { type: "refusal", refusal: "cannot answer" } },
          usage,
        }),
      "answers.q.type",
      "unexpected answer type",
    );
    // box exists on the wire (Jev 1.14) but is outside this contract's scope.
    assertContractError(
      () =>
        parseDecisionsResponse({
          model: "m",
          answers: {
            q: { type: "box", box: { top: 0.1, bottom: 0.2, left: 0.3, right: 0.4 } },
          },
          usage,
        }),
      "answers.q.type",
      "box",
    );
    assertContractError(
      () =>
        parseDecisionsResponse({
          model: "m",
          answers: { q: { type: "choice", choice: "a", probabilities: { a: "high" } } },
          usage,
        }),
      "answers.q.probabilities.a",
    );
    assertContractError(
      () =>
        parseDecisionsResponse({
          model: "m",
          answers: { q: { type: "noul", noul: true } },
          usage,
        }),
      "answers.q.noul",
      "expected a finite number",
    );
    assertContractError(
      () =>
        parseDecisionsResponse({
          model: "m",
          answers: { q: { type: "choice", choice: "a", confidence: "sure" } },
          usage,
        }),
      "answers.q.confidence",
    );
    assertContractError(
      () =>
        parseDecisionsResponse({
          model: "m",
          answers: {},
          usage: { input_tokens: 1.5, output_tokens: 1 },
        }),
      "usage.input_tokens",
    );
    assertContractError(
      () =>
        parseDecisionsResponse({
          model: "m",
          answers: {},
          usage: { input_tokens: 1, output_tokens: 1, cost: "free" },
        }),
      "usage.cost",
    );
    assertContractError(
      () =>
        parseDecisionsResponse({
          model: "m",
          answers: {},
          usage: { input_tokens: 1, output_tokens: 1 },
          id: 9,
        }),
      "id",
    );
  });

  it("rejects non-finite numbers, which JSON can produce via overflow", () => {
    // JSON.parse("1e999") yields Infinity: the wire can carry a non-finite
    // number, and the contract rejects it instead of passing it through.
    const raw = JSON.parse(`{
      "model": "m",
      "answers": { "q": { "type": "noul", "noul": 1e999 } },
      "usage": { "input_tokens": 1, "output_tokens": 1e999 }
    }`);
    assertContractError(() => parseDecisionsResponse(raw), "answers.q.noul");
    assert.equal(Number.isFinite(raw.usage.output_tokens), false);
  });
});

describe("Decisions answer/question correspondence", () => {
  const request = parseDecisionsRequest({
    model: "typesafe/jev-1.13",
    state: "state",
    questions: {
      is_bug: { type: "noul", instructions: "Is this a bug?" },
      team: {
        type: "choice",
        instructions: "Which team?",
        criteria: { payments: "Payments", frontend: "Frontend" },
      },
    },
  });

  it("accepts answers that match the asked question IDs and types", () => {
    const parsed = parseDecisionsExchange(request, {
      model: "typesafe/jev-1.13-20260917",
      answers: {
        is_bug: { type: "noul", noul: 0.9 },
        team: { type: "choice", choice: "frontend", confidence: 0.5 },
      },
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    assert.equal(parsed.answers.is_bug.noul, 0.9);
    assert.equal(parsed.answers.team.choice, "frontend");
  });

  it("rejects a missing answer for an asked question", () => {
    assertContractError(
      () =>
        parseDecisionsExchange(request, {
          model: "m",
          answers: { is_bug: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      "answers.team",
      "missing answer",
    );
  });

  it("rejects an extra answer with no matching question ID", () => {
    assertContractError(
      () =>
        parseDecisionsExchange(request, {
          model: "m",
          answers: {
            is_bug: { type: "noul", noul: 0.9 },
            team: { type: "choice", choice: "frontend" },
            mood: { type: "noul", noul: 0.5 },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      "answers.mood",
      "unexpected answer",
    );
  });

  it("rejects an extra answer whose key is an inherited Object.prototype name", () => {
    // Regression: with `in` membership, an extra answer keyed "toString" or
    // "constructor" slipped through the unexpected-answer check because those
    // names exist on the prototype chain. Membership now uses Object.hasOwn.
    assertContractError(
      () =>
        parseDecisionsExchange(request, {
          model: "m",
          answers: {
            is_bug: { type: "noul", noul: 0.9 },
            team: { type: "choice", choice: "frontend" },
            toString: { type: "noul", noul: 0.5 },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      "answers.toString",
      "unexpected answer",
    );
    assertContractError(
      () =>
        parseDecisionsExchange(request, {
          model: "m",
          answers: {
            is_bug: { type: "noul", noul: 0.9 },
            team: { type: "choice", choice: "frontend" },
            constructor: { type: "noul", noul: 0.5 },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      "answers.constructor",
      "unexpected answer",
    );
  });

  it("rejects an extra answer keyed __proto__ that is only an own key of the response", () => {
    const raw = JSON.parse(`{
      "model": "m",
      "answers": {
        "is_bug": { "type": "noul", "noul": 0.9 },
        "team": { "type": "choice", "choice": "frontend" },
        "__proto__": { "type": "noul", "noul": 0.5 }
      },
      "usage": { "input_tokens": 1, "output_tokens": 1 }
    }`);
    assertContractError(
      () => parseDecisionsExchange(request, raw),
      "answers.__proto__",
      "unexpected answer",
    );
  });

  it("matches answers for question IDs named after inherited Object.prototype names", () => {
    // A question id like "toString" or "__proto__" is valid (own-keyed maps);
    // correspondence must work through Object.hasOwn in both directions.
    const unusualRequest = parseDecisionsRequest(JSON.parse(`{
      "model": "m",
      "state": "s",
      "questions": {
        "toString": { "type": "noul", "instructions": "Is it so?" },
        "__proto__": { "type": "noul", "instructions": "Is it so?" }
      }
    }`));
    const parsed = parseDecisionsExchange(unusualRequest, JSON.parse(`{
      "model": "m",
      "answers": {
        "toString": { "type": "noul", "noul": 0.25 },
        "__proto__": { "type": "noul", "noul": 0.75 }
      },
      "usage": { "input_tokens": 1, "output_tokens": 1 }
    }`));
    assert.equal(parsed.answers["toString"].noul, 0.25);
    assert.equal(Object.hasOwn(parsed.answers, "__proto__"), true);
    assert.equal(parsed.answers["__proto__"].noul, 0.75);
  });

  it("rejects an answer whose type does not match its question", () => {
    assertContractError(
      () =>
        parseDecisionsExchange(request, {
          model: "m",
          answers: {
            is_bug: { type: "choice", choice: "yes" },
            team: { type: "choice", choice: "frontend" },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      "answers.is_bug.type",
      'expected a noul answer',
    );
  });
});
