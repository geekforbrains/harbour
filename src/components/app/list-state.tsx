import { EmptyState } from "@/components/app/empty-state";
import { ScopePrompt } from "@/components/app/scope-prompt";

/**
 * The shared "what does a list page show right now" branch, sans the loading
 * state (loading is an early `PageLoading` return that precedes the page header).
 *
 * Order of precedence, matching every list page:
 *   1. no scope selected → <ScopePrompt> (prompt the user to pick an org/project)
 *   2. nothing to show    → <EmptyState> with the page's icon + copy
 *   3. otherwise          → the list itself (children)
 *
 * `scope` is the active scope id (org or project) the list is keyed to; when
 * it's falsy the scope prompt renders. `scopeNeed`/`scopeEntity` are passed
 * straight through to <ScopePrompt>.
 */
export function ListState({
  scope,
  scopeNeed,
  scopeEntity,
  isEmpty,
  emptyIcon,
  emptyMessage,
  children,
}: {
  scope: unknown;
  scopeNeed: "org" | "project";
  scopeEntity: string;
  isEmpty: boolean;
  emptyIcon: React.ReactNode;
  emptyMessage: React.ReactNode;
  children: React.ReactNode;
}) {
  if (!scope) return <ScopePrompt need={scopeNeed} entity={scopeEntity} />;
  if (isEmpty)
    return (
      <EmptyState large icon={emptyIcon}>
        {emptyMessage}
      </EmptyState>
    );
  return <>{children}</>;
}
