export interface Ticket { id: string; subject: string; status: "open" | "pending" | "resolved"; priority: "low" | "medium" | "high" | "urgent"; requester: string; messages: { author: string; body: string }[]; }
export interface User { id: string; name: string; email: string; active: boolean; department: string; }
export interface AccessRequest { id: string; userId: string; resource: string; scope: "read" | "write" | "admin"; isProduction: boolean; status: "pending" | "approved" | "denied" | "escalated"; }
export interface Workflow { id: string; name: string; description: string; }
export interface Store { tickets: Ticket[]; users: User[]; accessRequests: AccessRequest[]; workflows: Workflow[]; idempo: Record<string, string>; seq: number; }

export const ERROR_TICKET_ID = "TCK-ERROR";

export function createStore(): Store {
  return {
    seq: 2000,
    idempo: {},
    tickets: [
      { id: "TCK-1001", subject: "VPN won't connect", status: "open", priority: "high", requester: "USR-2", messages: [] },
      { id: "TCK-1002", subject: "Request Figma license", status: "open", priority: "low", requester: "USR-3", messages: [] },
      { id: "TCK-1003", subject: "Laptop running slow", status: "pending", priority: "medium", requester: "USR-2", messages: [] },
    ],
    users: [
      { id: "USR-1", name: "Jane Doe", email: "jane@acme.com", active: true, department: "Engineering" },
      { id: "USR-2", name: "Bob Smith", email: "bob@acme.com", active: true, department: "Sales" },
      { id: "USR-3", name: "Carol Lee", email: "carol@acme.com", active: false, department: "Design" },
    ],
    accessRequests: [
      { id: "ACC-1", userId: "USR-1", resource: "github", scope: "write", isProduction: false, status: "pending" },
      { id: "ACC-2", userId: "USR-1", resource: "aws-prod", scope: "admin", isProduction: true, status: "pending" },
      { id: "ACC-3", userId: "USR-3", resource: "salesforce", scope: "read", isProduction: false, status: "pending" },
    ],
    workflows: [{ id: "WF-onboard", name: "Standard Onboarding", description: "Accounts, baseline access, laptop" }],
  };
}
