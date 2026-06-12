import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Marks an org-level row (project_id IS NULL) on dual-tier lists — workflows
 * and their runs. Monochrome outline per the design language: scope is a
 * type-like fact, not a state, so it gets shape, not color.
 */
export function OrgBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn("text-[10px] shrink-0", className)}>
      Org
    </Badge>
  );
}
