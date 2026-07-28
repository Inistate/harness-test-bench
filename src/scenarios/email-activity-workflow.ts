// Stateless Email Activity — End-to-End Information Retrieval
//
// The Email module contains activities and starts with no records. Inistate
// custom workflow activities are entry-scoped, so a task may create one
// temporary Email entry before executing the requested activity. Every task
// removes its temporary Email entries and independent source data.

import type {
  EvaluationResult,
  IBridge,
  Scenario,
  TaskVerificationContext,
  ToolCall,
} from "../types";
import {
  AI,
  findModuleByName,
  getCreatedEntryId,
  getCreatedModuleId,
  getEntryList,
  hasError,
} from "./scenario-helpers";

const NOTIFICATION_MODULE = "EmailNotificationRequestBenchmark";
const EMPLOYEE_MODULE = "EmployeeDetailsBenchmark";
const EMPLOYEE_EMAIL_MODULE = "EmployeeEmailBenchmark";
const EMAIL_MODULE = "Email";

const SEND_EMAIL = "Send Email";
const SEND_EMAIL_WITH_CC = "Send Email With CC";
const EMAIL_MODULE_DESCRIPTION =
  "Email activity gateway; benchmark setup intentionally seeds no Email records";
const LEGACY_EMAIL_MODULE_DESCRIPTION =
  "Stateless Email activity gateway; this module intentionally contains no records";

type SourceModuleName =
  | typeof NOTIFICATION_MODULE
  | typeof EMPLOYEE_MODULE
  | typeof EMPLOYEE_EMAIL_MODULE;

interface EmailWorkflowAssets {
  workspaceId: string;
  seededEntryIds: Record<SourceModuleName, Array<string | number>>;
  createdEmailEntryIds: Array<string | number>;
  currentTaskId: string;
}

interface ExpectedEntry {
  field: string;
  value: string;
  fields: Record<string, string>;
}

interface EmailTaskDefinition {
  id: string;
  name: string;
  requestId: string;
  activity: typeof SEND_EMAIL | typeof SEND_EMAIL_WITH_CC;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  employeeEvidence: ExpectedEntry[];
  emailEvidence: ExpectedEntry[];
}

const notificationSchema = {
  name: NOTIFICATION_MODULE,
  icon: "🔔",
  description: "Synthetic notification requests for the Email activity benchmark",
  information: [
    { name: "Request ID", type: "Text", ai_hint: "Unique notification request identifier" },
    {
      name: "Audience Type",
      type: "Selection",
      options: ["Employee", "Manager", "Department"],
      ai_hint: "Determines how recipients must be resolved",
    },
    { name: "Target Employee ID", type: "Text", ai_hint: "Employee whose record starts recipient resolution" },
    { name: "Target Department", type: "Text", ai_hint: "Department used for department-wide requests" },
    { name: "Target Location", type: "Text", ai_hint: "Location constraint for department audiences" },
    {
      name: "Recipient Address Type",
      type: "Selection",
      options: ["Work", "Personal"],
      ai_hint: "Required email-address type",
    },
    {
      name: "CC Rule",
      type: "Selection",
      options: ["None", "Employee ID", "Original Employee"],
      ai_hint: "Determines whether and how a CC recipient is resolved",
    },
    { name: "CC Employee ID", type: "Text", ai_hint: "Employee ID used when CC Rule is Employee ID" },
    {
      name: "CC Address Type",
      type: "Selection",
      options: ["Work", "Personal"],
      ai_hint: "Required address type for the CC recipient",
    },
    { name: "Subject", type: "Text", ai_hint: "Pass unchanged to the Email activity" },
    { name: "Body", type: "MultiText", ai_hint: "Pass unchanged to the Email activity" },
  ],
};

const employeeSchema = {
  name: EMPLOYEE_MODULE,
  icon: "👤",
  description: "Synthetic employee directory for Email activity benchmarks",
  information: [
    { name: "Employee ID", type: "Text", ai_hint: "Unique employee identifier" },
    { name: "Full Name", type: "Text", ai_hint: "Employee legal name" },
    { name: "Job Title", type: "Text", ai_hint: "Current job title" },
    { name: "Department", type: "Text", ai_hint: "Current department" },
    { name: "Location", type: "Text", ai_hint: "Current office location" },
    {
      name: "Employment Status",
      type: "Selection",
      options: ["Active", "Inactive", "On Leave"],
      ai_hint: "Only Active employees qualify for department audiences",
    },
    { name: "Manager Employee ID", type: "Text", ai_hint: "Employee ID of the current manager" },
  ],
};

const employeeEmailSchema = {
  name: EMPLOYEE_EMAIL_MODULE,
  icon: "📇",
  description: "Synthetic employee email-address directory for Email activity benchmarks",
  information: [
    { name: "Employee ID", type: "Text", ai_hint: "Employee identifier linked to EmployeeDetailsBenchmark" },
    { name: "Email Address", type: "Email", ai_hint: "Address to pass to the Email activity" },
    {
      name: "Address Type",
      type: "Selection",
      options: ["Work", "Personal"],
      ai_hint: "Whether this is a work or personal address",
    },
    {
      name: "Primary",
      type: "Selection",
      options: ["Yes", "No"],
      ai_hint: "Prefer the primary address of the requested type",
    },
    {
      name: "Active",
      type: "Selection",
      options: ["Yes", "No"],
      ai_hint: "Never use an inactive address",
    },
  ],
};

