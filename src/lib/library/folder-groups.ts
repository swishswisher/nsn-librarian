export type FolderGroup<T> = {
  folders: FolderGroup<T>[];
  id: string;
  items: T[];
  name: string;
  relativePath: string;
  totalItems: number;
};

export type FolderGrouping<T> = {
  folders: FolderGroup<T>[];
  rootItems: T[];
  totalItems: number;
};

type MutableFolderGroup<T> = Omit<FolderGroup<T>, "folders"> & {
  folderMap: Map<string, MutableFolderGroup<T>>;
  folders: MutableFolderGroup<T>[];
};

function normalizedPathSegments(relativePath: string) {
  return relativePath
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
}

function compareText(first: string, second: string) {
  return first.localeCompare(second, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function createFolderGroup<T>(
  name: string,
  relativePath: string,
): MutableFolderGroup<T> {
  return {
    folderMap: new Map<string, MutableFolderGroup<T>>(),
    folders: [],
    id: relativePath,
    items: [],
    name,
    relativePath,
    totalItems: 0,
  };
}

function publicFolderGroup<T>(
  folder: MutableFolderGroup<T>,
  getId: (item: T) => string,
  getRelativePath: (item: T) => string,
): FolderGroup<T> {
  return {
    folders: [...folder.folders]
      .sort((first, second) => compareText(first.name, second.name))
      .map((child) => publicFolderGroup(child, getId, getRelativePath)),
    id: folder.id,
    items: [...folder.items].sort((first, second) => {
      const pathComparison = compareText(
        getRelativePath(first),
        getRelativePath(second),
      );

      return pathComparison || compareText(getId(first), getId(second));
    }),
    name: folder.name,
    relativePath: folder.relativePath,
    totalItems: folder.totalItems,
  };
}

export function buildFolderGrouping<T>(
  items: T[],
  getRelativePath: (item: T) => string,
  getId: (item: T) => string,
): FolderGrouping<T> {
  const root = createFolderGroup<T>("Root Folder", "");

  for (const item of items) {
    const pathSegments = normalizedPathSegments(getRelativePath(item));
    const folderSegments = pathSegments.slice(0, -1);

    if (folderSegments.length === 0) {
      root.items.push(item);
      root.totalItems += 1;
      continue;
    }

    let currentFolder = root;
    currentFolder.totalItems += 1;

    for (let index = 0; index < folderSegments.length; index += 1) {
      const name = folderSegments[index];
      const relativePath = folderSegments.slice(0, index + 1).join("/");
      let child = currentFolder.folderMap.get(name);

      if (!child) {
        child = createFolderGroup(name, relativePath);
        currentFolder.folderMap.set(name, child);
        currentFolder.folders.push(child);
      }

      child.totalItems += 1;
      currentFolder = child;
    }

    currentFolder.items.push(item);
  }

  const publicRoot = publicFolderGroup(root, getId, getRelativePath);

  return {
    folders: publicRoot.folders,
    rootItems: publicRoot.items,
    totalItems: items.length,
  };
}

export function collectFolderGroupIds<T>(folders: FolderGroup<T>[]) {
  const ids: string[] = [];

  function collect(folder: FolderGroup<T>) {
    ids.push(folder.id);
    folder.folders.forEach(collect);
  }

  folders.forEach(collect);

  return ids;
}
