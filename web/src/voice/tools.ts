import { useConversationClientTool } from "@elevenlabs/react";

import { api, errorMessage } from "../api/client.ts";
import type { BoardOut, SystemMap } from "../api/types.ts";
import { findElement, labelOf, splitIds } from "../board/elements.ts";
import { useBoardUi } from "../board/store.ts";
import type { QuizState } from "../quiz/useQuiz.ts";
import { lettersToOptionIds } from "./letters.ts";
import { doneSpeech, nextQuestion, questionSpeech, resultSpeech, showingSpeech } from "./speech.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The client tools the ElevenLabs agent calls during a voice session. Their
// names and parameters are fixed; the agent in ElevenLabs is configured with
// the same ones. Parameters come from a model, so each is checked before use,
// and every tool answers with a sentence the agent can read out.


/** A string parameter, trimmed; anything else the model sends counts as missing. */
function text(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Register `get_next_question`, `submit_answer`, `show_on_board` and `get_board_brief` with the conversation. */
export function useVoiceTools({
  board,
  map,
  state,
  onActive,
}: {
  board: BoardOut;
  map: SystemMap;
  state: QuizState;
  onActive: (id: string) => void;
}) {
  const analysis = board.analysis;

  useConversationClientTool("get_next_question", () => {
    const quiz = state.latest();
    if (!quiz) return "The quiz is still loading. Try again in a moment.";
    const question = nextQuestion(quiz);
    if (question === null) {
      const weak = quiz.mastery.weak_spots.map((id) => labelOf(id, map, analysis));
      return doneSpeech(quiz.mastery, weak);
    }
    onActive(question.id);
    return questionSpeech(question, quiz.questions.indexOf(question), quiz.questions.length);
  });

  useConversationClientTool("submit_answer", async (params: Record<string, unknown>) => {
    const quiz = state.latest();
    const questionId = text(params, "question_id");
    const answer = text(params, "answer");
    const question = quiz?.questions.find((q) => q.id === questionId);
    if (!quiz || !question) return `There is no question with id ${questionId || "(none)"}. Call get_next_question.`;
    if (!answer) return "The answer was empty. Ask the developer to answer again.";
    onActive(question.id);
    // The answer comes from a model, so reading it stays in the try too: a throw becomes a reply the agent can read.
    try {
      let choiceIds: string[] = [];
      if (question.kind !== "open") {
        choiceIds = lettersToOptionIds(answer, question.options, question.kind === "single").ids;
        if (choiceIds.length === 0) {
          return `I could not match "${answer}" to an option letter. Ask the developer to say the letters again.`;
        }
      }
      const attempt = await state.submit(question.id, choiceIds, question.kind === "open" ? answer : null, "voice");
      return resultSpeech(attempt);
    } catch (caught) {
      return `The answer could not be saved: ${errorMessage(caught)}`;
    }
  });

  useConversationClientTool("show_on_board", (params: Record<string, unknown>) => {
    const requested = splitIds(text(params, "ids"));
    const found = requested.filter((id) => findElement(id, map, analysis) !== null);
    const missing = requested.filter((id) => !found.includes(id));
    if (found.length > 0) useBoardUi.getState().setHighlight(found, "voice");
    return showingSpeech(
      found.map((id) => labelOf(id, map, analysis)),
      missing,
    );
  });

  useConversationClientTool("get_board_brief", async () => {
    try {
      return (await api.brief(board.id)).text;
    } catch (caught) {
      return `The brief is not available: ${errorMessage(caught)}`;
    }
  });
}
