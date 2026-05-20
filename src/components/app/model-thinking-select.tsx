"use client";

import { Label } from "@/components/ui/label";
import { CLI_CONFIG, modelOptionLabel, modelOptionValue } from "@/lib/cli-config";

const SELECT_CLASS = "flex h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

export { SELECT_CLASS };

export function ModelThinkingSelect({
  cli,
  model,
  thinking,
  onModelChange,
  onThinkingChange,
  defaultModelLabel,
  defaultThinkingLabel,
}: {
  cli: string;
  model: string;
  thinking: string;
  onModelChange: (value: string) => void;
  onThinkingChange: (value: string) => void;
  defaultModelLabel?: string;
  defaultThinkingLabel?: string;
}) {
  const config = CLI_CONFIG[cli];
  if (!config) return null;
  const groupedModels = config.models.reduce<Record<string, typeof config.models>>((groups, option) => {
    const group = typeof option === "string" ? "" : option.group || "";
    groups[group] = groups[group] || [];
    groups[group].push(option);
    return groups;
  }, {});
  const ungroupedModels = groupedModels[""] || [];
  const groupedModelEntries = Object.entries(groupedModels).filter(([group]) => group);

  return (
    <>
      <div className="space-y-2">
        <Label>Model</Label>
        <select value={model} onChange={e => onModelChange(e.target.value)} className={SELECT_CLASS}>
          {defaultModelLabel !== undefined && <option value="">{defaultModelLabel}</option>}
          {ungroupedModels.map(option => (
            <option key={modelOptionValue(option)} value={modelOptionValue(option)}>{modelOptionLabel(option)}</option>
          ))}
          {groupedModelEntries.map(([group, options]) => (
            <optgroup key={group} label={group}>
              {options.map(option => (
                <option key={modelOptionValue(option)} value={modelOptionValue(option)}>{modelOptionLabel(option)}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      {config.thinkingOptions.length > 0 && (
        <div className="space-y-2">
          <Label>{config.thinkingLabel}</Label>
          <select value={thinking} onChange={e => onThinkingChange(e.target.value)} className={SELECT_CLASS}>
            {defaultThinkingLabel !== undefined && <option value="">{defaultThinkingLabel}</option>}
            {config.thinkingOptions.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      )}
    </>
  );
}
