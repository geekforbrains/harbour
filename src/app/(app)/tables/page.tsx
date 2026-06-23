"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Briefcase, Pin, Table2 } from "lucide-react";
import { ListState } from "@/components/app/list-state";
import { PageHeader, PageLoading } from "@/components/app/page-header";
import { RowLink } from "@/components/app/row-link";
import { apiFetch } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { useActiveOrgId } from "@/lib/hooks/use-project-filter";
import { useTables } from "@/lib/hooks/use-tables";
import { timeAgo } from "@/lib/time";

type TableEntry = {
  id: string;
  name: string;
  table_name: string;
  pinned: number;
  row_count: number;
  jobs: { id: string; name: string }[];
  created_at: number;
  updated_at: number;
};

export default function TablesPage() {
  const activeOrgId = useActiveOrgId();
  const queryClient = useQueryClient();

  const { data: tablesData = [], isLoading: loading } = useTables();
  const tables = tablesData as TableEntry[];

  async function handleTogglePin(e: React.MouseEvent, tableId: string) {
    e.preventDefault();
    try {
      await apiFetch(`/api/tables/${tableId}/pin`, { method: "POST" });
      queryClient.invalidateQueries({ queryKey: qk.tables.all });
    } catch {
      // ignore
    }
  }

  if (loading) return <PageLoading />;

  return (
    <div className="space-y-6">
      {/* TODO(v2): "Add Existing" removed — v2 dropped the per-project link
          tables and the PATCH link/unlink route; no entity PUT route accepts a
          project_id move. Restore once the data layer supports reparenting. */}
      <PageHeader title="Tables" subtitle="Agent-managed SQLite tables." />

      <ListState
        scope={activeOrgId}
        scopeNeed="org"
        scopeEntity="tables"
        isEmpty={tables.length === 0}
        emptyIcon={<Table2 className="h-10 w-10 text-muted-foreground/40" />}
        emptyMessage="No tables yet. Agents create them through the API."
      >
        <div className="space-y-2">
          {tables.map((table) => (
            <RowLink key={table.id} href={`/tables/${table.id}`}>
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Table2 className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-mono font-medium">{table.name}</span>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                  {table.jobs.length > 0 && (
                    <span className="flex items-center gap-1">
                      <Briefcase className="h-3 w-3" />
                      <span className="truncate">{table.jobs.map((j) => j.name).join(", ")}</span>
                    </span>
                  )}
                  <span>
                    {table.row_count} {table.row_count === 1 ? "row" : "rows"}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={(e) => handleTogglePin(e, table.id)}
                className={`shrink-0 p-1 rounded transition-colors ${table.pinned ? "text-primary" : "text-muted-foreground/30 hover:text-muted-foreground"}`}
                title={table.pinned ? "Unpin" : "Pin to all jobs"}
              >
                <Pin className="h-3.5 w-3.5" />
              </button>
              <span className="text-xs text-muted-foreground whitespace-nowrap pt-1">
                {timeAgo(table.updated_at)}
              </span>
            </RowLink>
          ))}
        </div>
      </ListState>
    </div>
  );
}