const emailSchema = {
  name: EMAIL_MODULE,
  icon: "✉️",
  description: EMAIL_MODULE_DESCRIPTION,
  states: [
    { name: "Ready", color: "#2968A8", initial: true },
  ],
  information: [
    { name: "To", type: "MultiText", ai_hint: "One or more recipient email addresses" },
    { name: "CC", type: "MultiText", ai_hint: "One or more copied recipient email addresses" },
    { name: "Subject", type: "Text", ai_hint: "Email subject line" },
    { name: "Body", type: "MultiText", ai_hint: "Email message body" },
  ],
  activities: [
    {
      name: SEND_EMAIL,
      actor: "ai",
      confidence_threshold: 0,
      ai_hint: "Send an email immediately when no CC recipient is required",
      fields: [
        { name: "To", required: true },
        { name: "Subject", required: true },
        { name: "Body", required: true },
      ],
    },
    {
      name: SEND_EMAIL_WITH_CC,
      actor: "ai",
      confidence_threshold: 0,
      ai_hint: "Send an email immediately when one or more CC recipients are required",
      fields: [
        { name: "To", required: true },
        { name: "CC", required: true },
        { name: "Subject", required: true },
        { name: "Body", required: true },
      ],
    },
  ],
  flows: [
    { activity: SEND_EMAIL, from: "Ready", to: "Ready" },
    { activity: SEND_EMAIL_WITH_CC, from: "Ready", to: "Ready" },
  ],
};

const sourceSchemas: Record<SourceModuleName, Record<string, unknown>> = {
  [NOTIFICATION_MODULE]: notificationSchema,
  [EMPLOYEE_MODULE]: employeeSchema,
  [EMPLOYEE_EMAIL_MODULE]: employeeEmailSchema,
};

const employeeRows: Array<Record<string, unknown>> = [
  {
    "Employee ID": "EMP-1042", "Full Name": "Elena Park",
    "Job Title": "Benefits Analyst", Department: "People Operations",
    Location: "Kuala Lumpur", "Employment Status": "Active",
    "Manager Employee ID": "EMP-1001",
  },
  {
    "Employee ID": "EMP-1402", "Full Name": "Elena Parks",
    "Job Title": "Benefits Associate", Department: "People Operations",
    Location: "Kuala Lumpur", "Employment Status": "Inactive",
    "Manager Employee ID": "EMP-1001",
  },
  {
    "Employee ID": "EMP-2087", "Full Name": "Marcus Lee",
    "Job Title": "Security Analyst", Department: "Information Security",
    Location: "Kuala Lumpur", "Employment Status": "Active",
    "Manager Employee ID": "EMP-2001",
  },
  {
    "Employee ID": "EMP-2088", "Full Name": "Markus Lee",
    "Job Title": "Security Analyst", Department: "Information Security",
    Location: "Penang", "Employment Status": "Active",
    "Manager Employee ID": "EMP-2001",
  },
  {
    "Employee ID": "EMP-2001", "Full Name": "Nora Aziz",
    "Job Title": "Security Lead", Department: "Information Security",
    Location: "Kuala Lumpur", "Employment Status": "Active",
    "Manager Employee ID": "EMP-1900",
  },
  {
    "Employee ID": "EMP-3105", "Full Name": "Priya Nair",
    "Job Title": "Product Analyst", Department: "Product",
    Location: "Kuala Lumpur", "Employment Status": "Active",
    "Manager Employee ID": "EMP-3001",
  },
  {
    "Employee ID": "EMP-3001", "Full Name": "Dana Wong",
    "Job Title": "Product Director", Department: "Product",
    Location: "Kuala Lumpur", "Employment Status": "Active",
    "Manager Employee ID": "EMP-2900",
  },
  {
    "Employee ID": "EMP-3002", "Full Name": "Dana Woon",
    "Job Title": "Product Manager", Department: "Product",
    Location: "Penang", "Employment Status": "On Leave",
    "Manager Employee ID": "EMP-3001",
  },
  {
    "Employee ID": "EMP-4101", "Full Name": "Aisha Rahman",
    "Job Title": "Finance Manager", Department: "Finance",
    Location: "Kuala Lumpur", "Employment Status": "Active",
    "Manager Employee ID": "EMP-4001",
  },
  {
    "Employee ID": "EMP-4102", "Full Name": "Daniel Tan",
    "Job Title": "Accountant", Department: "Finance",
    Location: "Kuala Lumpur", "Employment Status": "Active",
    "Manager Employee ID": "EMP-4101",
  },
  {
    "Employee ID": "EMP-4103", "Full Name": "Nur Imani",
    "Job Title": "Financial Analyst", Department: "Finance",
    Location: "Kuala Lumpur", "Employment Status": "Active",
    "Manager Employee ID": "EMP-4101",
  },
  {
    "Employee ID": "EMP-4104", "Full Name": "Aisha Raman",
    "Job Title": "Accountant", Department: "Finance",
    Location: "Kuala Lumpur", "Employment Status": "Inactive",
    "Manager Employee ID": "EMP-4101",
  },
  {
    "Employee ID": "EMP-4105", "Full Name": "Danial Tan",
    "Job Title": "Finance Specialist", Department: "Finance",
    Location: "Penang", "Employment Status": "Active",
    "Manager Employee ID": "EMP-4101",
  },
  {
    "Employee ID": "EMP-4106", "Full Name": "Noor Imani",
    "Job Title": "Software Engineer", Department: "Engineering",
    Location: "Kuala Lumpur", "Employment Status": "Active",
    "Manager Employee ID": "EMP-6001",
  },
  {
    "Employee ID": "EMP-5099", "Full Name": "Sofia Alvarez",
    "Job Title": "Legal Counsel", Department: "Legal",
    Location: "Kuala Lumpur", "Employment Status": "Active",
    "Manager Employee ID": "EMP-5001",
  },
  {
    "Employee ID": "EMP-5909", "Full Name": "Sophia Alvarez",
    "Job Title": "Legal Assistant", Department: "Legal",
    Location: "Kuala Lumpur", "Employment Status": "Active",
    "Manager Employee ID": "EMP-5099",
  },
];

function emailRow(
  employeeId: string,
  address: string,
  addressType: "Work" | "Personal",
  primary: "Yes" | "No" = "Yes",
  active: "Yes" | "No" = "Yes",
): Record<string, unknown> {
  return {
    "Employee ID": employeeId,
    "Email Address": address,
    "Address Type": addressType,
    Primary: primary,
    Active: active,
  };
}

