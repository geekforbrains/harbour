// Workflows are jobs (kind === "workflow") under the hood — same API, same
// detail view. This route exists so workflows live under /workflows in the
// URL and nav; the shared component adapts its labels/links via job.kind.
export { default } from "../../jobs/[id]/page";
