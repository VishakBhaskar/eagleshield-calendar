"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  addDays,
  blockApplies,
  computeCellState,
  slotLabel,
  zonedDateParts,
} from "@/lib/domain.mjs";
import type {
  Appointment,
  CalendarPayload,
  CapacityBlock,
  CellState,
  TerritoryId,
} from "@/lib/types";

type Tab = "calendar" | "scheduling" | "log";
type View = "week" | "month";
type SlotContext = { territoryId: TerritoryId; date: string; slot: string };
type Modal =
  | ({ type: "choose" } & SlotContext)
  | ({ type: "book" } & SlotContext)
  | ({ type: "block" } & SlotContext)
  | { type: "bulk-block" }
  | { type: "appointment"; appointment: Appointment }
  | { type: "reschedule"; appointment: Appointment }
  | { type: "cancel-appointment"; appointment: Appointment }
  | { type: "remove-block"; block: CapacityBlock }
  | { type: "reps" }
  | null;

const emptyPayload: CalendarPayload = {
  territories: [],
  reps: [],
  lanes: [],
  appointments: [],
  blocks: [],
  settings: {
    timeZone: "America/Los_Angeles",
    cutoffOn: true,
    cutoffHour: 15,
    cutoffDays: 1,
    appointmentDuration: 120,
    slots: ["10:00", "13:00", "16:00"],
  },
  integration: { mode: "mock", healthy: true, message: "Local mode" },
  providerAvailability: {
    mode: "local",
    from: new Date().toISOString().slice(0, 10),
    to: new Date().toISOString().slice(0, 10),
    slots: { SAC: {}, EB: {} },
  },
  currentUser: { id: "", name: "", email: "", role: "staff" },
  serverNow: new Date().toISOString(),
};