const emailRows: Array<Record<string, unknown>> = [
  emailRow("EMP-1042", "elena.park@northstar.example", "Work"),
  emailRow("EMP-1042", "elena.park.old@northstar.example", "Work", "No", "No"),
  emailRow("EMP-1042", "elena.park.personal@example.net", "Personal"),
  emailRow("EMP-1402", "elena.parks@northstar.example", "Work"),
  emailRow("EMP-2087", "marcus.lee@northstar.example", "Work"),
  emailRow("EMP-2087", "marcus.secondary@northstar.example", "Work", "No"),
  emailRow("EMP-2087", "marcus.lee.personal@example.net", "Personal"),
  emailRow("EMP-2088", "markus.lee@northstar.example", "Work"),
  emailRow("EMP-2001", "nora.aziz@northstar.example", "Work"),
  emailRow("EMP-2001", "nora.aziz.personal@example.net", "Personal"),
  emailRow("EMP-3105", "priya.nair@northstar.example", "Work"),
  emailRow("EMP-3105", "priya.nair.old@northstar.example", "Work", "No", "No"),
  emailRow("EMP-3001", "dana.wong@northstar.example", "Work"),
  emailRow("EMP-3002", "dana.woon@northstar.example", "Work"),
  emailRow("EMP-4101", "aisha.rahman@northstar.example", "Work"),
  emailRow("EMP-4101", "aisha.personal@example.net", "Personal"),
  emailRow("EMP-4102", "daniel.tan@northstar.example", "Work"),
  emailRow("EMP-4102", "daniel.old@northstar.example", "Work", "No", "No"),
  emailRow("EMP-4103", "nur.imani@northstar.example", "Work"),
  emailRow("EMP-4104", "aisha.raman@northstar.example", "Work"),
  emailRow("EMP-4105", "danial.tan@northstar.example", "Work"),
  emailRow("EMP-4106", "noor.imani@northstar.example", "Work"),
  emailRow("EMP-5099", "sofia.alvarez@northstar.example", "Work"),
  emailRow("EMP-5099", "sofia.alvarez.personal@example.net", "Personal"),
  emailRow("EMP-5099", "sofia.old.personal@example.net", "Personal", "No", "No"),
  emailRow("EMP-5909", "sophia.alvarez@northstar.example", "Work"),
  emailRow("EMP-5909", "sophia.personal@example.net", "Personal"),
];

const notificationRows: Array<Record<string, unknown>> = [
  {
    "Request ID": "NTF-1001", "Audience Type": "Employee",
    "Target Employee ID": "EMP-1042", "Target Department": "",
    "Target Location": "", "Recipient Address Type": "Work",
    "CC Rule": "None", "CC Employee ID": "", "CC Address Type": "Work",
    Subject: "Benefits enrollment reminder",
    Body: "Please complete your benefits enrollment by Friday.",
  },
  {
    "Request ID": "NTF-2001", "Audience Type": "Employee",
    "Target Employee ID": "EMP-2087", "Target Department": "",
    "Target Location": "", "Recipient Address Type": "Work",
    "CC Rule": "Employee ID", "CC Employee ID": "EMP-2001",
    "CC Address Type": "Work",
    Subject: "Immediate security acknowledgement required",
    Body: "Please acknowledge the security notice immediately.",
  },
  {
    "Request ID": "NTF-3001", "Audience Type": "Manager",
    "Target Employee ID": "EMP-3105", "Target Department": "",
    "Target Location": "", "Recipient Address Type": "Work",
    "CC Rule": "Original Employee", "CC Employee ID": "",
    "CC Address Type": "Work",
    Subject: "Probation review discussion",
    Body: "Please arrange Priya Nair's probation review discussion this week.",
  },
  {
    "Request ID": "NTF-4001", "Audience Type": "Department",
    "Target Employee ID": "", "Target Department": "Finance",
    "Target Location": "Kuala Lumpur", "Recipient Address Type": "Work",
    "CC Rule": "None", "CC Employee ID": "", "CC Address Type": "Work",
    Subject: "Finance town hall",
    Body: "The Finance town hall starts at 3:00 PM on Thursday.",
  },
  {
    "Request ID": "NTF-5001", "Audience Type": "Employee",
    "Target Employee ID": "EMP-5099", "Target Department": "",
    "Target Location": "", "Recipient Address Type": "Personal",
    "CC Rule": "None", "CC Employee ID": "", "CC Address Type": "Personal",
    Subject: "Emergency contact form",
    Body: "Please review and return your emergency contact form.",
  },
  {
    "Request ID": "NTF-100I", "Audience Type": "Employee",
    "Target Employee ID": "EMP-1402", "Target Department": "",
    "Target Location": "", "Recipient Address Type": "Work",
    "CC Rule": "None", "CC Employee ID": "", "CC Address Type": "Work",
    Subject: "Inactive employee benefits notice",
    Body: "This decoy request must not be sent.",
  },
  {
    "Request ID": "NTF-4002", "Audience Type": "Department",
    "Target Employee ID": "", "Target Department": "Finance",
    "Target Location": "Penang", "Recipient Address Type": "Work",
    "CC Rule": "None", "CC Employee ID": "", "CC Address Type": "Work",
    Subject: "Penang finance briefing",
    Body: "This message is only for the Penang office.",
  },
  {
    "Request ID": "NTF-500I", "Audience Type": "Employee",
    "Target Employee ID": "EMP-5909", "Target Department": "",
    "Target Location": "", "Recipient Address Type": "Personal",
    "CC Rule": "None", "CC Employee ID": "", "CC Address Type": "Personal",
    Subject: "Legal assistant contact form",
    Body: "This decoy request belongs to Sophia Alvarez.",
  },
];

