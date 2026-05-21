export function EmptyState({ icon, children, large }: { icon?: React.ReactNode; children: React.ReactNode; large?: boolean }) {
  return (
    <div className={`rounded-[28px] border border-dashed border-[#d8d8d8] bg-white/55 ${large ? "p-12" : "p-8"} text-center text-sm font-medium text-muted-foreground backdrop-blur`}>
      {icon && <div className="flex justify-center mb-3">{icon}</div>}
      {children}
    </div>
  );
}
