import type { Store, Ticket, AccessRequest } from "./seeds";
import { ERROR_TICKET_ID } from "./seeds";
import { decideAccess } from "../policy/access-policy";

export type OpResult = { data: unknown } | { error: string };

// Permissiveness ordering: an agent may be MORE restrictive than policy, never less.
const RANK = { deny: 0, escalate: 1, approve: 2 } as const;
const STATUS = { approve: "approved", deny: "denied", escalate: "escalated" } as const;
const ok = (data: unknown): OpResult => ({ data });
const no = (error: string): OpResult => ({ error });

export const operations = {
  list_tickets: (s: Store): OpResult => ok({ tickets: s.tickets.map(({ messages, ...t }) => t) }),
  get_ticket: (s: Store, a: { id: string }): OpResult => {
    if (a.id === ERROR_TICKET_ID) return no("Simulated upstream error");
    const t = s.tickets.find((x) => x.id === a.id);
    return t ? ok(t) : no(`Ticket ${a.id} not found`);
  },
  update_ticket: (s: Store, a: { id: string; status?: Ticket["status"]; priority?: Ticket["priority"] }): OpResult => {
    const t = s.tickets.find((x) => x.id === a.id);
    if (!t) return no(`Ticket ${a.id} not found`);
    if (a.status) t.status = a.status;
    if (a.priority) t.priority = a.priority;
    return ok(t);
  },
  post_message: (s: Store, a: { id: string; body: string }): OpResult => {
    const t = s.tickets.find((x) => x.id === a.id);
    if (!t) return no(`Ticket ${a.id} not found`);
    t.messages.push({ author: "agent", body: a.body });
    return ok({ id: t.id, messageCount: t.messages.length });
  },
  list_access_requests: (s: Store): OpResult => ok({ accessRequests: s.accessRequests }),
  get_access_request: (s: Store, a: { id: string }): OpResult => {
    const r = s.accessRequests.find((x) => x.id === a.id);
    return r ? ok(r) : no(`Access request ${a.id} not found`);
  },
  review_access_request: (s: Store, a: { id: string; decision: "approve" | "deny" | "escalate" }): OpResult => {
    const r = s.accessRequests.find((x) => x.id === a.id);
    if (!r) return no(`Access request ${a.id} not found`);
    // Deterministic policy is the safety boundary: the recorded decision can never
    // be more permissive than decideAccess() allows. If the agent tries, the
    // policy verdict is enforced and the override is reported back to the agent.
    const user = s.users.find((u) => u.id === r.userId);
    const verdict = decideAccess({
      resource: r.resource,
      scope: r.scope,
      requesterActive: user?.active ?? false,
      isProduction: r.isProduction,
      isAdmin: r.scope === "admin",
    });
    const enforced = RANK[a.decision] > RANK[verdict.decision];
    const final = enforced ? verdict.decision : a.decision;
    r.status = STATUS[final] as AccessRequest["status"];
    return ok(enforced ? { ...r, enforced: true, policyDecision: verdict.decision, policyReason: verdict.reason } : r);
  },
  create_access_request: (s: Store, a: { userId: string; resource: string; scope: "read" | "write" | "admin"; isProduction?: boolean; idempotencyKey?: string }): OpResult => {
    const k = a.idempotencyKey && "acc:" + a.idempotencyKey;
    if (k && s.idempo[k]) return ok(s.accessRequests.find((x) => x.id === s.idempo[k]));
    const id = `ACC-${s.accessRequests.length + 100}`;
    const rec: AccessRequest = { id, userId: a.userId, resource: a.resource, scope: a.scope, isProduction: a.isProduction ?? false, status: "pending" };
    s.accessRequests.push(rec);
    if (k) s.idempo[k] = id;
    return ok(rec);
  },
  create_ticket: (s: Store, a: { subject: string; requester: string; priority?: Ticket["priority"]; idempotencyKey?: string }): OpResult => {
    const k = a.idempotencyKey && "tck:" + a.idempotencyKey;
    if (k && s.idempo[k]) return ok(s.tickets.find((x) => x.id === s.idempo[k]));
    const id = `TCK-${++s.seq}`;
    const rec: Ticket = { id, subject: a.subject, status: "open", priority: a.priority ?? "medium", requester: a.requester, messages: [] };
    s.tickets.push(rec);
    if (k) s.idempo[k] = id;
    return ok({ id: rec.id, subject: rec.subject, status: rec.status, priority: rec.priority });
  },
  get_user: (s: Store, a: { id: string }): OpResult => {
    const u = s.users.find((x) => x.id === a.id || x.email === a.id || x.name.toLowerCase() === String(a.id).toLowerCase());
    return u ? ok(u) : no(`User ${a.id} not found`);
  },
  list_workflows: (s: Store): OpResult => ok({ workflows: s.workflows }),
  run_workflow: (s: Store, a: { id: string; subjectUserId: string }): OpResult => {
    const wf = s.workflows.find((x) => x.id === a.id);
    if (!wf) return no(`Workflow ${a.id} not found`);
    return ok({ workflow: wf.id, subject: a.subjectUserId, status: "completed", steps: ["accounts", "baseline-access", "laptop"] });
  },
} as const;
