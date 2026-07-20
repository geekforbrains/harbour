import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Names the project a row belongs to — shown on union-view lists and detail
 * headers. Monochrome outline per the design language: scope is a type-like
 * fact, not a state, so it gets shape, not color.
 */
export function ProjectBadge({ name, className }: { name?: string; className?: string }) {
  if (!name) return null;
  return (
    <Badge variant="outline" className={cn("text-[10px] shrink-0", className)}>
      {name}
    </Badge>
  );
}
