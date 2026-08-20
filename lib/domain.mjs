export const DEFAULT_SLOTS = ["10:00", "13:00", "16:00"];

export function weekday(date) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function addDays(date, amount) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

export function blockApplies(block, territoryId, date, slot) {
  if (!["active", "cancel_pending"].includes(block.status) || block.territoryId !== territoryId) return false;
  if (block.slot !== "ALL" && block.slot !== slot) return false;
  if (block.recurrence === "weekly") {
    if (Number(block.recurrenceDow) !== weekday(date)) return false;
    if (block.fromDate && date < block.fromDate) return false;
    if (block.toDate && date > block.toDate) return false;
    return true;
  }
  return block.date === date;
}

export function zonedDateParts(now, timeZone = "America/Los_Angeles") {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(
    formatter.formatToParts(new Date(now)).map((part) => [part.type, part.value]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

export function cutoffBlocksDate({
  date,
  now,
  cutoffOn,
  cutoffHour,
  cutoffDays,
  timeZone,
}) {
  if (!cutoffOn) return false;
  const current = zonedDateParts(now, timeZone);
  if (current.hour < cutoffHour) return false;
  for (let index = 1; index <= cutoffDays; index += 1) {
    if (date === addDays(current.date, index)) return true;
  }
  return false;
}

function eligibleFor(rep, territoryId) {
  return territoryId === "SAC"
    ? Boolean(rep.sacramentoEligible)
    : Boolean(rep.eastBayEligible);
}

export function computeCellState({
  territoryId,
  date,
  slot,
  lanes,
  reps,
  appointments,
  blocks,
  settings,
  now,
}) {
  const activeAppointments = appointments.filter(
    (appointment) =>
      appointment.date === date &&
      appointment.slot === slot &&
      appointment.status !== "Cancelled",
  );
  const territoryAppointments = activeAppointments.filter(
    (appointment) => appointment.territoryId === territoryId,
  );
  const territoryLanes = lanes
    .filter((lane) => lane.active && lane.territoryId === territoryId)
    .sort((left, right) => left.ordinal - right.ordinal);
  const activeBlocks = blocks.filter((block) =>
    blockApplies(block, territoryId, date, slot),
  );
  const blockedLaneIds = [...new Set(activeBlocks.map((block) => block.laneId))];
  const usedLaneIds = new Set(territoryAppointments.map((appointment) => appointment.laneId));
  const openLaneIds = territoryLanes
    .map((lane) => lane.id)
    .filter((laneId) => !blockedLaneIds.includes(laneId) && !usedLaneIds.has(laneId));
  const busyRepIds = new Set(activeAppointments.map((appointment) => appointment.repId));
  const freeRepIds = reps
    .filter(
      (rep) =>
        rep.active && eligibleFor(rep, territoryId) && !busyRepIds.has(rep.id),
    )
    .map((rep) => rep.id);
  const cutoff = cutoffBlocksDate({
    date,
    now,
    cutoffOn: settings.cutoffOn,
    cutoffHour: settings.cutoffHour,
    cutoffDays: settings.cutoffDays,
    timeZone: settings.timeZone,
  });
  const openBookable = cutoff ? 0 : openLaneIds.length;
  return {
    capacity: territoryLanes.length,
    booked: territoryAppointments,
    blockedLaneIds,
    openLaneIds: cutoff ? [] : openLaneIds,
    freeRepIds: cutoff ? [] : freeRepIds,
    openBookable,
    full: cutoff || openBookable === 0,
    cutoff,
  };
}

export function chooseAssignment(state, requestedRepId) {
  const laneId = state.openLaneIds[0] ?? null;
  if (!laneId) return null;
  if (requestedRepId && !state.freeRepIds.includes(requestedRepId)) return null;
  return { repId: requestedRepId ?? "", laneId };
}

export function slotLabel(slot) {
  const [hours] = slot.split(":").map(Number);
  const hour = hours % 12 || 12;
  return `${hour}:00 ${hours >= 12 ? "PM" : "AM"}`;
}

export function toUtcIso(date, time, timeZone = "America/Los_Angeles") {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]),
    );
    const rendered = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const target = Date.UTC(year, month - 1, day, hour, minute, 0);
    guess += target - rendered;
  }
  return new Date(guess).toISOString();
}

export function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

export function localDateAndSlot(iso, timeZone = "America/Los_Angeles") {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(
    formatter.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    slot: `${values.hour}:${values.minute}`,
  };
}
