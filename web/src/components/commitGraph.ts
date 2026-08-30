import type { Commit } from "../types";

export const GRAPH_LANE_GAP = 16;
export const GRAPH_LANE_OFFSET = 17;

type RowPosition = 0 | 0.5 | 1;

export interface GraphSegment {
  kind: "incoming" | "continuation" | "parent";
  fromLane: number;
  toLane: number;
  fromPosition: RowPosition;
  toPosition: RowPosition;
  color: number;
  parentHash?: string;
}

export interface CommitGraphRow {
  nodeLane: number;
  nodeColor: number;
  segments: GraphSegment[];
}

export interface CommitGraphLayout {
  rows: CommitGraphRow[];
  maxLanes: number;
}

interface ActiveLane {
  hash: string;
  color: number;
}

type GraphCommit = Pick<Commit, "hash" | "parents">;

/**
 * Assign a lane to every commit and route its parent edges. Git's date order
 * guarantees that children appear before their parents, so the active lanes
 * can be carried forward through a single pass.
 */
export function layoutCommitGraph(commits: readonly GraphCommit[]): CommitGraphLayout {
  const rows: CommitGraphRow[] = [];
  let lanes: ActiveLane[] = [];
  let maxLanes = 0;
  let nextColor = 0;

  for (const commit of commits) {
    let nodeLane = lanes.findIndex((lane) => lane.hash === commit.hash);
    const startsHere = nodeLane === -1;
    if (startsHere) {
      nodeLane = lanes.length;
      lanes.push({ hash: commit.hash, color: nextColor++ });
    }

    const before = lanes;
    const current = before[nodeLane];
    const next: Array<ActiveLane | null> = [...before];
    next[nodeLane] = null;

    const parents = Array.from(
      new Set(commit.parents.filter((parent) => parent && parent !== commit.hash)),
    );
    for (let i = 0; i < parents.length; i += 1) {
      const parent = parents[i];
      if (next.some((lane) => lane?.hash === parent)) continue;

      let targetLane = i === 0 ? nodeLane : next.findIndex((lane) => lane === null);
      if (targetLane < 0 || next[targetLane] !== null) targetLane = next.length;
      next[targetLane] = {
        hash: parent,
        color: i === 0 ? current.color : nextColor++,
      };
    }

    const after = next.filter((lane): lane is ActiveLane => lane !== null);
    const segments: GraphSegment[] = [];

    for (let laneIndex = 0; laneIndex < before.length; laneIndex += 1) {
      const lane = before[laneIndex];
      if (laneIndex === nodeLane) {
        if (!startsHere) {
          segments.push({
            kind: "incoming",
            fromLane: laneIndex,
            toLane: nodeLane,
            fromPosition: 0,
            toPosition: 0.5,
            color: lane.color,
          });
        }
        continue;
      }

      const targetLane = after.findIndex((candidate) => candidate.hash === lane.hash);
      if (targetLane >= 0) {
        segments.push({
          kind: "continuation",
          fromLane: laneIndex,
          toLane: targetLane,
          fromPosition: 0,
          toPosition: 1,
          color: lane.color,
        });
      }
    }

    for (const parent of parents) {
      const targetLane = after.findIndex((lane) => lane.hash === parent);
      if (targetLane >= 0) {
        segments.push({
          kind: "parent",
          fromLane: nodeLane,
          toLane: targetLane,
          fromPosition: 0.5,
          toPosition: 1,
          color: after[targetLane].color,
          parentHash: parent,
        });
      }
    }

    maxLanes = Math.max(maxLanes, before.length, after.length);
    rows.push({ nodeLane, nodeColor: current.color, segments });
    lanes = after;
  }

  return { rows, maxLanes };
}

export function graphLaneX(lane: number): number {
  return GRAPH_LANE_OFFSET + lane * GRAPH_LANE_GAP;
}

export function graphSvgWidth(maxLanes: number): number {
  return Math.max(34, GRAPH_LANE_OFFSET * 2 + Math.max(0, maxLanes - 1) * GRAPH_LANE_GAP);
}
