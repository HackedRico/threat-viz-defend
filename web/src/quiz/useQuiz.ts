import { useCallback, useEffect, useRef, useState } from "react";

import { api, errorMessage } from "../api/client.ts";
import type { AttemptOut, MemoryUse, QuizOut } from "../api/types.ts";
import { useBoardUi, type HighlightSource } from "../board/store.ts";
import { useSession } from "../shell/session.tsx";

// =============================================================================
// Module Overview
// =============================================================================
// The quiz for one board, shared by the text quiz and the voice coach so both
// see the same answers. `latest` reads the newest state synchronously, which
// the voice coach needs when the agent asks for the next question straight
// after submitting one. `memory` holds what Backboard memory did around each
// answer given in this sitting.

/** The quiz, its loading state and the actions on it. */
export interface QuizState {
  quiz: QuizOut | null;
  loading: boolean;
  error: string | null;
  pending: string | null;
  /** What memory recalled and kept for each question answered since the quiz loaded. */
  memory: Record<string, MemoryUse>;
  latest: () => QuizOut | null;
  submit: (questionId: string, choiceIds: string[], text: string | null, source: HighlightSource) => Promise<AttemptOut>;
  reset: () => Promise<void>;
  reload: () => Promise<void>;
}

/** Load and drive the quiz for board `boardId`, reloading when the analysis changes. */
export function useQuiz(boardId: string, analysisVersion: number): QuizState {
  const { refreshMe } = useSession();
  const [quiz, setQuiz] = useState<QuizOut | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [memory, setMemory] = useState<Record<string, MemoryUse>>({});
  const ref = useRef<QuizOut | null>(null);
  // A grade can land after the reader moved to another board; it must not light that board's map.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const store = useCallback((next: QuizOut) => {
    ref.current = next;
    setQuiz(next);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      store(await api.quiz(boardId));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [boardId, store]);

  useEffect(() => {
    void reload();
  }, [reload, analysisVersion]);

  const submit = useCallback<QuizState["submit"]>(
    async (questionId, choiceIds, text, source) => {
      setPending(questionId);
      try {
        const answered = await api.answer(boardId, { question_id: questionId, choice_ids: choiceIds, text });
        const { attempt, mastery } = answered;
        const current = ref.current;
        if (current) store({ ...current, results: { ...current.results, [questionId]: attempt }, mastery });
        const use = answered.memory;
        if (use) setMemory((before) => ({ ...before, [questionId]: use }));
        if (alive.current) useBoardUi.getState().setHighlight(attempt.highlight, source);
        // Open answers are graded by a model and count against today's usage.
        refreshMe();
        return attempt;
      } finally {
        setPending(null);
      }
    },
    [boardId, store, refreshMe],
  );

  const reset = useCallback(async () => {
    await api.resetQuiz(boardId);
    useBoardUi.getState().clearHighlight();
    await reload();
  }, [boardId, reload]);

  const latest = useCallback(() => ref.current, []);

  return { quiz, loading, error, pending, memory, latest, submit, reset, reload };
}
