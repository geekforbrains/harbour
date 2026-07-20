import { EmptyState } from "@/components/app/empty-state";

/**
 * The shared "what does a list page show right now" branch, sans the loading
 * state (loading is an early `PageLoading` return that precedes the page header).
 */
export function ListState({
  isEmpty,
  emptyIcon,
  emptyMessage,
  children,
}: {
  isEmpty: boolean;
  emptyIcon: React.ReactNode;
  emptyMessage: React.ReactNode;
  children: React.ReactNode;
}) {
  if (isEmpty)
    return (
      <EmptyState large icon={emptyIcon}>
        {emptyMessage}
      </EmptyState>
    );
  return <>{children}</>;
}