const taskDefinitions: EmailTaskDefinition[] = [
  {
    id: "task_1_direct_work_email",
    name: "Resolve and Send a Direct Work Email",
    requestId: "NTF-1001",
    activity: SEND_EMAIL,
    to: ["elena.park@northstar.example"],
    cc: [],
    subject: "Benefits enrollment reminder",
    body: "Please complete your benefits enrollment by Friday.",
    employeeEvidence: [
      {
        field: "Employee ID", value: "EMP-1042",
        fields: { "Full Name": "Elena Park", "Employment Status": "Active" },
      },
    ],
    emailEvidence: [
      {
        field: "Email Address", value: "elena.park@northstar.example",
        fields: {
          "Employee ID": "EMP-1042", "Address Type": "Work",
          Primary: "Yes", Active: "Yes",
        },
      },
    ],
  },
  {
    id: "task_2_email_with_security_cc",
    name: "Resolve an Employee and CC a Security Lead",
    requestId: "NTF-2001",
    activity: SEND_EMAIL_WITH_CC,
    to: ["marcus.lee@northstar.example"],
    cc: ["nora.aziz@northstar.example"],
    subject: "Immediate security acknowledgement required",
    body: "Please acknowledge the security notice immediately.",
    employeeEvidence: [
      {
        field: "Employee ID", value: "EMP-2087",
        fields: { "Full Name": "Marcus Lee", "Employment Status": "Active" },
      },
      {
        field: "Employee ID", value: "EMP-2001",
        fields: { "Full Name": "Nora Aziz", "Employment Status": "Active" },
      },
    ],
    emailEvidence: [
      {
        field: "Email Address", value: "marcus.lee@northstar.example",
        fields: {
          "Employee ID": "EMP-2087", "Address Type": "Work",
          Primary: "Yes", Active: "Yes",
        },
      },
      {
        field: "Email Address", value: "nora.aziz@northstar.example",
        fields: {
          "Employee ID": "EMP-2001", "Address Type": "Work",
          Primary: "Yes", Active: "Yes",
        },
      },
    ],
  },
  {
    id: "task_3_manager_email_with_employee_cc",
    name: "Resolve a Manager and CC the Original Employee",
    requestId: "NTF-3001",
    activity: SEND_EMAIL_WITH_CC,
    to: ["dana.wong@northstar.example"],
    cc: ["priya.nair@northstar.example"],
    subject: "Probation review discussion",
    body: "Please arrange Priya Nair's probation review discussion this week.",
    employeeEvidence: [
      {
        field: "Employee ID", value: "EMP-3105",
        fields: {
          "Full Name": "Priya Nair", "Employment Status": "Active",
          "Manager Employee ID": "EMP-3001",
        },
      },
      {
        field: "Employee ID", value: "EMP-3001",
        fields: { "Full Name": "Dana Wong", "Employment Status": "Active" },
      },
    ],
    emailEvidence: [
      {
        field: "Email Address", value: "dana.wong@northstar.example",
        fields: {
          "Employee ID": "EMP-3001", "Address Type": "Work",
          Primary: "Yes", Active: "Yes",
        },
      },
      {
        field: "Email Address", value: "priya.nair@northstar.example",
        fields: {
          "Employee ID": "EMP-3105", "Address Type": "Work",
          Primary: "Yes", Active: "Yes",
        },
      },
    ],
  },
  {
    id: "task_4_department_location_email",
    name: "Resolve an Active Department Audience",
    requestId: "NTF-4001",
    activity: SEND_EMAIL,
    to: [
      "aisha.rahman@northstar.example",
      "daniel.tan@northstar.example",
      "nur.imani@northstar.example",
    ],
    cc: [],
    subject: "Finance town hall",
    body: "The Finance town hall starts at 3:00 PM on Thursday.",
    employeeEvidence: ["EMP-4101", "EMP-4102", "EMP-4103"].map((employeeId) => ({
      field: "Employee ID",
      value: employeeId,
      fields: {
        Department: "Finance", Location: "Kuala Lumpur",
        "Employment Status": "Active",
      },
    })),
    emailEvidence: [
      ["EMP-4101", "aisha.rahman@northstar.example"],
      ["EMP-4102", "daniel.tan@northstar.example"],
      ["EMP-4103", "nur.imani@northstar.example"],
    ].map(([employeeId, address]) => ({
      field: "Email Address",
      value: address,
      fields: {
        "Employee ID": employeeId, "Address Type": "Work",
        Primary: "Yes", Active: "Yes",
      },
    })),
  },
  {
    id: "task_5_personal_address_email",
    name: "Resolve and Use a Personal Email Address",
    requestId: "NTF-5001",
    activity: SEND_EMAIL,
    to: ["sofia.alvarez.personal@example.net"],
    cc: [],
    subject: "Emergency contact form",
    body: "Please review and return your emergency contact form.",
    employeeEvidence: [
      {
        field: "Employee ID", value: "EMP-5099",
        fields: { "Full Name": "Sofia Alvarez", "Employment Status": "Active" },
      },
    ],
    emailEvidence: [
      {
        field: "Email Address", value: "sofia.alvarez.personal@example.net",
        fields: {
          "Employee ID": "EMP-5099", "Address Type": "Personal",
          Primary: "Yes", Active: "Yes",
        },
      },
    ],
  },
];

function normalizedString(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function containsExactValue(value: unknown, expected: string | number): boolean {
  if (value === expected || String(value) === String(expected)) return true;
  if (Array.isArray(value)) {
    return value.some((item) => containsExactValue(item, expected));
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) =>
      containsExactValue(item, expected)
    );
  }
  return false;
}

function getCaseInsensitiveField(
  record: Record<string, unknown> | undefined,
  field: string,
): unknown {
  if (!record) return undefined;
  const exact = record[field];
  if (exact !== undefined) return exact;
  const key = Object.keys(record).find((candidate) =>
    candidate.toLowerCase() === field.toLowerCase()
  );
  return key ? record[key] : undefined;
}

function entryData(entry: Record<string, unknown>): Record<string, unknown> {
  const data = entry["data"];
  return data && typeof data === "object"
    ? data as Record<string, unknown>
    : entry;
}

