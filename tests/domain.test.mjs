import assert from "node:assert/strict";
import test from "node:test";
import {
  addDays,
  blockApplies,
  chooseAssignment,
  computeCellState,
  cutoffBlocksDate,
  localDateAndSlot,
  toUtcIso,
} from "../lib/domain.mjs";

const lanes = [
  { id: "sac_a", territoryId: "SAC", ordinal: 1, active: true },
  { id: "sac_b", territoryId: "SAC", ordinal: 2, active: true },
  { id: "eb_a", territoryId: "EB", ordinal: 1, active: true },
];
const reps = [
  { id: "garrett", active: true, sacramentoEligible: true, eastBayEligible: true },
  { id: "kim", active: true, sacramentoEligible: true, eastBayEligible: true },
];
const settings = {
  timeZone: "America/Los_Angeles",
  cutoffOn: true,
  cutoffHour: 15,
  cutoffDays: 1,
};
const now = "2026-08-07T20:00:00.000Z"; // 1 PM Pacific

function state(overrides = {}) {
  return computeCellState({
    territoryId: "SAC",
    date: "2026-08-10",
    slot: "10:00",
    lanes,
    reps,
    appointments: [],
    blocks: [],
    settings,
    now,
    ...overrides,
  });
}

test("Sacramento exposes two capacity lanes and East Bay exposes one", () => {
  assert.equal(state().openBookable, 2);
  assert.equal(state({ territoryId: "EB" }).openBookable, 1);
});

test("provider availability caps lanes and closes missing Cal.com slots", () => {
  assert.equal(state({ providerOpenSeats: 1 }).openBookable, 1);
  assert.equal(state({ providerOpenSeats: 1 }).providerClosed, false);
  const closed = state({ providerOpenSeats: 0 });
  assert.equal(closed.openBookable, 0);
  assert.deepEqual(closed.openLaneIds, []);
  assert.equal(closed.providerClosed, true);
});

test("a partial one-seat block reduces only that date and time", () => {
  const blocks = [{
    id: "b1", ruleId: "r1", territoryId: "SAC", laneId: "sac_a",
    date: "2026-08-10", slot: "10:00", recurrence: "once", status: "active",
  }];
  assert.equal(state({ blocks }).openBookable, 1);
  assert.equal(state({ blocks, slot: "13:00" }).openBookable, 2);
  assert.equal(state({ blocks, date: "2026-08-11" }).openBookable, 2);
});

test("rep conflicts are global but do not reduce location capacity", () => {
  const appointments = [{
    id: "a1", territoryId: "SAC", repId: "garrett", laneId: "sac_a",
    date: "2026-08-10", slot: "10:00", status: "Scheduled",
  }];
  const eastBay = state({ territoryId: "EB", appointments });
  assert.deepEqual(eastBay.freeRepIds, ["kim"]);
  assert.equal(eastBay.openBookable, 1);
  const bothBusy = state({
    territoryId: "EB",
    appointments: [...appointments, { ...appointments[0], id: "a2", repId: "kim", laneId: "sac_b" }],
  });
  assert.equal(bothBusy.openBookable, 1);
  assert.deepEqual(bothBusy.freeRepIds, []);
});

test("weekly blocks honor weekday and date boundaries", () => {
  const block = {
    territoryId: "SAC", laneId: "sac_a", slot: "10:00", recurrence: "weekly",
    recurrenceDow: 1, fromDate: "2026-08-10", toDate: "2026-08-24", status: "active",
  };
  assert.equal(blockApplies(block, "SAC", "2026-08-10", "10:00"), true);
  assert.equal(blockApplies(block, "SAC", "2026-08-17", "10:00"), true);
  assert.equal(blockApplies(block, "SAC", "2026-08-25", "10:00"), false);
  assert.equal(blockApplies(block, "EB", "2026-08-17", "10:00"), false);
});

test("after-hours cutoff closes only configured future dates", () => {
  const afterCutoff = "2026-08-08T00:30:00.000Z"; // Aug 7, 5:30 PM Pacific
  assert.equal(cutoffBlocksDate({ date: "2026-08-08", now: afterCutoff, cutoffOn: true, cutoffHour: 15, cutoffDays: 1, timeZone: "America/Los_Angeles" }), true);
  assert.equal(cutoffBlocksDate({ date: "2026-08-09", now: afterCutoff, cutoffOn: true, cutoffHour: 15, cutoffDays: 1, timeZone: "America/Los_Angeles" }), false);
  assert.equal(cutoffBlocksDate({ date: "2026-08-08", now: afterCutoff, cutoffOn: false, cutoffHour: 15, cutoffDays: 1, timeZone: "America/Los_Angeles" }), false);
});

test("assignment selects only a free rep and open lane", () => {
  const available = state();
  assert.deepEqual(chooseAssignment(available, "kim"), { repId: "kim", laneId: "sac_a" });
  assert.deepEqual(chooseAssignment(available), { repId: "", laneId: "sac_a" });
  assert.equal(chooseAssignment(available, "missing"), null);
});

test("timezone conversion is stable across Pacific DST", () => {
  assert.equal(toUtcIso("2026-01-15", "10:00", "America/Los_Angeles"), "2026-01-15T18:00:00.000Z");
  assert.equal(toUtcIso("2026-07-15", "10:00", "America/Los_Angeles"), "2026-07-15T17:00:00.000Z");
  assert.deepEqual(localDateAndSlot("2026-07-15T17:00:00.000Z", "America/Los_Angeles"), { date: "2026-07-15", slot: "10:00" });
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});
