"use client";

import { Bot, Check } from "lucide-react";
import { Label } from "@/components/ui/label";
import { AGENT_COLORS, resolveAgentColor } from "@/lib/agent-color";

/**
 * Shared agent color picker — 16 swatch circles plus a live preview of the
 * agent avatar as it will render in lists. Used by both the New Agent dialog
 * and the agent settings dialog so the choices stay identical.
 *
 * `value` is "" when no explicit color is chosen; the preview then falls back
 * to the name-hash color, matching what actually renders when nothing is
 * stored.
 */
export function AgentColorPicker({
  value,
  onChange,
  previewName,
}: {
  value: string;
  onChange: (color: string) => void;
  previewName: string;
}) {
  const previewColor = resolveAgentColor(value, previewName || "Agent");

  return (
    <div className="space-y-2">
      <Label>Color</Label>
      <div className="flex items-center gap-4 rounded-lg border bg-muted/40 p-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${previewColor}1f`, color: previewColor }}
        >
          <Bot className="h-5 w-5" />
        </div>
        <div className="grid grid-cols-8 gap-2">
          {AGENT_COLORS.map(color => {
            const selected = value === color;
            return (
              <button
                key={color}
                type="button"
                onClick={() => onChange(selected ? "" : color)}
                title={color}
                aria-pressed={selected}
                className={`flex h-6 w-6 items-center justify-center rounded-full transition-transform hover:scale-110 ${
                  selected ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : ""
                }`}
                style={{ backgroundColor: color }}
              >
                {selected && <Check className="h-3.5 w-3.5 text-white" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