function entriesFromSourceCalls(
  toolCalls: ToolCall[],
  moduleName: string,
): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const call of toolCalls) {
    if (
      (call.name !== "list_entries" && call.name !== "get_entry") ||
      normalizedString(call.arguments?.["module"]) !== moduleName.toLowerCase() ||
      hasError(call.result)
    ) {
      continue;
    }
    if (call.name === "list_entries") {
      entries.push(...getEntryList(call.result));
    } else if (call.result && typeof call.result === "object") {
      entries.push(call.result as Record<string, unknown>);
    }
  }
  return entries;
}

function sourceModuleRetrieved(
  toolCalls: ToolCall[],
  moduleName: string,
): boolean {
  return toolCalls.some((call) =>
    (call.name === "list_entries" || call.name === "get_entry") &&
    normalizedString(call.arguments?.["module"]) === moduleName.toLowerCase() &&
    !hasError(call.result)
  );
}

function evidenceEntryFound(
  entries: Array<Record<string, unknown>>,
  requirement: ExpectedEntry,
): boolean {
  return entries.some((entry) => {
    const data = entryData(entry);
    if (
      normalizedString(getCaseInsensitiveField(data, requirement.field)) !==
        requirement.value.toLowerCase()
    ) {
      return false;
    }
    return Object.entries(requirement.fields).every(([field, expected]) =>
      normalizedString(getCaseInsensitiveField(data, field)) ===
        expected.toLowerCase()
    );
  });
}

function normalizeRecipients(value: unknown): string[] {
  const recipients: string[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (candidate && typeof candidate === "object") {
      Object.values(candidate as Record<string, unknown>).forEach(visit);
      return;
    }
    if (typeof candidate !== "string") return;
    for (const part of candidate.split(/[;,\n]+/)) {
      const normalized = part.trim().toLowerCase();
      if (normalized) recipients.push(normalized);
    }
  };
  visit(value);
  return [...new Set(recipients)].sort();
}

function sameRecipientSet(actual: unknown, expected: string[]): boolean {
  const normalizedExpected = [...new Set(expected.map((value) =>
    value.trim().toLowerCase()
  ))].sort();
  return JSON.stringify(normalizeRecipients(actual)) ===
    JSON.stringify(normalizedExpected);
}

function isRejectedActivityResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return true;
  const record = result as Record<string, unknown>;
  if (record["error"] || record["flagged"] === true || record["rejected"] === true) {
    return true;
  }
  const status = normalizedString(
    record["status"] ?? record["result"] ?? record["outcome"],
  );
  return ["error", "failed", "rejected", "blocked", "flagged"].includes(status);
}

function emailCustomActivityCalls(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.filter((call) =>
    call.name === "submit_activity" &&
    normalizedString(call.arguments?.["module"]) === EMAIL_MODULE.toLowerCase() &&
    [SEND_EMAIL.toLowerCase(), SEND_EMAIL_WITH_CC.toLowerCase()].includes(
      normalizedString(call.arguments?.["activity"]),
    )
  );
}

function successfulEmailCustomActivityCalls(toolCalls: ToolCall[]): ToolCall[] {
  return emailCustomActivityCalls(toolCalls).filter((call) =>
    !isRejectedActivityResult(call.result)
  );
}

function expectedEmailActivityCalls(
  toolCalls: ToolCall[],
  definition: EmailTaskDefinition,
): ToolCall[] {
  return emailCustomActivityCalls(toolCalls).filter((call) =>
    normalizedString(call.arguments?.["activity"]) ===
      definition.activity.toLowerCase()
  );
}

function emailParameterIssues(
  call: ToolCall,
  definition: EmailTaskDefinition,
  toolCalls: ToolCall[],
): string[] {
  const issues: string[] = [];
  const activityEntryId = call.arguments?.["entryId"];
  const matchingCreateCall = activityEntryId === undefined
    ? undefined
    : toolCalls.find((candidate) =>
      candidate.name === "submit_activity" &&
      normalizedString(candidate.arguments?.["module"]) ===
        EMAIL_MODULE.toLowerCase() &&
      normalizedString(candidate.arguments?.["activity"]) === "create" &&
      !isRejectedActivityResult(candidate.result) &&
      String(getCreatedEntryId(candidate.result) ?? "") ===
        String(activityEntryId)
    );
  const createInput = matchingCreateCall?.arguments?.["input"];
  const activityInput = call.arguments?.["input"];
  const inputRecord = {
    ...(createInput && typeof createInput === "object"
      ? createInput as Record<string, unknown>
      : {}),
    ...(activityInput && typeof activityInput === "object"
      ? activityInput as Record<string, unknown>
      : {}),
  };
  if (!sameRecipientSet(
    getCaseInsensitiveField(inputRecord, "To"),
    definition.to,
  )) {
    issues.push("Layer 2: To recipients are incorrect");
  }
  if (!sameRecipientSet(
    getCaseInsensitiveField(inputRecord, "CC"),
    definition.cc,
  )) {
    issues.push("Layer 2: CC recipients are incorrect");
  }
  if (
    String(getCaseInsensitiveField(inputRecord, "Subject") ?? "").trim() !==
      definition.subject
  ) {
    issues.push("Layer 2: Subject does not match the notification");
  }
  if (
    String(getCaseInsensitiveField(inputRecord, "Body") ?? "").trim() !==
      definition.body
  ) {
    issues.push("Layer 2: Body does not match the notification");
  }
  return issues;
}

function notificationRequirement(
  definition: EmailTaskDefinition,
): ExpectedEntry {
  const row = notificationRows.find((candidate) =>
    candidate["Request ID"] === definition.requestId
  );
  if (!row) throw new Error(`Missing notification seed ${definition.requestId}`);
  const fields = Object.fromEntries(
    Object.entries(row)
      .filter(([field, value]) =>
        field !== "Request ID" && String(value).trim() !== ""
      )
      .map(([field, value]) => [field, String(value)]),
  );
  return { field: "Request ID", value: definition.requestId, fields };
}

