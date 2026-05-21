import { Badge } from "@/components/ui/badge";

export function SectionHeader({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-[#7c7c7c]">
      {children}
      {count !== undefined && <Badge variant="secondary" className="ml-1">{count}</Badge>}
    </h2>
  );
}