const isoToday = () => new Date().toISOString().slice(0, 10);
const asDate = (iso: string) => new Date(`${iso}T12:00:00Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);
const dayName = (date: string, long = false) =>
  asDate(date).toLocaleDateString("en-US", {
    weekday: long ? "long" : "short",
    timeZone: "UTC",
  });
const monthName = (date: string) =>
  asDate(date).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
const prettyDate = (date: string) =>
  asDate(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

const appointmentInitials = (appointment: Appointment) =>
  appointment.customerName
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "ES";

function visuallyBlocked(state: CellState) {
  const unbookedCapacity = Math.max(0, state.capacity - state.booked.length);
  const locallyUnblockedCapacity = Math.max(0, unbookedCapacity - state.blockedLaneIds.length);
  return state.cutoff || (
    unbookedCapacity > 0 && (
      state.blockedLaneIds.length >= unbookedCapacity ||
      (state.providerClosed && locallyUnblockedCapacity > 0)
    )
  );
}

function startOfWeek(date: string) {
  const dow = asDate(date).getUTCDay();
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}

function weekDates(date: string) {
  const start = startOfWeek(date);
  return Array.from({ length: 6 }, (_, index) => addDays(start, index));
}

function monthCells(anchor: string) {
  const [year, month] = anchor.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1, 12));
  const start = new Date(first);
  start.setUTCDate(1 - first.getUTCDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return { date: iso(date), current: date.getUTCMonth() === month - 1 };
  });
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export function CalendarApp() {
  const router = useRouter();
  const [data, setData] = useState<CalendarPayload>(emptyPayload);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("calendar");
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState(isoToday());
  const [visible, setVisible] = useState<Record<TerritoryId, boolean>>({ SAC: true, EB: true });
  const [scheduleTerritory, setScheduleTerritory] = useState<TerritoryId>("SAC");
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [logTerritory, setLogTerritory] = useState("ALL");
  const [logStatus, setLogStatus] = useState("ALL");

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const year = Number(anchor.slice(0, 4));
      const availabilityDates = tab === "calendar" && view === "month"
        ? monthCells(anchor).filter((cell) => cell.current).map((cell) => cell.date)
        : weekDates(anchor);
      const availabilityFrom = availabilityDates[0];
      const availabilityTo = availabilityDates[availabilityDates.length - 1];
      const dataFrom = availabilityFrom < `${year}-01-01` ? availabilityFrom : `${year}-01-01`;
      const dataTo = availabilityTo > `${year}-12-31` ? availabilityTo : `${year}-12-31`;
      const payload = await api<CalendarPayload>(
        `/api/calendar?from=${dataFrom}&to=${dataTo}&availabilityFrom=${availabilityFrom}&availabilityTo=${availabilityTo}`,
      );
      setData(payload);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Calendar could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [anchor, tab, view]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const refresh = () => void load(true);
    const timer = window.setInterval(refresh, 30_000);
    const visibleRefresh = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibleRefresh);
    };
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && setModal(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  const stateFor = useCallback(
    (territoryId: TerritoryId, date: string, slot: string, omitId?: string): CellState => {
      const providerRangeApplies =
        data.providerAvailability.mode === "provider" &&
        date >= data.providerAvailability.from &&
        date <= data.providerAvailability.to;
      return computeCellState({
        territoryId,
        date,
        slot,
        lanes: data.lanes,
        reps: data.reps,
        appointments: omitId
          ? data.appointments.filter((appointment) => appointment.id !== omitId)
          : data.appointments,
        blocks: data.blocks,
        settings: data.settings,
        now: data.serverNow,
        providerOpenSeats: providerRangeApplies
          ? data.providerAvailability.slots[territoryId][`${date}|${slot}`] ?? 0
          : undefined,
      });
    },
    [data],
  );

  const run = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await work();
      setModal(null);
      setToast(success);
      await load(true);
    } catch (caught) {
      setToast(caught instanceof Error ? caught.message : "The change could not be saved");
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };

  const navigate = (direction: number) => {
    const activeView = tab === "scheduling" ? "week" : view;
    if (activeView === "week") setAnchor(addDays(anchor, direction * 7));
    else {
      const date = asDate(anchor);
      date.setUTCMonth(date.getUTCMonth() + direction, 1);
      setAnchor(iso(date));
    }
  };

  const range = tab !== "scheduling" && view === "month"
    ? monthName(anchor)
    : `${prettyDate(weekDates(anchor)[0])} – ${prettyDate(weekDates(anchor)[5])}`;

  return (
    <main className="app">
      <header className="top">
        <div className="brand">
          <div className="shield" aria-hidden="true" />
          <div>
            <h1>Eagle Shield Calendar</h1>
            <div className="sub">Appointment Operations</div>
          </div>
        </div>
        <div className="spacer" />
        <nav className="pill-tabs" aria-label="Primary">
          <button className={tab === "calendar" ? "on" : ""} onClick={() => setTab("calendar")}>Calendar</button>
          <button className={tab === "scheduling" ? "on" : ""} onClick={() => setTab("scheduling")}>Scheduling</button>
          <button className={tab === "log" ? "on" : ""} onClick={() => setTab("log")}>Appointments Log</button>
        </nav>
        <div className="account-chip">
          <span className="ini">{data.currentUser.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "ES"}</span>
          <span>{data.currentUser.name || data.currentUser.email}</span>
          <button onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>

      {tab !== "log" && (
        <div className="subbar">
          <button className="navbtn" aria-label="Previous" onClick={() => navigate(-1)}>‹</button>
          <button className="today" onClick={() => setAnchor(isoToday())}>Today</button>
          <button className="navbtn" aria-label="Next" onClick={() => navigate(1)}>›</button>
          <div className="rangelabel">{range}</div>
          {tab === "calendar" && (
            <div className="viewtoggle">
              <button className={view === "week" ? "on" : ""} onClick={() => setView("week")}>Week</button>
              <button className={view === "month" ? "on" : ""} onClick={() => setView("month")}>Month</button>
            </div>
          )}
        </div>
      )}

      <div className={`statusbanner ${error || !data.integration.healthy ? "error" : ""}`}>
        <b>{error || !data.integration.healthy ? "ATTENTION" : "SYSTEM READY"}</b>
        <span>{error || data.integration.message} · {data.integration.mode === "live" ? "Cal.com live sync" : "safe local simulation"}</span>
      </div>

      {loading ? (
        <div className="loading-shell">Loading calendar…</div>
      ) : tab === "calendar" ? (
        <CalendarView
          data={data}
          anchor={anchor}
          view={view}
          visible={visible}
          setVisible={setVisible}
          stateFor={stateFor}
          setAnchor={setAnchor}
          setView={setView}
          open={setModal}
          reload={load}
          notify={setToast}
          setBusy={setBusy}
          currentRole={data.currentUser.role}
        />
      ) : tab === "scheduling" ? (
        <SchedulingView
          data={data}
          anchor={anchor}
          territoryId={scheduleTerritory}
          setTerritoryId={setScheduleTerritory}
          stateFor={stateFor}
          setAnchor={setAnchor}
          open={setModal}
        />
      ) : (
        <AppointmentLog
          data={data}
          search={search}
          setSearch={setSearch}
          territory={logTerritory}
          setTerritory={setLogTerritory}
          status={logStatus}
          setStatus={setLogStatus}
          open={setModal}
          assign={(appointment, repId) => void run(
            () => api(`/api/appointments/${appointment.id}`, {
              method: "PATCH",
              headers: { "Idempotency-Key": crypto.randomUUID() },
              body: JSON.stringify({ action: "assign", repId: repId || null }),
            }),
            repId ? "Team member assigned" : "Appointment unassigned",
          )}
        />
      )}

      {modal && (
        <ModalPanel
          modal={modal}
          data={data}
          stateFor={stateFor}
          busy={busy}
          close={() => setModal(null)}
          choose={setModal}
          submit={run}
        />
      )}
      {toast && <div className="toast" role="status"><span className="k">ES</span>{toast}</div>}
    </main>
  );
}

type CalendarProps = {
  data: CalendarPayload;
  anchor: string;
  view: View;
  visible: Record<TerritoryId, boolean>;
  setVisible: (value: Record<TerritoryId, boolean>) => void;
  stateFor: (territoryId: TerritoryId, date: string, slot: string) => CellState;
  setAnchor: (date: string) => void;
  setView: (view: View) => void;
  open: (modal: Modal) => void;
  reload: (quiet?: boolean) => Promise<void>;
  notify: (message: string) => void;
  setBusy: (busy: boolean) => void;
  currentRole: CalendarPayload["currentUser"]["role"];
};

function CalendarView(props: CalendarProps) {
  const activeLanes = (territoryId: TerritoryId) =>
    props.data.lanes.filter((lane) => lane.active && lane.territoryId === territoryId).length;
  const toggleCutoff = async () => {
    props.setBusy(true);
    try {
      await api("/api/config/cutoff", {
        method: "PATCH",
        body: JSON.stringify({ enabled: !props.data.settings.cutoffOn }),
      });
      props.notify(`After-hours cutoff ${props.data.settings.cutoffOn ? "disabled" : "enabled"}`);
      await props.reload(true);
    } catch (caught) {
      props.notify(caught instanceof Error ? caught.message : "Cutoff could not be changed");
    } finally {
      props.setBusy(false);
    }
  };
  return (
    <div className="layout">
      <aside className="rail">
        <div className="grp">
          <h3>Territories</h3>
          {props.data.territories.map((territory) => (
            <button
              key={territory.id}
              className={`terrtoggle ${props.visible[territory.id] ? "" : "off"}`}
              onClick={() => props.setVisible({ ...props.visible, [territory.id]: !props.visible[territory.id] })}
            >
              <span className="swatch" style={{ background: territory.color }} />
              <span className="nm">{territory.name}</span>
              <span className="ct">{activeLanes(territory.id)} slots</span>
            </button>
          ))}
        </div>
        <div className="grp">
          <div className="rail-title"><h3>Reps</h3>{props.currentRole === "master_admin" && <button className="tiny-action" aria-label="Manage users" onClick={() => props.open({ type: "reps" })}>+</button>}</div>
          {props.data.reps.map((rep) => <div className={`repchip ${rep.active ? "" : "inactive"}`} key={rep.id}><span className="ini">{rep.initials}</span>{rep.name}</div>)}
        </div>
        <div className="grp legend">
          <h3>Legend</h3>
          <div className="lg"><span className="swatch" style={{ background: "var(--sac-bg)" }} />Sacramento</div>
          <div className="lg"><span className="swatch" style={{ background: "var(--eb-bg)" }} />East Bay</div>
          <div className="lg"><span className="stripe" />Blocked</div>
        </div>
        <div className="grp">
          <h3>Booking Controls</h3>
          {(props.currentRole === "master_admin" || props.currentRole === "manager") && <button className="bulk-block-btn" onClick={() => props.open({ type: "bulk-block" })}>Block times in bulk</button>}
          <label className="cutoggle"><input type="checkbox" checked={props.data.settings.cutoffOn} onChange={() => void toggleCutoff()} />After-hours cutoff</label>
          <div className="cuthint">After 3:00 PM, tomorrow closes automatically.</div>
        </div>
        <div className="killbox"><b>Conflict protection</b><p>Location capacity and team assignments are protected from double booking.</p></div>
      </aside>
      <section className="cal">
        {props.view === "week" ? <WeekGrid {...props} /> : <MonthGrid {...props} />}
      </section>
    </div>
  );
}

function WeekGrid(props: CalendarProps) {
  const dates = weekDates(props.anchor);
  const today = zonedDateParts(props.data.serverNow, props.data.settings.timeZone).date;
  return (
    <table className="week">
      <thead><tr><th className="slotcol" />{dates.map((date) => {
        const total = props.data.settings.slots.reduce((sum, slot) => sum + props.data.territories.filter((t) => props.visible[t.id]).reduce((n, t) => n + props.stateFor(t.id, date, slot).openBookable, 0), 0);
        return <th key={date} className={date === today ? "today-h" : ""}><div className="dow">{dayName(date)}</div><div className="dnum">{Number(date.slice(8))}</div><div className="dtot">{total} open</div></th>;
      })}</tr></thead>
      <tbody>{props.data.settings.slots.map((slot) => <tr key={slot}>
        <th className="slotcell">{slotLabel(slot)}<span className="ap">2 hrs</span></th>
        {dates.map((date) => <td className="cell" key={date}>{props.data.territories.filter((territory) => props.visible[territory.id]).map((territory) => (
          <TerritoryCell key={territory.id} data={props.data} territoryId={territory.id} date={date} slot={slot} state={props.stateFor(territory.id, date, slot)} open={props.open} />
        ))}</td>)}
      </tr>)}</tbody>
    </table>
  );
}

function TerritoryCell({ data, territoryId, date, slot, state, open }: {
  data: CalendarPayload; territoryId: TerritoryId; date: string; slot: string; state: CellState; open: (modal: Modal) => void;
}) {
  const rep = (id: string) => data.reps.find((item) => item.id === id);
  const applicable = data.blocks.filter((block) => blockApplies(block, territoryId, date, slot));
  const openSlots = state.openLaneIds.length;
  const showProviderBlock = state.providerClosed && Math.max(
    0,
    state.capacity - state.booked.length - state.blockedLaneIds.length,
  ) > 0;
  return <div className={`terrblock ${territoryId === "SAC" ? "tb-sac" : "tb-eb"}`}>
    <div className="hd"><span className="dot" style={{ background: territoryId === "SAC" ? "var(--sac)" : "var(--eb)" }} />{territoryId === "SAC" ? "Sacramento" : "East Bay"}</div>
    {state.booked.map((appointment) => <button type="button" className={`seat appointment-seat ${appointment.status === "Expired" ? "expired" : ""}`} key={appointment.id} title={`${appointment.confirmation} · ${rep(appointment.repId)?.name ?? "Unassigned"}`} aria-label={`Open appointment ${appointment.confirmation} for ${appointment.customerName}`} onClick={() => open({ type: "appointment", appointment })}><span className="rp">{rep(appointment.repId)?.initials ?? appointmentInitials(appointment)}</span><span className="cn">{appointment.customerName}</span><span className="seat-action" aria-hidden="true">›</span></button>)}
    {applicable.map((block) => <button className="blocked blockseat" key={block.id} onClick={() => open({ type: "remove-block", block })}>Blocked</button>)}
    {state.cutoff ? <button className="blocked" disabled>After-hours cutoff</button> : showProviderBlock ? <button className="blocked" disabled>Blocked</button> : <>
      {Array.from({ length: state.openBookable }, (_, index) => <button className="seatopen" key={`open-${index}`} onClick={() => open({ type: "choose", territoryId, date, slot })}>＋ Open seat</button>)}
      {Array.from({ length: Math.max(0, openSlots - state.openBookable) }, (_, index) => <button className="norep" key={`norep-${index}`} disabled>No eligible rep</button>)}
    </>}
  </div>;
}

function MonthGrid(props: CalendarProps) {
  const cells = monthCells(props.anchor);
  const today = zonedDateParts(props.data.serverNow, props.data.settings.timeZone).date;
  return <table className="month"><thead><tr>{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <th key={day}>{day}</th>)}</tr></thead><tbody>{Array.from({ length: 6 }, (_, row) => <tr key={row}>{cells.slice(row * 7, row * 7 + 7).map((cell) => {
    const sunday = asDate(cell.date).getUTCDay() === 0;
    const visibleTerritories = props.data.territories.filter((territory) => props.visible[territory.id]);
    const summaries = props.data.settings.slots.map((slot) => {
      const states = visibleTerritories.map((territory) => props.stateFor(territory.id, cell.date, slot));
      return {
        count: states.reduce((sum, state) => sum + state.openBookable, 0),
        blocked: states.length > 0 && states.every(visuallyBlocked),
      };
    });
    const blockedDay = summaries.length > 0 && summaries.every((summary) => summary.blocked);
    return <td key={cell.date} className={`${cell.current ? "" : "dim"} ${sunday ? "sun" : ""} ${cell.date === today ? "mtoday" : ""}`} onClick={() => { if (!sunday && cell.current) { props.setAnchor(cell.date); props.setView("week"); } }}>
      <div className="mday">{Number(cell.date.slice(8))}{blockedDay && <span className="mcutt">blocked</span>}</div>
      {cell.current && !sunday && <div className="mslots">{props.data.settings.slots.map((slot, index) => <div className={`mslot ${summaries[index].blocked ? "blk" : summaries[index].count ? "open" : "zero"}`} key={slot}><span>{slotLabel(slot)}</span><b>{summaries[index].count}</b></div>)}</div>}
    </td>;
  })}</tr>)}</tbody></table>;
}

function SchedulingView({ data, anchor, territoryId, setTerritoryId, stateFor, setAnchor, open }: {
  data: CalendarPayload; anchor: string; territoryId: TerritoryId; setTerritoryId: (id: TerritoryId) => void; stateFor: (id: TerritoryId, date: string, slot: string) => CellState; setAnchor: (date: string) => void; open: (modal: Modal) => void;
}) {
  const dates = weekDates(anchor);
  const cells = monthCells(anchor);
  return <div className="sched">
    <aside className="sched-side"><h3>{monthName(anchor)}</h3><table className="minih"><tbody>{Array.from({ length: 6 }, (_, row) => <tr key={row}>{cells.slice(row * 7, row * 7 + 7).map((cell) => {
      const capacity = data.settings.slots.reduce((sum, slot) => sum + stateFor(territoryId, cell.date, slot).capacity, 0);
      const openCount = data.settings.slots.reduce((sum, slot) => sum + stateFor(territoryId, cell.date, slot).openBookable, 0);
      const tone = !cell.current ? "mh-blank" : openCount === 0 ? "mh-full" : openCount < capacity ? "mh-mid" : "mh-open";
      return <td key={cell.date} className={`${tone} ${cell.date === anchor ? "sel" : ""}`} onClick={() => cell.current && setAnchor(cell.date)}>{cell.current ? Number(cell.date.slice(8)) : ""}</td>;
    })}</tr>)}</tbody></table><div className="sched-legend"><div className="row"><span className="box" style={{ background: "#4caf50" }} />Good availability</div><div className="row"><span className="box" style={{ background: "#f4c400" }} />Limited</div><div className="row"><span className="box" style={{ background: "#e0554d" }} />Full / blocked</div></div></aside>
    <section className="sched-main"><div className="sched-head"><div className="fld"><label>Territory</label><select value={territoryId} onChange={(event) => setTerritoryId(event.target.value as TerritoryId)}><option value="SAC">Sacramento</option><option value="EB">East Bay</option></select></div><div><div className="fld"><label>Appointment type</label></div><div className="apptype">Free Estimate · 2 hours</div></div><div className="sched-note">Select a green cell to create an appointment. Availability reflects Cal.com, location capacity, blocks, and cutoff rules.</div></div>
      <table className="sgrid"><thead><tr><th className="slotlab" />{dates.map((date) => <th key={date}><div className="sd">{dayName(date)}</div><div className="sdt">{Number(date.slice(8))}</div><div className="stot">{data.settings.slots.reduce((sum, slot) => sum + stateFor(territoryId, date, slot).openBookable, 0)} open</div></th>)}</tr></thead><tbody>{data.settings.slots.map((slot) => <tr key={slot}><th className="slotlab">{slotLabel(slot)}</th>{dates.map((date) => {
        const state = stateFor(territoryId, date, slot);
        const blocked = visuallyBlocked(state);
        return <td key={date}><button className={`scell ${blocked ? "blk" : state.openBookable ? "open" : "zero"}`} disabled={!state.openBookable} onClick={() => open({ type: "book", territoryId, date, slot })}>{state.openBookable}<span className="cq">{blocked ? "blocked" : "seats"}</span></button></td>;
      })}</tr>)}</tbody></table>
    </section>
  </div>;
}

function AppointmentLog({ data, search, setSearch, territory, setTerritory, status, setStatus, open, assign }: {
  data: CalendarPayload; search: string; setSearch: (value: string) => void; territory: string; setTerritory: (value: string) => void; status: string; setStatus: (value: string) => void; open: (modal: Modal) => void; assign: (appointment: Appointment, repId: string) => void;
}) {
  const rows = useMemo(() => data.appointments.filter((appointment) => {
    const needle = search.toLowerCase();
    const matches = !needle || [appointment.customerName, appointment.confirmation, appointment.phone, appointment.address].some((value) => value.toLowerCase().includes(needle));
    return matches && (territory === "ALL" || appointment.territoryId === territory) && (status === "ALL" || appointment.status === status);
  }).sort((a, b) => b.startAt.localeCompare(a.startAt)), [data.appointments, search, territory, status]);
  const rep = (id: string) => data.reps.find((item) => item.id === id)?.name ?? "Unassigned";
  return <section className="logwrap"><div className="logtools"><input aria-label="Search appointments" placeholder="Search customer or confirmation" value={search} onChange={(event) => setSearch(event.target.value)} /><select aria-label="Territory filter" value={territory} onChange={(event) => setTerritory(event.target.value)}><option value="ALL">All territories</option><option value="SAC">Sacramento</option><option value="EB">East Bay</option></select><select aria-label="Status filter" value={status} onChange={(event) => setStatus(event.target.value)}><option value="ALL">All statuses</option>{["Scheduled", "Confirmed", "Expired", "Cancelled"].map((item) => <option key={item}>{item}</option>)}</select><span className="spacer" />{rows.length} appointments</div>
    <table className="log"><thead><tr><th>Confirmation</th><th>Customer</th><th>Date & time</th><th>Territory</th><th>Rep</th><th>Status</th><th>Actions</th></tr></thead><tbody>{rows.map((appointment) => <tr key={appointment.id}><td><b>{appointment.confirmation}</b></td><td>{appointment.customerName}<div className="ctx">{appointment.phone}</div></td><td>{prettyDate(appointment.date)}<div className="ctx">{slotLabel(appointment.slot)}</div></td><td><span className={`tag ${appointment.territoryId === "SAC" ? "tag-sac" : "tag-eb"}`}>{appointment.territoryId === "SAC" ? "Sacramento" : "East Bay"}</span></td><td><select className="assign-select" aria-label={`Assign ${appointment.confirmation}`} value={appointment.repId} disabled={appointment.status === "Cancelled"} onChange={(event) => assign(appointment, event.target.value)}><option value="">Unassigned</option>{data.reps.filter((item) => item.active && (appointment.territoryId === "SAC" ? item.sacramentoEligible : item.eastBayEligible)).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><div className="ctx">{rep(appointment.repId)}</div></td><td><span className={`stat ${appointment.status.toLowerCase()}`}>{appointment.status}</span></td><td>{appointment.status !== "Cancelled" && <><button className="rowbtn" onClick={() => open({ type: "reschedule", appointment })}>Reschedule</button><button className="rowbtn danger" onClick={() => open({ type: "cancel-appointment", appointment })}>Cancel</button></>}</td></tr>)}</tbody></table>
  </section>;
}

function ModalPanel({ modal, data, stateFor, busy, close, choose, submit }: {
  modal: Exclude<Modal, null>; data: CalendarPayload; stateFor: (id: TerritoryId, date: string, slot: string, omitId?: string) => CellState; busy: boolean; close: () => void; choose: (modal: Modal) => void; submit: (work: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  const appointment = ["appointment", "reschedule", "cancel-appointment"].includes(modal.type)
    ? (modal as { appointment: Appointment }).appointment
    : null;
  const title = modal.type === "choose" ? "Choose an action"
    : modal.type === "book" ? "New appointment"
      : modal.type === "block" ? "Block capacity"
        : modal.type === "bulk-block" ? "Bulk block times"
          : modal.type === "appointment" ? "Appointment details"
            : modal.type === "reschedule" ? "Reschedule appointment"
              : modal.type === "cancel-appointment" ? "Cancel appointment"
                : modal.type === "remove-block" ? "Remove block"
                  : "Manage users";
  const context = modal.type === "reps" ? "Team access and appointment eligibility"
    : modal.type === "bulk-block" ? "Multiple locations, dates, and appointment times"
      : modal.type === "remove-block" ? `${modal.block.territoryId === "SAC" ? "Sacramento" : "East Bay"} · ${modal.block.date ? prettyDate(modal.block.date) : "Recurring"} · ${slotLabel(modal.block.slot)}`
        : appointment ? appointment.confirmation
          : "territoryId" in modal
            ? `${modal.territoryId === "SAC" ? "Sacramento" : "East Bay"} · ${prettyDate(modal.date)} · ${slotLabel(modal.slot)}`
            : "";
  const destructive = modal.type === "cancel-appointment" || modal.type === "remove-block";
  return <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && close()}><section className="modal" role="dialog" aria-modal="true" aria-label="Calendar action">
    <div className={`mh ${destructive ? "danger-head" : ""}`}><span className="modal-mark" aria-hidden="true">{destructive ? "!" : modal.type === "appointment" || modal.type === "reschedule" ? "ES" : modal.type === "book" ? "+" : "◆"}</span><div className="modal-heading"><h2>{title}</h2><div className="ctx">{context}</div></div><button type="button" className="modal-close" aria-label="Close dialog" onClick={close}>×</button></div>
    {modal.type === "choose" ? <div className="mb choice"><button onClick={() => choose({ ...modal, type: "book" })}><span className="big">＋</span><span className="lb">Book appointment</span><div className="ds">Assign a customer and rep</div></button><button onClick={() => choose({ ...modal, type: "block" })}><span className="big">▨</span><span className="lb">Block time</span><div className="ds">Reduce territory capacity</div></button></div>
      : modal.type === "book" ? <BookForm modal={modal} data={data} state={stateFor(modal.territoryId, modal.date, modal.slot)} busy={busy} close={close} submit={submit} />
      : modal.type === "block" ? <BlockForm modal={modal} data={data} state={stateFor(modal.territoryId, modal.date, modal.slot)} busy={busy} close={close} submit={submit} />
      : modal.type === "bulk-block" ? <BulkBlockForm data={data} busy={busy} close={close} submit={submit} />
      : modal.type === "appointment" ? <AppointmentActions appointment={modal.appointment} data={data} close={close} choose={choose} />
      : modal.type === "reschedule" ? <RescheduleForm appointment={modal.appointment} data={data} busy={busy} close={close} submit={submit} />
      : modal.type === "cancel-appointment" ? <CancelAppointment appointment={modal.appointment} busy={busy} close={close} submit={submit} />
      : modal.type === "remove-block" ? <RemoveBlock block={modal.block} busy={busy} close={close} submit={submit} />
      : <RepForm data={data} busy={busy} close={close} submit={submit} />}
    {modal.type === "choose" && <div className="mf"><button className="btn ghost" onClick={close}>Cancel</button></div>}
  </section></div>;
}

function AppointmentActions({ appointment, data, close, choose }: {
  appointment: Appointment; data: CalendarPayload; close: () => void; choose: (modal: Modal) => void;
}) {
  const assigned = data.reps.find((rep) => rep.id === appointment.repId)?.name ?? "Unassigned";
  return <><div className="mb appointment-panel"><div className="appointment-hero"><span className="appointment-avatar">{appointmentInitials(appointment)}</span><div><b>{appointment.customerName}</b><span>{appointment.customerEmail || appointment.phone || "No contact details"}</span></div><span className={`stat ${appointment.status.toLowerCase()}`}>{appointment.status}</span></div><div className="detail-grid"><div><span>Date and time</span><b>{prettyDate(appointment.date)} · {slotLabel(appointment.slot)}</b></div><div><span>Territory</span><b>{appointment.territoryId === "SAC" ? "Sacramento" : "East Bay"}</b></div><div><span>Assigned to</span><b>{assigned}</b></div><div><span>Confirmation</span><b>{appointment.confirmation}</b></div></div>{appointment.address && <div className="service-address"><span>Service address</span><b>{appointment.address}{appointment.zip ? ` · ${appointment.zip}` : ""}</b></div>}</div><div className="mf action-footer"><button type="button" className="btn danger" onClick={() => choose({ type: "cancel-appointment", appointment })}>Cancel appointment</button><span className="spacer" /><button type="button" className="btn ghost" onClick={close}>Close</button><button type="button" className="btn primary" onClick={() => choose({ type: "reschedule", appointment })}>Reschedule</button></div></>;
}

function CancelAppointment({ appointment, busy, close, submit }: {
  appointment: Appointment; busy: boolean; close: () => void; submit: (work: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  return <><div className="mb confirm-panel"><p>Cancel the appointment for <b>{appointment.customerName}</b>?</p><div className="confirm-summary"><span>{prettyDate(appointment.date)} · {slotLabel(appointment.slot)}</span><b>{appointment.territoryId === "SAC" ? "Sacramento" : "East Bay"} · {appointment.confirmation}</b></div><div className="danger-note">This cancels the booking in Cal.com and releases its capacity. This action cannot be undone.</div></div><div className="mf"><button type="button" className="btn ghost" onClick={close}>Keep appointment</button><button type="button" className="btn danger solid" disabled={busy} onClick={() => void submit(() => api(`/api/appointments/${appointment.id}`, { method: "PATCH", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ action: "cancel" }) }), "Appointment cancelled")}>{busy ? "Cancelling…" : "Cancel appointment"}</button></div></>;
}

function RemoveBlock({ block, busy, close, submit }: {
  block: CapacityBlock; busy: boolean; close: () => void; submit: (work: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  return <><div className="mb confirm-panel"><p>Remove this {block.recurrence === "weekly" ? "recurring " : ""}capacity block?</p><div className="confirm-summary"><span>{block.territoryId === "SAC" ? "Sacramento" : "East Bay"} · {slotLabel(block.slot)}</span><b>{block.reason || "Capacity block"}</b></div><div className="danger-note">{block.recurrence === "weekly" ? "Every occurrence in this recurring block will be removed and synced with Cal.com." : "The seat will become available again after the removal is synced with Cal.com."}</div></div><div className="mf"><button type="button" className="btn ghost" onClick={close}>Keep blocked</button><button type="button" className="btn danger solid" disabled={busy} onClick={() => void submit(() => api(`/api/blocks/${block.ruleId}`, { method: "DELETE" }), "Capacity block removed")}>{busy ? "Removing…" : "Remove block"}</button></div></>;
}

function BookForm({ modal, data, state, busy, close, submit }: { modal: SlotContext; data: CalendarPayload; state: CellState; busy: boolean; close: () => void; submit: (work: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [repId, setRepId] = useState("");
  const available = data.reps.filter((rep) => state.freeRepIds.includes(rep.id));
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    void submit(() => api("/api/appointments", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ customerName: form.get("name"), customerEmail: form.get("email"), phone: form.get("phone"), address: form.get("address"), zip: form.get("zip"), repId: repId || undefined, source: "calendar-ui", ...modal }) }), "Appointment booked and synced");
  };
  return <form onSubmit={save}><div className="mb"><div className="field"><label>Assign to</label><div className="repopts"><button type="button" className={`repopt ${!repId ? "sel" : ""}`} onClick={() => setRepId("")}><span className="ini2">—</span><span className="nm2">Unassigned</span></button>{available.map((rep) => <button type="button" key={rep.id} className={`repopt ${repId === rep.id ? "sel" : ""}`} onClick={() => setRepId(rep.id)}><span className="ini2">{rep.initials}</span><span className="nm2">{rep.name}</span></button>)}</div></div><div className="field"><label>Customer name</label><input name="name" required autoFocus /></div><div className="field"><label>Email</label><input name="email" type="email" required={data.integration.mode === "live"} /></div><div className="field"><label>Phone</label><input name="phone" type="tel" /></div><div className="field"><label>Service address</label><input name="address" /></div><div className="field"><label>ZIP code</label><input name="zip" inputMode="numeric" /></div></div><div className="mf"><button type="button" className="btn ghost" onClick={close}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? "Saving…" : "Book appointment"}</button></div></form>;
}

function BlockForm({ modal, state, busy, close, submit }: { modal: SlotContext; data: CalendarPayload; state: CellState; busy: boolean; close: () => void; submit: (work: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [type, setType] = useState<"SEATS" | "ALL">("SEATS");
  const availableToBlock = Math.max(0, state.capacity - state.blockedLaneIds.length);
  const save = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); void submit(() => api("/api/blocks", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ ...modal, type, seats: Number(form.get("seats") || 1), reason: form.get("reason") }) }), "Capacity block saved and synced"); };
  return <form onSubmit={save}><div className="mb"><div className="field"><label>Block type</label><div className="radio-row"><label><input type="radio" checked={type === "SEATS"} onChange={() => setType("SEATS")} />Specific seats</label><label><input type="radio" checked={type === "ALL"} onChange={() => setType("ALL")} />Whole day</label></div></div>{type === "SEATS" && <div className="field"><label>Seats to block</label><select name="seats">{Array.from({ length: availableToBlock }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select></div>}<div className="field"><label>Reason</label><input name="reason" defaultValue="Capacity hold" /></div><div className="hint">Use “Block times in bulk” for holidays, date ranges, or several appointment times.</div></div><div className="mf"><button type="button" className="btn ghost" onClick={close}>Cancel</button><button className="btn primary" disabled={busy || availableToBlock === 0}>{busy ? "Saving…" : "Block capacity"}</button></div></form>;
}

function BulkBlockForm({ data, busy, close, submit }: { data: CalendarPayload; busy: boolean; close: () => void; submit: (work: () => Promise<unknown>, success: string) => Promise<void> }) {
  const today = zonedDateParts(data.serverNow, data.settings.timeZone).date;
  const [sacramento, setSacramento] = useState(true);
  const [eastBay, setEastBay] = useState(false);
  const [sacSeats, setSacSeats] = useState(2);
  const [weekdays, setWeekdays] = useState(() => new Set([1, 2, 3, 4, 5, 6]));
  const [slots, setSlots] = useState(() => new Set(data.settings.slots));
  const toggleNumber = (set: Set<number>, value: number, update: (next: Set<number>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    update(next);
  };
  const toggleString = (set: Set<string>, value: string, update: (next: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    update(next);
  };
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const territories = [
      ...(sacramento ? [{ territoryId: "SAC", seats: sacSeats }] : []),
      ...(eastBay ? [{ territoryId: "EB", seats: 1 }] : []),
    ];
    void submit(
      () => api("/api/blocks", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          territories,
          fromDate: form.get("fromDate"),
          toDate: form.get("toDate"),
          weekdays: [...weekdays],
          slots: [...slots],
          reason: form.get("reason"),
        }),
      }),
      "Bulk capacity block saved and synced",
    );
  };
  return <form onSubmit={save}><div className="mb bulk-block-form">
    <div className="field"><label>Locations and capacity</label><div className="bulk-locations">
      <label className="bulk-location"><input type="checkbox" checked={sacramento} onChange={(event) => setSacramento(event.target.checked)} /><span><b>Sacramento</b><small>2 seats normally</small></span>{sacramento && <select aria-label="Sacramento seats to block" value={sacSeats} onChange={(event) => setSacSeats(Number(event.target.value))}><option value={1}>Block 1 seat</option><option value={2}>Block both seats</option></select>}</label>
      <label className="bulk-location"><input type="checkbox" checked={eastBay} onChange={(event) => setEastBay(event.target.checked)} /><span><b>East Bay</b><small>1 seat normally</small></span>{eastBay && <span className="fixed-cap">Block 1 seat</span>}</label>
    </div></div>
    <div className="field split-fields"><label>Start date<input name="fromDate" type="date" min={today} defaultValue={today} required /></label><label>End date<input name="toDate" type="date" min={today} defaultValue={today} required /></label></div>
    <div className="field"><label>Days included</label><div className="bulk-checks">{[1, 2, 3, 4, 5, 6].map((day) => <label key={day}><input type="checkbox" checked={weekdays.has(day)} onChange={() => toggleNumber(weekdays, day, setWeekdays)} />{["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]}</label>)}</div></div>
    <div className="field"><label>Appointment times</label><div className="bulk-checks">{data.settings.slots.map((slot) => <label key={slot}><input type="checkbox" checked={slots.has(slot)} onChange={() => toggleString(slots, slot, setSlots)} />{slotLabel(slot)}</label>)}</div></div>
    <div className="field"><label>Reason</label><input name="reason" defaultValue="Holiday closure" required /></div>
    <div className="hint">Every selected date and time is blocked independently. Unselected times and all future dates remain unchanged.</div>
  </div><div className="mf"><button type="button" className="btn ghost" onClick={close}>Cancel</button><button className="btn primary" disabled={busy || (!sacramento && !eastBay) || !weekdays.size || !slots.size}>{busy ? "Applying blocks…" : "Apply bulk block"}</button></div></form>;
}

function RescheduleForm({ appointment, data, busy, close, submit }: { appointment: Appointment; data: CalendarPayload; busy: boolean; close: () => void; submit: (work: () => Promise<unknown>, success: string) => Promise<void> }) {
  const save = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); void submit(() => api(`/api/appointments/${appointment.id}`, { method: "PATCH", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ action: "reschedule", date: form.get("date"), slot: form.get("slot") }) }), "Appointment rescheduled and synced"); };
  return <form onSubmit={save}><div className="mb"><div className="field"><label>Customer</label><input value={appointment.customerName} disabled /></div><div className="field"><label>New date</label><input name="date" type="date" defaultValue={appointment.date} required /></div><div className="field"><label>New time</label><select name="slot" defaultValue={appointment.slot}>{data.settings.slots.map((slot) => <option value={slot} key={slot}>{slotLabel(slot)}</option>)}</select></div><div className="field"><div className="hint">The assigned team member is retained when available; otherwise the appointment becomes unassigned.</div></div></div><div className="mf"><button type="button" className="btn ghost" onClick={close}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? "Saving…" : "Save new time"}</button></div></form>;
}

function RepForm({ data, busy, close, submit }: { data: CalendarPayload; busy: boolean; close: () => void; submit: (work: () => Promise<unknown>, success: string) => Promise<void> }) {
  const save = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); void submit(() => api("/api/reps", { method: "POST", body: JSON.stringify({ name: form.get("name"), email: form.get("email"), password: form.get("password"), role: form.get("role"), sacramentoEligible: form.get("sacramento") === "on", eastBayEligible: form.get("eastBay") === "on" }) }), "User created and ready to sign in"); };
  return <form onSubmit={save}><div className="mb"><div className="field"><label>Current team</label>{data.reps.map((rep) => <div className={`repchip ${rep.active ? "" : "inactive"}`} key={rep.id}><span className="ini">{rep.initials}</span>{rep.name}<span className="ctx">{rep.email} · {rep.role.replace("_", " ")}</span><button type="button" className="rowbtn" disabled={busy || rep.id === data.currentUser.id} onClick={() => void submit(() => api(`/api/reps/${rep.id}`, { method: "PATCH", body: JSON.stringify({ active: !rep.active }) }), rep.active ? `${rep.name} deactivated` : `${rep.name} activated`)}>{rep.active ? "Deactivate" : "Activate"}</button></div>)}</div><div className="field"><label>New user name</label><input name="name" required autoFocus /></div><div className="field"><label>Email</label><input name="email" type="email" autoComplete="off" required /></div><div className="field"><label>Initial password</label><input name="password" type="password" minLength={12} autoComplete="new-password" required /><div className="hint">At least 12 characters. Passwords are stored as Argon2id hashes.</div></div><div className="field"><label>Access role</label><select name="role" defaultValue="staff"><option value="staff">Staff</option><option value="manager">Manager</option><option value="master_admin">Master admin</option></select></div><div className="field"><label>Eligible territories</label><div className="check-row"><label><input type="checkbox" name="sacramento" defaultChecked />Sacramento</label><label><input type="checkbox" name="eastBay" defaultChecked />East Bay</label></div></div></div><div className="mf"><button type="button" className="btn ghost" onClick={close}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? "Creating…" : "Add user"}</button></div></form>;
}