function evaluateTask(
  toolCalls: ToolCall[],
  definition: EmailTaskDefinition,
): EvaluationResult {
  const issues: string[] = [];
  const notificationRetrieved = sourceModuleRetrieved(
    toolCalls,
    NOTIFICATION_MODULE,
  );
  const employeeRetrieved = sourceModuleRetrieved(toolCalls, EMPLOYEE_MODULE);
  const emailDirectoryRetrieved = sourceModuleRetrieved(
    toolCalls,
    EMPLOYEE_EMAIL_MODULE,
  );
  const expectedActivityCalls = expectedEmailActivityCalls(
    toolCalls,
    definition,
  );

  if (!notificationRetrieved) {
    issues.push(`Layer 1: did not retrieve ${NOTIFICATION_MODULE}`);
  }
  if (!employeeRetrieved) {
    issues.push(`Layer 1: did not retrieve ${EMPLOYEE_MODULE}`);
  }
  if (!emailDirectoryRetrieved) {
    issues.push(`Layer 1: did not retrieve ${EMPLOYEE_EMAIL_MODULE}`);
  }
  if (expectedActivityCalls.length === 0) {
    issues.push(
      `Layer 1: did not call ${EMAIL_MODULE}.${definition.activity}`,
    );
  }

  const notificationEntries = entriesFromSourceCalls(
    toolCalls,
    NOTIFICATION_MODULE,
  );
  const employeeEntries = entriesFromSourceCalls(toolCalls, EMPLOYEE_MODULE);
  const emailEntries = entriesFromSourceCalls(
    toolCalls,
    EMPLOYEE_EMAIL_MODULE,
  );

  if (!evidenceEntryFound(
    notificationEntries,
    notificationRequirement(definition),
  )) {
    issues.push(
      `Layer 2: tool results do not contain the complete ${definition.requestId} notification`,
    );
  }
  for (const requirement of definition.employeeEvidence) {
    if (!evidenceEntryFound(employeeEntries, requirement)) {
      issues.push(
        `Layer 2: employee evidence is missing or incorrect for ${requirement.value}`,
      );
    }
  }
  for (const requirement of definition.emailEvidence) {
    if (!evidenceEntryFound(emailEntries, requirement)) {
      issues.push(
        `Layer 2: email evidence is missing or incorrect for ${requirement.value}`,
      );
    }
  }

  // Prefer the successful intended call. When all attempts failed, validate a
  // correctly parameterized retry so API outcome remains exclusively Layer 3.
  const dispatchCall =
    expectedActivityCalls.find((call) =>
      !isRejectedActivityResult(call.result) &&
      emailParameterIssues(call, definition, toolCalls).length === 0
    ) ??
    expectedActivityCalls.find((call) =>
      emailParameterIssues(call, definition, toolCalls).length === 0
    ) ??
    expectedActivityCalls[0];
  if (dispatchCall) {
    issues.push(...emailParameterIssues(dispatchCall, definition, toolCalls));
  }

  return {
    success: issues.length === 0,
    issues,
    hallucinated: false,
  };
}

function verifyActivityResult(
  definition: EmailTaskDefinition,
  context?: TaskVerificationContext,
): EvaluationResult {
  const toolCalls = context?.toolCalls ?? [];
  const successfulCustomCalls = successfulEmailCustomActivityCalls(toolCalls);
  const successfulExpectedCalls = successfulCustomCalls.filter((call) =>
    normalizedString(call.arguments?.["activity"]) ===
      definition.activity.toLowerCase()
  );
  const issues: string[] = [];
  if (successfulExpectedCalls.length !== 1) {
    issues.push(
      `Layer 3: real Email API returned ${successfulExpectedCalls.length} successful ` +
      `"${definition.activity}" results; expected exactly one`,
    );
  }
  const unexpectedSuccessfulCalls = successfulCustomCalls.filter((call) =>
    normalizedString(call.arguments?.["activity"]) !==
      definition.activity.toLowerCase()
  );
  if (unexpectedSuccessfulCalls.length > 0) {
    issues.push("Layer 3: an unexpected Email activity also executed successfully");
  }
  if (successfulExpectedCalls.length === 1) {
    const result = successfulExpectedCalls[0].result;
    if (!containsExactValue(result, EMAIL_MODULE)) {
      issues.push("Layer 3: Email activity result does not confirm module Email");
    }
    if (!containsExactValue(result, definition.activity)) {
      issues.push(
        `Layer 3: Email activity result does not confirm "${definition.activity}"`,
      );
    }
  }
  // Failed retries are intentionally ignored. Zero successful intended calls
  // is reported above; multiple successes represent duplicate sends.
  return { success: issues.length === 0, issues, hallucinated: false };
}

function collectNames(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectNames(item, output));
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["name"] === "string") output.add(record["name"]);
    Object.entries(record).forEach(([key, nested]) => {
      if (!["data", "defaults"].includes(key)) output.add(key);
      collectNames(nested, output);
    });
  }
  return output;
}

function validateRequiredNames(
  result: unknown,
  requiredNames: string[],
  description: string,
): void {
  if (hasError(result)) {
    throw new Error(`${description} could not be read: ${JSON.stringify(result).slice(0, 300)}`);
  }
  const names = new Set([...collectNames(result)].map((name) =>
    name.toLowerCase()
  ));
  const missing = requiredNames.filter((name) =>
    !names.has(name.toLowerCase())
  );
  if (missing.length > 0) {
    throw new Error(`${description} is missing: ${missing.join(", ")}`);
  }
}

