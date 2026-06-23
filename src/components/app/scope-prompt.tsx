import { Building2, FolderOpen } from "lucide-react";

/**
 * Shown in place of an empty state when a list can't load because the required
 * scope isn't selected. Org-scoped pages need an active org ("All orgs" =
 * `activeOrgId == null`); project-scoped pages additionally need an active
 * project. The scoped data hooks disable themselves without that scope, so
 * without this prompt the page would misleadingly fall through to "No X yet."
 */
export function ScopePrompt({ need, entity }: { need: "org" | "project"; entity: string }) {
  const Icon = need === "org" ? Building2 : FolderOpen;
  const what = need === "org" ? "an organization" : "a project";
  return (
    <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
      <div className="flex justify-center mb-3">
        <Icon className="h-10 w-10 text-muted-foreground/40" />
      </div>
      Select {what} to view {entity}.
    </div>
  );
}
