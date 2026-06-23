import { Badge } from "@/components/ui/badge";

export function SectionHeader({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
      {children}
      {count !== undefined && (
        <Badge variant="secondary" className="ml-1">
          {count}
        </Badge>
      )}
    </h2>
  );
}
