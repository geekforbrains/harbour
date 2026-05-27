"use client";

import { Database, Briefcase } from "lucide-react";
import { timeAgo } from "@/lib/time";
import { PageHeader, PageLoading } from "@/components/app/page-header";
import { ListState } from "@/components/app/list-state";
import { RowLink } from "@/components/app/row-link";
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

  if (loading) return <PageLoading />;

  return (
    <div className="space-y-6">
      {/* TODO(v2): "Add Existing" removed — v2 dropped the per-project link
          tables and the PATCH link/unlink route; no entity PUT route accepts a
          project_id move. Restore once the data layer supports reparenting. */}
      <PageHeader title="Databases" subtitle="Agent-managed SQLite tables." />

      <ListState
        scope={activeOrgId}
        scopeNeed="org"
        scopeEntity="databases"
        isEmpty={databases.length === 0}
        emptyIcon={<Database className="h-10 w-10 text-muted-foreground/40" />}
        emptyMessage="No databases yet. Agents create them through the API."
      >
        <div className="space-y-2">
          {databases.map(db => (
            <RowLink key={db.id} href={`/databases/${db.id}`}>
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
            </RowLink>
          ))}
        </div>
      </ListState>
    </div>
  );
}
