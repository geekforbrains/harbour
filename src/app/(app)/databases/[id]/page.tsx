"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/app/back-link";
import { PageLoading } from "@/components/app/page-header";
import { Briefcase, ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { timeAgo } from "@/lib/time";
import { EmptyState } from "@/components/app/empty-state";
import { useDatabase, useDatabaseRows, useDeleteDatabase } from "@/lib/hooks/use-databases";

type ColumnInfo = { cid: number; name: string; type: string; notnull: number; dflt_value: any; pk: number };
type JobRef = { id: string; name: string };

type DatabaseDetail = {
  id: string;
  name: string;
  table_name: string;
  columns: ColumnInfo[];
  jobs: JobRef[];
  created_at: number;
  updated_at: number;
};

type RowsResponse = {
  rows: Record<string, any>[];
  total: number;
  limit: number;
  offset: number;
};

function formatCell(value: any): string {
  if (value === null || value === undefined) return "\u2014";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export default function DatabaseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [page, setPage] = useState(0);
  const pageSize = 50;

  const { data: dbData, isLoading: dbLoading } = useDatabase(id, { refetchInterval: 5000 });
  const db = (dbData as DatabaseDetail | undefined) ?? null;

  const { data: rowsRaw, isLoading: rowsLoading } = useDatabaseRows(id, page, pageSize, { refetchInterval: 5000 });
  const rowsData = (rowsRaw as RowsResponse | undefined) ?? null;

  const deleteDatabase = useDeleteDatabase();

  const loading = dbLoading || rowsLoading;

  async function handleDelete() {
    if (!confirm(`Delete "${db?.name}"? The table and all its data will be permanently removed.`)) return;
    try {
      await deleteDatabase.mutateAsync(id);
    } catch {
      alert("Failed to delete database");
      return;
    }
    router.push("/databases");
  }

  if (loading) return <PageLoading />;
  if (!db) return <div className="text-sm text-muted-foreground py-12 text-center">Database not found.</div>;

  const totalPages = rowsData ? Math.ceil(rowsData.total / pageSize) : 0;
  const columns = db.columns;
  const rows = rowsData?.rows ?? [];

  return (
    <div className="space-y-6">
      <BackLink href="/databases" label="Databases" />

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight font-mono">{db.name}</h1>
          <p className="text-xs text-muted-foreground mt-1">
            {rowsData?.total ?? 0} {(rowsData?.total ?? 0) === 1 ? "row" : "rows"} · Updated {timeAgo(db.updated_at)}
          </p>
        </div>
        <Button variant="outline" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={handleDelete} title="Delete">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {db.jobs.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          {db.jobs.map(j => (
            <Link key={j.id} href={`/jobs/${j.id}`}>
              <Badge variant="secondary" className="gap-1 cursor-pointer hover:bg-accent">
                <Briefcase className="h-3 w-3" /> {j.name}
              </Badge>
            </Link>
          ))}
        </div>
      )}

      {/* Schema */}
      <div className="flex flex-wrap gap-2">
        {columns.map(col => (
          <Badge key={col.name} variant="outline" className="font-mono text-xs gap-1">
            {col.name}
            <span className="text-muted-foreground/60">{col.type.toLowerCase()}</span>
            {col.notnull ? <span className="text-muted-foreground/40">*</span> : null}
          </Badge>
        ))}
      </div>

      {/* Table */}
      {rows.length === 0 ? (
        <EmptyState>No rows.</EmptyState>
      ) : (
        <div className="overflow-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground w-12">#</th>
                {columns.map(col => (
                  <th key={col.name} className="px-3 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap">
                    {col.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row._id} className="border-b last:border-0 hover:bg-accent/30 transition-colors">
                  <td className="px-3 py-2 text-xs text-muted-foreground">{row._id}</td>
                  {columns.map(col => (
                    <td key={col.name} className="px-3 py-2 text-sm whitespace-nowrap">
                      {formatCell(row[col.name])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <div className="flex gap-1">
            <Button variant="outline" size="icon" className="h-7 w-7" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button variant="outline" size="icon" className="h-7 w-7" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
