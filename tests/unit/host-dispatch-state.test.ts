import { describe, expect, it } from "vitest";
import {
  clearPreferredHost,
  createHostDispatchState,
  listHostDispatchSnapshots,
  notePreferredHost,
  releaseHostForIssue,
  reserveHostForIssue,
} from "../../src/orchestrator/host-dispatch-state.js";

const workerHosts = [
  {
    name: "builder-a",
    sshDestination: "builder-a@example.test",
    sshExecutable: "ssh",
    sshOptions: [],
    workspaceRoot: "/srv/symphony/a",
  },
  {
    name: "builder-b",
    sshDestination: "builder-b@example.test",
    sshExecutable: "ssh",
    sshOptions: [],
    workspaceRoot: "/srv/symphony/b",
  },
] as const;

describe("host-dispatch-state", () => {
  it("prefers the previous host when it remains free", () => {
    const state = createHostDispatchState(workerHosts);
    notePreferredHost(state, 188, "builder-b");

    const reservation = reserveHostForIssue(state, 188);

    expect(reservation).toMatchObject({
      kind: "selected",
      preferred: true,
      workerHost: {
        name: "builder-b",
      },
    });
  });

  it("falls back to another configured host when the preferred host is occupied", () => {
    const state = createHostDispatchState(workerHosts);
    notePreferredHost(state, 188, "builder-a");
    expect(reserveHostForIssue(state, 99)).toMatchObject({
      kind: "selected",
      workerHost: {
        name: "builder-a",
      },
    });

    const reservation = reserveHostForIssue(state, 188);

    expect(reservation).toMatchObject({
      kind: "selected",
      preferred: false,
      workerHost: {
        name: "builder-b",
      },
    });
  });

  it("reports blocked dispatch when every host is occupied", () => {
    const state = createHostDispatchState(workerHosts);
    reserveHostForIssue(state, 1);
    reserveHostForIssue(state, 2);

    const reservation = reserveHostForIssue(state, 3);

    expect(reservation).toEqual({
      kind: "blocked",
      preferredHost: null,
      occupiedHosts: ["builder-a", "builder-b"],
    });
  });

  it("projects occupancy and preferred retry hosts for status surfaces", () => {
    const state = createHostDispatchState(workerHosts);
    reserveHostForIssue(state, 1);
    notePreferredHost(state, 2, "builder-a");
    notePreferredHost(state, 3, "builder-b");
    releaseHostForIssue(state, 1);
    clearPreferredHost(state, 3);

    expect(listHostDispatchSnapshots(state)).toEqual([
      {
        name: "builder-a",
        occupiedByIssueNumber: null,
        preferredIssueNumbers: [2],
      },
      {
        name: "builder-b",
        occupiedByIssueNumber: null,
        preferredIssueNumbers: [],
      },
    ]);
  });
});
