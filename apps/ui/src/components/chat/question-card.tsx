import { useState } from "react";
import { ArrowLeft, MessageCircleQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

type QuestionOption = { label: string; description?: string };
type AgentQuestion = { question: string; header?: string; options: QuestionOption[]; multiSelect?: boolean };

export const isQuestionRequest = (toolName: string) => toolName === "AskUserQuestion";

export function questionsOf(input: unknown): AgentQuestion[] {
  const questions = (input as { questions?: unknown })?.questions;
  return Array.isArray(questions) ? (questions as AgentQuestion[]) : [];
}

/**
 * Agent asks (AskUserQuestion). One question at a time: pick options or type an own answer, then continue.
 * "Überspringen" skips only the current question; skipping all of them tells the agent nothing was chosen.
 */
export function QuestionCard(props: { input: unknown; onAnswer: (answers: Record<string, string>) => void; onSkip: () => void }) {
  const questions = questionsOf(props.input);
  const [stepIndex, setStepIndex] = useState(0);
  const [selectedLabels, setSelectedLabels] = useState<Record<string, string[]>>({});
  const [ownAnswers, setOwnAnswers] = useState<Record<string, string>>({});
  const [skippedQuestions, setSkippedQuestions] = useState<Set<string>>(new Set());

  const question = questions[stepIndex];
  if (!question) return null;
  const isLastStep = stepIndex === questions.length - 1;

  const toggle = (label: string) =>
    setSelectedLabels((previous) => {
      const current = previous[question.question] ?? [];
      const next = question.multiSelect ? (current.includes(label) ? current.filter((entry) => entry !== label) : [...current, label]) : [label];
      return { ...previous, [question.question]: next };
    });

  const answerFor = (candidate: AgentQuestion) =>
    skippedQuestions.has(candidate.question) ? "" : [...(selectedLabels[candidate.question] ?? []), ownAnswers[candidate.question]?.trim()].filter(Boolean).join(", ");

  const finish = (skipped: Set<string>) => {
    const answers = Object.fromEntries(
      questions.flatMap((candidate) => {
        const answer = skipped.has(candidate.question) ? "" : answerFor(candidate);
        return answer ? [[candidate.question, answer]] : [];
      }),
    );
    if (Object.keys(answers).length === 0) props.onSkip();
    else props.onAnswer(answers);
  };

  const goForward = (skipped: Set<string>) => (isLastStep ? finish(skipped) : setStepIndex(stepIndex + 1));

  const skipCurrent = () => {
    const nextSkipped = new Set(skippedQuestions).add(question.question);
    setSkippedQuestions(nextSkipped);
    goForward(nextSkipped);
  };

  const continueWithCurrent = () => {
    const nextSkipped = new Set(skippedQuestions);
    nextSkipped.delete(question.question);
    setSkippedQuestions(nextSkipped);
    goForward(nextSkipped);
  };

  const hasAnswer = Boolean((selectedLabels[question.question] ?? []).length || ownAnswers[question.question]?.trim());

  return (
    <div className="grid animate-in gap-3 rounded-xl border bg-card p-3 shadow-xs fade-in slide-in-from-bottom-1 duration-200">
      <div className="flex items-start gap-2 text-[13px]">
        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-status-waiting" />
        <span className="min-w-0 flex-1 font-medium">{question.question}</span>
        {questions.length > 1 && (
          <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">
            {stepIndex + 1} / {questions.length}
          </span>
        )}
      </div>

      <div key={stepIndex} className="grid animate-in gap-1.5 pl-6 fade-in duration-150">
        {question.options.map((option) => {
          const selected = (selectedLabels[question.question] ?? []).includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              onClick={() => toggle(option.label)}
              className={cn("rounded-lg border px-3 py-2 text-left transition-colors hover:bg-foreground/[0.04]", selected && "border-primary bg-primary/[0.06]")}
            >
              <div className="text-[13px] font-medium">{option.label}</div>
              {option.description && <div className="text-[12px] text-muted-foreground">{option.description}</div>}
            </button>
          );
        })}
        <Input
          value={ownAnswers[question.question] ?? ""}
          placeholder={t("Eigene Antwort …")}
          className="h-8 text-[13px]"
          onChange={(changeEvent) => setOwnAnswers((previous) => ({ ...previous, [question.question]: changeEvent.target.value }))}
        />
      </div>

      <div className="flex items-center gap-2 pl-6">
        {stepIndex > 0 && (
          <Button size="sm" variant="ghost" className="px-2" aria-label={t("Zurück")} onClick={() => setStepIndex(stepIndex - 1)}>
            <ArrowLeft className="size-4" />
          </Button>
        )}
        <Button size="sm" disabled={!hasAnswer} onClick={continueWithCurrent}>
          {isLastStep ? t("Antworten") : t("Weiter")}
        </Button>
        <Button size="sm" variant="ghost" onClick={skipCurrent}>
          {t("Überspringen")}
        </Button>
      </div>
    </div>
  );
}