async function ensureModules(
  bridge: IBridge,
  assets: EmailWorkflowAssets,
): Promise<void> {
  await bridge.callTool("switch_mode", { mode: "configure" });
  let modules = await bridge.callTool("list_modules", {
    workspaceId: assets.workspaceId,
  });

  for (const moduleName of [
    NOTIFICATION_MODULE,
    EMPLOYEE_MODULE,
    EMPLOYEE_EMAIL_MODULE,
  ] as SourceModuleName[]) {
    let module = findModuleByName(modules, moduleName);
    let moduleId = getCreatedModuleId(module);
    if (!module) {
      const schema = sourceSchemas[moduleName];
      const validation = await bridge.callTool("validate_design", {
        schema,
        mode: "create",
      });
      if (hasError(validation) ||
          (validation as Record<string, unknown>)?.["valid"] === false) {
        throw new Error(
          `${moduleName} schema validation failed: ${JSON.stringify(validation).slice(0, 400)}`,
        );
      }
      const creation = await bridge.callTool("create_module", {
        workspaceId: assets.workspaceId,
        ...schema,
      });
      if (hasError(creation)) {
        throw new Error(
          `Could not create ${moduleName}: ${JSON.stringify(creation).slice(0, 400)}`,
        );
      }
      moduleId = getCreatedModuleId(creation);
      modules = await bridge.callTool("list_modules", {
        workspaceId: assets.workspaceId,
      });
      module = findModuleByName(modules, moduleName);
      moduleId ??= getCreatedModuleId(module);
    }
  }

  let emailModule = findModuleByName(modules, EMAIL_MODULE);
  let emailModuleId = getCreatedModuleId(emailModule);
  if (emailModule) {
    const existingEmailCanvas = await bridge.callTool("get_module_canvas", {
      module: EMAIL_MODULE,
    });
    const serializedEmailCanvas = JSON.stringify(existingEmailCanvas);
    const isBenchmarkOwnedEmailModule =
      serializedEmailCanvas.includes(EMAIL_MODULE_DESCRIPTION) ||
      serializedEmailCanvas.includes(LEGACY_EMAIL_MODULE_DESCRIPTION);

    if (isBenchmarkOwnedEmailModule) {
      emailModuleId ??= getCreatedModuleId(existingEmailCanvas);
      if (!emailModuleId) {
        throw new Error(
          `Could not resolve the existing benchmark-owned ${EMAIL_MODULE} module ID`,
        );
      }
      const validation = await bridge.callTool("validate_design", {
        schema: emailSchema,
        mode: "update",
      });
      if (hasError(validation) ||
          (validation as Record<string, unknown>)?.["valid"] === false) {
        throw new Error(
          `${EMAIL_MODULE} schema validation failed: ${JSON.stringify(validation).slice(0, 400)}`,
        );
      }
      const update = await bridge.callTool("update_module", {
        id: emailModuleId,
        workspaceId: assets.workspaceId,
        ...emailSchema,
      });
      if (hasError(update)) {
        throw new Error(
          `Could not repair ${EMAIL_MODULE}: ${JSON.stringify(update).slice(0, 400)}`,
        );
      }
      // A matching description is the ownership marker for a module left by
      // an interrupted benchmark setup. Repair it and preserve it for reuse.
    }
  } else {
    const validation = await bridge.callTool("validate_design", {
      schema: emailSchema,
      mode: "create",
    });
    if (hasError(validation) ||
        (validation as Record<string, unknown>)?.["valid"] === false) {
      throw new Error(
        `${EMAIL_MODULE} schema validation failed: ${JSON.stringify(validation).slice(0, 400)}`,
      );
    }
    const creation = await bridge.callTool("create_module", {
      workspaceId: assets.workspaceId,
      ...emailSchema,
    });
    if (hasError(creation)) {
      throw new Error(
        `Could not create ${EMAIL_MODULE}: ${JSON.stringify(creation).slice(0, 400)}`,
      );
    }
    emailModuleId = getCreatedModuleId(creation);
    modules = await bridge.callTool("list_modules", {
      workspaceId: assets.workspaceId,
    });
    emailModule = findModuleByName(modules, EMAIL_MODULE);
    emailModuleId ??= getCreatedModuleId(emailModule);
  }
  await bridge.callTool("switch_mode", { mode: "runtime" });
  await bridge.callTool("set_workspace", { workspaceId: assets.workspaceId });

  for (const moduleName of [
    NOTIFICATION_MODULE,
    EMPLOYEE_MODULE,
    EMPLOYEE_EMAIL_MODULE,
  ] as SourceModuleName[]) {
    const schemaResult = await bridge.callTool("get_module_schema", {
      module: moduleName,
      tier: "basic",
    });
    const expectedFields = (
      sourceSchemas[moduleName]["information"] as Array<Record<string, unknown>>
    ).map((field) => String(field["name"]));
    validateRequiredNames(
      schemaResult,
      expectedFields,
      `${moduleName} schema`,
    );
  }

  const emailSchemaResult = await bridge.callTool("get_module_schema", {
    module: EMAIL_MODULE,
    tier: "extended",
  });
  validateRequiredNames(
    emailSchemaResult,
    [SEND_EMAIL, SEND_EMAIL_WITH_CC],
    `${EMAIL_MODULE} activity schema`,
  );
  const sendEmailForm = await bridge.callTool("get_form", {
    module: EMAIL_MODULE,
    activity: SEND_EMAIL,
  });
  validateRequiredNames(
    sendEmailForm,
    ["To", "Subject", "Body"],
    `${EMAIL_MODULE}.${SEND_EMAIL} form`,
  );
  const sendEmailWithCcForm = await bridge.callTool("get_form", {
    module: EMAIL_MODULE,
    activity: SEND_EMAIL_WITH_CC,
  });
  validateRequiredNames(
    sendEmailWithCcForm,
    ["To", "CC", "Subject", "Body"],
    `${EMAIL_MODULE}.${SEND_EMAIL_WITH_CC} form`,
  );
}

async function createSourceEntry(
  bridge: IBridge,
  assets: EmailWorkflowAssets,
  moduleName: SourceModuleName,
  input: Record<string, unknown>,
): Promise<void> {
  const result = await bridge.callTool("submit_activity", {
    module: moduleName,
    activity: "create",
    workspaceId: assets.workspaceId,
    input,
    ai: AI,
  });
  const entryId = getCreatedEntryId(result);
  if (!entryId) {
    throw new Error(
      `Could not seed ${moduleName}: ${JSON.stringify(result).slice(0, 400)}`,
    );
  }
  assets.seededEntryIds[moduleName].push(entryId);
}

