import { useState } from "react";
import { MessageCircleQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type QuestionOption = { label: string; description?: string };
type AgentQuestion = { question: string; header?: string; options: QuestionOption[]; multiSelect?: boolean };

export const isQuestionRequest = (toolName: string) => toolName === "AskUserQuestion";

export function questionsOf(input: unknown): AgentQuestion[] {
  const questions = (input as { questions?: unknown })?.questions;
  return Array.isArray(questions) ? (questions as AgentQuestion[]) : [];
}

/** Agent asks (AskUserQuestion): pick options or type an own answer; skip tells the agent nothing was chosen. */
export function QuestionCard(props: { input: unknown; onAnswer: (answers: Record<string, string>) => void; onSkip: () => void }) {
  const questions = questionsOf(props.input);
  const [selectedLabels, setSelectedLabels] = useState<Record<string, string[]>>({});
  const [ownAnswers, setOwnAnswers] = useState<Record<string, string>>({});

  const toggle = (question: AgentQuestion, label: string) =>
    setSelectedLabels((previous) => {
      const current = previous[question.question] ?? [];
      const next = question.multiSelect ? (current.includes(label) ? current.filter((entry) => entry !== label) : [...current, label]) : [label];
      return { ...previous, [question.question]: next };
    });

  const answerFor = (question: AgentQuestion) => [...(selectedLabels[question.question] ?? []), ownAnswers[question.question]?.trim()].filter(Boolean).join(", ");
  const complete = questions.every((question) => answerFor(question));

  return (
    <div className="grid animate-in gap-4 rounded-xl border bg-card p-3 shadow-xs fade-in slide-in-from-bottom-1 duration-200">
      {questions.map((question) => (
        <div key={question.question} className="grid gap-2">
          <div className="flex items-start gap-2 text-[13px]">
            <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-status-waiting" />
            <span className="font-medium">{question.question}</span>
          </div>
          <div className="grid gap-1.5 pl-6">
            {question.options.map((option) => {
              const selected = (selectedLabels[question.question] ?? []).includes(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => toggle(question, option.label)}
                  className={cn("rounded-lg border px-3 py-2 text-left transition-colors hover:bg-foreground/[0.04]", selected && "border-primary bg-primary/[0.06]")}
                >
                  <div className="text-[13px] font-medium">{option.label}</div>
                  {option.description && <div className="text-[12px] text-muted-foreground">{option.description}</div>}
                </button>
              );
            })}
            <Input
              value={ownAnswers[question.question] ?? ""}
              placeholder="Eigene Antwort …"
              className="h-8 text-[13px]"
              onChange={(changeEvent) => setOwnAnswers((previous) => ({ ...previous, [question.question]: changeEvent.target.value }))}
            />
          </div>
        </div>
      ))}
      <div className="flex gap-2 pl-6">
        <Button size="sm" disabled={!complete} onClick={() => props.onAnswer(Object.fromEntries(questions.map((question) => [question.question, answerFor(question)])))}>
          Antworten
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onSkip}>
          Überspringen
        </Button>
      </div>
    </div>
  );
}
