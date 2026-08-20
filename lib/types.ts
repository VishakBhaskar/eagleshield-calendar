export type TerritoryId = "SAC" | "EB";
export type UserRole = "master_admin" | "manager" | "staff";
export type AppointmentStatus =
  | "Scheduled"
  | "Confirmed"
  | "Expired"
  | "Cancelled";

export interface Territory {
  id: TerritoryId;
  name: string;
  shortName: string;
  color: string;
}

export interface Rep {
  id: string;
  userId?: string | null;
  name: string;
  email: string;
  initials: string;
  role: UserRole;
  sacramentoEligible: boolean;
  eastBayEligible: boolean;
  active: boolean;
}

export interface Lane {
  id: string;
  territoryId: TerritoryId;
  label: string;
  ordinal: number;
  active: boolean;
}

export interface Appointment {
  id: string;
  calUid?: string | null;
  calSeatUid?: string | null;
  confirmation: string;
  customerName: string;
  customerEmail: string;
  phone: string;
  address: string;
  zip: string;
  territoryId: TerritoryId;
  repId: string;
  laneId: string;
  date: string;
  slot: string;
  startAt: string;
  endAt: string;
  status: AppointmentStatus;
  calStatus: string;
  source: string;
  syncState: string;
  correlationId: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CapacityBlock {
  id: string;
  ruleId: string;
  territoryId: TerritoryId;
  laneId: string;
  date?: string | null;
  slot: string;
  recurrence: "once" | "weekly";
  recurrenceDow?: number | null;
  fromDate?: string | null;
  toDate?: string | null;
  reason: string;
  status: string;
  calUid?: string | null;
  calSeatUid?: string | null;
  syncState?: string;
  errorMessage?: string | null;
}

export interface CellState {
  capacity: number;
  booked: Appointment[];
  blockedLaneIds: string[];
  openLaneIds: string[];
  freeRepIds: string[];
  openBookable: number;
  full: boolean;
  cutoff: boolean;
}

export interface CalendarPayload {
  territories: Territory[];
  reps: Rep[];
  lanes: Lane[];
  appointments: Appointment[];
  blocks: CapacityBlock[];
  settings: {
    timeZone: string;
    cutoffOn: boolean;
    cutoffHour: number;
    cutoffDays: number;
    appointmentDuration: number;
    slots: string[];
  };
  integration: {
    mode: "mock" | "live";
    healthy: boolean;
    message: string;
  };
  currentUser: {
    id: string;
    name: string;
    email: string;
    role: UserRole | "voice_agent";
  };
  serverNow: string;
}
