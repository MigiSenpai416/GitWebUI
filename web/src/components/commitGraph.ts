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
export function layoutCommitGraph(commits: readonly GraphCommit[], pinned: ReadonlySet<string> = new Set()): CommitGraphLayout {
  const rows: CommitGraphRow[] = [];
  const reserveLeft = pinned.size > 0;
  let lanes: Array<ActiveLane | null> = reserveLeft ? [null] : [];
  let maxLanes = 0;
  let nextColor = reserveLeft ? 1 : 0;

  for (const commit of commits) {
    const pinnedNode = pinned.has(commit.hash);
    let sourceLane = lanes.findIndex((lane) => lane?.hash === commit.hash);
    const startsHere = sourceLane === -1;
    if (startsHere) {
      sourceLane = pinnedNode ? 0 : lanes.length;
      lanes[sourceLane] = { hash: commit.hash, color: pinnedNode ? 0 : nextColor++ };
    }
    const nodeLane = pinnedNode ? 0 : sourceLane;

    const before = lanes;
    const current = before[sourceLane]!;
    const next: Array<ActiveLane | null> = [...before];
    next[sourceLane] = null;

    const parents = Array.from(
      new Set(commit.parents.filter((parent) => parent && parent !== commit.hash)),
    );
    for (let i = 0; i < parents.length; i += 1) {
      const parent = parents[i];
      const existing = next.findIndex((lane) => lane?.hash === parent);
      if (existing >= 0) {
        if (pinnedNode && i === 0) {
          next[0] = { hash: parent, color: 0 };
          if (existing !== 0) next[existing] = null;
        }
        continue;
      }

      let targetLane = i === 0 ? nodeLane : next.findIndex((lane, index) => lane === null && (!reserveLeft || index > 0));
      if (targetLane < 0 || next[targetLane] !== null) targetLane = next.length;
      next[targetLane] = {
        hash: parent,
        color: i === 0 ? pinnedNode ? 0 : current.color : nextColor++,
      };
    }

    const after = reserveLeft ? [next[0], ...next.slice(1).filter((lane) => lane !== null)] : next.filter((lane) => lane !== null);
    const segments: GraphSegment[] = [];

    for (let laneIndex = 0; laneIndex < before.length; laneIndex += 1) {
      const lane = before[laneIndex];
      if (!lane) continue;
      if (laneIndex === sourceLane) {
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

      const targetLane = after.findIndex((candidate) => candidate?.hash === lane.hash);
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
      const targetLane = after.findIndex((lane) => lane?.hash === parent);
      if (targetLane >= 0) {
        segments.push({
          kind: "parent",
          fromLane: nodeLane,
          toLane: targetLane,
          fromPosition: 0.5,
          toPosition: 1,
          color: after[targetLane]!.color,
          parentHash: parent,
        });
      }
    }

    maxLanes = Math.max(maxLanes, before.length, after.length);
    rows.push({ nodeLane, nodeColor: pinnedNode ? 0 : current.color, segments });
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
