// The owner-approvals Worker (see approvals.ts).
import { ApprovalStore, handle, type Env } from "./approvals.ts";
import { pageResponse } from "./page.ts";

export { ApprovalStore };
export default {
  fetch: (req: Request, env: Env) => handle(req, env, pageResponse),
};
