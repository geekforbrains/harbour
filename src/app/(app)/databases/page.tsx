"use client";

import Link from "next/link";
import { Database, Briefcase } from "lucide-react";
import { timeAgo } from "@/lib/time";
import { EmptyState } from "@/components/app/empty-state";
import { ScopePrompt } from "@/components/app/scope-prompt";
import { useActiveOrgId } from "@/lib/hooks/use-project-filter";
import { useDatabases } from "@/lib/hooks/use-databases";

type DatabaseEntry = {
  id: string;
  name: string;
  table_name: string;
  row_count: number;
  jobs: { id: string; name: string }[];
  created_at: number;
  updated_at: number;
};

export default function DatabasesPage() {
  const activeOrgId = useActiveOrgId();

  const { data: databasesData = [], isLoading: loading } = useDatabases();
  const databases = databasesData as DatabaseEntry[];

  if (loading) return <div className="text-sm text-muted-foreground py-12 text-center">Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Databases</h1>
          <p className="text-sm text-muted-foreground mt-1">Agent-managed SQLite tables.</p>
        </div>
        {/* TODO(v2): "Add Existing" removed — v2 dropped the per-project link
            tables and the PATCH link/unlink route; no entity PUT route accepts a
            project_id move. Restore once the data layer supports reparenting. */}
      </div>

      {!activeOrgId ? (
        <ScopePrompt need="org" entity="databases" />
      ) : databases.length === 0 ? (
        <EmptyState large icon={<Database className="h-10 w-10 text-muted-foreground/40" />}>
          No databases yet. Agents create them through the API.
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {databases.map(db => (
            <Link key={db.id} href={`/databases/${db.id}`} className="flex items-start gap-3 rounded-lg border p-3 hover:bg-accent/50 transition-colors">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Database className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-mono font-medium">{db.name}</span>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                  {db.jobs.length > 0 && (
                    <span className="flex items-center gap-1">
                      <Briefcase className="h-3 w-3" />
                      <span className="truncate">{db.jobs.map(j => j.name).join(", ")}</span>
                    </span>
                  )}
                  <span>{db.row_count} {db.row_count === 1 ? "row" : "rows"}</span>
                </div>
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap pt-1">{timeAgo(db.updated_at)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
