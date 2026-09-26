import { test } from "node:test";
import assert from "node:assert/strict";

import type { QuestionOut } from "../api/types.ts";
import { lettersToOptionIds, optionLetter } from "./letters.ts";
import { doneSpeech, joinWords, nextQuestion, questionSpeech, resultSpeech, showingSpeech } from "./speech.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks how spoken letters map to option ids and the exact sentences the voice
// agent reads, since the agent's prompt relies on their shape.

const options = [
  { id: "f1", label: "Email senders to Gmail API: send email" },
  { id: "f4", label: "Web app to API: API requests" },
  { id: "f8", label: "Mail sync worker to Postgres: save messages" },
];

test("maps letters to option ids by position", () => {
  assert.equal(optionLetter(2), "C");
  assert.deepEqual(lettersToOptionIds("A, C", options).ids, ["f1", "f8"]);
  assert.deepEqual(lettersToOptionIds("c and a", options).ids, ["f1", "f8"]);
  assert.deepEqual(lettersToOptionIds("Options B.", options).ids, ["f4"]);
  assert.deepEqual(lettersToOptionIds("bee", options).ids, ["f4"]);
});

test("reports words that match no option", () => {
  const { ids, unmatched } = lettersToOptionIds("A, Z, maybe", options);
  assert.deepEqual(ids, ["f1"]);
  assert.deepEqual(unmatched, ["Z", "maybe"]);
});

test("accepts option ids when a letter is out of range", () => {
  const stride = ["S", "T", "R", "I", "D", "E"].map((id) => ({ id, label: id }));
  assert.deepEqual(lettersToOptionIds("B", stride).ids, ["T"]);
  assert.deepEqual(lettersToOptionIds("f8", options).ids, ["f8"]);
});

test("reads a multi choice question with lettered options", () => {
  const question: QuestionOut = { id: "boundary", topic: "boundary", kind: "multi", prompt: "Which flows cross a boundary?", options };
  assert.equal(
    questionSpeech(question, 0, 7),
    "Question 1 of 7, id boundary. Which flows cross a boundary? Options: A, Email senders to Gmail API: send email. " +
      "B, Web app to API: API requests. C, Mail sync worker to Postgres: save messages. Say every letter that applies.",
  );
});

test("reads single and open questions with their own instruction", () => {
  const single: QuestionOut = { id: "stride:T2", topic: "stride", kind: "single", prompt: "What kind of threat is this?", options: options.slice(0, 1) };
  assert.match(questionSpeech(single, 3, 7), /^Question 4 of 7, id stride:T2\. .* Pick one letter\.$/);
  const open: QuestionOut = { id: "fix:T1", topic: "fix", kind: "open", prompt: "How would you stop it", options: [] };
  assert.equal(questionSpeech(open, 6, 7), "Question 7 of 7, id fix:T1. How would you stop it. Answer in your own words.");
});

test("finds the next unanswered question", () => {
  const q = (id: string): QuestionOut => ({ id, topic: "data", kind: "multi", prompt: id, options: [] });
  const attempt = { question_id: "a", result: "correct" as const, feedback: "", explanation: "", evidence: [], highlight: [], correct_ids: [], your_ids: [], your_text: null };
  assert.equal(nextQuestion({ questions: [q("a"), q("b")], results: { a: attempt } })?.id, "b");
  assert.equal(nextQuestion({ questions: [q("a")], results: { a: attempt } }), null);
});

test("reads results, the final score and what was shown", () => {
  assert.equal(
    resultSpeech({ result: "partial", feedback: "You found one crossing", explanation: "Two flows cross." }),
    "Result: partly right. You found one crossing. Two flows cross.",
  );
  assert.equal(
    doneSpeech({ total: 7, answered: 7, correct: 4, partial: 2, score: 0.714, weak_spots: [] }, ["Postgres", "Triage agent"]),
    "All 7 questions are answered. Score 71 percent: 4 correct, 2 partly right. Weak spots to review: Postgres and Triage agent.",
  );
  assert.equal(showingSpeech(["Postgres"], ["x9"]), "Showing Postgres. Not on this board: x9.");
  assert.equal(joinWords(["a", "b", "c"]), "a, b and c");
});
