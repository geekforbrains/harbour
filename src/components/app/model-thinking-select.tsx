"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CLI_CONFIG } from "@/lib/cli-config";

const SELECT_CLASS =
  "flex h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

export { SELECT_CLASS };

export function ModelThinkingSelect({
  cli,
  model,
  thinking,
  onModelChange,
  onThinkingChange,
  defaultModelLabel,
  defaultThinkingLabel,
  modelPlaceholder,
  modelSuggestions,
}: {
  cli: string;
  model: string;
  thinking: string;
  onModelChange: (value: string) => void;
  onThinkingChange: (value: string) => void;
  defaultModelLabel?: string;
  defaultThinkingLabel?: string;
  modelPlaceholder?: string;
  modelSuggestions?: string[];
}) {
  const config = CLI_CONFIG[cli];
  const modelListId = useId();
  const thinkingListId = useId();
  const modelInputId = useId();
  const thinkingInputId = useId();
  if (!config) return null;

  const models = modelSuggestions ?? config.models;

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={modelInputId}>Model</Label>
        {config.modelInput === "text" ? (
          <>
            <Input
              id={modelInputId}
              className="font-mono"
              value={model}
              onChange={(event) => onModelChange(event.target.value)}
              placeholder={modelPlaceholder ?? defaultModelLabel ?? "provider/model-id"}
              list={models.length > 0 ? modelListId : undefined}
            />
            {models.length > 0 && (
              <datalist id={modelListId}>
                {models.map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
            )}
          </>
        ) : (
          <select
            id={modelInputId}
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            className={SELECT_CLASS}
          >
            {defaultModelLabel !== undefined && <option value="">{defaultModelLabel}</option>}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}
      </div>
      {config.thinkingOptions.length > 0 && (
        <div className="space-y-2">
          <Label htmlFor={thinkingInputId}>{config.thinkingLabel}</Label>
          {config.thinkingInput === "text" ? (
            <>
              <Input
                id={thinkingInputId}
                value={thinking}
                onChange={(event) => onThinkingChange(event.target.value)}
                placeholder={defaultThinkingLabel ?? "Default"}
                list={thinkingListId}
              />
              <datalist id={thinkingListId}>
                {config.thinkingOptions.map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
              <p className="text-xs text-muted-foreground">
                Optional provider-specific OpenCode variant.
              </p>
            </>
          ) : (
            <select
              id={thinkingInputId}
              value={thinking}
              onChange={(e) => onThinkingChange(e.target.value)}
              className={SELECT_CLASS}
            >
              {defaultThinkingLabel !== undefined && (
                <option value="">{defaultThinkingLabel}</option>
              )}
              {config.thinkingOptions.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </>
  );
}
