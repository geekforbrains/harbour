"use client";

import { ShieldOff } from "lucide-react";
import { useId } from "react";
import { SELECT_CLASS } from "@/components/app/model-thinking-select";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";

// Per-agent CLI permission policy. "enforced" (the default) requires an
// operator-authored policy file in the agent's workspace — the runner refuses
// to run without one. "unrestricted" keeps the CLI's permission-bypass flag,
// so selecting it is gated behind the codebase's confirm() idiom.

const CONFIRM_UNRESTRICTED =
  "Run this agent unrestricted? All permission checks will be bypassed and its workspace policy file ignored.";

export function PermissionsSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const inputId = useId();

  function handleChange(next: string) {
    if (next === "unrestricted" && !confirm(CONFIRM_UNRESTRICTED)) return;
    onChange(next);
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>Permissions</Label>
      <select
        id={inputId}
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        className={SELECT_CLASS}
      >
        <option value="enforced">Enforced (policy file)</option>
        <option value="unrestricted">Unrestricted (bypass permissions)</option>
      </select>
      <p className="text-xs text-muted-foreground">
        {value === "unrestricted"
          ? "All permission checks are bypassed and the workspace policy file is ignored."
          : "Requires a policy file in the agent's workspace; the runner refuses to run without one."}
      </p>
    </div>
  );
}

/**
 * At-a-glance marker for an agent running with permission checks bypassed —
 * shown wherever the agent's identity is displayed.
 *
 * Deliberately monochrome. Color here is reserved for run status and agent
 * identity (design-language.md), and this badge sits in the same row as the
 * amber `waiting` and violet `pending` status badges — tinting it would put a
 * third color dimension in the view and, in amber, would read as a status. The
 * shield icon carries the meaning instead, per "entity type is conveyed by icon
 * shape, not color".
 */
export function UnrestrictedBadge() {
  return (
    <Badge
      variant="outline"
      className="text-[10px] gap-1 shrink-0 font-normal"
      title="Permission checks are bypassed for this agent"
    >
      <ShieldOff className="h-3 w-3" />
      Unrestricted
    </Badge>
  );
}
