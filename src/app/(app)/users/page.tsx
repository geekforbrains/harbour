"use client";

import { User } from "lucide-react";
import { timeAgo } from "@/lib/time";
import { EmptyState } from "@/components/app/empty-state";
import { useUsers } from "@/lib/hooks/use-users";

type UserType = { id: string; email: string; display_name: string; created_at: number };

export default function UsersPage() {
  const { data: usersData = [], isLoading: loading } = useUsers();
  const users = usersData as unknown as UserType[];

  if (loading) return <div className="text-sm text-muted-foreground py-12 text-center">Loading...</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm text-muted-foreground mt-1">Dashboard accounts.</p>
      </div>

      {users.length === 0 ? (
        <EmptyState>No users.</EmptyState>
      ) : (
        <div className="space-y-2">
          {users.map(user => (
            <div key={user.id} className="flex items-start gap-3 rounded-lg border p-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <User className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{user.display_name}</div>
                <div className="text-xs text-muted-foreground">{user.email}</div>
              </div>
              <span className="text-xs text-muted-foreground pt-1">Joined {timeAgo(user.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
