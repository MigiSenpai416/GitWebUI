import type { FileChange } from "../types";

export interface DirNode {
  type: "dir";
  name: string;
  path: string;
  children: TreeNode[];
}
export interface FileNode {
  type: "file";
  name: string;
  path: string;
  file: FileChange;
}
export type TreeNode = DirNode | FileNode;

/** Build a nested folder/file tree from a flat list of changes (for Tree view). */
export function buildTree(files: FileChange[]): TreeNode[] {
  const root: DirNode = { type: "dir", name: "", path: "", children: [] };

  for (const file of files) {
    const parts = file.path.split("/");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const dirPath = parts.slice(0, i + 1).join("/");
      let next = dir.children.find(
        (c): c is DirNode => c.type === "dir" && c.path === dirPath,
      );
      if (!next) {
        next = { type: "dir", name: seg, path: dirPath, children: [] };
        dir.children.push(next);
      }
      dir = next;
    }
    dir.children.push({
      type: "file",
      name: parts[parts.length - 1],
      path: file.path,
      file,
    });
  }

  sortNode(root);
  return root.children;
}

function sortNode(node: DirNode): void {
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) {
    if (child.type === "dir") sortNode(child);
  }
}

/** All directory paths in the tree (used by "Collapse All"). */
export function allDirPaths(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      if (n.type === "dir") {
        out.push(n.path);
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return out;
}