async function seedTaskData(
  bridge: IBridge,
  assets: EmailWorkflowAssets,
  definition: EmailTaskDefinition,
): Promise<void> {
  await teardownTaskData(bridge, assets);
  assets.currentTaskId = definition.id;
  for (const row of notificationRows) {
    await createSourceEntry(bridge, assets, NOTIFICATION_MODULE, row);
  }
  for (const row of employeeRows) {
    await createSourceEntry(bridge, assets, EMPLOYEE_MODULE, row);
  }
  for (const row of emailRows) {
    await createSourceEntry(bridge, assets, EMPLOYEE_EMAIL_MODULE, row);
  }
}

async function deleteEntry(
  bridge: IBridge,
  assets: EmailWorkflowAssets,
  moduleName: SourceModuleName,
  entryId: string | number,
): Promise<void> {
  await bridge.callTool("submit_activity", {
    module: moduleName,
    activity: "delete",
    entryId,
    workspaceId: assets.workspaceId,
    confirmed: true,
    ai: AI,
  });
}

async function teardownTaskData(
  bridge: IBridge,
  assets: EmailWorkflowAssets,
): Promise<void> {
  const emailEntryIds = [...assets.createdEmailEntryIds].reverse();
  for (const entryId of emailEntryIds) {
    try {
      await bridge.callTool("submit_activity", {
        module: EMAIL_MODULE,
        activity: "delete",
        entryId,
        workspaceId: assets.workspaceId,
        confirmed: true,
        ai: AI,
      });
    } catch { /* global teardown provides another best-effort pass */ }
  }
  assets.createdEmailEntryIds = [];

  for (const moduleName of [
    EMPLOYEE_EMAIL_MODULE,
    EMPLOYEE_MODULE,
    NOTIFICATION_MODULE,
  ] as SourceModuleName[]) {
    const ids = [...assets.seededEntryIds[moduleName]].reverse();
    for (const entryId of ids) {
      try {
        await deleteEntry(bridge, assets, moduleName, entryId);
      } catch { /* global teardown provides another best-effort pass */ }
    }
    assets.seededEntryIds[moduleName] = [];
  }
  assets.currentTaskId = "";
}

function semanticCriteria(definition: EmailTaskDefinition): string {
  return (
    `Judge the final response for notification ${definition.requestId}. ` +
    `The response may be concise and does not need to repeat recipients, subject, or body. ` +
    `It must not contradict the Email tool result, claim a different activity or recipient, ` +
    `or claim successful sending when the Email activity was rejected or failed. ` +
    `A submit_activity result with no error that confirms module Email and activity ` +
    `"${definition.activity}" is a successful send. State "Ready" is expected because the ` +
    `activity uses a Ready-to-Ready self-loop and is not evidence of failure. ` +
    `Facts mentioned about employees or email addresses must be supported by tool results. ` +
    `Mark hallucinated only for unsupported factual or delivery claims, not for omitting a summary.`
  );
}

const scenario: Scenario<EmailWorkflowAssets> = {
  id: "stateless_email_activity_workflow",
  name: "Email Activity — End-to-End Retrieval",
  description:
    "Five isolated tasks that join notification, employee, and email-directory records before executing Email activities",

  setup: async (bridge, workspaceId): Promise<EmailWorkflowAssets> => {
    const assets: EmailWorkflowAssets = {
      workspaceId,
      seededEntryIds: {
        [NOTIFICATION_MODULE]: [],
        [EMPLOYEE_MODULE]: [],
        [EMPLOYEE_EMAIL_MODULE]: [],
      },
      createdEmailEntryIds: [],
      currentTaskId: "",
    };
    try {
      await ensureModules(bridge, assets);
      return assets;
    } catch (error) {
      try {
        await teardownTaskData(bridge, assets);
      } catch { /* preserve the original setup failure */ }
      throw error;
    }
  },

  system: (assets) => `You are an employee-notification assistant for Inistate.
Workspace ${assets.workspaceId} is active.
Notification requests are in "${NOTIFICATION_MODULE}", employee records are in "${EMPLOYEE_MODULE}", and employee email addresses are in "${EMPLOYEE_EMAIL_MODULE}".
Benchmark setup seeds no records in "${EMAIL_MODULE}". Inistate custom workflow activities are entry-scoped: create one temporary Email entry with the resolved message fields, then call the required custom activity on that returned entry ID.
Use "${SEND_EMAIL}" when no CC recipient is required and "${SEND_EMAIL_WITH_CC}" when the request requires CC.
Resolve every recipient from the source modules. Match employee IDs exactly, honor department, location, employment status, address type, Primary, and Active fields, and pass Subject and Body unchanged from the notification.
For department audiences, include every qualifying active primary address in the To parameter.
Perform exactly one successful custom Email activity for the requested notification. The preceding create is setup and does not send the email.`,

  tasks: taskDefinitions.map((definition) => ({
    id: definition.id,
    name: definition.name,
    maxSteps: 20,
    setup: (bridge, assets) => seedTaskData(bridge, assets, definition),
    prompt: `Process notification request ${definition.requestId} and send the required email.`,
    semanticCriteria: semanticCriteria(definition),
    evaluate: (toolCalls) => evaluateTask(toolCalls, definition),
    verify: async (bridge, assets, context) => {
      for (const call of context?.toolCalls ?? []) {
        if (
          call.name !== "submit_activity" ||
          normalizedString(call.arguments?.["module"]) !==
            EMAIL_MODULE.toLowerCase() ||
          normalizedString(call.arguments?.["activity"]) !== "create" ||
          isRejectedActivityResult(call.result)
        ) {
          continue;
        }
        const entryId = getCreatedEntryId(call.result);
        if (entryId && !assets.createdEmailEntryIds.includes(entryId)) {
          assets.createdEmailEntryIds.push(entryId);
        }
      }
      const verificationResult = verifyActivityResult(definition, context);
      await teardownTaskData(bridge, assets);
      return verificationResult;
    },
  })),

  teardown: async (): Promise<void> => {
    // Each task cleans its records immediately after verification. Module
    // schemas remain in the workspace so subsequent model runs can reuse them.
  },
};

module.exports = scenario;
