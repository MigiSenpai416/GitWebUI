// Generic over the file payload so both working changes (FileChange) and a
// commit's changed files (CommitFile) can be grouped into the same tree.
export interface DirNode<T> {
  type: "dir";
  name: string;
  path: string;
  children: TreeNode<T>[];
}
export interface FileNode<T> {
  type: "file";
  name: string;
  path: string;
  file: T;
}
export type TreeNode<T> = DirNode<T> | FileNode<T>;

/** Build a nested folder/file tree from a flat list of files (for Tree view). */
export function buildTree<T extends { path: string }>(files: T[]): TreeNode<T>[] {
  const root: DirNode<T> = { type: "dir", name: "", path: "", children: [] };

  for (const file of files) {
    const parts = file.path.split("/");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const dirPath = parts.slice(0, i + 1).join("/");
      let next = dir.children.find(
        (c): c is DirNode<T> => c.type === "dir" && c.path === dirPath,
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

function sortNode<T>(node: DirNode<T>): void {
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) {
    if (child.type === "dir") sortNode(child);
  }
}

/** Every file path under a tree node (the node itself if it's a file). */
export function filesUnder<T extends { path: string }>(node: TreeNode<T>): string[] {
  if (node.type === "file") return [node.path];
  const out: string[] = [];
  for (const child of node.children) out.push(...filesUnder(child));
  return out;
}

/** All directory paths in the tree (used by "Collapse All"). */
export function allDirPaths<T>(nodes: TreeNode<T>[]): string[] {
  const out: string[] = [];
  const walk = (list: TreeNode<T>[]) => {
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
